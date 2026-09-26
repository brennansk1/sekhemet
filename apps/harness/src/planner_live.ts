import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CardRecord, measuresModel } from "@sekhemet/kernel";
import {
  DecisionStore,
  type GoalReplanOutcome,
  type GoalReplanRequest,
  GoalStore,
  type PlanDiff,
  type PlanStorySnapshot,
  type PlannedEpic,
  type PlannedStory,
  type PlannerLedger,
  type ReplanTrigger,
  type RoutingDecision,
  type SignalReading,
  type SpidrFeaturePlanner,
  type SpidrPlan,
  type SpidrSliceKind,
  diffPlans,
  formatPlanDiff,
  latestPlan,
  moveCard,
  replanSession,
  runGoalLoop,
  waitingReason,
  workerDegradation,
} from "@sekhemet/planner";
import { resolveConfig } from "./config.js";
import { ledgerOutcomes } from "./pm/capability.js";
import { stepBudgetSummary } from "./pm/pm_copy.js";
import { PmStore } from "./pm/store.js";
import type { Kernel } from "./wave2.js";

/**
 * The planner's live rules carried out on the board (planner-pm §2.11–2.12,
 * §2.18.6): the signals' responses as proposals and decision requests
 * (NEW-planner-pm-2, -5), the goal loop's inputs and its two timers
 * (NEW-planner-pm-4), and re-plans that carry the riskiest card and, in the
 * Team setup, post a change to an issue someone else owns to that owner as a
 * suggestion (PM-P1-8, PM-N9-9).
 */

export type Setup = "solo" | "team";

const ledgerOf = (k: Kernel): PlannerLedger => ({
  store: k.cardStore,
  log: k.log,
  ...(k.boardService ? { board: k.boardService } : {}),
});

/**
 * The install's setup (`[team] mode`). When the config cannot be read the
 * planner takes the Team side: it proposes rather than changes (teams M6
 * refuses to guess Solo for access; the planner does not guess it either).
 */
export function setupFor(repoPath: string): Setup {
  try {
    return resolveConfig({ repoPath }).config.team.mode;
  } catch {
    return "team";
  }
}

/**
 * PM-N9-9: whether a planner rule changes this issue or posts the change to
 * its owner. In the Team setup an issue whose human owner is not the person
 * who asked — for a signal or a scheduled pass nobody asked — gets a
 * suggestion; in Solo, or with no owner, the rule acts as written.
 */
export function changeRoute(
  card: Pick<CardRecord, "owner">,
  setup: Setup,
  requester?: string,
): "apply" | "suggest" {
  if (setup === "solo" || !card.owner) return "apply";
  return requester && card.owner === requester ? "apply" : "suggest";
}

// ------------------------------------------------------------- re-plans

const RISKIEST = /^Riskiest assumption\b/i;
/** Statuses a re-plan returns a removed story from (sessions `replanSession`). */
const REMOVABLE = new Set(["backlog", "ready", "planning"]);

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function snapshots(plan: SpidrPlan): PlanStorySnapshot[] {
  return plan.stories.map((s) => ({
    id: s.card.id,
    title: s.card.title,
    slice: s.slice,
    scopeFiles: s.card.scopeFiles,
    difficulty: s.difficulty.value,
    routing: s.routing,
    dependsOn: s.dependsOn,
  }));
}

/** An existing card carried into a new plan version as it stands (never re-created). */
function carriedStory(card: CardRecord, snap: PlanStorySnapshot | undefined): PlannedStory {
  return {
    card,
    slice: (snap?.slice ?? card.kind ?? "rule") as SpidrSliceKind,
    rationale: "Carried into the new plan unchanged.",
    keywords: [],
    acceptanceTests: [],
    advances: [],
    difficulty: { value: snap?.difficulty ?? card.difficulty ?? 5, factors: [] },
    routing: (snap?.routing ?? "direct") as RoutingDecision,
    dependsOn: snap?.dependsOn ?? [],
    estimatedPackTokens: 0,
    splitDepth: card.splitDepth ?? 0,
  };
}

