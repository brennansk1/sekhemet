import { createHash } from "node:crypto";
import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import type { CardKind, CardRecord, CardStatus, CardStore, EventLog } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import {
  DEFAULT_MAX_SPLIT_DEPTH,
  type PersistPlanResult,
  contentWords,
  persistPlan,
  sameWord,
} from "@sekhemet/planner";
import { type Kernel, planCommand, repoPlanner } from "../wave2.js";

/**
 * One planning pipeline for every card Seshat produces (planner-pm §2.1.1,
 * PM-P1-1): `/plan`, `start_project`, `propose_create_card` and
 * `propose_split_card` all reach the board through the planner — INVEST,
 * the criterion lint, scope validation and a staged acceptance test — and
 * never through a bare `createCard`.
 *
 * A card Seshat wrote is Seshat's model's slice (Seshat runs on the Planner
 * role's model, §2.8.1): it is handed to the planner as that model's slice
 * reply, so the planner re-costs it, lints its criteria, bounds its scope,
 * splits it when INVEST says so and stages its test, exactly as it does a
 * slice the Planner wrote for `sekhemet plan`.
 */

export interface PipelineDeps {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
  boardService?: Pick<BoardService, "transitionCard">;
  /** Who acts on the ledger ("human" for an applied proposal). */
  actor?: string;
  /** The person the planned work is for (PM-P13-2). */
  principal?: string;
}

/** A card as Seshat drafted it (a proposal's `cards[]` entry). */
export type CardDraft = Record<string, unknown>;

