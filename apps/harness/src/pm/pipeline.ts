import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import type {
  CardKind,
  CardRecord,
  CardStatus,
  CardStore,
  DepthProfile,
  EventLog,
} from "@sekhemet/kernel";
import { parseDepthProfile } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import {
  ASSUMPTION_EVENTS,
  BRIEF_ACCEPTED,
  DEFAULT_MAX_SPLIT_DEPTH,
  DecisionStore,
  type DesignStageResult,
  MAX_OPEN_QUESTIONS_PER_PASS,
  type PersistPlanResult,
  type SettledAnswer,
  type SettledSource,
  type StackLanguage,
  acceptBrief,
  appendPlannerEvent,
  briefSources,
  contentWords,
  deriveCapabilities,
  designStage,
  estimatePoints,
  formatPlanReport,
  persistPlan,
  playbookSources,
  postDesignQuestion,
  recordDepthChoice,
  renderBrief,
  sameWord,
  sentenceCase,
  settleDesignQuestions,
} from "@sekhemet/planner";
import {
  CARD_ONE_LABEL,
  CARD_ZERO_LABEL,
  type CardFields,
  cardOneCard,
  cardZeroCard,
  generatorFor,
  installScaffoldGate,
  recordGeneratorInBrief,
} from "../card_zero.js";
import { LearningStore } from "../learning/store.js";
import { blockLines, isHeading, markdownBlocks } from "../markdown.js";
import { type Kernel, isGreenfield, planCommand, repoPlanner } from "../wave2.js";
import { flowMetrics, monteCarloForecast } from "./metrics.js";
import { NEW_PROJECT_REFUSAL } from "./pm_copy.js";

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
    slices?: Record<string, unknown>[];
    /** The Planner's model; without slices or one, the heuristic plans and says so. */
    adapter?: LocalInferenceAdapter;
    riskiest?: string;
  },
): Promise<PipelineOutcome> {
  const planner = await repoPlanner(
    kernelOf(deps),
    input.slices ? sliceReplyAdapter(input.slices) : input.adapter,
  );
  const plan = await planner.decomposeSpec({
    parentId: input.epicId,
    parentTier: "epic",
    spec: input.spec,
    // PM-P2-6: a question already answered is not asked again.
    settled: await settledSourcesFor(deps),
    ...(input.riskiest ? { riskiest: input.riskiest } : {}),
  });
  if (plan.rejected) {
    throw new PipelineRefusal(
      `The Planning model refused it: ${plan.rejectionReason ?? "the spec leaves too many open questions"}. Say more about it and ask again.`,
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
    throw new PipelineRefusal(`The Planning model created no issue${why ? ` (${why})` : ""}.`);
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
      `${parent.title} is ${parent.status.replace("_", " ")}; an issue is split before it runs or after it stops.`,
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
  const reason = `Split into ${outcome.cards.length} issues: ${outcome.cards.map((c) => c.id).join(", ")}`;
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
    // PM-P2-2: a person's /plan or bare-brief start_project is theirs.
    ...(deps.actor ? { actor: deps.actor } : {}),
    ...(deps.principal ? { principal: deps.principal } : {}),
    print: (l) => lines.push(l),
  });
  return { report: lines.join("\n"), epicId: r.epicId, created: r.created };
}

/**
 * Every answer already recorded (planner-pm §2.10.1, PM-P2-6): earlier
 * decisions' answers, the brief (the design stage's and the exported one),
 * and the playbook's approved (active) rules. A question one of them answers
 * is not asked again; its answer is the assumption, with its source.
 */
/**
 * The brief a person accepted, from the ledger (PM-P13-1): the latest
 * `brief/accepted` — its baseline and the titles and criteria of the
 * requirements it named. A brief in the working tree nobody accepted (a
 * draft, a file an agent wrote) settles nothing. None when no brief was
 * accepted, or its private part was erased.
 */