/**
 * Carry `cards` into `plan`: a card the new plan already has (by id or
 * title) stays as planned; the riskiest-assumption card takes the place of
 * the new plan's own riskiest story, so there is never a second one; any
 * other card is appended as it stands. Returns the plan and the ids carried.
 */
function carryInto(
  plan: SpidrPlan,
  cards: readonly CardRecord[],
  previous: readonly PlanStorySnapshot[],
): { plan: SpidrPlan; carried: string[] } {
  let stories = [...plan.stories];
  const carried: string[] = [];
  const keep = new Set(cards.map((c) => c.id));
  for (const card of cards) {
    const has = stories.some(
      (s) => s.card.id === card.id || norm(s.card.title) === norm(card.title),
    );
    if (has) continue;
    const snap = previous.find((p) => p.id === card.id);
    const story = carriedStory(card, snap);
    const own = RISKIEST.test(card.title)
      ? stories.findIndex((s) => RISKIEST.test(s.card.title) && !keep.has(s.card.id))
      : -1;
    if (own >= 0) {
      const replaced = (stories[own] as PlannedStory).card.id;
      stories[own] = story;
      stories = stories.map((s) => ({
        ...s,
        dependsOn: s.dependsOn.map((d) => (d === replaced ? card.id : d)),
      }));
    } else {
      stories.push(story);
    }
    carried.push(card.id);
  }
  return { plan: { ...plan, stories }, carried };
}

/** A planner that answers with a fixed plan, so the Replan session diffs and applies exactly it. */
function fixedPlanner(inner: SpidrFeaturePlanner, plan: SpidrPlan): SpidrFeaturePlanner {
  const p = Object.create(inner) as SpidrFeaturePlanner;
  p.decomposeSpec = async () => plan;
  return p;
}

export interface GatedReplanInput {
  epicId: string;
  /** The spec the plan is made from — the original, never a failing card's text. */
  spec: string;
  reason: string;
  trigger: ReplanTrigger;
  /** The design stage's riskiest assumption, planned again as a rule (PM-P1-8). */
  riskiest?: string;
  setup: Setup;
  requester?: string;
}

export interface GatedReplanResult extends GoalReplanOutcome {
  reason: string;
  /** Cards kept in the new plan as they stood: the riskiest, and owned cards in the Team setup. */
  carried: string[];
  /** Cards whose removal went to their owner as a suggestion (PM-N9-9). */
  suggested: string[];
}

/**
 * The Replan session with the planner's two guarantees (PM-P1-8, PM-N9-9):
 * the riskiest-assumption card and the original spec go into the new plan,
 * and the riskiest card is never removed; in the Team setup a card the new
 * plan would remove whose owner did not ask stays as it is, carried into the
 * plan, and its owner gets a suggestion instead. Everything else is applied
 * as the Replan session applies it.
 */