/** The slice kind a stored card kind was planned from (DEC-26, the inverse of persist's map). */
const SLICE_OF_KIND: Partial<Record<CardKind, string>> = {
  spike: "spike",
  interface: "interface",
  data: "data",
  implement: "path",
  rule: "rule",
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

function sliceOf(draft: CardDraft, fallbackKind: string): Record<string, unknown> {
  const title = String(draft.title ?? "").trim();
  const criteria = strings(draft.acceptanceCriteria);
  const behaviour = typeof draft.spec === "string" ? draft.spec.trim() : "";
  return {
    kind: typeof draft.slice === "string" ? draft.slice : fallbackKind,
    title,
    keywords: contentWords(title),
    rationale: behaviour || title,
    ...(criteria.length > 0 ? { criteria: criteria.map((text) => ({ text })) } : {}),
    ...(behaviour ? { behaviour } : {}),
    ...(Array.isArray(draft.interface) ? { interface: draft.interface } : {}),
  };
}

/**
 * The Planner's model reply that carries exactly Seshat's slices: the
 * planner parses it like any model reply (PM-P1-4) and plans from it.
 */
export function sliceReplyAdapter(slices: Record<string, unknown>[]): LocalInferenceAdapter {
  const text = JSON.stringify({ slices });
  return {
    modelId: "seshat-slices",
    supportedArms: ["arm_a_flat"],
    async generate() {
      return {
        text,
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      };
    },
  };
}

const kernelOf = (d: PipelineDeps): Kernel => ({
  repoPath: d.repoPath,
  cardStore: d.cardStore,
  log: d.log,
  ...(d.boardService ? { boardService: d.boardService } : {}),
});

/** An epic to plan under: the card's own, else one made for this plan (as `sekhemet plan` makes one). */
async function epicFor(
  deps: PipelineDeps,
  input: {
    epicId?: string | undefined;
    title: string;
    spec: string;
    projectId?: string | undefined;
  },
): Promise<string> {
  if (input.epicId && (await deps.cardStore.getCard(input.epicId))) return input.epicId;
  const id = `epic_${createHash("sha256")
    .update(`${input.title}\n${input.spec}\n${Date.now()}`)
    .digest("hex")
    .slice(0, 10)}`;
  await deps.cardStore.createCard(
    {
      id,
      tier: "epic",
      title: input.title,
      spec: input.spec,
      status: "in_progress",
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    deps.actor ?? "planner",
  );
  return id;
}

export interface PipelineOutcome {
  result: PersistPlanResult;
  cards: CardRecord[];
  epicId: string;
}

/** Why a plan created nothing, for the person applying it. */
export class PipelineRefusal extends Error {}

async function planSlices(
  deps: PipelineDeps,
  input: {
    epicId: string;
    spec: string;
    slices: Record<string, unknown>[];
  },
): Promise<PipelineOutcome> {
  const planner = await repoPlanner(kernelOf(deps), sliceReplyAdapter(input.slices));
  const plan = await planner.decomposeSpec({
    parentId: input.epicId,
    parentTier: "epic",
    spec: input.spec,
  });
  if (plan.rejected) {
    throw new PipelineRefusal(
      `The planner refused it: ${plan.rejectionReason ?? "the spec leaves too many open questions"}. Say more about it and ask again.`,
    );
  }
  const result = await persistPlan(
    {
      store: deps.cardStore,
      log: deps.log,
      ...(deps.boardService ? { board: deps.boardService } : {}),
    },
    plan,
    {
      epicId: input.epicId,
      repoRoot: deps.repoPath,
      ...(deps.actor ? { actor: deps.actor } : {}),
      ...(deps.principal ? { principal: deps.principal } : {}),
    },
  );
  const cards: CardRecord[] = [];
  for (const c of result.created) {
    const card = await deps.cardStore.getCard(c.id);
    if (card) cards.push(card);
  }
  if (cards.length === 0) {
    const why = result.rejected.map((r) => `${r.title}: ${r.reason}`).join("; ");
    throw new PipelineRefusal(`The planner created no card${why ? ` (${why})` : ""}.`);
  }
  return { result, cards, epicId: input.epicId };
}

/**
 * `propose_create_card`, applied (PM-P1-1): each drafted card through the
 * planner as Seshat's slice. A card the checks hold waits in Planning with
 * the reason; one they refuse is not created.
 */
export async function createThroughPipeline(
  deps: PipelineDeps,
  drafts: CardDraft[],
): Promise<PipelineOutcome[]> {
  const out: PipelineOutcome[] = [];
  for (const draft of drafts) {
    const title = String(draft.title ?? "").trim();
    const spec = [
      title,
      typeof draft.spec === "string" ? draft.spec : "",
      ...strings(draft.acceptanceCriteria).map((c) => `- ${c}`),
    ].join("\n");
    const epicId = await epicFor(deps, {
      epicId: typeof draft.epicId === "string" ? draft.epicId : undefined,
      title,
      spec,
      projectId: typeof draft.projectId === "string" ? draft.projectId : undefined,
    });
    out.push(await planSlices(deps, { epicId, spec, slices: [sliceOf(draft, "path")] }));
  }
  return out;
}

/**
 * Each of the parent's criteria goes to the one part whose words it shares
 * most (the planner's own rule for a split, `splitStory`, PM-P1-7): a part
 * keeps its own behaviour and only the tests that exercise it. A criterion
 * that shares a word with no part cannot be placed by that rule, so it is
 * never dropped silently: the split is refused, naming the criterion, so a
 * person rewords the parts or the criterion instead of losing coverage.
 */
export function criteriaForParts(
  parent: Pick<CardRecord, "acceptanceCriteria">,
  parts: CardDraft[],
): string[][] {
  const own = parts.map((p) => strings(p.acceptanceCriteria));
  const words = parts.map((p) => contentWords(`${String(p.title ?? "")} ${String(p.spec ?? "")}`));
  const orphaned: string[] = [];
  for (const criterion of parent.acceptanceCriteria ?? []) {
    const cw = contentWords(criterion);
    const scores = words.map((ws) => ws.filter((w) => cw.some((c) => sameWord(c, w))).length);
    const best = Math.max(...scores);
    if (best === 0) {
      orphaned.push(criterion);
      continue;
    }
    const i = scores.indexOf(best);
    if (!own[i]?.includes(criterion)) own[i]?.push(criterion);
  }
  if (orphaned.length > 0) {
    throw new PipelineRefusal(
      `The split doesn't cover every criterion of the parent: ${orphaned.map((c) => `"${c}"`).join(", ")} shares no word with any part. Reword a part or the criterion, then split again.`,
    );
  }
  return own;
}

const OPEN: readonly CardStatus[] = ["backlog", "ready", "planning", "parked"];

/**
 * `propose_split_card`, applied (PM-P1-1, PM-P1-7): the parts are planned as
 * the parent's slices under the parent's epic, each with only the criteria
 * that are about it, and so only the staged tests that exercise them — never
 * the parent's test files. The parent moves to Rejected, "Split into N
 * cards", naming its parts; never to Parked.
 */
export async function splitThroughPipeline(
  deps: PipelineDeps,
  parent: CardRecord,
  parts: CardDraft[],
): Promise<PipelineOutcome> {
  // PM-P1-13: a lineage at the depth limit is held, never split again.
  if ((parent.splitDepth ?? 0) >= DEFAULT_MAX_SPLIT_DEPTH) {
    throw new PipelineRefusal(
      `${parent.title} is at split depth ${parent.splitDepth}; it is not split again. Name the one behaviour to ship first.`,
    );
  }
  if (!OPEN.includes(parent.status)) {
    throw new PipelineRefusal(
      `${parent.title} is ${parent.status.replace("_", " ")}; a card is split before it runs or after it stops.`,
    );
  }
  const own = criteriaForParts(parent, parts);
  const kind = SLICE_OF_KIND[parent.kind ?? "implement"] ?? "path";
  const epicId = await epicFor(deps, {
    epicId: parent.parentId ?? parent.epicId,
    title: parent.title,
    spec: parent.spec ?? parent.title,
    projectId: parent.projectId,
  });
  // The parts' own words are the spec's too, so each traces to what it builds (PM-P13-2).
  const spec = [
    parent.spec ?? parent.title,
    ...parts.map((p, i) =>
      [
        `${String(p.title ?? "")}: ${String(p.spec ?? "")}`,
        ...(own[i] ?? []).map((c) => `- ${c}`),
      ].join("\n"),
    ),
  ].join("\n\n");
  const outcome = await planSlices(deps, {
    epicId,
    spec,
    slices: parts.map((p, i) => sliceOf({ ...p, acceptanceCriteria: own[i] ?? [] }, kind)),
  });
  // PM-P1-13: the parts are one split deeper than the parent, siblings
  // under its parent; they wait on what it waited on, and run in order.
  let previous: string | undefined;
  for (const card of outcome.cards) {
    await deps.cardStore.updateCard(
      card.id,
      { splitDepth: (parent.splitDepth ?? 0) + 1 },
      deps.actor ?? "planner",
      deps.principal ? { principal: deps.principal } : {},
    );
    for (const dep of [...(parent.dependsOn ?? []), ...(previous ? [previous] : [])]) {
      if (!(card.dependsOn ?? []).includes(dep) && (await deps.cardStore.getCard(dep))) {
        await deps.cardStore.addDependency(card.id, dep, "declared", deps.actor ?? "planner");
      }
    }
    previous = card.id;
  }
  const board =
    deps.boardService ?? new BoardServiceImpl(deps.cardStore, { entryConditions: true });
  const reason = `Split into ${outcome.cards.length} cards: ${outcome.cards.map((c) => c.id).join(", ")}`;
  await board.transitionCard({
    cardId: parent.id,
    fromStatus: parent.status,
    toStatus: "rejected",
    actor: deps.actor ?? "human",
    reason,
  });
  await deps.cardStore.updateCard(
    parent.id,
    { blockedReason: reason },
    deps.actor ?? "human",
    deps.principal ? { principal: deps.principal } : {},
  );
  const cards: CardRecord[] = [];
  for (const c of outcome.cards) cards.push((await deps.cardStore.getCard(c.id)) ?? c);
  return { ...outcome, cards };
}

/**
 * `/plan` and `start_project` (PM-P1-1): the same `planCommand` as
 * `sekhemet plan` — the design stage, then decompose, validate, persist —
 * with the Planner's model when one is given, else the heuristic, whose
 * report says so in its first line (PM-P1-3). Returns the report.
 */
export async function planThroughPipeline(
  deps: PipelineDeps,
  spec: string,
  options: { adapter?: LocalInferenceAdapter } = {},
): Promise<{ report: string; epicId: string; created: number }> {
  const lines: string[] = [];
  const r = await planCommand(kernelOf(deps), spec, {
    ...(options.adapter ? { sketcher: options.adapter } : {}),
    print: (l) => lines.push(l),
  });
  return { report: lines.join("\n"), epicId: r.epicId, created: r.created };
}
