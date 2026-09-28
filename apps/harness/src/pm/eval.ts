import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clopperPearson,
  describeDetectable,
  exactMcNemar,
  minDetectableDifference,
  verifyAsset,
} from "@sekhemet/eval";
import { type CardRecord, type CardStatus, DEFAULT_STEP_BUDGET } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import {
  MAX_SCOPE_FILES,
  SPLIT_POINTS,
  containsLineByLineDictation,
  lintCriterion,
} from "@sekhemet/planner";
import { type PmSnapshot, answer } from "./agent.js";
import {
  type FailureFacts,
  type SnapshotAssumption,
  type SnapshotFinding,
  type SnapshotGoal,
  cardsNamed,
} from "./knowledge.js";
import { SESHAT_SKILL_VERSION } from "./seshat_skill.js";
import type { Cycle, PmCite, PmMessage } from "./types.js";
import { voiceProblems } from "./voice.js";

/**
 * The senior-PM skill's scripted-conversation evaluation (planner-pm
 * PM-P6-13, PM-N9-4; measurement rule 29, the asset `pm-conversations`).
 *
 * Twenty scripted conversations, each a board and one or two things a
 * person says, run through Seshat's own answer path (`answer`, the prompt,
 * tools and fitting the product uses) on the configured PM model. Every
 * reply is scored by a fixed rubric of deterministic checks — no model
 * judges another — and a conversation meets the rubric only when every
 * reply meets every item that applies to it. P6 passes when at least 16 of
 * the 20 meet it, on every run (one run at non-zero temperature is never a
 * finding, measurement rule 11).
 *
 * The rubric scores the reply as `answer` returns it, before the chat's
 * voice guard rewrites it (`voiceGuard`, applied when the reply is stored),
 * so the voice items measure the prompt, not the guard.
 */

/** The registered asset this evaluation scores against. */
export const PM_CONVERSATION_ASSET = "pm-conversations";
/** PM-P6-13: at least 16 of the 20 conversations meet every rubric item. */
export const PM_PASS_MIN = 16;
export const PM_CONVERSATIONS = 20;

