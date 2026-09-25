import type { CardRecord, EventRecord } from "@sekhemet/kernel";
import { DecisionStore } from "./decisions.js";
import { EstimationModel } from "./estimation.js";
import { type PlannerLedger, appendPlannerEvent, moveCard, plannerEvents } from "./ledger.js";
import { type PersistPlanResult, persistPlan } from "./persist.js";
import type { SpidrFeaturePlanner } from "./planner.js";

/**
 * Planner sessions beyond intake (P12, P13, P14; design "Sessions",
 * "Status reporting", "Escalation"). Everything here is derived from the
 * board and the event log, never written freehand by a model.
 */

// ------------------------------------------------------------ plans and diffs

export interface PlanStorySnapshot {
  id: string;
  title: string;
  slice: string;
  scopeFiles: string[];
  difficulty: number;
  routing: string;
  dependsOn: string[];
}

export interface PlanSnapshot {
  epicId: string;
  version: number;
  stories: PlanStorySnapshot[];
}

export interface PlanDiff {
  added: PlanStorySnapshot[];
  removed: PlanStorySnapshot[];
  changed: { id: string; title: string; fields: string[] }[];
  unchanged: number;
}

const PLAN_EVENTS = ["plan/created", "plan/replanned"];

/** The newest plan version recorded for an epic. */
export async function latestPlan(
  ledger: PlannerLedger,
  epicId: string,
): Promise<PlanSnapshot | undefined> {
  const events = (await plannerEvents(ledger, PLAN_EVENTS)).filter(
    (e) => (e.payload as { epicId?: string }).epicId === epicId,
  );
  const last = events[events.length - 1];
  if (!last) return undefined;
  const p = last.payload as PlanSnapshot;
  return { epicId, version: p.version, stories: p.stories };
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Diff two plans: by id, falling back to the normalised title. */
export function diffPlans(
  before: readonly PlanStorySnapshot[],
  after: readonly PlanStorySnapshot[],
): PlanDiff {
  const matched = new Map<string, PlanStorySnapshot>();
  const remaining = [...before];
  const pairs: [PlanStorySnapshot, PlanStorySnapshot][] = [];
  const added: PlanStorySnapshot[] = [];
  for (const s of after) {
    let i = remaining.findIndex((b) => b.id === s.id);
    if (i < 0) i = remaining.findIndex((b) => norm(b.title) === norm(s.title));
    if (i < 0) {
      added.push(s);
      continue;
    }
    const [b] = remaining.splice(i, 1) as [PlanStorySnapshot];
    matched.set(s.id, b);
    pairs.push([b, s]);
  }
  const changed: PlanDiff["changed"] = [];
  let unchanged = 0;
  for (const [b, a] of pairs) {
    const fields: string[] = [];
    if (norm(b.title) !== norm(a.title)) fields.push("title");
    if ([...b.scopeFiles].sort().join() !== [...a.scopeFiles].sort().join()) fields.push("scope");
    if (b.difficulty !== a.difficulty) fields.push("difficulty");
    if (b.routing !== a.routing) fields.push("routing");
    if (b.slice !== a.slice) fields.push("slice");
    if (fields.length > 0) changed.push({ id: a.id, title: a.title, fields });
    else unchanged++;
  }
  return { added, removed: remaining, changed, unchanged };
}

export function formatPlanDiff(diff: PlanDiff): string {
  const lines: string[] = [];
  for (const s of diff.added) lines.push(`+ ${s.id}: ${s.title}`);
  for (const s of diff.removed) lines.push(`- ${s.id}: ${s.title}`);
  for (const c of diff.changed) lines.push(`~ ${c.id}: ${c.title} (${c.fields.join(", ")})`);
  lines.push(`= ${diff.unchanged} unchanged`);
  return lines.join("\n");
}

export type ReplanTrigger =
  | "rung3_failure"
  | "scope_change"
  | "capacity_change"
  | "criterion_regressed"
  | "budget_forecast"
  | "no_criterion_advanced"
  | "manual";

export interface ReplanResult {
  version: number;
  diff: PlanDiff;
  reason: string;
  applied?: PersistPlanResult;
  /** Stories the new plan removed, returned to Backlog (the name is kept for callers). */
  parkedRemoved: string[];
}

/**
 * The Replan session: re-decompose, diff against the previous version and
 * record the new version with its reason. With `apply`, new stories become
 * cards and removed ones that have not started are parked with the reason.
 */
export async function replanSession(
  ledger: PlannerLedger,
  planner: SpidrFeaturePlanner,
  input: { epicId: string; spec: string; reason: string; trigger: ReplanTrigger; apply?: boolean },
): Promise<ReplanResult> {
  const previous = await latestPlan(ledger, input.epicId);
  const plan = await planner.decomposeSpec({
    parentId: input.epicId,
    parentTier: "epic",
    spec: input.spec,
  });
  const after: PlanStorySnapshot[] = plan.stories.map((s) => ({
    id: s.card.id,
    title: s.card.title,
    slice: s.slice,
    scopeFiles: s.card.scopeFiles,
    difficulty: s.difficulty.value,
    routing: s.routing,
    dependsOn: s.dependsOn,
  }));
  const diff = diffPlans(previous?.stories ?? [], after);
  const version = (previous?.version ?? 0) + 1;
  const result: ReplanResult = { version, diff, reason: input.reason, parkedRemoved: [] };
  if (input.apply) {
    const addedIds = new Set(diff.added.map((a) => a.id));
    result.applied = await persistPlan(
      ledger,
      { ...plan, stories: plan.stories.filter((s) => addedIds.has(s.card.id)) },
      { epicId: input.epicId },
    );
    for (const r of diff.removed) {
      const card = await ledger.store.getCard(r.id);
      if (!card || !["backlog", "ready", "planning"].includes(card.status)) continue;
      // A story the new plan removed is no longer planned: it returns to
      // Backlog. Parked needs a stop reason, a person's reason or an open
      // decision (kernel rule 27, K-N5-2); a replan is none of those.
      if (card.status !== "backlog") {
        await moveCard(ledger, {
          cardId: r.id,
          from: card.status,
          to: "backlog",
          reason: `removed by replan v${version}`,
        });
      }
      await ledger.store.updateCard(
        r.id,
        { blockedReason: `Removed by replan v${version}: ${input.reason}` },
        "planner",
      );
      result.parkedRemoved.push(r.id);
    }
  }
  await appendPlannerEvent(
    ledger,
    "plan/replanned",
    {
      epicId: input.epicId,
      version,
      trigger: input.trigger,
      reason: input.reason,
      stories: after,
      diff: {
        added: diff.added.map((s) => s.id),
        removed: diff.removed.map((s) => s.id),
        changed: diff.changed,
      },
    },
    { cardId: (await ledger.store.getCard(input.epicId)) ? input.epicId : undefined },
  );
  return result;
}

// ------------------------------------------------------------------ review

export interface ReviewBrief {
  cardId: string;
  title: string;
  gates: { gate: string; status: string }[];
  dossier: number;
  recommendation: "accept" | "return" | "split";
  why: string;
}

/**
 * The Review session: the evidence a reviewer needs in one screen, and a
 * recommendation from the gate results and the card's bounds.
 */
export async function reviewSession(ledger: PlannerLedger, cardId: string): Promise<ReviewBrief> {
  const card = await ledger.store.getCard(cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  const events = await ledger.log.getEventsByCardAndTypes(cardId, ["gate/result"]);
  const latest = new Map<string, string>();
  for (const e of events) {
    const p = e.payload as { gate?: string; status?: string };
    if (p.gate) latest.set(p.gate, p.status ?? "unknown");
  }
  const gates = [...latest.entries()].map(([gate, status]) => ({ gate, status }));
  const failing = gates.filter((g) => g.status !== "pass");
  const dossier = (await ledger.store.getDossier(cardId)).entries?.length ?? 0;
  let recommendation: ReviewBrief["recommendation"] = "accept";
  let why = "every recorded gate passed";
  if (failing.length > 0) {
    recommendation = "return";
    why = `gates not passing: ${failing.map((g) => `${g.gate}=${g.status}`).join(", ")}`;
  } else if (card.scopeFiles.length > 3) {
    recommendation = "split";
    why = `${card.scopeFiles.length} files is over the 3-file card bound`;
  } else if (gates.length === 0) {
    recommendation = "return";
    why = "no gate result is recorded for this card";
  }
  return { cardId, title: card.title, gates, dossier, recommendation, why };
}

// ------------------------------------------------------------------ standup (P13)

export interface StandupReport {
  text: string;
  byState: Record<string, { id: string; title: string; line: string }[]>;
  decisionsWaiting: { id: string; cardId?: string; question: string; waitingHours: number }[];
  nextWindow: { id: string; title: string; estimate: string }[];
}

/**
 * Status from gate results and the log: cards by state, one line each; then
 * the decisions waiting with their wait times; then the plan for the next
 * window with each estimate's range and basis.
 */
export async function standupReport(
  ledger: PlannerLedger,
  options: {
    now?: Date;
    sinceHours?: number;
    estimator?: EstimationModel;
    windowCards?: number;
  } = {},
): Promise<StandupReport> {
  const now = options.now ?? new Date();
  const since = now.getTime() - (options.sinceHours ?? 24) * 3_600_000;
  const cards = await ledger.store.listCards();
  const estimator = options.estimator ?? EstimationModel.fromCards(cards);
  const work = cards.filter((c) => c.tier === "story" || c.tier === "task");
  const byState: StandupReport["byState"] = {};
  const put = (state: string, c: CardRecord, line: string) => {
    byState[state] = [...(byState[state] ?? []), { id: c.id, title: c.title, line }];
  };
  for (const c of work) {
    const updated = Date.parse(c.updatedAt);
    if (c.status === "done" && updated >= since) put("passed", c, `${c.id} ${c.title}`);
    else if (c.status === "parked")
      put("parked", c, `${c.id} ${c.title}: ${c.blockedReason ?? c.stopReason ?? "parked"}`);
    else if (c.status === "review") put("review", c, `${c.id} ${c.title}: waiting on your review`);
    else if (c.status === "in_progress" || c.status === "verify") {
      put("in_progress", c, `${c.id} ${c.title} (${c.stepsUsed}/${c.stepBudget} steps)`);
    }
  }
  const waiting = await new DecisionStore(ledger).waiting();
  const kernelPending = ledger.store.runs.listDecisions("pending");
  const decisionsWaiting = kernelPending.map((d) => ({
    id: d.id,
    ...(d.cardId ? { cardId: d.cardId } : {}),
    question: d.question,
    waitingHours: Math.round(((now.getTime() - Date.parse(d.createdAt)) / 3_600_000) * 10) / 10,
  }));
  void waiting;
  const ready = work.filter((c) => c.status === "ready").slice(0, options.windowCards ?? 5);
  const nextWindow = ready.map((c) => {
    const e = estimator.estimate({
      tier: c.tier,
      labels: c.labels,
      difficulty: c.difficulty ?? 5,
      basePackTokens: 2_000,
      stepBudget: c.stepBudget,
    });
    return {
      id: c.id,
      title: c.title,
      estimate: `${e.tokensRange[0]}-${e.tokensRange[1]} tokens, ${Math.round(e.secondsRange[0] / 60)}-${Math.round(e.secondsRange[1] / 60)} min (${e.basis.kind}${e.basis.kind === "measured" ? `, ${e.basis.samples} cards` : ""})`,
    };
  });
  const section = (title: string, lines: string[]) =>
    lines.length > 0 ? [`${title}:`, ...lines.map((l) => `  ${l}`)] : [];
  const text = [
    ...section(
      "Passed",
      (byState.passed ?? []).map((x) => x.line),
    ),
    ...section(
      "In progress",
      (byState.in_progress ?? []).map((x) => x.line),
    ),
    ...section(
      "In review",
      (byState.review ?? []).map((x) => x.line),
    ),
    ...section(
      "Parked",
      (byState.parked ?? []).map((x) => x.line),
    ),
    ...section(
      "Waiting on you",
      decisionsWaiting.map(
        (d) =>
          `${d.id}${d.cardId ? ` (${d.cardId})` : ""}: ${d.question} - waiting ${d.waitingHours}h`,
      ),
    ),
    ...section(
      "Next window",
      nextWindow.map((n) => `${n.id} ${n.title}: ${n.estimate}`),
    ),
  ].join("\n");
  return { text: text || "Nothing to report.", byState, decisionsWaiting, nextWindow };
}

// ----------------------------------------------------------- escalation (P14)

export interface EscalationDiagnostic {
  cardId: string;
  diagnosis: string;
  tried: string[];
  smallestHumanAction: string;
  category:
    | "capability_ceiling"
    | "environment"
    | "external_dependency"
    | "budget"
    | "scope"
    | "specification"
    | "memory"
    | "unknown";
}

const ENV_PATTERNS: [RegExp, string, EscalationDiagnostic["category"]][] = [
  [
    /(EACCES|permission denied)/i,
    "a file or directory the gate needs is not writable",
    "environment",
  ],
  [
    /(ENOENT|command not found|not recognized as)/i,
    "a tool or file the gate calls is missing on this machine",
    "environment",
  ],
  [
    /(api[_ ]?key|credential|unauthori[sz]ed|401|403|token (is )?(missing|invalid))/i,
    "a credential the code or a test needs is missing",
    "environment",
  ],
  [
    /(ECONNREFUSED|ENOTFOUND|getaddrinfo|network|ETIMEDOUT)/i,
    "the code or a test needs a network service that is not reachable",
    "external_dependency",
  ],
  [
    /(Cannot find module|Module not found|ERR_MODULE_NOT_FOUND)/i,
    "a dependency is not installed",
    "environment",
  ],
];

/**
 * The smallest human action that unblocks a card (P14), from its stop
 * reason and the text of its failures. States the diagnosis and what was
 * tried, never just "failed".
 */
export function diagnoseEscalation(
  card: CardRecord,
  events: readonly EventRecord[],
): EscalationDiagnostic {
  const failures = events
    .filter((e) => e.type === "gate/result" || e.type === "card/step")
    .map((e) => JSON.stringify(e.payload))
    .join("\n");
  const attempts = events.filter((e) => e.type === "attempt/started").length;
  const rungs = [
    ...new Set(
      events
        .map((e) => (e.payload as { rung?: string }).rung)
        .filter((r): r is string => typeof r === "string"),
    ),
  ];
  const tried = [
    `${attempts || 1} attempt(s), ${card.stepsUsed} of ${card.stepBudget} steps`,
    ...(rungs.length ? [`repair rungs: ${rungs.join(", ")}`] : []),
  ];
  for (const [re, what, category] of ENV_PATTERNS) {
    const m = re.exec(failures);
    if (m) {
      return {
        cardId: card.id,
        category,
        diagnosis: `The retry ladder cannot fix this: ${what} ("${m[0]}").`,
        tried,
        smallestHumanAction:
          category === "external_dependency"
            ? "Start or point the card at the service it needs (or mock it in the test), then unpark the card."
            : `Fix the environment (${what}) and unpark the card; no code change is needed from you.`,
      };
    }
  }
  switch (card.stopReason) {
    case "capability_ceiling":
    case "repair_exhausted":
      return {
        cardId: card.id,
        category: "capability_ceiling",
        diagnosis: `"${card.title}" is past what the worker managed in ${card.stepsUsed} steps across the repair ladder.`,
        tried,
        smallestHumanAction: `Split it: name the one behaviour of "${card.title}" to ship first, or reroute it to the escalation model.`,
      };
    case "budget_exhausted":
    case "token_budget_exhausted":
    case "time_budget_exhausted":
      return {
        cardId: card.id,
        category: "budget",
        diagnosis: `The card ran out of its ${card.stopReason.replace(/_/g, " ")} before its gates passed.`,
        tried,
        smallestHumanAction:
          "Approve a larger budget for this card once, or split it along its scope files.",
      };
    case "scope_violation":
      return {
        cardId: card.id,
        category: "scope",
        diagnosis: "The fix needs a file outside the card's declared scope.",
        tried,
        smallestHumanAction: `Add the needed file to the scope (now ${card.scopeFiles.join(", ") || "empty"}) or create a card for it.`,
      };
    case "vacuous_tests":
      return {
        cardId: card.id,
        category: "specification",
        diagnosis: "The acceptance tests pass before any change, so they cannot prove the card.",
        tried,
        smallestHumanAction:
          "Write one assertion that fails today and passes when the card is done.",
      };
    case "memory_pressure":
      return {
        cardId: card.id,
        category: "memory",
        diagnosis: "The host ran out of memory headroom mid-card.",
        tried,
        smallestHumanAction:
          "Close memory-heavy apps (or pick a smaller model) and resume the card.",
      };
    case "oscillation_detected":
    case "no_progress":
      return {
        cardId: card.id,
        category: "specification",
        diagnosis:
          "The worker kept undoing or repeating its own edits: the goal is ambiguous to it.",
        tried,
        smallestHumanAction:
          "Add one sentence to the spec saying what the finished code must do differently.",
      };
    default:
      return {
        cardId: card.id,
        category: "unknown",
        diagnosis: `Stopped with ${card.stopReason ?? "no recorded reason"}.`,
        tried,
        smallestHumanAction:
          "Read the card's last step and either answer its question or unpark it.",
      };
  }
}