export async function gatedReplan(
  k: Kernel,
  planner: SpidrFeaturePlanner,
  input: GatedReplanInput,
): Promise<GatedReplanResult> {
  const ledger = ledgerOf(k);
  const previous = (await latestPlan(ledger, input.epicId))?.stories ?? [];
  const children = await k.cardStore.listCards({ parentId: input.epicId });
  const raw = await planner.decomposeSpec({
    parentId: input.epicId,
    parentTier: "epic",
    spec: input.spec,
    ...(input.riskiest ? { riskiest: input.riskiest } : {}),
  });
  const riskiest = children.filter((c) => RISKIEST.test(c.title) && c.status !== "rejected");
  const withRiskiest = carryInto(raw, riskiest, previous);
  const wouldRemove = diffPlans(previous, snapshots(withRiskiest.plan)).removed.map((r) => r.id);
  const owned = children.filter(
    (c) =>
      wouldRemove.includes(c.id) &&
      REMOVABLE.has(c.status) &&
      changeRoute(c, input.setup, input.requester) === "suggest",
  );
  const final = carryInto(withRiskiest.plan, owned, previous);
  const r = await replanSession(ledger, fixedPlanner(planner, final.plan), {
    epicId: input.epicId,
    spec: input.spec,
    reason: input.reason,
    trigger: input.trigger,
    apply: true,
  });
  const suggested: string[] = [];
  for (const card of owned) {
    const id = await k.cardStore.suggestions.propose({
      cardId: card.id,
      // PM-N9-9: the removal itself, which Apply performs (Rejected, with the
      // re-plan's reason); a dismissed one is not raised again (TEAM-19).
      kind: "remove",
      // One stable value: a later re-plan finds the open suggestion, and a
      // dismissed one is not raised again for this issue (TEAM-19).
      value: `Removed by the re-plan of ${input.epicId}`,
      why: `Plan v${r.version} of ${input.epicId} no longer includes this issue: ${input.reason}. Apply to move it to Won't do; dismiss to keep it.`,
    });
    if (id) suggested.push(card.id);
  }
  return {
    version: r.version,
    diff: r.diff,
    applied: true,
    reason: input.reason,
    carried: [...withRiskiest.carried, ...final.carried],
    suggested,
  };
}

/** A re-plan in Seshat's thread: the reason paragraph, then the diff (PM-N4-5). */
export async function postReplan(
  k: Kernel,
  reason: string,
  diff: PlanDiff,
  suggested: readonly string[] = [],
): Promise<void> {
  const owners = suggested.length
    ? `\n\nSuggested to their owners instead of changed: ${suggested.join(", ")}.`
    : "";
  await new PmStore(k.log).appendReply({
    replyTo: [],
    text: `${reason}\n\n${formatPlanDiff(diff)}${owners}`,
    model: "planner",
  });
}

// ------------------------------------------------------- the goal loop's inputs

/** Lockfiles whose change is a dependency change (PM-N4-4). */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
];
/** Files that pin a toolchain version. */
const TOOLCHAIN = [
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".python-version",
  ".ruby-version",
  "rust-toolchain",
  "rust-toolchain.toml",
];

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/**
 * The environment's fingerprint (PM-N4-4): each lockfile and toolchain pin
 * present, `package.json`'s `engines` and `packageManager`, and the Node
 * running the harness, as `name=hash` pairs, so a change names what moved.
 */
export function environmentFingerprint(repoPath: string): string {
  const parts: string[] = [];
  for (const f of [...LOCKFILES, ...TOOLCHAIN]) {
    const p = join(repoPath, f);
    if (existsSync(p)) parts.push(`${f}=${sha(readFileSync(p)).slice(0, 16)}`);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      engines?: unknown;
      packageManager?: unknown;
    };
    const pin = JSON.stringify({ engines: pkg.engines ?? null, pm: pkg.packageManager ?? null });
    parts.push(`package.json toolchain=${sha(pin).slice(0, 16)}`);
  } catch {
    // No package.json: not a Node project, nothing to pin.
  }
  parts.push(`node=${process.version}`);
  return parts.sort().join(",");
}

/** What differs between two fingerprints, in words ("pnpm-lock.yaml changed"). */
export function environmentChange(before: string | undefined, now: string): string | undefined {
  if (before === undefined || before === now) return undefined;
  const map = (s: string) =>
    new Map(
      s
        .split(",")
        .filter(Boolean)
        .map((p) => {
          const i = p.lastIndexOf("=");
          return [p.slice(0, i), p.slice(i + 1)] as [string, string];
        }),
    );
  const a = map(before);
  const b = map(now);
  const names = [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n));
  return names.length ? `${names.sort().join(", ")} changed` : undefined;
}