/** A card as a conversation's board states it: the fields Seshat reads. */
export interface EvalCard {
  id: string;
  title: string;
  status: CardStatus;
  priority?: number;
  estimate?: number;
  stepsUsed?: number;
  stepBudget?: number;
  scopeFiles?: string[];
  labels?: string[];
  cycleId?: string;
  spec?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  blockedReason?: string;
  stopReason?: string;
  assignee?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The board a conversation is held over. */
export interface EvalBoard {
  project: string;
  today: string;
  cards: EvalCard[];
  cycles?: Cycle[];
  recentRuns?: string[];
  worker?: { model: string; record: string };
  forecast?: string;
  team?: string;
  preferences?: string[];
  pmRules?: string[];
  decisions?: string[];
  goals?: SnapshotGoal[];
  assumptions?: SnapshotAssumption[];
  findings?: SnapshotFinding[];
  failures?: FailureFacts[];
}

/** What a conversation's replies must show beyond the rubric every reply meets. */
export interface Expectations {
  /** A new small tool: planned at once, zero questions (PM-P6-13's calculator). */
  zeroQuestions?: boolean;
  /** A service that holds money or personal data starts from a brief (PM-P6-13's billing). */
  brief?: boolean;
  /** PM-P6-7: at least one item not at risk, with its reason. */
  notAtRisk?: boolean;
  /** PM-P6-8: the sprint's bet in points is at most this (85% of the last three sprints' mean). */
  maxBet?: number;
  /** PM-P6-9: a split of this issue, not a retry. */
  splitOf?: string;
  /** PM-P6-6: the failure's facts the reply names. */
  failure?: { stop: string; step: number; gate: string; at: string; evidence: string };
  /** When the evidence is missing, the reply says which. */
  saysMissing?: boolean;
  /** Words or keys the reply names. */
  mentions?: string[];
  /** Whether the reply proposes changes. */
  proposals?: "none" | "some";
  /** Plain words for a non-developer: no backticks, no internal codes (§2.8.9). */
  plain?: boolean;
  /** The reply cites a source; on by default when the board has issues. */
  cite?: boolean;
  /** The first sentence answers: it matches this pattern (case-insensitive). */
  answer?: string;
}

export interface PmConversation {
  id: string;
  title: string;
  /** A board by name from `boards.json`, or the board itself. */
  board: string | EvalBoard;
  /** Earlier turns, oldest first. */
  history?: { role: "user" | "pm"; text: string }[];
  /** What the person says, one reply each. */
  turns: string[];
  expect: Expectations;
  /** Replies that meet every item: the scorer's proof, never shown to the model. */
  exemplar?: { text: string; calls?: ToolCall[] }[];
}

export interface PmConversationSet {
  hash: string;
  version: string;
  conversations: PmConversation[];
  boards: Record<string, EvalBoard>;
}

const NOW = "2026-09-28T09:00:00.000Z";

/**
 * The snapshot Seshat answers from, built from the conversation's board.
 * Given the person's message, the failure evidence is limited to the issues
 * it names, as the product's `answerFor` limits it (PM-P6-6).
 */
export function evalSnapshot(
  board: EvalBoard,
  pmModel: string,
  opts: { asked?: string } = {},
): PmSnapshot {
  const cards: CardRecord[] = board.cards.map((c) => ({
    id: c.id,
    tier: "story",
    title: c.title,
    status: c.status,
    scopeFiles: c.scopeFiles ?? [],
    stepBudget: c.stepBudget ?? DEFAULT_STEP_BUDGET,
    stepsUsed: c.stepsUsed ?? 0,
    createdAt: c.createdAt ?? NOW,
    updatedAt: c.updatedAt ?? c.createdAt ?? NOW,
    ...(c.priority !== undefined ? { priority: c.priority } : {}),
    ...(c.estimate !== undefined ? { estimate: c.estimate } : {}),
    ...(c.labels ? { labels: c.labels } : {}),
    ...(c.cycleId ? { cycleId: c.cycleId } : {}),
    ...(c.spec ? { spec: c.spec } : {}),
    ...(c.acceptanceCriteria ? { acceptanceCriteria: c.acceptanceCriteria } : {}),
    ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}),
    ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}),
    ...(c.stopReason ? { stopReason: c.stopReason as CardRecord["stopReason"] } : {}),
    ...(c.assignee ? { assignee: c.assignee } : {}),
  })) as CardRecord[];
  const named =
    opts.asked === undefined ? undefined : new Set(cardsNamed(opts.asked, cards).map((c) => c.id));
  const failures = (board.failures ?? []).filter((f) => !named || named.has(f.cardId));
  return {
    project: board.project,
    cards,
    cycles: board.cycles ?? [],
    recentRuns: board.recentRuns ?? [],
    pmModel,
    today: board.today,
    ...(board.worker ? { worker: board.worker } : {}),
    ...(board.forecast ? { forecast: board.forecast } : {}),
    ...(board.team ? { team: board.team } : {}),
    ...(board.preferences ? { preferences: board.preferences } : {}),
    ...(board.pmRules ? { pmRules: board.pmRules } : {}),
    ...(board.decisions ? { decisions: board.decisions } : {}),
    ...(board.goals ? { goals: board.goals } : {}),
    ...(board.assumptions ? { assumptions: board.assumptions } : {}),
    ...(board.findings ? { findings: board.findings } : {}),
    ...(failures.length ? { failures } : {}),
  };
}

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

export type RubricItem =
  | "answer_first"
  | "numbers_with_basis"
  | "no_invented_ids"
  | "cites_source"
  | "voice"
  | "proposals_reasoned"
  | "proposals_invest"
  | "zero_questions"
  | "brief"
  | "not_at_risk"
  | "sprint_bet"
  | "split_not_retry"
  | "failure_facts"
  | "says_missing"
  | "mentions"
  | "proposals"
  | "plain_words";

export interface ItemResult {
  item: RubricItem;
  ok: boolean;
  /** Why it failed, in one line; empty when it passed. */
  detail: string;
}