async function acceptedBriefSources(
  deps: Pick<PipelineDeps, "cardStore" | "log">,
): Promise<SettledSource[]> {
  const e = (await deps.log.getEventsByTypes([BRIEF_ACCEPTED]).catch(() => [])).at(-1);
  if (!e) return [];
  const ids = new Set((e.payload as { requirementIds?: string[] }).requirementIds ?? []);
  const requirements = (await deps.cardStore.requirements.list().catch(() => [])).filter((r) =>
    ids.has(r.id),
  );
  const baseline = e.private?.baseline;
  const text = [
    typeof baseline === "string" ? baseline : "",
    ...requirements.flatMap((r) => [r.title, ...r.criteria.map((c) => c.text)]),
  ]
    .filter((l): l is string => typeof l === "string" && l.trim() !== "")
    .join("\n\n");
  return briefSources(text, `accepted at ledger seq ${e.seq}`);
}

export async function settledSourcesFor(
  deps: Pick<PipelineDeps, "repoPath" | "cardStore" | "log">,
): Promise<SettledSource[]> {
  const decisions = await new DecisionStore({ store: deps.cardStore, log: deps.log })
    .settledSources()
    .catch(() => []);
  const briefs = await acceptedBriefSources(deps);
  const rules = (await new LearningStore(deps.log).rules().catch(() => []))
    .filter((r) => r.status === "active")
    .map((r) => ({ id: r.id, text: r.text }));
  return [...decisions, ...briefs, ...playbookSources(rules)];
}

// --- Starting a project by conversation (planner-pm §2.9, design-stage §2.9) ---

export type MoscowPriority = "must" | "should" | "could";

/** One candidate of a new project's plan, listed under its priority (DS-P2-7). */
export interface ProjectCandidate {
  key: string;
  title: string;
  priority: MoscowPriority;
  /**
   * `request`: the person's own words, accepted as said; `walkthrough`: a
   * step of the story map no capability covers, a proposal until a person
   * accepts it (design-stage §2.8, DS-P14-6).
   */
  source: "request" | "walkthrough";
  accepted: boolean;
}

export interface ProjectRelease {
  name: string;
  /** Candidate keys it holds. */
  candidates: string[];
  /** Cards it is expected to take: its planned cards, or one per candidate. */
  cards: number;
  /** Days, from the project's throughput; absent means *Not enough history yet*. */
  forecast?: { p50Days: number; p85Days: number; samples: number };
}

export interface ProjectQuestion {
  question: string;
  default: string;
  answers: string[];
}

/**
 * The proposal group of a new project (planner-pm §2.9, PM-P2-1): computed,
 * never written, until a person applies it. It carries what *Review plan*
 * shows (design-stage §2.9 item 6, DS-P2-6) and what apply creates.
 */
export interface ProjectGroup {
  version: 1;
  /** The person's sentence. */
  sentence: string;
  buildSpec: string;
  /** The brief under the headings Review plan uses. */
  brief: {
    problem: string[];
    outcome: string[];
    users: string[];
    notInScope: string[];
    constraints: string[];
    priorArt: string[];
    riskiest: string[];
    doneMeans: string[];
  };
  /** The Type proposed, with its reason (DS-P2-7); a person may change it. */
  type: { profile: DepthProfile; reason: string };
  stack: { language: StackLanguage; name: string; stated: boolean };
  /** The generator card zero runs (DS-P2-1, -2). */
  generator: string;
  epics: { title: string; mechanism?: string }[];
  /** The first slice's cards, with their criteria and points. */
  cards: { title: string; criteria: string[]; points: number }[];
  /** The requirements the plan proposes (planner-pm §2.15). */
  requirements: { key: string; title: string; mustHave: boolean }[];
  candidates: ProjectCandidate[];
  /** How many of `candidates`, in order, the first release holds. */
  releaseLine: number;
  releases: ProjectRelease[];
  /** At most two (DS-P2-7, PM-P2-3). */
  questions: ProjectQuestion[];
  /** Every default in force, and every question not asked. */
  assumptions: string[];
  /** Questions not asked because their answer is recorded (PM-P2-6). */
  settled: SettledAnswer[];
  cardZero: CardFields;
  cardOne: CardFields & { reason: string };
  /** What approval creates, counted; before it, nothing exists. */
  creates: { project: number; epics: number; issues: number; brief: number; cardZero: number };
}

