import type { CardRecord, CardStatus, CreateCardInput } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ASSUMPTION_EVENTS } from "./calibration_store.js";
import { DecisionStore, waitingReason } from "./decisions.js";
import { sketchWithModel } from "./edit_sketch.js";
import { type CardEstimate, EstimationModel } from "./estimation.js";
import { analyzeImpact } from "./impact.js";
import { validateInvest } from "./invest.js";
import { type PlannerLedger, appendPlannerEvent } from "./ledger.js";
import type {
  EditSketch,
  InvestValidationReport,
  PlannedStory,
  RoutingDecision,
  SpidrPlan,
  TierBudget,
} from "./types.js";

/**
 * Persist a plan as cards with their whole contract (P1, defect 6), with
 * INVEST enforced rather than advisory (P2):
 *
 * - every story becomes a card carrying its spec, acceptance criteria,
 *   difficulty (P5), routing as a model route and label (P6), dependencies,
 *   and token/second budgets from the estimation model (P4);
 * - the edit sketch (P7) and the logged assumptions (P8) go to the card's
 *   dossier, which the card runner puts in front of the Worker;
 * - INVEST `reject` stories are not created; stories that hit a capability
 *   ceiling are created Parked with the smallest human action as the
 *   blocked reason; overlap with cards already in progress is serialized as
 *   a dependency (Independent);
 * - the batched decision request (P9) with its approach previews (P25) is
 *   persisted and parks the epic, and the new stories wait in Planning until
 *   it is answered (P11);
 * - the plan itself is a versioned `plan/created` event, so a replan can be
 *   diffed against it (P12).
 */
export interface PersistPlanOptions {
  epicId: string;
  /**
   * The planning model (P7). With it, cards routed `edit_sketch`
   * (difficulty 4-7) get a model-written, scope-checked sketch; without it,
   * the template sketch.
   */
  sketcher?: LocalInferenceAdapter;
  /** Repository root: grounds sketches in real outlines and adds impact (P24). */
  repoRoot?: string;
  estimator?: EstimationModel;
  tierBudget?: TierBudget;
  actor?: string;
}

export interface PersistedStory {
  id: string;
  title: string;
  status: CardStatus;
  difficulty: number;
  routing: RoutingDecision;
  estimate: CardEstimate;
}

export interface PersistPlanResult {
  created: PersistedStory[];
  rejected: { id: string; title: string; reason: string }[];
  parked: { id: string; reason: string }[];
  serialized: { id: string; after: string; files: string[] }[];
  sketches: { id: string; source: "model" | "template"; rejected?: string }[];
  decisionId?: string;
  invest: InvestValidationReport;
  version: number;
}

const ACTIVE: CardStatus[] = ["in_progress", "verify", "review"];

/** `executor` model role for a route (the queue maps roles to models). */
export function modelRouteFor(routing: RoutingDecision): { planner?: string; executor: string } {
  switch (routing) {
    case "direct":
      return { executor: "worker" };
    case "edit_sketch":
      return { planner: "manager", executor: "worker" };
    default:
      return { planner: "manager", executor: "escalation" };
  }
}

export function formatEditSketch(s: EditSketch): string {
  return [
    "Edit sketch from the planner (follow it unless the code says otherwise):",
    ...s.targetSymbols.map((t) => `- ${t.change} ${t.symbol} in ${t.filePath}`),
    `Preconditions: ${s.preconditions.join(" ")}`,
    `Invariants: ${s.invariants.join(" ")}`,
    `Approach: ${s.diffSketch}`,
    `Blast radius: ${s.blastRadius.join(", ") || "scope files only"}`,
  ].join("\n");
}

function clampDifficulty(v: number): number {
  return Math.min(10, Math.max(1, Math.round(v)));
}