/** One reply as the rubric reads it. */
export interface ScoredReply {
  text: string;
  cites: PmCite[];
  /** The model's tool calls other than look-ups. */
  calls: ToolCall[];
}

/** Prose only: fenced and inline code removed. */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

/** Sentences of prose, each trimmed; a line break ends one too. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PREAMBLE =
  /^(?:sure|certainly|of course|okay|ok|absolutely|let me|i'll|i will|i can|i'd be|to answer|here is|here's|looking at|thanks|thank you|good|great|hi|hello|as (?:your|the) (?:pm|project manager))\b/i;

/** A quantity a reader would ask the basis of: a number and its unit, one word between at most (*12 more hours*). */
const QUANTITY =
  /\b\d+(?:\.\d+)?\s*(?:[a-z]+\s+)?(?:%|percent\b|points?\b|pts\b|days?\b|hours?\b|h\b|minutes?\b|weeks?\b|issues?\b|steps?\b|times\b)/i;
/**
 * A basis named with the number (§2.8.5, voice rule 2): a count it is part of
 * (*13 of 21 points*), a percentile, median or mean, a window of history
 * (*over the last 3 sprints*, *since yesterday*), or a source — the
 * forecast's simulations, the throughput, the burn-up, a measured history or
 * the prior. A range or a bare preposition is not a basis. A sentence that
 * names an id the board holds has that id as its source.
 */
const BASIS =
  /\b(?:out of|of) (?:its |the |their |all )?\d|\bpercentile\b|\b\d+(?:st|nd|rd|th)[- ]percentile|\bp(?:50|80|85|90|95)\b|\bmedian\b|\bmean\b|\baverag\w*|\b(?:last|past) (?:\d+|two|three|four|five|six|seven|eight|nine|ten|several) (?:sprints?|cycles?|weeks?|days?|months?|issues?|runs?|attempts?)\b|\bsince\b|\bsimulations?\b|\bthroughput\b|\bburn-?up\b|\bhistory\b|\bmeasured\b|\bprior\b/i;

/** Whether a text names an id the snapshot holds (the board's own source). */
function namesKnownId(text: string, known: ReadonlySet<string>): boolean {
  for (const m of text.matchAll(/[A-Za-z][\w-]*\d[\w-]*|[A-Za-z]{1,6}[-_][0-9a-z]+/g))
    if (known.has(m[0])) return true;
  return false;
}

/**
 * The ledger records a snapshot carries without an id — the Agent's record,
 * the decisions waiting, the forecast, the recent runs — each named only
 * when the snapshot holds it.
 */