/**
 * The values a goal's `metric` criteria are checked against (PM-N4-2):
 * from the repository, `coverage` — the line coverage in
 * `coverage/coverage-summary.json` (Istanbul's json-summary, which Vitest,
 * c8 and nyc write); from the log, `errors` — the gates whose latest
 * result is failing.
 */
export async function goalMetrics(k: Kernel): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const summary = JSON.parse(
      readFileSync(join(k.repoPath, "coverage", "coverage-summary.json"), "utf8"),
    ) as { total?: { lines?: { pct?: unknown } } };
    const pct = summary.total?.lines?.pct;
    if (typeof pct === "number" && Number.isFinite(pct)) out.coverage = pct;
  } catch {
    // No coverage report: the criterion stays as it was, never met by default.
  }
  const latest = new Map<string, boolean>();
  for (const e of await k.log.getEventsByTypes(["gate/result"])) {
    const p = e.payload as { gate?: string; passed?: boolean };
    if (p.gate && typeof p.passed === "boolean") latest.set(p.gate, p.passed);
  }
  if (latest.size > 0) out.errors = [...latest.values()].filter((v) => !v).length;
  return out;
}

/**
 * Re-evaluate every active goal (PM-N4-1): metrics from the log and the
 * repository, the people's marks, the environment's fingerprint; a re-plan
 * goes through `gatedReplan` and is posted with its diff and reason in
 * Seshat's thread (PM-N4-5).
 */
export async function evaluateGoals(
  k: Kernel,
  options: {
    planner: () => Promise<SpidrFeaturePlanner>;
    setup?: Setup;
    say?: (line: string) => void;
  },
): Promise<{ goalId: string; state: string; replanned: boolean }[]> {
  const ledger = ledgerOf(k);
  const store = new GoalStore(ledger);
  const active = (await store.all()).filter((g) => g.state === "active");
  if (active.length === 0) return [];
  const setup = options.setup ?? setupFor(k.repoPath);
  const planner = await options.planner();
  const metrics = await goalMetrics(k);
  const environment = environmentFingerprint(k.repoPath);
  const out: { goalId: string; state: string; replanned: boolean }[] = [];
  for (const g of active) {
    const detail = environmentChange(g.environment, environment);
    const r = await runGoalLoop(ledger, planner, g.id, {
      metrics,
      humanMarks: await store.humanMarks(g.id),
      environment,
      ...(detail ? { environmentDetail: `the environment changed: ${detail}` } : {}),
      replan: (req: GoalReplanRequest) => gatedReplan(k, planner, { ...req, setup }),
    });
    if (r.replan) {
      await postReplan(k, r.replan.reason, r.replan.diff, r.replan.suggested ?? []);
      options.say?.(`Goal ${g.id} replanned to v${r.replan.version}: ${r.replan.reason}`);
    } else if (r.verdict.state !== "active") {
      options.say?.(
        `Goal ${g.id} is ${r.verdict.state}.${r.verdict.diagnosis ? ` ${r.verdict.diagnosis}` : ""}`,
      );
    }
    out.push({ goalId: g.id, state: r.verdict.state, replanned: r.replanned });
  }
  return out;
}

/** The goal loop's timer: evaluate on a card close, and hourly without one (PM-N4-1). */
export const GOAL_HOUR_MS = 3_600_000;

/**
 * Started by the daemon's server: every `everyMs` it looks for a card that
 * reached Done since its last look — in this process or the queue's, which
 * share the database file — and re-evaluates every active goal when one did,
 * or when an hour has passed with none.
 */