/** A person's choices on Review plan, sent with Create project (DS-P2-7). */
export interface ProjectChoices {
  /** Candidate keys accepted (a walkthrough candidate enters only when accepted). */
  accept?: string[];
  /** Candidate keys removed. */
  remove?: string[];
  /** Where the release line sits: how many of the kept candidates the first release holds. */
  releaseLine?: number;
  /** The Type, when the person changed it. */
  type?: string;
  /** Answers by question index: the index of the answer chosen. */
  answers?: Record<string, number>;
}

/** Each `## ` section's lines, a list item per line (DEC-44: read as Markdown). */
const sectionsOf = (markdown: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let at: string | undefined;
  for (const block of markdownBlocks(markdown)) {
    if (isHeading(block)) {
      if (block.depth === 2) {
        at = block.text.trim();
        out.set(at, []);
      }
      continue;
    }
    if (at) out.get(at)?.push(...blockLines(block));
  }
  return out;
};

const keyOf = (text: string) =>
  `c_${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 8)}`;

/** The candidates in order: Must, Should, Could (DS-P2-7). */
function candidatesOf(design: DesignStageResult): ProjectCandidate[] {
  const first = new Set(deriveCapabilities(design.firstSlice).map((c) => c.text.toLowerCase()));
  const all = deriveCapabilities(design.buildSpec).map((c) => c.text.trim());
  const out: ProjectCandidate[] = [];
  for (const text of all) {
    const title = sentenceCase(text.replace(/[.;:]+$/, ""));
    if (out.some((c) => c.title === title)) continue;
    out.push({
      key: keyOf(title),
      title,
      priority: first.has(text.toLowerCase()) ? "must" : "should",
      source: "request",
      accepted: true,
    });
  }
  // A step a user role takes that no capability covers (DS-P14-7).
  for (const a of design.actions) {
    const words = contentWords(a.text);
    const covered = out.some((c) => {
      const cw = contentWords(c.title);
      return words.length > 0 && words.every((w) => cw.some((x) => sameWord(w, x)));
    });
    if (covered) continue;
    const title = sentenceCase(`${a.role ? `${a.role} can ` : ""}${a.text}`);
    out.push({
      key: keyOf(title),
      title,
      priority: "could",
      source: "walkthrough",
      accepted: false,
    });
  }
  const rank = { must: 0, should: 1, could: 2 } as const;
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Releases either side of the line, each with its forecast or none. */
async function releasesOf(
  log: EventLog,
  candidates: readonly ProjectCandidate[],
  line: number,
  firstCards: number,
): Promise<ProjectRelease[]> {
  const kept = candidates.filter((c) => c.accepted);
  const above = kept.slice(0, line);
  const below = kept.slice(line);
  const cfd = (await flowMetrics(log, 60).catch(() => ({ cfd: [] }))).cfd;
  const daily = cfd.map((d, i) => (i === 0 ? 0 : Math.max(0, d.done - (cfd[i - 1]?.done ?? 0))));
  const release = (name: string, holds: ProjectCandidate[], cards: number, before: number) => {
    const forecast = monteCarloForecast(daily.slice(1), before + cards);
    return {
      name,
      candidates: holds.map((c) => c.key),
      cards,
      ...(forecast ? { forecast } : {}),
    };
  };
  // The first release: card zero, card one and the first slice's cards, and
  // one card for each further candidate it holds.
  const musts = above.filter((c) => c.priority === "must").length;
  const first = 2 + firstCards + Math.max(0, above.length - musts);
  const out = [release("Release 1", above, first, 0)];
  if (below.length) out.push(release("Release 2", below, below.length, first));
  return out;
}

/**
 * A new project's proposal group (planner-pm §2.9 item 1, PM-P2-1): the
 * design stage on the person's sentence, the plan of its first slice through
 * the one planner — epics, cards with criteria and points — the proposed
 * requirements, the candidates by priority with a release line, card zero
 * and card one, at most two questions, and the count of what approval
 * creates. Nothing is written: no card, no requirement, no brief, no event.
 */
export async function draftProjectGroup(
  deps: Pick<PipelineDeps, "repoPath" | "cardStore" | "log">,
  sentence: string,
  options: { adapter?: LocalInferenceAdapter } = {},
): Promise<ProjectGroup> {
  // A project that does not exist yet (design-stage §2.4).
  const design = designStage(sentence, { greenfield: true });
  const settledFrom = await settledSourcesFor(deps);
  const designQs = settleDesignQuestions(design.questions, settledFrom);
  const planner = await repoPlanner(
    { repoPath: deps.repoPath, cardStore: deps.cardStore, log: deps.log },
    options.adapter,
  );
  const plan = await planner.decomposeSpec({
    parentId: "epic_draft",
    parentTier: "epic",
    spec: design.buildSpec,
    settled: settledFrom,
    ...(design.riskiest ? { riskiest: design.riskiest } : {}),
  });
  // At most two questions in all (PM-P2-3, DS-P2-7): the design stage's
  // first, then the planner's; every other takes its default.
  const asked: ProjectQuestion[] = [
    ...designQs.ask.map((q) => ({
      question: q.question,
      default: q.default,
      answers: q.answers.map((a) => a.answer),
    })),
    ...(plan.ambiguity.batch?.requests ?? []).map((r) => ({
      question: r.question,
      default:
        r.options[r.defaultIfNoAnswer.optionIndex ?? r.recommendation.optionIndex]?.label ??
        r.options[0]?.label ??
        "",
      answers: r.options.map((o) => o.label),
    })),
  ];
  const questions = asked.slice(0, MAX_OPEN_QUESTIONS_PER_PASS);
  const settled = [...designQs.settled, ...(plan.ambiguity.settled ?? [])];
  const assumptions = [
    ...design.assumptions,
    ...asked.slice(MAX_OPEN_QUESTIONS_PER_PASS).map((q) => `${q.question} ${q.default}.`),
    ...plan.ambiguity.assumptions.map((a) => a.statement),
    ...settled.map((s) => `${s.question} ${s.answer} (settled by ${s.source} ${s.ref}).`),
  ].filter((a, i, all) => all.indexOf(a) === i);

  const stack = design.stack.language;
  const g = generatorFor(stack);
  const profile = design.depth ?? { profile: "internal tool" as DepthProfile, reason: "" };
  const briefMd = renderBrief(design, { gates: [`the checks derived from ${g.name}`] });
  const sec = sectionsOf(briefMd);
  const candidates = candidatesOf(design);
  const releaseLine = candidates.filter((c) => c.accepted && c.priority !== "could").length;
  const cards = plan.stories.map((s) => ({
    title: s.card.title,
    criteria: s.acceptanceTests.map((t) => t.assertion),
    points: estimatePoints(s.difficulty.value, []).points,
  }));
  const epics = [
    { title: design.buildSpec },
    ...plan.epics.map((e) => ({ title: e.title, mechanism: e.mechanism })),
  ];
  return {
    version: 1,
    sentence,
    buildSpec: design.buildSpec,
    brief: {
      problem: sec.get("Problem") ?? [],
      outcome: sec.get("Outcome") ?? [],
      users: design.who.length ? design.who : design.roles,
      notInScope: sec.get("Non-goals") ?? [],
      constraints: [...(sec.get("Constraints") ?? []), `Generator: ${g.name}`],
      priorArt: sec.get("Prior art") ?? [],
      riskiest: sec.get("Riskiest assumption") ?? [],
      doneMeans: sec.get("Definition of done") ?? [],
    },
    type: { profile: profile.profile, reason: profile.reason },
    stack: { language: stack, name: design.stack.name, stated: design.stack.stated },
    generator: g.name,
    epics,
    cards,
    requirements: candidates
      .filter((c) => c.source === "request")
      .map((c) => ({ key: c.key, title: c.title, mustHave: c.priority === "must" })),
    candidates,
    releaseLine,
    releases: await releasesOf(deps.log, candidates, releaseLine, cards.length),
    questions,
    assumptions,
    settled,
    cardZero: cardZeroCard(stack),
    cardOne: cardOneCard(design, stack),
    creates: {
      project: 1,
      epics: epics.length,
      issues: cards.length + 2,
      brief: 1,
      cardZero: 1,
    },
  };
}

/** The group as a proposal's patch carries it back, checked. */
export function projectGroupOf(
  patch: Record<string, unknown> | undefined,
): ProjectGroup | undefined {
  const g = patch?.group as ProjectGroup | undefined;
  return g && g.version === 1 && typeof g.sentence === "string" && Array.isArray(g.candidates)
    ? g
    : undefined;
}

/**
 * A new project's group is applied only where there is no project yet
 * (PM-P2-2): a repository whose tracked files hold code, or whose project
 * already has an accepted brief or a card, is refused with what to do
 * instead. Nothing is written.
 */
async function refuseUnlessNewFolder(deps: Pick<PipelineDeps, "repoPath" | "cardStore" | "log">) {
  if (!isGreenfield(deps.repoPath)) {
    throw new PipelineRefusal(NEW_PROJECT_REFUSAL.hasCode);
  }
  let root = deps.repoPath;
  try {
    root = realpathSync(deps.repoPath);
  } catch {
    // A folder that does not exist yet has no project.
  }
  const project = deps.cardStore
    .listProjects()
    .find((p) => p.rootPath === root || p.rootPath === deps.repoPath);
  // This folder's project's, and every card or brief no project claims: the
  // ledger is the folder's, so a card recorded before any project was (an
  // imported issue, a card made at the terminal) is this folder's work too.
  const ours = (projectId: string | null | undefined) =>
    projectId === undefined || projectId === null || projectId === project?.id;
  const briefs = (await deps.log.getEventsByTypes([BRIEF_ACCEPTED])).filter((e) =>
    ours((e.payload as { projectId?: string }).projectId),
  );
  const cards = (await deps.cardStore.listCards()).filter((c) => ours(c.projectId));
  if (briefs.length > 0 || cards.length > 0) {
    throw new PipelineRefusal(
      NEW_PROJECT_REFUSAL.hasProject(
        project?.name ?? basename(root),
        briefs.length > 0
          ? NEW_PROJECT_REFUSAL.acceptedBrief
          : NEW_PROJECT_REFUSAL.cards(cards.length),
      ),
    );
  }
}

/**
 * Apply a new project's group (planner-pm §2.9 item 2, PM-P2-2): with the
 * person as actor, the project and its brief — the releases as its slices,
 * the kept candidates as its requirements (PM-P13-1) —, the Type the person
 * chose (DS-P14-1), the questions' answers as decisions and every unanswered
 * one as an assumption with its default (DS-P2-7), the first release planned
 * through the one planner (`planCommand`), card zero with its gate and card
 * one after it, and every planned card waiting on card one. No terminal
 * command is needed at any step.
 */
export async function applyProjectGroup(
  deps: PipelineDeps & { adapter?: LocalInferenceAdapter },
  group: ProjectGroup,
  choices: ProjectChoices = {},
): Promise<{ epicId: string; cards: CardRecord[]; report: string }> {
  const actor = deps.actor ?? "human";
  const principal = deps.principal ?? deps.cardStore.localPrincipal();
  const ledger = { store: deps.cardStore, log: deps.log };
  const removed = new Set(choices.remove ?? []);
  const accepted = new Set(choices.accept ?? []);
  const kept = group.candidates.filter(
    (c) => !removed.has(c.key) && (c.accepted || accepted.has(c.key)),
  );
  if (kept.length === 0)
    throw new PipelineRefusal("Nothing is left to plan: every candidate was removed.");
  const line = Math.max(1, Math.min(kept.length, choices.releaseLine ?? group.releaseLine));
  const first = kept.slice(0, line);
  const later = kept.slice(line);

  // A new project only (planner-pm §2.9 item 2): before any write, a folder
  // that already holds code, an accepted brief or cards is refused, so
  // neither its brief's baseline is replaced nor card zero's generator run
  // over its code.
  await refuseUnlessNewFolder(deps);
  // The Type the person chose (DS-P14-1): one of the profiles, never
  // replaced silently by the proposed one.
  const chosen = choices.type !== undefined ? parseDepthProfile(choices.type) : undefined;
  if (choices.type !== undefined && !chosen)
    throw new PipelineRefusal(NEW_PROJECT_REFUSAL.notAType(choices.type));
  const name = group.buildSpec.slice(0, 80);
  const project = await deps.cardStore.ensureProject({ rootPath: deps.repoPath, name });
  const profile = chosen ?? group.type.profile;
  const before = deps.cardStore.depthProfiles.of(project.id);
  if (!before.recorded || (chosen && chosen !== before.profile)) {
    await recordDepthChoice(
      ledger,
      { profile, projectId: project.id, proposal: group.type },
      principal,
    );
  }
  const requirement = (c: ProjectCandidate) => ({
    key: c.key,
    title: c.title,
    mustHave: c.priority === "must",
  });
  await acceptBrief(
    ledger,
    {
      projectId: project.id,
      baseline: `Nothing yet: a new project, asked for as "${group.sentence}"`,
      slices: [
        {
          title: "Release 1",
          appetite: { cards: 2 + group.cards.length + first.length },
          requirements: first.map(requirement),
        },
        ...(later.length
          ? [
              {
                title: "Release 2",
                appetite: { cards: later.length },
                requirements: later.map(requirement),
              },
            ]
          : []),
      ],
    },
    principal,
  );

  // The brief, never over one a person wrote, with the generator card zero runs.
  const briefPath = join(deps.repoPath, ".sekhemet", "brief.md");
  if (!existsSync(briefPath)) {
    const design = designStage(group.sentence, { greenfield: true });
    mkdirSync(dirname(briefPath), { recursive: true });
    writeFileSync(
      briefPath,
      renderBrief(design, { gates: [`the checks derived from ${group.generator}`] }),
    );
  }
  recordGeneratorInBrief(
    briefPath,
    `${group.generator} (its version is recorded when the setup issue is done)`,
  );
  installScaffoldGate(deps.repoPath, group.stack.language);

  // The first release through the one planner — decompose, INVEST, the
  // criterion lint, scope, a staged test, persist — the person the actor.
  const spec = first.map((c) => c.title).join(". ");
  const epicId = await epicFor(deps, { title: group.buildSpec, spec, projectId: project.id });
  const planned = await planSlices(deps, {
    epicId,
    spec,
    ...(deps.adapter ? { adapter: deps.adapter } : {}),
    ...(group.brief.riskiest[0] && !/^None/.test(group.brief.riskiest[0])
      ? { riskiest: group.brief.riskiest[0] }
      : {}),
  });

  // DS-P2-7: each question answered is a decision with its answer; each
  // unanswered one is an assumption with its default.
  for (const [i, q] of group.questions.entries()) {
    const answer = choices.answers?.[String(i)];
    if (answer !== undefined && q.answers[answer] !== undefined) {
      const id = await postDesignQuestion(ledger, {
        cardId: epicId,
        question: {
          question: q.question,
          default: q.default,
          answers: q.answers.map((a) => ({ answer: a, cards: [] })),
        },
        spec: group.sentence,
      });
      const d = await new DecisionStore(ledger).get(id);
      if (d?.state === "pending")
        await new DecisionStore(ledger).answer(id, answer, actor, principal);
      continue;
    }
    await appendPlannerEvent(
      ledger,
      ASSUMPTION_EVENTS.logged,
      {
        id: `asm_start_${createHash("sha256").update(`${epicId}:${q.question}`).digest("hex").slice(0, 10)}`,
        cardId: epicId,
        category: "vagueness",
        statement: `${q.question} ${q.default}.`,
        basis: "Not answered when the project was created: its default",
        excerpt: group.sentence.slice(0, 120),
        createdAt: new Date().toISOString(),
      },
      { cardId: epicId },
    );
  }

  // Card zero, then card one after it; every planned card waits on card one.
  const planCards = (await deps.cardStore.listCards({ parentId: epicId })).filter(
    (c) => c.tier !== "epic",
  );
  const { reason: _reason, ...oneFields } = group.cardOne;
  const zero = await deps.cardStore.createCard(
    { ...group.cardZero, tier: "task", status: "ready", parentId: epicId, projectId: project.id },
    actor,
  );
  const one = await deps.cardStore.createCard(
    {
      ...oneFields,
      tier: "task",
      status: "backlog",
      parentId: epicId,
      projectId: project.id,
      dependsOn: [zero.id],
    },
    actor,
  );
  for (const c of planCards) {
    if (c.labels?.includes(CARD_ZERO_LABEL) || c.labels?.includes(CARD_ONE_LABEL)) continue;
    await deps.cardStore.addDependency(c.id, one.id, "declared", actor);
  }
  const cards: CardRecord[] = [];
  for (const c of [zero, one, ...planCards]) cards.push((await deps.cardStore.getCard(c.id)) ?? c);
  return { epicId, cards, report: formatPlanReport(planned.result) };
}