function namedRecords(snapshot: PmSnapshot): RegExp[] {
  return [
    ...(snapshot.worker?.record ? [/\bagent'?s record\b|\bfirst attempts\b/i] : []),
    ...(snapshot.decisions?.length ? [/\bdecisions? (?:waiting|queue)\b/i] : []),
    ...(snapshot.forecast ? [/\bforecast\b/i] : []),
    ...(snapshot.recentRuns.length ? [/\brecent (?:runs|attempts)\b/i] : []),
  ];
}

/**
 * A real source (§2.8.5): a cite the reply carries (an id the snapshot
 * holds, or a research source), or a *Based on:* that names an id the board
 * holds — an issue, goal, assumption, finding or evidence id — or a ledger
 * record the snapshot holds without an id (the Agent's record, the decisions
 * waiting, the forecast, the recent runs). *Based on the board* names nothing.
 */
function citesRealSource(
  reply: ScoredReply,
  known: ReadonlySet<string>,
  records: readonly RegExp[],
): boolean {
  if (reply.cites.length > 0) return true;
  return [...reply.text.matchAll(/\bbased on\b:?([^\n]*)/gi)].some((m) => {
    const named = m[1] ?? "";
    return namesKnownId(named, known) || records.some((r) => r.test(named));
  });
}

/** Tokens that look like an id of the kind the snapshot holds. */
function idPrefixes(snapshot: PmSnapshot): string[] {
  const ids = knownIds(snapshot);
  const prefixes = new Set<string>();
  for (const id of ids) {
    const m = /^([A-Za-z]{1,6}[-_])[0-9a-z]+$/.exec(id);
    if (m?.[1]) prefixes.add(m[1]);
  }
  return [...prefixes];
}

function knownIds(snapshot: PmSnapshot): Set<string> {
  return new Set([
    ...snapshot.cards.map((c) => c.id),
    ...snapshot.cycles.map((c) => c.id),
    ...(snapshot.goals ?? []).map((g) => g.id),
    ...(snapshot.assumptions ?? []).map((a) => a.id),
    ...(snapshot.findings ?? []).map((f) => f.entryId),
    ...(snapshot.failures ?? []).map((f) => f.evidenceId),
  ]);
}

/** The ids a reply names that the snapshot does not hold (§2.8.5: invented ids). */
export function inventedIds(text: string, snapshot: PmSnapshot): string[] {
  const known = knownIds(snapshot);
  const found = new Set<string>();
  // An id carries a digit (`CHR-7`, `ev_7f3a`, `A-2`); a code symbol such as
  // `find_library` or a word such as e-mail is not one.
  for (const m of text.matchAll(/`([A-Za-z]{1,6}[-_](?=[0-9a-z]*\d)[0-9a-z]+)`/g))
    found.add(m[1] as string);
  for (const prefix of idPrefixes(snapshot)) {
    const esc = prefix.replace(/[-_]/g, (c) => `\\${c}`);
    for (const m of text.matchAll(new RegExp(`(?<![\\w-])${esc}(?=[0-9a-z]*\\d)[0-9a-z]+\\b`, "g")))
      found.add(m[0]);
  }
  return [...found].filter((id) => !known.has(id));
}

const PROPOSING = (c: ToolCall) => c.name.startsWith("propose_") || c.name === "start_project";

/** The proposal-time part of INVEST and the criterion lint for one drafted issue. */
export function draftProblems(draft: Record<string, unknown>): string[] {
  const title = typeof draft.title === "string" ? draft.title : "";
  const spec = typeof draft.spec === "string" ? draft.spec : "";
  const criteria = Array.isArray(draft.acceptance_criteria)
    ? draft.acceptance_criteria.filter((c): c is string => typeof c === "string")
    : [];
  const scope = Array.isArray(draft.scope_files) ? draft.scope_files : [];
  const estimate = typeof draft.estimate === "number" ? draft.estimate : undefined;
  const out: string[] = [];
  // T and V: criteria a test can check, each passing the lint (§2.3).
  if (criteria.length === 0) out.push(`${title || "an issue"} has no acceptance criterion`);
  for (const c of criteria) {
    const lint = lintCriterion(c, { title, specText: `${title}\n${spec}` });
    if (!lint.ok) out.push(`"${c}": ${lint.problems.map((p) => p.code).join(", ")}`);
  }
  // N: an outcome, not dictated syntax.
  if (containsLineByLineDictation(`${title}\n${spec}\n${criteria.join("\n")}`))
    out.push(`${title} dictates line-by-line edits`);
  // S and E: within the Agent's bound, on the points scale.
  if (scope.length > MAX_SCOPE_FILES)
    out.push(`${title} touches ${scope.length} files, over ${MAX_SCOPE_FILES}`);
  if (estimate !== undefined && (estimate > SPLIT_POINTS || estimate <= 0))
    out.push(`${title} is estimated at ${estimate} points`);
  return out;
}

function questionCount(text: string): number {
  return (prose(text).match(/\?/g) ?? []).length;
}

const pointsIn = (s: string) =>
  [...s.matchAll(/\b(\d+)\s*(?:points?|pts)\b/gi)].map((m) => Number(m[1]));

/** Score one reply against every rubric item that applies to its conversation. */
export function scoreReply(
  conversation: Pick<PmConversation, "expect">,
  snapshot: PmSnapshot,
  reply: ScoredReply,
  opts: { last: boolean } = { last: true },
): ItemResult[] {
  const e = conversation.expect;
  const text = reply.text;
  const out: ItemResult[] = [];
  const add = (item: RubricItem, ok: boolean, detail: string) =>
    out.push({ item, ok, detail: ok ? "" : detail });
  const said = sentences(prose(text));
  const first = sentences(text)[0] ?? "";
  const known = knownIds(snapshot);

  // Universal items: every reply.
  const answerPattern = e.answer ? new RegExp(e.answer, "i") : undefined;
  add(
    "answer_first",
    !!first &&
      !PREAMBLE.test(first) &&
      !(first.endsWith("?") && !e.brief) &&
      (!answerPattern || !opts.last || answerPattern.test(first)),
    `the first sentence does not answer: "${first.slice(0, 100)}"`,
  );
  // Sentences with their code kept, so an id in backticks is the number's source.
  const unfounded = sentences(text)
    .map((raw) => ({ raw, plain: prose(raw) }))
    .filter(
      ({ raw, plain }) => QUANTITY.test(plain) && !BASIS.test(plain) && !namesKnownId(raw, known),
    )
    .map(({ plain }) => plain.trim());
  add(
    "numbers_with_basis",
    unfounded.length === 0,
    `a number without its basis: "${unfounded[0]?.slice(0, 100) ?? ""}"`,
  );
  const invented = inventedIds(text, snapshot);
  add(
    "no_invented_ids",
    invented.length === 0,
    `names ids the board does not hold: ${invented.join(", ")}`,
  );
  if ((e.cite ?? snapshot.cards.length > 0) && opts.last) {
    add(
      "cites_source",
      citesRealSource(reply, known, namedRecords(snapshot)),
      "cites no issue, goal, assumption, finding or evidence",
    );
  }
  const voice = voiceProblems(text);
  add("voice", voice.length === 0, `says ${voice.join(", ")}`);
  const proposing = reply.calls.filter(PROPOSING);
  const unreasoned = proposing.filter(
    (c) => typeof c.arguments?.reason !== "string" || !String(c.arguments.reason).trim(),
  );
  if (proposing.length > 0)
    add(
      "proposals_reasoned",
      unreasoned.length === 0,
      `${unreasoned.map((c) => c.name).join(", ")} without a reason`,
    );
  const drafts = proposing.flatMap((c) =>
    c.name === "propose_create_card"
      ? [c.arguments ?? {}]
      : c.name === "propose_split_card" && Array.isArray(c.arguments?.parts)
        ? (c.arguments.parts as Record<string, unknown>[])
        : [],
  );
  if (drafts.length > 0) {
    const problems = drafts.flatMap(draftProblems);
    add("proposals_invest", problems.length === 0, problems.slice(0, 3).join("; "));
  }

  // The conversation's own expectations: its last reply carries them.
  if (!opts.last) return out;
  if (e.zeroQuestions) {
    const planned = proposing.some(
      (c) => c.name === "start_project" || c.name === "propose_create_card",
    );
    add(
      "zero_questions",
      questionCount(text) === 0 && planned,
      questionCount(text) ? `asks ${questionCount(text)} question(s)` : "plans nothing",
    );
  }
  if (e.brief) {
    add(
      "brief",
      /\bbrief\b/i.test(text) && questionCount(text) <= 2,
      /\bbrief\b/i.test(text) ? `asks ${questionCount(text)} questions, over 2` : "no brief",
    );
  }
  if (e.notAtRisk) {
    add(
      "not_at_risk",
      /\bnot at risk\b|\bsafe\b|\bon track\b|\bno risk\b/i.test(text),
      "names nothing that is not at risk",
    );
  }
  if (e.maxBet !== undefined) {
    const max = e.maxBet;
    const stated = said
      .filter((s) => /\b(?:suggest|bet|propose|plan|commit)\w*\b/i.test(s))
      .flatMap((s) => pointsIn(s).slice(0, 1));
    const points = new Map(snapshot.cards.map((c) => [c.id, c.estimate ?? 0]));
    const cycles = proposing
      .filter((c) => c.name === "propose_create_cycle")
      .map((c) =>
        (Array.isArray(c.arguments?.card_ids) ? (c.arguments.card_ids as unknown[]) : []).reduce(
          (n: number, id) => n + (points.get(String(id)) ?? 0),
          0,
        ),
      );
    const bets = [...stated, ...cycles];
    const basis =
      /averag|mean/i.test(text) &&
      /\b(?:last|past) (?:three|3)\b|\b(?:three|3) sprints\b/i.test(text);
    const over = bets.filter((b) => b > max);
    add(
      "sprint_bet",
      bets.length > 0 && over.length === 0 && basis,
      bets.length === 0
        ? "states no bet in points"
        : over.length
          ? `bets ${over[0]} points, over ${max}`
          : "states no basis in the last three sprints' mean",
    );
  }
  if (e.splitOf) {
    const proposed = proposing.some(
      (c) =>
        c.name === "propose_split_card" &&
        c.arguments?.card_id === e.splitOf &&
        Array.isArray(c.arguments?.parts) &&
        (c.arguments.parts as unknown[]).length >= 2,
    );
    const retried = proposing.some(
      (c) =>
        c.name === "propose_move_card" &&
        c.arguments?.card_id === e.splitOf &&
        c.arguments?.to === "ready",
    );
    add(
      "split_not_retry",
      proposed && !retried,
      proposed ? "also proposes a retry" : `no split of ${e.splitOf}`,
    );
  }
  if (e.failure) {
    const f = e.failure;
    const missing = [
      new RegExp(f.stop, "i").test(text) ? "" : "the stop reason",
      new RegExp(`\\bstep ${f.step}\\b`, "i").test(text) ? "" : `step ${f.step}`,
      new RegExp(f.gate, "i").test(text) ? "" : "the failing check",
      text.includes(f.at) ? "" : f.at,
      text.includes(f.evidence) ? "" : f.evidence,
    ].filter(Boolean);
    add("failure_facts", missing.length === 0, `leaves out ${missing.join(", ")}`);
  }
  if (e.saysMissing) {
    add(
      "says_missing",
      /\b(?:no evidence|not recorded|missing|isn't recorded|is not recorded|can't see|cannot see|no record)\b/i.test(
        text,
      ),
      "does not say which evidence is missing",
    );
  }
  if (e.mentions?.length) {
    const absent = e.mentions.filter((m) => !text.includes(m));
    add("mentions", absent.length === 0, `does not name ${absent.join(", ")}`);
  }
  if (e.proposals) {
    add(
      "proposals",
      e.proposals === "none" ? proposing.length === 0 : proposing.length > 0,
      e.proposals === "none" ? "proposes changes nobody asked for" : "proposes nothing",
    );
  }
  if (e.plain) {
    const codes = prose(text).match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    add(
      "plain_words",
      !text.includes("`") && codes.length === 0,
      text.includes("`") ? "uses backticked ids" : `uses internal codes: ${codes.join(", ")}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running the set
// ---------------------------------------------------------------------------

export interface ConversationResult {
  id: string;
  met: boolean;
  items: ItemResult[];
  replies: string[];
}

export interface SeshatEvalRunResult {
  run: number;
  met: number;
  total: number;
  conversations: ConversationResult[];
}

export interface SeshatEvalResult {
  kind: "seshat-conversations";
  assetHash: string;
  assetVersion: string;
  skillVersion: string;
  model: string;
  at: string;
  runs: SeshatEvalRunResult[];
  /** PM-P6-13 on every run: at least 16 of 20 conversations meet every item. */
  passes: boolean;
  /** Set when only some conversations ran (`--only`): never PM-P6-13's verdict. */
  partial?: boolean;
  line: string;
}

/** A model that records every tool call it makes, for the rubric. */
function recording(model: LocalInferenceAdapter): {
  model: LocalInferenceAdapter;
  take(): ToolCall[];
} {
  let calls: ToolCall[] = [];
  const wrapped: LocalInferenceAdapter = {
    modelId: model.modelId,
    supportedArms: model.supportedArms,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.nativeTools !== undefined ? { nativeTools: model.nativeTools } : {}),
    ...(model.preferredToolArm ? { preferredToolArm: model.preferredToolArm } : {}),
    generate: async (req: InferenceRequest) => {
      const res = await model.generate(req);
      calls.push(
        ...res.toolCalls.filter((c) => c.name !== "find_library" && c.name !== "ask_researcher"),
      );
      return res;
    },
  };
  return {
    model: wrapped,
    take: () => {
      const out = calls;
      calls = [];
      return out;
    },
  };
}

const boardOf = (set: Pick<PmConversationSet, "boards">, c: PmConversation): EvalBoard => {
  const b = typeof c.board === "string" ? set.boards[c.board] : c.board;
  if (!b) throw new Error(`${c.id}: no board ${String(c.board)}`);
  return b;
};

/** Hold one conversation with Seshat and score each reply. */
export async function runConversation(
  set: Pick<PmConversationSet, "boards">,
  conversation: PmConversation,
  model: LocalInferenceAdapter,
): Promise<ConversationResult> {
  const source = boardOf(set, conversation);
  const rec = recording(model);
  let seq = 0;
  const message = (role: "user" | "pm", text: string): PmMessage => ({
    id: `${conversation.id}-${seq}`,
    seq: ++seq,
    role,
    text,
    createdAt: NOW,
    state: "done",
  });
  const history: PmMessage[] = (conversation.history ?? []).map((h) => message(h.role, h.text));
  const items: ItemResult[] = [];
  const replies: string[] = [];
  for (const [i, turn] of conversation.turns.entries()) {
    const asked = { ...message("user", turn), state: "queued" as const };
    // As the product builds it (`answerFor`): the failure evidence of the
    // issues the person's message names, and no other.
    const snapshot = evalSnapshot(source, model.modelId, { asked: turn });
    rec.take();
    const got = await answer(rec.model, snapshot, history, [asked]);
    const reply: ScoredReply = { text: got.text, cites: got.cites, calls: rec.take() };
    items.push(
      ...scoreReply(conversation, snapshot, reply, { last: i === conversation.turns.length - 1 }),
    );
    replies.push(got.text);
    history.push({ ...asked, state: "done" }, message("pm", got.text));
  }
  return { id: conversation.id, met: items.every((r) => r.ok), items, replies };
}

/** The registered conversations (MS-T11-2, -7): refused unregistered, changed or short. */
export function loadPmConversations(root: string): PmConversationSet {
  const asset = verifyAsset(root, PM_CONVERSATION_ASSET);
  const dir = join(root, asset.path);
  return {
    hash: asset.hash,
    version: asset.version,
    conversations: JSON.parse(readFileSync(join(dir, "items.json"), "utf8")) as PmConversation[],
    boards: JSON.parse(readFileSync(join(dir, "boards.json"), "utf8")) as Record<string, EvalBoard>,
  };
}

/** Run the set `runs` times on one PM model and score it (PM-P6-13). */
export async function runSeshatEval(
  set: PmConversationSet,
  model: LocalInferenceAdapter,
  opts: {
    runs?: number;
    only?: readonly string[];
    say?: (line: string) => void;
    now?: () => Date;
  } = {},
): Promise<SeshatEvalResult> {
  const runs = Math.max(1, opts.runs ?? 2);
  const chosen = opts.only?.length
    ? set.conversations.filter((c) => opts.only?.includes(c.id))
    : set.conversations;
  const results: SeshatEvalRunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    const conversations: ConversationResult[] = [];
    for (const c of chosen) {
      const r = await runConversation(set, c, model);
      conversations.push(r);
      opts.say?.(
        `run ${run} ${r.met ? "met" : "missed"} ${c.id}${
          r.met
            ? ""
            : `: ${r.items
                .filter((i) => !i.ok)
                .map((i) => i.item)
                .join(", ")}`
        }`,
      );
    }
    results.push({
      run,
      met: conversations.filter((c) => c.met).length,
      total: conversations.length,
      conversations,
    });
  }
  const partial = chosen.length < set.conversations.length;
  const passes =
    !partial && results.every((r) => r.total >= PM_CONVERSATIONS && r.met >= PM_PASS_MIN);
  return {
    kind: "seshat-conversations",
    assetHash: set.hash,
    assetVersion: set.version,
    skillVersion: SESHAT_SKILL_VERSION,
    model: model.modelId,
    at: (opts.now?.() ?? new Date()).toISOString(),
    runs: results,
    passes,
    ...(partial ? { partial: true } : {}),
    line: `${results.map((r) => `run ${r.run}: ${r.met} of ${r.total} conversations met every rubric item`).join("; ")}. ${
      partial
        ? `Partial run (${chosen.length} of ${set.conversations.length}): not PM-P6-13's verdict.`
        : passes
          ? `Meets PM-P6-13 (at least ${PM_PASS_MIN} of ${PM_CONVERSATIONS} on every run).`
          : `Does not meet PM-P6-13 (at least ${PM_PASS_MIN} of ${PM_CONVERSATIONS} on every run).`
    }`,
  };
}

// ---------------------------------------------------------------------------
// Two skill versions, paired
// ---------------------------------------------------------------------------

export interface SkillComparison {
  a: string;
  b: string;
  model: string;
  pairs: number;
  /** Pairs A met and B missed, and the reverse. */
  aOnly: number;
  bOnly: number;
  metA: number;
  metB: number;
  /** Exact two-sided McNemar test on the discordant pairs. */
  p: number;
  /** The smallest difference these pairs could resolve at 80% power, when one is. */
  detectable: number | null;
  verdict: "a_better" | "b_better" | "no_clear_difference";
  line: string;
}

/**
 * Compare two skill versions on the same conversations (measurement rules
 * 10–11, PROMPT_STANDARD rule 35.4): paired by conversation and run, decided
 * by the exact McNemar test at 0.05, and a difference is claimed only when
 * it is significant and at least 20 points — the resolution the set allows
 * is stated with it. The two results must be on the same asset hash
 * (MS-T11-2) and the same model: only the skill differs.
 */
export function compareSkillRuns(a: SeshatEvalResult, b: SeshatEvalResult): SkillComparison {
  if (a.assetHash !== b.assetHash)
    throw new Error("the two runs were scored on different conversation sets; they do not compare");
  if (a.model !== b.model)
    throw new Error(
      `the two runs used different models (${a.model}, ${b.model}); a skill comparison holds the model fixed`,
    );
  if (a.partial || b.partial) throw new Error("a partial run is not compared");
  const key = (run: number, id: string) => `${run}\u0000${id}`;
  const bMet = new Map(
    b.runs.flatMap((r) => r.conversations.map((c) => [key(r.run, c.id), c.met] as const)),
  );
  let pairs = 0;
  let aOnly = 0;
  let bOnly = 0;
  let metA = 0;
  let metB = 0;
  for (const r of a.runs) {
    for (const c of r.conversations) {
      const other = bMet.get(key(r.run, c.id));
      if (other === undefined) continue;
      pairs++;
      if (c.met) metA++;
      if (other) metB++;
      if (c.met && !other) aOnly++;
      if (!c.met && other) bOnly++;
    }
  }
  const p = exactMcNemar(aOnly, bOnly);
  const detectable = minDetectableDifference(pairs);
  const diff = pairs ? (metA - metB) / pairs : 0;
  const resolved = p < 0.05 && Math.abs(diff) >= 0.2;
  const verdict = resolved ? (diff > 0 ? "a_better" : "b_better") : "no_clear_difference";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return {
    a: a.skillVersion,
    b: b.skillVersion,
    model: a.model,
    pairs,
    aOnly,
    bOnly,
    metA,
    metB,
    p,
    detectable,
    verdict,
    line: `${a.skillVersion} met ${metA} and ${b.skillVersion} met ${metB} of ${pairs} paired conversations (${aOnly} only by the first, ${bOnly} only by the second; exact McNemar p = ${p.toFixed(3)}): ${
      verdict === "no_clear_difference"
        ? "no clear difference"
        : `${verdict === "a_better" ? a.skillVersion : b.skillVersion} is better by ${pct(Math.abs(diff))}`
    }; ${describeDetectable(detectable, pairs, "difference")}.`,
  };
}

/** The share of conversations met on one run, with its interval, for a report. */
export function metInterval(run: SeshatEvalRunResult): { low: number; high: number } {
  return clopperPearson(run.met, run.total);
}