export function startGoalTicker(
  k: Kernel,
  options: {
    everyMs?: number;
    hourMs?: number;
    now?: () => number;
    setup?: Setup;
    planner?: () => Promise<SpidrFeaturePlanner>;
    say?: (line: string) => void;
  } = {},
): { stop: () => void; tick: () => Promise<"closed" | "hourly" | "idle"> } {
  const now = options.now ?? Date.now;
  const hourMs = options.hourMs ?? GOAL_HOUR_MS;
  let seen = k.log.lastSeq();
  let lastEval = now();
  let busy = false;
  const planner =
    options.planner ??
    (async () => (await import("./wave2.js")).repoPlanner(k) as Promise<SpidrFeaturePlanner>);
  const tick = async (): Promise<"closed" | "hourly" | "idle"> => {
    if (busy) return "idle";
    busy = true;
    try {
      const moves = await k.log.getEventsByTypes(["card/status_changed"], seen + 1);
      const closed = moves.some((e) => (e.payload as { toStatus?: string }).toStatus === "done");
      seen = Math.max(seen, ...moves.map((e) => e.seq));
      const why = closed ? "closed" : now() - lastEval >= hourMs ? "hourly" : "idle";
      if (why === "idle") return why;
      lastEval = now();
      await evaluateGoals(k, {
        planner,
        ...(options.setup ? { setup: options.setup } : {}),
        ...(options.say ? { say: options.say } : {}),
      });
      return why;
    } catch {
      // A failed evaluation must not stop the server; the next tick tries again.
      return "idle";
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), options.everyMs ?? 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

// ------------------------------------------------------- signal responses

/** A response already made for this key (so a pass does not repeat a proposal). */
const RESPONDED = "signal/responded";

async function respondedBefore(k: Kernel, key: string): Promise<boolean> {
  return (await k.log.getEventsByTypes([RESPONDED])).some(
    (e) => (e.payload as { key?: string }).key === key,
  );
}

async function markResponded(k: Kernel, signal: string, key: string): Promise<void> {
  await k.log.append({ actor: "planner", type: RESPONDED, payload: { signal, key } });
}

const keyOf = (ids: readonly string[]) => sha([...ids].sort().join(",")).slice(0, 12);

/**
 * Each planned epic's first plan and every story any later version made,
 * from the plan events (scope drift's input, PM-N5-1).
 */
export async function plannedEpics(k: Kernel): Promise<PlannedEpic[]> {
  const byEpic = new Map<string, { original: string[]; planned: string[] }>();
  for (const e of await k.log.getEventsByTypes(["plan/created", "plan/replanned"])) {
    const p = e.payload as { epicId?: string; stories?: { id: string }[] };
    if (!p.epicId) continue;
    const ids = (p.stories ?? []).map((s) => s.id);
    const entry = byEpic.get(p.epicId);
    if (!entry) byEpic.set(p.epicId, { original: ids, planned: [] });
    else entry.planned.push(...ids);
  }
  return [...byEpic].map(([epicId, v]) => ({
    epicId,
    originalCardIds: v.original,
    plannedCardIds: v.planned,
  }));
}

/**
 * The Worker's attempts that measure it, in ledger order, checked against its
 * record (PM-N5-3): the *What's at risk* line when the last 10 fall below
 * the lower bound of its 95% interval.
 */
export function degradationRisk(repoPath: string): string | undefined {
  let passes: boolean[];
  try {
    passes = ledgerOutcomes(repoPath)
      .filter(measuresModel)
      .map((o) => o.passed);
  } catch {
    return undefined;
  }
  return workerDegradation(passes)?.text;
}

/**
 * Carry out the triggered signals' responses (§2.12). Nothing here writes a
 * field a person owns: priority and a re-split are suggestions on the issue
 * (PM-N2-1, PM-N5-2), a step-budget change and a verification spike are
 * proposals in Seshat's thread (PM-N5-3, -4), and scope drift holds the
 * auxiliary cards in Planning — or, in the Team setup, suggests the hold to
 * an owner (PM-N9-9) — and asks whether the goal has grown (PM-N5-1).
 * Returns the cards held this pass.
 */
export async function respondToSignals(
  k: Kernel,
  fired: readonly SignalReading[],
  options: { setup: Setup; now: Date; say: (line: string) => void },
): Promise<{ held: Set<string> }> {
  const held = new Set<string>();
  const ledger = ledgerOf(k);
  const pm = new PmStore(k.log);
  for (const s of fired) {
    const targets = s.response?.targets ?? [];
    switch (s.response?.action) {
      case "escalate_blockers": {
        for (const id of targets) {
          const card = await k.cardStore.getCard(id);
          if (!card || card.priority === 1) continue;
          const sug = await k.cardStore.suggestions.propose({
            cardId: id,
            kind: "priority",
            value: 1,
            why: `Blocked for over ${s.threshold ?? "the bound's"} hours${card.blockedReason ? `: ${card.blockedReason}` : ""}.`,
          });
          if (sug)
            options.say(`Suggested Urgent for ${id} (blocked ${s.value} h); a person decides.`);
        }
        break;
      }
      case "resplit_hotspot": {
        for (const id of targets) {
          const sug = await k.cardStore.suggestions.propose({
            cardId: id,
            kind: "split",
            value: ["interface", "data"],
            why: `${s.detail}: re-split along Interface or Data so each part fails alone.`,
          });
          if (sug) options.say(`Suggested a re-split of ${id} (${s.detail}); it keeps running.`);
        }
        break;
      }
      case "halt_aux_cards_and_ask": {
        if (!s.epicId || targets.length === 0) break;
        const decisions = new DecisionStore(ledger);
        const requestId = `scope_drift_${s.epicId}_${keyOf(targets)}`;
        const known = await decisions.get(requestId);
        if (known && known.state !== "pending" && known.state !== "parked") break;
        const decisionId =
          known?.id ??
          (await decisions.request(
            {
              id: requestId,
              cardId: s.epicId,
              question: `Has the goal grown? ${s.detail} (${Math.round(s.value * 100)}% over the plan). Held until you answer: ${targets.join(", ")}.`,
              options: [
                {
                  label: "Yes, it has grown: release the added cards",
                  consequence: "The added cards return to Ready and the forecast grows.",
                  effortDelta: `+${targets.length} cards`,
                  riskNote: "The plan's date moves.",
                },
                {
                  label: "No: keep them out of this plan",
                  consequence: "Release them, then move them to Backlog on the board.",
                  effortDelta: "none",
                  riskNote: "Work someone asked for waits.",
                },
              ],
              previewSketches: [],
              recommendation: {
                optionIndex: 1,
                rationale: "A plan that grows mid-flight without a decision loses its forecast.",
              },
              policy: "default_deny",
              defaultIfNoAnswer: {
                deadline: new Date(options.now.getTime() + 72 * 3_600_000).toISOString(),
              },
              category: "scope_boundary",
              createdAt: options.now.toISOString(),
            },
            { park: false },
          ));
        for (const id of targets) {
          const card = await k.cardStore.getCard(id);
          if (!card || card.status !== "ready") continue;
          if (changeRoute(card, options.setup) === "suggest") {
            // PM-N9-9: the hold itself, which Apply performs as it is done in
            // Solo: into Planning, waiting on the decision.
            await k.cardStore.suggestions.propose({
              cardId: id,
              kind: "hold",
              value: `scope drift on ${s.epicId}: held until decision ${decisionId} is answered`,
              why: `${s.detail}; a decision asks whether the goal has grown. Apply to hold this issue in Planning until it is answered.`,
            });
            continue;
          }
          held.add(id);
          // Held in Planning, released by the answer (`DecisionStore` resumes
          // cards waiting on it). A card the board will not take into
          // Planning (no difficulty score) stays in Ready and sits out every
          // pass while the question is open.
          try {
            await moveCard(ledger, {
              cardId: id,
              from: "ready",
              to: "planning",
              reason: `scope drift on ${s.epicId}: held until decision ${decisionId} is answered`,
            });
            await k.cardStore.updateCard(
              id,
              { blockedReason: waitingReason(decisionId) },
              "planner",
            );
          } catch {
            // Sits out this pass instead (Planning at its WIP limit, or no score).
          }
        }
        options.say(
          `Scope drift on ${s.epicId}: ${held.size} card(s) held; asked whether the goal has grown.`,
        );
        break;
      }
      case "adjust_step_budgets": {
        const cards = await k.cardStore.listCards();
        const used = cards
          .filter((c) => (c.status === "review" || c.status === "done") && c.stepsUsed > 0)
          .map((c) => c.stepsUsed)
          .sort((a, b) => a - b);
        if (used.length === 0) break;
        const p90 = used[Math.min(used.length - 1, Math.ceil(0.9 * used.length) - 1)] as number;
        const budget = Math.max(8, p90);
        const over = cards.filter((c) => c.status === "ready" && c.stepBudget > budget);
        if (over.length === 0) break;
        const key = `cycle_time:${budget}:${keyOf(over.map((c) => c.id))}`;
        if (await respondedBefore(k, key)) break;
        await pm.appendReply({
          replyTo: [],
          text: `Cycle time is congested (${s.detail}). Suggested: a step budget of ${budget} for ${over.length} Ready card(s). Why: cards that reached Review used at most ${p90} steps (p90); a larger budget lets a stuck card hold a slot far longer than the rest.`,
          proposals: over.map((c) => ({
            kind: "update_card" as const,
            summary: stepBudgetSummary(c.id, c.stepBudget, budget),
            cardId: c.id,
            patch: { stepBudget: budget },
            before: { stepBudget: c.stepBudget },
            // PM-N9-9: in the Team setup, a change to someone else's card is theirs to apply.
            ...(options.setup === "team" && c.owner ? { forOwner: c.owner } : {}),
          })),
          model: "planner",
        });
        await markResponded(k, s.id, key);
        options.say(`Proposed a step budget of ${budget} for ${over.length} Ready card(s).`);
        break;
      }
      case "dispatch_verification_spike": {
        const logged = await k.log.getEventsByTypes(["assumption/logged"]);
        for (const id of targets) {
          const key = `risk_register:${id}`;
          if (await respondedBefore(k, key)) continue;
          const a = logged
            .map((e) => e.payload as { id?: string; statement?: string; cardId?: string })
            .find((p) => p.id === id);
          const statement = a?.statement ?? id;
          const parent = a?.cardId ? await k.cardStore.getCard(a.cardId) : null;
          await pm.appendReply({
            replyTo: [],
            text: `An assumption has gone unverified for over 24 hours: "${statement}". Suggested: a short spike that checks it before more is built on it.`,
            proposals: [
              {
                kind: "create_card" as const,
                summary: `Spike: verify "${statement}"`,
                cards: [
                  {
                    title: `Spike: verify that ${statement.replace(/\.$/, "")}`,
                    spec: `Verify the assumption "${statement}" (${id}) with the smallest experiment that could prove it wrong, and record the outcome with \`sekhemet assume\`.`,
                    ...(parent ? { epicId: parent.id } : {}),
                  },
                ],
              },
            ],
            model: "planner",
          });
          await markResponded(k, s.id, key);
          options.say(`Proposed a verification spike for ${id}.`);
        }
        break;
      }
      default:
        break;
    }
  }
  const risk = degradationRisk(k.repoPath);
  if (risk) {
    options.say(`What's at risk: ${risk}`);
    const attempts = ledgerOutcomes(k.repoPath).filter(measuresModel).length;
    const key = `worker_degradation:${Math.floor(attempts / 10)}`;
    if (!(await respondedBefore(k, key))) {
      await pm.appendReply({ replyTo: [], text: `What's at risk: ${risk}`, model: "ledger" });
      await markResponded(k, "cycle_time", key);
    }
  }
  return { held };
}