export async function persistPlan(
  ledger: PlannerLedger,
  plan: SpidrPlan,
  options: PersistPlanOptions,
): Promise<PersistPlanResult> {
  const { store } = ledger;
  const actor = options.actor ?? "planner";
  const all = await store.listCards();
  const estimator = options.estimator ?? EstimationModel.fromCards(all);
  const active = all.filter((c) => ACTIVE.includes(c.status));

  // INVEST with the live board: overlap with running cards is serialized.
  const invest = validateInvest(plan.stories, {
    ...(options.tierBudget ? { tierBudget: options.tierBudget } : {}),
    activeCardScopes: active.map((c) => ({ cardId: c.id, filesTouched: c.scopeFiles })),
  });
  const rejectedIds = new Set(invest.rejected);
  const ceilings = new Map(plan.capabilityCeilings.map((c) => [c.storyId, c]));
  const reasonFor = (id: string): string =>
    invest.checks
      .filter((c) => c.offendingStoryIds.includes(id) && c.action === "reject")
      .map((c) => c.detail)
      .join(" ") || "rejected by the INVEST pre-flight";

  const ask = plan.ambiguity.askUser && plan.ambiguity.decision !== undefined;
  // The batched decision is persisted first (it parks the epic), so the
  // stories can name it while they wait in Planning.
  const decisionId =
    ask && plan.ambiguity.decision
      ? await new DecisionStore(ledger).request({
          ...plan.ambiguity.decision,
          cardId: options.epicId,
        })
      : undefined;
  const result: PersistPlanResult = {
    created: [],
    rejected: [],
    parked: [],
    serialized: [],
    sketches: [],
    invest,
    version: 1,
    ...(decisionId ? { decisionId } : {}),
  };
  const createdIds = new Set<string>();
  const known = new Set(all.map((c) => c.id));

  for (const story of plan.stories) {
    const id = story.card.id;
    if (rejectedIds.has(id)) {
      result.rejected.push({ id, title: story.card.title, reason: reasonFor(id) });
      continue;
    }
    const deps = story.dependsOn.filter((d) => createdIds.has(d) || known.has(d));
    for (const a of active) {
      const shared = story.card.scopeFiles.filter((f) => a.scopeFiles.includes(f));
      if (shared.length > 0 && !deps.includes(a.id)) {
        deps.push(a.id);
        result.serialized.push({ id, after: a.id, files: shared });
      }
    }
    const ceiling = ceilings.get(id);
    const estimate = estimator.estimateStory(story);
    let status: CardStatus = deps.length === 0 ? "ready" : "backlog";
    let blockedReason: string | undefined;
    if (ceiling) {
      status = "parked";
      blockedReason = `Capability ceiling: ${ceiling.smallestHumanAction}`;
      result.parked.push({ id, reason: ceiling.reason });
    } else if (ask && decisionId) {
      status = "planning";
      blockedReason = waitingReason(decisionId);
    }
    const difficulty = clampDifficulty(story.difficulty.value);
    const input: CreateCardInput = {
      id,
      tier: story.card.tier,
      parentId: options.epicId,
      title: story.card.title,
      status,
      scopeFiles: story.card.scopeFiles,
      stepBudget: story.card.stepBudget,
      spec: story.card.spec ?? `${story.card.title}\n\n${story.rationale}`,
      acceptanceCriteria: story.acceptanceTests.map((t) => t.assertion),
      difficulty,
      tokenBudget: estimate.tokens,
      secondsBudget: estimate.seconds,
      modelRoute: modelRouteFor(story.routing),
      labels: [story.slice, `route:${story.routing}`],
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
      // A card created parked carries its reason (kernel rule 27, K-S4-9).
      ...(blockedReason ? { blockedReason } : {}),
    };
    await store.createCard(input, actor);
    createdIds.add(id);
    result.created.push({
      id,
      title: story.card.title,
      status,
      difficulty,
      routing: story.routing,
      estimate,
    });

    const notes: string[] = [];
    const impact = options.repoRoot
      ? await analyzeImpact(options.repoRoot, story.card.scopeFiles).catch(() => undefined)
      : undefined;
    if (story.routing === "edit_sketch" && options.sketcher) {
      const r = await sketchWithModel(options.sketcher, story, {
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        ...(impact ? { blastRadius: impact.blastRadius } : {}),
      });
      result.sketches.push({
        id,
        source: r.source,
        ...(r.rejected ? { rejected: r.rejected } : {}),
      });
      notes.push(formatEditSketch(r.sketch));
    } else if (story.editSketch) {
      notes.push(
        formatEditSketch(
          impact
            ? {
                ...story.editSketch,
                blastRadius: [
                  ...new Set([...story.editSketch.blastRadius, ...impact.blastRadius]),
                ].sort(),
              }
            : story.editSketch,
        ),
      );
    }
    if (impact && impact.blastRadius.length > 0) {
      notes.push(
        `Impact: a change here can break ${impact.blastRadius.join(", ")}${impact.tests.length ? `; run ${impact.tests.join(", ")}` : ""}.`,
      );
    }
    if (story.acceptanceTests.length > 0) {
      notes.push(
        `Acceptance tests to write first (they must fail before the change): ${story.acceptanceTests
          .map((t) => `${t.filePath}: ${t.assertion}`)
          .join("; ")}`,
      );
    }
    if (plan.ambiguity.assumptions.length > 0) {
      notes.push(
        `Planner assumptions (tell the team if one is wrong): ${plan.ambiguity.assumptions
          .map((a) => a.statement)
          .join(" ")}`,
      );
    }
    notes.push(
      `Estimate: ${estimate.tokens} tokens (${estimate.tokensRange[0]}-${estimate.tokensRange[1]}), ${estimate.seconds}s, basis ${estimate.basis.kind} (${estimate.basis.samples} samples of ${estimate.basis.cardClass}).`,
    );
    for (const text of notes) {
      await store.recordDossierEntry({ cardId: id, kind: "note", text, actor: "planner" });
    }
  }

  // Assumptions are logged on the epic, one event each (P8, feeds P15).
  for (const a of plan.ambiguity.assumptions) {
    await appendPlannerEvent(
      ledger,
      ASSUMPTION_EVENTS.logged,
      { ...a, cardId: options.epicId },
      { cardId: (await store.getCard(options.epicId)) ? options.epicId : undefined },
    );
  }

  const previous = await ledger.log.getEventsByTypes(["plan/created"]);
  result.version =
    previous.filter((e) => (e.payload as { epicId?: string }).epicId === options.epicId).length + 1;
  await appendPlannerEvent(
    ledger,
    "plan/created",
    {
      epicId: options.epicId,
      version: result.version,
      source: plan.source,
      stories: plan.stories.map((s) => ({
        id: s.card.id,
        title: s.card.title,
        slice: s.slice,
        scopeFiles: s.card.scopeFiles,
        difficulty: s.difficulty.value,
        routing: s.routing,
        dependsOn: s.dependsOn,
      })),
      rejected: result.rejected.map((r) => r.id),
      invest: { passed: invest.passed, checks: invest.checks.map((c) => [c.check, c.passed]) },
    },
    { cardId: (await store.getCard(options.epicId)) ? options.epicId : undefined },
  );

  return result;
}

/** One line per story and every INVEST check, for `sekhemet plan` (P2: shown). */
export function formatPlanReport(result: PersistPlanResult): string {
  const lines = [
    `Plan v${result.version}: ${result.created.length} cards created, ${result.rejected.length} rejected, ${result.parked.length} parked.`,
  ];
  for (const c of result.created) {
    lines.push(
      `  [${c.status}] ${c.id}: ${c.title} (difficulty ${c.difficulty}, ${c.routing}, ~${c.estimate.tokens} tokens, ${c.estimate.basis.kind})`,
    );
  }
  for (const r of result.rejected) lines.push(`  [rejected] ${r.id}: ${r.title} - ${r.reason}`);
  for (const s of result.serialized) {
    lines.push(`  [serialized] ${s.id} after active ${s.after} (shares ${s.files.join(", ")})`);
  }
  lines.push("INVEST pre-flight:");
  for (const check of result.invest.checks) {
    lines.push(`  ${check.passed ? "pass" : "FAIL"} ${check.check}: ${check.detail}`);
  }
  if (result.decisionId) {
    lines.push(
      `Decision ${result.decisionId} is waiting on you; the new cards stay in Planning until it is answered.`,
    );
  }
  return lines.join("\n");
}

export type { CardRecord };
