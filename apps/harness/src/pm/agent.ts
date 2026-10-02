import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ALLOCATOR_WINDOW_MARGIN_TOKENS as ALLOCATOR_MARGIN,
  type AllocationResult,
  type ContextSection,
  type SectionTokens,
  allocateContext,
  charsForTokens,
  estimatePromptTokens,
  shrinkHead,
} from "@sekhemet/context";
import type { CardRecord } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  type ToolCall,
  type ToolDefinition,
  stripReasoning,
} from "@sekhemet/models";
import { type StoryMap, guardCompletionClaim } from "@sekhemet/planner";
import {
  type StatusSliceLike,
  columnLabel,
  gateLabel,
  requirementsWords,
  stopReasonLabel,
} from "@sekhemet/ui";
import { researchCopy } from "../research/research_copy.js";
import type { ResearchAnswer } from "../research/researcher.js";
import { ResearchHostAwaitsYes } from "../research_consent.js";
import type { TakeoverPromptContext } from "../takeover_brief.js";
import {
  type FailureFacts,
  type SnapshotAssumption,
  type SnapshotFinding,
  type SnapshotGoal,
  isWhyFailedQuestion,
} from "./knowledge.js";
import { type LibrarySearch, formatHits } from "./libraries.js";
import type { ProjectGroup } from "./pipeline.js";
import {
  DUPLICATE_OF_DESCRIPTION,
  PM_TOOL_COPY,
  PROPOSE_SPLIT_CARD_DESCRIPTION,
  SESHAT_DATA,
  SESHAT_FACTS,
  SESHAT_READER_SYSTEM,
  SESHAT_TAGS,
  START_PROJECT_DESCRIPTION,
  START_PROJECT_SENTENCE_DESCRIPTION,
  documentAttrs,
  documentsNotHeldWords,
  partsWords,
  pmSystemPromptText,
  seshatPart,
  seshatReaderPrompt,
  splitSuggestedSummary,
  sprintProposalSummary,
  startProjectSummary,
} from "./pm_copy.js";
import { SESHAT_SKILL_VERSION } from "./seshat_skill.js";
import { type StandupFacts, boardOnlyFacts, standupLines } from "./standup.js";
import type { Cycle, PmCite, PmDocumentRef, PmMessage, PmProposal } from "./types.js";

/** What the PM can see when it answers. Built by the caller from the live board. */
export interface PmSnapshot {
  project: string;
  cards: CardRecord[];
  cycles: Cycle[];
  /** One line per recent card attempt: "hasher: passed in 3 turns (38s)". */
  recentRuns: string[];
  /** Worker model id and a one-line track record, for self- and worker-awareness. */
  worker?: { model: string; record: string };
  /** The PM's own model id. */
  pmModel: string;
  /** Active statements from the user profile, strongest first. */
  preferences?: string[];
  /** Monte Carlo delivery forecast, as a sentence. */
  forecast?: string;
  /** Who is on the team and what asking each costs right now (residency). */
  team?: string;
  /** The playbook rules in force for the PM role (context CX-N4-5), one each. */
  pmRules?: string[];
  /** The dossier of the card the person is looking at, one line per entry. */
  dossier?: { cardId: string; lines: string[] };
  /**
   * The brief's invariant lines the architecture gate cannot check, each
   * with the forms it could be restated in (gates rule 26, GT-N1-1).
   */
  unenforcedInvariants?: { line: string; restate: string[] }[];
  /**
   * The requirement graph as computed from the ledger (planner-pm §2.15):
   * must-haves proven, unplanned, whether the project is done. A model's
   * claim of "complete" or "ready" is checked against it (PM-P13-6, -14).
   */
  storyMap?: StoryMap;
  /**
   * The decisions waiting, each naming its person and, where one applies,
   * the default and its deadline (PM-N9-5).
   */
  decisions?: string[];
  /**
   * A take-over's brief as found (design-stage DS-TO-10): repository text,
   * only ever as `takeoverPromptContext` wraps it — the contract once, each
   * claim inside the untrusted tags.
   */
  takeover?: TakeoverPromptContext;
  /** The goals the asker can see, each with its id (PM-P6-1). */
  goals?: SnapshotGoal[];
  /** The planner's logged assumptions and the risk register they make (PM-P6-1). */
  assumptions?: SnapshotAssumption[];
  /** The latest AI review's findings per issue, each with its entry id (PM-P6-2). */
  findings?: SnapshotFinding[];
  /** The failure evidence of the issues the person is asking about (PM-P6-6). */
  failures?: FailureFacts[];
  /** The project's brief, file text (untrusted, PROMPT_STANDARD rule 16). */
  brief?: string;
  /**
   * The documents the queued messages carry (PM-N10-3): whole, or — when the
   * window cannot hold them — the notes of their reading in parts.
   */
  documents?: SnapshotDocument[];
  /** The standup's facts for the asker, when the ledger gave them (PM-P6-3). */
  standup?: StandupFacts;
  today: string;
}

/** An attached document as Seshat's answer reads it (PM-N10-3). */
export interface SnapshotDocument extends PmDocumentRef {
  messageId: string;
  /** The whole text; undefined when a person erased it. */
  text?: string;
  /**
   * Its reading in parts, when the window could not hold it whole; `condensed`
   * counts the rounds of notes on the notes needed for them to fit.
   */
  read?: { parts: number; notes: string; condensed?: number };
}

export type ProposalDraft = Omit<PmProposal, "id" | "state">;

export interface PmAnswer {
  text: string;
  proposals: ProposalDraft[];
  cites: PmCite[];
  /** The last request's prompt, per section, as the allocator kept it (CX-N3-7). */
  promptSections?: SectionTokens[];
  /** The budget it was fitted to: the role and the Planner's configured context. */
  promptBudget?: { role: "seshat"; windowTokens: number; budgetTokens: number; usedTokens: number };
  /** The senior-PM skill the answer was made under (PM-P6-4). */
  skillVersion?: string;
}

const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];
const STATUS_ORDER = [
  "in_progress",
  "verify",
  "review",
  "ready",
  "backlog",
  "planning",
  "parked",
  "done",
  "rejected",
];

/**
 * The PM's standing brief. It is written as the role a good engineering
 * manager plays: outcome first, numbers over adjectives, risks named early,
 * and never a silent change to the board. The text itself lives in the PM's
 * copy module (`pm_copy.ts`, CX-M1-13), out of the literal inventory's way.
 */
export function pmSystemPrompt(s: PmSnapshot): string {
  return pmSystemPromptText(s);
}

function cardLine(c: CardRecord): string {
  const bits = [
    `\`${c.id}\` ${c.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "")}`,
    c.priority ? PRIORITY[c.priority] : undefined,
    c.estimate !== undefined ? `${c.estimate} pts` : undefined,
    c.cycleId ? `cycle ${c.cycleId}` : undefined,
    c.labels && c.labels.length > 0 ? `labels ${c.labels.join(",")}` : undefined,
    c.dependsOn && c.dependsOn.length > 0 ? `waits on ${c.dependsOn.join(",")}` : undefined,
    c.stepsUsed ? `${c.stepsUsed}/${c.stepBudget} steps` : undefined,
    // DEC-31: the column and the stop reason in the words a person reads.
    c.stopReason ? `stopped: ${stopReasonLabel(c.stopReason).short}` : undefined,
    c.blockedReason ? `blocked: ${c.blockedReason}` : undefined,
  ].filter(Boolean);
  return `- ${bits.join(" · ")}`;
}

/** The board as the PM reads it, capped so the request fits an 8k window. */
export function boardDigest(s: PmSnapshot, maxChars = 9000): string {
  const byStatus = new Map<string, CardRecord[]>();
  for (const c of s.cards) {
    const list = byStatus.get(c.status) ?? [];
    list.push(c);
    byStatus.set(c.status, list);
  }
  const sections: string[] = [];
  for (const status of STATUS_ORDER) {
    const list = byStatus.get(status);
    if (!list || list.length === 0) continue;
    sections.push(`${columnLabel(status)} (${list.length}):\n${list.map(cardLine).join("\n")}`);
  }
  let digest = sections.join("\n\n");
  if (digest.length > maxChars) digest = `${digest.slice(0, maxChars)}\n… (board truncated)`;

  const cycles =
    s.cycles.length > 0
      ? s.cycles
          .map(
            (c) =>
              `- \`${c.id}\` ${c.name} ${c.startsOn}..${c.endsOn} (${c.state})${c.goal ? `: ${c.goal}` : ""}`,
          )
          .join("\n")
      : "none";
  const runs = s.recentRuns.length > 0 ? s.recentRuns.slice(-12).join("\n") : "none";
  const capability = s.worker ? `${s.worker.model}: ${s.worker.record}` : "no runs yet";
  const prefs =
    s.preferences && s.preferences.length > 0
      ? `\n\nWHAT THE HUMAN PREFERS (learned; adapt to it)\n${s.preferences.map((p) => `- ${p}`).join("\n")}`
      : "";
  const fc = s.forecast ? `\n\nFORECAST (Monte Carlo from real throughput)\n${s.forecast}` : "";
  const team = s.team ? `\n\nYOUR TEAM\n${s.team}` : "";
  return `Today: ${s.today}${prefs}${fc}${team}\n\nBOARD\n${digest || "(empty)"}\n\nCYCLES\n${cycles}\n\nRECENT WORKER ATTEMPTS\n${runs}\n\nWORKER CAPABILITY\n${capability}`;
}

/**
 * The conversation as Seshat reads it: the rolling summary of everything older,
 * then the recent exchanges verbatim, so "split it" knows what "it" is.
 */
export function conversationDigest(
  history: PmMessage[],
  maxChars = 3500,
  summary?: { upToSeq: number; text: string },
): string {
  const lines: string[] = summary ? [`${SESHAT_DATA.earlierSummary} ${summary.text}`] : [];
  const recent = summary ? history.filter((m) => m.seq > summary.upToSeq) : history;
  for (const m of recent.slice(-10)) {
    const who = m.role === "user" ? SESHAT_DATA.person : SESHAT_DATA.you;
    // PM-N10-3: an earlier message's documents are named, not repeated.
    const attached = (m.documents ?? []).map((d) => SESHAT_DATA.attachedEarlier(d)).join("");
    lines.push(`${who}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}${attached}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;

/** Offered only when a Researcher model is configured. */
export const ASK_RESEARCHER_TOOL: ToolDefinition = {
  name: "ask_researcher",
  description: PM_TOOL_COPY.askResearcher,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      depth: { type: "string", enum: ["quick", "deep"] },
    },
    required: ["question"],
  },
};

export const PM_TOOLS: ToolDefinition[] = [
  {
    name: "find_library",
    description: PM_TOOL_COPY.findLibrary,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: PM_TOOL_COPY.libraryQuery },
        ecosystem: { type: "string", enum: ["npm", "pypi"] },
      },
      required: ["query"],
    },
  },
  {
    name: "propose_update_card",
    description: PM_TOOL_COPY.updateIssue,
    parameters: {
      type: "object",
      properties: {
        card_id: str,
        title: str,
        spec: str,
        priority: { type: "number", description: PM_TOOL_COPY.priority },
        estimate: { type: "number", description: PM_TOOL_COPY.estimate },
        labels: { type: "array", items: str },
        cycle_id: str,
        assignee: str,
        duplicate_of: { type: "string", description: DUPLICATE_OF_DESCRIPTION },
        due_date: { type: "string", description: PM_TOOL_COPY.day },
        reason: str,
      },
      required: ["card_id", "reason"],
    },
  },
  {
    name: "propose_create_card",
    description: PM_TOOL_COPY.createIssue,
    parameters: {
      type: "object",
      properties: {
        title: str,
        spec: str,
        scope_files: { type: "array", items: str },
        acceptance_criteria: { type: "array", items: str },
        priority: num,
        estimate: num,
        labels: { type: "array", items: str },
        depends_on: { type: "array", items: str },
        cycle_id: str,
        reason: str,
      },
      required: ["title", "spec", "reason"],
    },
  },
  {
    name: "propose_split_card",
    description: PROPOSE_SPLIT_CARD_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        card_id: str,
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: str,
              spec: str,
              scope_files: { type: "array", items: str },
              acceptance_criteria: { type: "array", items: str },
              estimate: num,
            },
            required: ["title", "spec"],
          },
        },
        reason: str,
      },
      required: ["card_id", "parts", "reason"],
    },
  },
  {
    name: "start_project",
    description: START_PROJECT_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        brief: { type: "string", description: START_PROJECT_SENTENCE_DESCRIPTION },
        reason: str,
      },
      required: ["brief", "reason"],
    },
  },
  {
    name: "propose_move_card",
    description: PM_TOOL_COPY.moveIssue,
    parameters: {
      type: "object",
      properties: {
        card_id: str,
        to: { type: "string", enum: ["ready", "backlog", "parked"] },
        reason: str,
      },
      required: ["card_id", "to", "reason"],
    },
  },
  {
    name: "propose_create_cycle",
    description: PM_TOOL_COPY.createSprint,
    parameters: {
      type: "object",
      properties: {
        name: str,
        starts_on: { type: "string", description: PM_TOOL_COPY.day },
        ends_on: { type: "string", description: PM_TOOL_COPY.day },
        goal: str,
        card_ids: { type: "array", items: str },
        reason: str,
      },
      required: ["name", "starts_on", "ends_on", "reason"],
    },
  },
];

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

const UPDATE_FIELDS: [string, string, (v: unknown) => unknown][] = [
  ["title", "title", asString],
  ["spec", "spec", asString],
  [
    "priority",
    "priority",
    (v) => {
      const n = asNumber(v);
      return n !== undefined && n >= 0 && n <= 4 ? Math.round(n) : undefined;
    },
  ],
  ["estimate", "estimate", asNumber],
  ["labels", "labels", asStrings],
  ["cycle_id", "cycleId", asString],
  ["assignee", "assignee", asString],
  ["duplicate_of", "duplicateOf", asString],
  ["due_date", "dueDate", asString],
];

/** The fields a change to which is a suggestion on the issue, one each (PM-N9-1). */
const SUGGESTIBLE = ["priority", "labels", "assignee", "duplicateOf"];

/**
 * Turn the model's tool calls into proposals, dropping anything invalid.
 *
 * The model's arguments are untrusted: an unknown card id, an out-of-range
 * priority or an empty split becomes nothing rather than a broken proposal
 * the human would have to reason about.
 */
const shortTitle = (t: string) => t.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");
/** "the API waits on it" -> "The API waits on it" (PM-N9-4: every proposal carries it). */
const whyOf = (reason: string) =>
  `${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/[.\s]+$/, "")}`;
const because = (why: string) => `. Why: ${why}.`;
const PRIORITY_NAME = ["No priority", "Urgent", "High", "Medium", "Low"];

/** The model's tool calls as proposals, and how many were left out for giving no reason. */
export function proposalsFrom(
  calls: ToolCall[],
  cards: CardRecord[],
): { proposals: ProposalDraft[]; unreasoned: number } {
  const proposing = calls.filter(
    (c) => c.name.startsWith("propose_") || c.name === "start_project",
  );
  const unreasoned = proposing.filter((c) => !asString(c.arguments?.reason)).length;
  return { proposals: toProposals(calls, cards), unreasoned };
}

export function toProposals(calls: ToolCall[], cards: CardRecord[]): ProposalDraft[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: ProposalDraft[] = [];
  for (const call of calls) {
    const a = call.arguments ?? {};
    const reason = asString(a.reason);
    // PM-N9-4: a proposal without a reason is not offered.
    if (!reason) continue;
    const why = whyOf(reason);
    if (call.name === "propose_update_card") {
      const card = byId.get(String(a.card_id));
      if (!card) continue;
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const [arg, field, parse] of UPDATE_FIELDS) {
        const value = parse(a[arg]);
        if (value === undefined) continue;
        const current = (card as unknown as Record<string, unknown>)[field];
        if (JSON.stringify(current) === JSON.stringify(value)) continue;
        patch[field] = value;
        before[field] = current ?? null;
      }
      if (Object.keys(patch).length === 0) continue;
      const title = shortTitle(card.title);
      // PM-N9-1: each triage property is its own suggestion on the issue.
      for (const field of SUGGESTIBLE) {
        if (!(field in patch)) continue;
        const value = patch[field];
        const what =
          field === "priority"
            ? `priority ${PRIORITY_NAME[value as number] ?? value} for ${title}`
            : field === "labels"
              ? `label ${title} ${(value as string[]).join(", ")}`
              : field === "assignee"
                ? `assign ${title} to ${String(value)}`
                : `mark ${title} a duplicate of ${String(value)}`;
        out.push({
          kind: "update_card",
          cardId: card.id,
          patch: { [field]: value },
          before: field === "duplicateOf" ? {} : { [field]: before[field] },
          why,
          summary: `Suggested: ${what}${because(why)}`,
        });
        delete patch[field];
        delete before[field];
      }
      if (Object.keys(patch).length === 0) continue;
      out.push({
        kind: "update_card",
        cardId: card.id,
        patch,
        before,
        why,
        summary: `Update ${title}: ${Object.keys(patch).join(", ")}${because(why)}`,
      });
    } else if (call.name === "propose_create_card") {
      const title = asString(a.title);
      const spec = asString(a.spec);
      if (!title || !spec) continue;
      const draft = cleanCard({
        title,
        spec,
        scopeFiles: asStrings(a.scope_files),
        acceptanceCriteria: asStrings(a.acceptance_criteria),
        priority: asNumber(a.priority),
        estimate: asNumber(a.estimate),
        labels: asStrings(a.labels),
        dependsOn: asStrings(a.depends_on)?.filter((id) => byId.has(id)),
        cycleId: asString(a.cycle_id),
      });
      out.push({
        kind: "create_card",
        cards: [draft],
        why,
        summary: `Create ${title}${because(why)}`,
      });
    } else if (call.name === "propose_split_card") {
      const card = byId.get(String(a.card_id));
      const parts = Array.isArray(a.parts) ? (a.parts as Record<string, unknown>[]) : [];
      const drafts = parts
        .map((p) =>
          asString(p.title) && asString(p.spec)
            ? cleanCard({
                title: asString(p.title),
                spec: asString(p.spec),
                scopeFiles: asStrings(p.scope_files),
                acceptanceCriteria: asStrings(p.acceptance_criteria),
                estimate: asNumber(p.estimate),
              })
            : undefined,
        )
        .filter((d): d is Record<string, unknown> => d !== undefined);
      if (!card || drafts.length < 2) continue;
      const points = drafts.reduce((n, d) => n + ((d.estimate as number) ?? 0), 0);
      out.push({
        kind: "split_card",
        cardId: card.id,
        cards: drafts,
        why,
        summary: splitSuggestedSummary(
          shortTitle(card.title),
          drafts.length,
          points ? ` (${points} pts)` : "",
          because(why),
        ),
      });
    } else if (call.name === "propose_move_card") {
      const card = byId.get(String(a.card_id));
      const to = asString(a.to);
      if (!card || !to || !["ready", "backlog", "parked"].includes(to) || card.status === to)
        continue;
      out.push({
        kind: to === "parked" ? "park" : card.status === "parked" ? "unpark" : "move_card",
        cardId: card.id,
        patch: { status: to },
        before: { status: card.status },
        why,
        summary: `Move ${shortTitle(card.title)} to ${to}${because(why)}`,
      });
    } else if (call.name === "propose_create_cycle") {
      const name = asString(a.name);
      const startsOn = asString(a.starts_on);
      const endsOn = asString(a.ends_on);
      if (!name || !startsOn || !endsOn) continue;
      const cardIds = asStrings(a.card_ids)?.filter((id) => byId.has(id)) ?? [];
      const goal = asString(a.goal);
      out.push({
        kind: "create_cycle",
        patch: { name, startsOn, endsOn, ...(goal ? { goal } : {}), cardIds },
        why,
        summary: `${sprintProposalSummary(name, startsOn, endsOn, cardIds.length)}${because(why)}`,
      });
    } else if (call.name === "start_project") {
      const brief = asString(a.brief);
      if (!brief) continue;
      const short = brief.length > 80 ? `${brief.slice(0, 77)}…` : brief;
      out.push({
        kind: "start_project",
        patch: { brief },
        why,
        summary: `Start a project: ${short}${because(why)}`,
      });
    }
  }
  return out;
}

/**
 * Each `start_project` proposal with its group (PM-P2-1): the epics, the
 * first slice's cards with criteria and points, the proposed requirements,
 * card zero, the candidates and the count of what applying creates, for
 * Review plan. A group that cannot be drafted leaves the bare proposal,
 * which the one planner plans when applied.
 */
export async function withProjectGroups(
  proposals: ProposalDraft[],
  draft: (sentence: string) => Promise<ProjectGroup>,
): Promise<ProposalDraft[]> {
  const out: ProposalDraft[] = [];
  for (const p of proposals) {
    const sentence = typeof p.patch?.brief === "string" ? p.patch.brief : "";
    if (p.kind !== "start_project" || !sentence) {
      out.push(p);
      continue;
    }
    const group = await draft(sentence).catch(() => undefined);
    out.push(
      group
        ? {
            ...p,
            patch: { brief: sentence, group },
            summary: startProjectSummary(group, because(p.why ?? "")),
          }
        : p,
    );
  }
  return out;
}

function cleanCard(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  );
}

/**
 * What the reply cites, so the UI can link it: the card ids it mentions in
 * backticks, and — from the snapshot it was answered from — the goals,
 * assumptions, review findings and evidence bundles it names by id
 * (PM-P6-1, -2, -6). An id the snapshot does not hold is never cited.
 */
export function citesFrom(
  text: string,
  cards: CardRecord[],
  known: Pick<PmSnapshot, "goals" | "assumptions" | "findings" | "failures"> = {},
): PmCite[] {
  const ids = new Set(cards.map((c) => c.id));
  const seen = new Set<string>();
  const out: PmCite[] = [];
  for (const m of text.matchAll(/`([A-Za-z0-9_-]+)`/g)) {
    const id = m[1];
    if (id && ids.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push({ cardId: id });
    }
  }
  const named = (id: string): boolean => {
    if (!text.includes(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  for (const g of known.goals ?? [])
    if (named(g.id)) out.push({ goalId: g.id, label: `Goal ${g.id}` });
  for (const a of known.assumptions ?? [])
    if (named(a.id))
      out.push({ assumptionId: a.id, cardId: a.cardId, label: `Assumption ${a.id}` });
  for (const f of known.findings ?? [])
    if (named(f.entryId))
      out.push({ findingId: f.entryId, cardId: f.cardId, label: `AI review of ${f.cardId}` });
  for (const f of known.failures ?? [])
    if (named(f.evidenceId))
      out.push({ evidenceId: f.evidenceId, cardId: f.cardId, label: `Evidence ${f.evidenceId}` });
  return out;
}

/** Seshat's window when the adapter does not say: the manager profile's 8,192. */
export const SESHAT_DEFAULT_WINDOW_TOKENS = 8192;
/** Seshat's answer cap (`maxTokens` of every PM request). */
export const SESHAT_ANSWER_TOKENS = 1200;

/** Keep the tail of a text (the newest lines), with a marker at its head. */
function shrinkTail(text: string, maxTokens: number): string | undefined {
  const marker = "(earlier lines cut to fit the context window) …\n";
  if (estimatePromptTokens(text) <= maxTokens) return text;
  const room = maxTokens - estimatePromptTokens(marker);
  if (room <= 0) return undefined;
  const ratio = text.length / Math.max(1, estimatePromptTokens(text));
  let keep = Math.floor(room * ratio);
  while (keep > 0 && estimatePromptTokens(marker + text.slice(text.length - keep)) > maxTokens)
    keep -= 16;
  if (keep <= 0) return undefined;
  const tail = text.slice(text.length - keep);
  const nl = tail.indexOf("\n");
  return `${marker}${nl !== -1 && nl < tail.length * 0.4 ? tail.slice(nl + 1) : tail}`;
}

/**
 * Seshat's prompt as allocator sections (CX-N3-7): the board, the rules for
 * the PM, the profile, the conversation and the dossier each carry a
 * priority; the person's newest messages are required. The system text is
 * sent apart and counted as overhead, never cut.
 *
 * Each part is wrapped in its registered tag (PROMPT_STANDARD rule 5). What
 * is stable for a project comes first — the approved PM rules and the
 * person's profile, ranked above the board so a larger board never cuts them
 * — and the board digest starts everything that changes with the board, so
 * two prompts for one project are byte-identical up to `<board>` (PM-P6-11,
 * rule 21). The date is task data, after the board.
 */
export function seshatSections(
  s: PmSnapshot,
  history: PmMessage[],
  queued: PmMessage[],
  summary?: { upToSeq: number; text: string },
  extra?: { lookups?: string },
): ContextSection[] {
  const T = SESHAT_TAGS;
  const questions = queued
    .map((m) => {
      // PM-N10-3: a message kept whole as its own document is named here and
      // read in the document part, never twice; other documents are named after it.
      const own = m.documents?.find((d) => d.fromMessage);
      const words = own ? SESHAT_DATA.sentAsDocument(own) : m.text;
      const attached = (m.documents ?? [])
        .filter((d) => !d.fromMessage)
        .map((d) => SESHAT_DATA.attached(d))
        .join("");
      return `${SESHAT_DATA.person}${m.context?.cardId ? SESHAT_DATA.lookingAt(m.context.cardId) : ""}: ${words}${attached}`;
    })
    .join("\n");
  let order = 0;
  const section = (
    id: string,
    kind: ContextSection["kind"],
    text: string,
    priority: number,
    more: Partial<ContextSection> = {},
  ): ContextSection => ({ id, kind, text, priority, placement: "static", order: order++, ...more });
  const bullets = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => `- ${x}`).join("\n");
  const byStatus = new Map<string, CardRecord[]>();
  for (const c of s.cards) byStatus.set(c.status, [...(byStatus.get(c.status) ?? []), c]);
  const board = STATUS_ORDER.flatMap((status) => {
    const list = byStatus.get(status);
    return list?.length
      ? [`${columnLabel(status)} (${list.length}):\n${list.map(cardLine).join("\n")}`]
      : [];
  }).join("\n\n");
  const cycles = s.cycles
    .map(
      (c) =>
        `- \`${c.id}\` ${c.name} ${c.startsOn}..${c.endsOn} (${c.state})${c.goal ? `: ${c.goal}` : ""}`,
    )
    .join("\n");
  const conversation =
    conversationDigest(history, Number.POSITIVE_INFINITY, summary) || SESHAT_DATA.newConversation;
  const failures = (s.failures ?? [])
    .map((f) => SESHAT_FACTS.failure(f, failureWords(f)))
    .join("\n");
  // Tag, open and close each counted inside the section, so what is cut is said.
  const shrinkBody = (tag: string) => (t: string, max: number) => {
    const open = t.indexOf("\n");
    const close = `\n</${tag}>`;
    const head = t.slice(0, open + 1);
    const body = t.endsWith(close) ? t.slice(open + 1, -close.length) : t.slice(open + 1);
    const cut = shrinkHead(body, Math.max(1, max - estimatePromptTokens(head + close)));
    return cut === undefined ? undefined : `${head}${cut}${close}`;
  };
  return [
    // The stable head (PM-P6-11): the same for every prompt of this project and person.
    section("pm_rules", "rules", seshatPart(T.playbook, bullets(s.pmRules)), 89),
    section("profile", "conventions", seshatPart(T.preferences, bullets(s.preferences)), 89),
    // Everything from here changes with the board.
    section("board", "contract", seshatPart(T.board, board || SESHAT_DATA.emptyBoard), 88, {
      shrink: shrinkBody(T.board),
      minTokens: 200,
    }),
    section("today", "notice", SESHAT_DATA.today(s.today), 100, { required: true }),
    section("failures", "failure", seshatPart(T.failure, failures), 86),
    section(
      "findings",
      "notice",
      seshatPart(T.findings, (s.findings ?? []).map(SESHAT_FACTS.finding).join("\n")),
      74,
      { shrink: shrinkBody(T.findings), minTokens: 80 },
    ),
    section(
      "goals",
      "goal",
      seshatPart(T.goals, (s.goals ?? []).map(SESHAT_FACTS.goal).join("\n")),
      72,
    ),
    section(
      "assumptions",
      "notice",
      seshatPart(T.assumptions, (s.assumptions ?? []).map(SESHAT_FACTS.assumption).join("\n")),
      64,
      { shrink: shrinkBody(T.assumptions), minTokens: 80 },
    ),
    section(
      "capability",
      "notice",
      seshatPart(T.agent, s.worker ? SESHAT_DATA.agentRecord(s.worker.model, s.worker.record) : ""),
      65,
    ),
    section("decisions", "notice", seshatPart(T.decisions, bullets(s.decisions)), 62),
    section("team", "team", seshatPart(T.team, s.team ?? ""), 60),
    section(
      "takeover",
      "notice",
      s.takeover?.blocks.length
        ? seshatPart(T.asFound, `${s.takeover.contract}\n${s.takeover.blocks.join("\n")}`)
        : "",
      55,
      { shrink: shrinkBody(T.asFound), minTokens: 120 },
    ),
    section("runs", "history_old", seshatPart(T.attempts, s.recentRuns.slice(-12).join("\n")), 45),
    section("forecast", "notice", seshatPart(T.forecast, s.forecast ?? ""), 40),
    section("cycles", "notice", seshatPart(T.sprints, cycles), 35),
    section(
      "dossier",
      "dossier",
      s.dossier?.lines.length
        ? seshatPart(T.dossier, s.dossier.lines.join("\n"), ` issue="${s.dossier.cardId}"`)
        : "",
      75,
    ),
    section("conversation", "history_recent", seshatPart(T.conversation, conversation), 80, {
      shrink: (t, max) => {
        const open = `<${T.conversation}>\n`;
        const close = `\n</${T.conversation}>`;
        const body = t.slice(open.length, t.length - close.length);
        const cut = shrinkTail(body, Math.max(1, max - estimatePromptTokens(open + close)));
        return cut === undefined ? undefined : `${open}${cut}${close}`;
      },
      minTokens: 120,
    }),
    section("lookups", "failure", seshatPart(T.lookups, extra?.lookups ?? ""), 90, {
      shrink: shrinkBody(T.lookups),
      minTokens: 150,
    }),
    // PROMPT_STANDARD rule 31: the brief goes last among the data, before the
    // message and the ask (it is volatile across projects, never in the head).
    section(
      "brief",
      "notice",
      s.brief
        ? seshatPart(
            T.brief,
            `<untrusted_content source="brief">\n${s.brief}\n</untrusted_content>`,
          )
        : "",
      50,
    ),
    // PM-N10-3: the attached documents, whole or as the notes of their reading
    // in parts; never cut (no shrink), ranked above everything but the message.
    section("documents", "goal", documentsPart(s.documents ?? []), 95, {
      shrink: () => undefined,
    }),
    section("newest", "goal", seshatPart(T.message, questions), 1000, { required: true }),
    section(
      "instruction",
      "goal",
      extra?.lookups ? SESHAT_DATA.replyAfterLookups : SESHAT_DATA.replyNow,
      1000,
      { required: true },
    ),
  ];
}

/** A failure's stop reason and check in the words a person reads (DEC-31). */
export function failureWords(f: FailureFacts): { stop: string; gate?: string | undefined } {
  return {
    stop: stopReasonLabel(f.stopReason, f.step !== undefined ? { step: f.step } : {}).short,
    gate: f.gate ? gateLabel(f.gate) : undefined,
  };
}

/**
 * Seshat's prompt fitted to the Planner model's configured context (CX-N3-7):
 * the allocator's `seshat` role, the window less the answer cap and the
 * margin, with the system text and the tool schemas counted as overhead.
 */
export function fitSeshatPrompt(
  model: Pick<LocalInferenceAdapter, "contextWindow">,
  systemPrompt: string,
  tools: readonly ToolDefinition[],
  sections: ContextSection[],
): { prompt: string; allocation: AllocationResult; windowTokens: number } {
  const windowTokens = model.contextWindow?.contextTokens ?? SESHAT_DEFAULT_WINDOW_TOKENS;
  const allocation = allocateContext(sections, {
    role: "seshat",
    windowTokens,
    answerTokens: SESHAT_ANSWER_TOKENS,
    overheadTokens:
      estimatePromptTokens(systemPrompt) +
      (tools.length ? estimatePromptTokens(JSON.stringify(tools)) : 0),
  });
  return {
    prompt: allocation.sections.map((x) => x.text).join("\n\n"),
    allocation,
    windowTokens,
  };
}

/** The attached documents' part of Seshat's prompt (PM-N10-3). */
export function documentsPart(docs: readonly SnapshotDocument[]): string {
  return docs
    .map((d) => {
      if (d.text === undefined) {
        return seshatPart(SESHAT_TAGS.document, SESHAT_DATA.documentErased, documentAttrs(d));
      }
      if (d.read) {
        return seshatPart(
          SESHAT_TAGS.document,
          `${SESHAT_DATA.readInParts(d.read.parts, d.path, d.read.condensed ?? 0)}\n\n${d.read.notes}`,
          documentAttrs({ ...d, extra: ` read="${partsWords(d.read.parts)}"` }),
        );
      }
      return seshatPart(SESHAT_TAGS.document, d.text, documentAttrs(d));
    })
    .join("\n\n");
}

/**
 * Whether the queued messages' documents fit Seshat's prompt whole (PM-N10-3):
 * the prompt `answer` would send, fitted to the window, keeps the documents'
 * section. When it does not, the documents are read in parts first.
 */
export function documentsFitWhole(
  model: Pick<LocalInferenceAdapter, "contextWindow">,
  snapshot: PmSnapshot,
  history: PmMessage[],
  queued: PmMessage[],
  summary: { upToSeq: number; text: string } | undefined,
  withResearcher: boolean,
): boolean {
  if (!snapshot.documents?.length) return true;
  const tools = withResearcher ? [...PM_TOOLS, ASK_RESEARCHER_TOOL] : PM_TOOLS;
  const fitted = fitSeshatPrompt(
    model,
    pmSystemPrompt(snapshot),
    tools,
    seshatSections(snapshot, history, queued, summary),
  );
  return fitted.allocation.fits && fitted.allocation.sections.some((x) => x.id === "documents");
}

/** Each part's reading answer: the notes on it. */
export const READER_NOTES_TOKENS = 900;

/** At most this many rounds of notes on the notes before Seshat answers without them. */
export const MAX_CONDENSE_ROUNDS = 3;

/**
 * Notes too long to sit beside the rest of Seshat's prompt (PM-N10-3) are
 * read again in parts, as the document was: notes on the notes, every
 * character of them read, round after round while they do not fit and each
 * round makes them shorter, at most `MAX_CONDENSE_ROUNDS`. `fits` says
 * whether a set of documents fits the prompt. Returns the documents as they
 * stand at the end, each with its rounds counted.
 */
export async function condenseNotes(
  model: LocalInferenceAdapter,
  docs: SnapshotDocument[],
  fits: (docs: SnapshotDocument[]) => boolean,
  onPart?: (name: string, index: number, parts: number) => Promise<void> | void,
): Promise<SnapshotDocument[]> {
  let out = docs;
  for (let round = 1; round <= MAX_CONDENSE_ROUNDS && !fits(out); round += 1) {
    let shorter = false;
    const next: SnapshotDocument[] = [];
    for (const d of out) {
      if (!d.read) {
        next.push(d);
        continue;
      }
      const again = await readDocumentInParts(
        model,
        { id: d.id, name: `${d.name} (notes)`, path: d.path, text: d.read.notes },
        (i, n) => onPart?.(d.name, i, n),
      );
      if (again.notes.length < d.read.notes.length) {
        shorter = true;
        next.push({ ...d, read: { ...d.read, notes: again.notes, condensed: round } });
      } else next.push(d);
    }
    if (!shorter) break;
    out = next;
  }
  return out;
}

/**
 * Split a text into consecutive parts of at most `maxChars` characters, at a
 * paragraph or line break where one is near the end of a part. The parts
 * joined are the text, character for character.
 */
export function splitDocument(text: string, maxChars: number): string[] {
  const size = Math.max(1, Math.floor(maxChars));
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const window = text.slice(at, end);
      const para = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      const cut = para > size * 0.5 ? para + 2 : line > size * 0.5 ? line + 1 : -1;
      if (cut > 0) end = at + cut;
    }
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

/**
 * Read a document too long for Seshat's window in parts (PM-N10-3): each part
 * sized so its request fits the window with the notes it asks for, every
 * character read once, the notes of every part kept in order. `onPart` hears
 * each part as it is read.
 */
export async function readDocumentInParts(
  model: LocalInferenceAdapter,
  doc: { id: string; name: string; path?: string | undefined; text: string },
  onPart?: (index: number, parts: number) => Promise<void> | void,
): Promise<{ parts: number; notes: string; windowTokens: number }> {
  const windowTokens = model.contextWindow?.contextTokens ?? SESHAT_DEFAULT_WINDOW_TOKENS;
  const wrapper = estimatePromptTokens(seshatReaderPrompt(doc, "x", 99, 99));
  const room =
    windowTokens -
    READER_NOTES_TOKENS -
    ALLOCATOR_MARGIN -
    estimatePromptTokens(SESHAT_READER_SYSTEM) -
    wrapper;
  const parts = splitDocument(doc.text, Math.max(256, charsForTokens(room)));
  const notes: string[] = [];
  for (const [i, part] of parts.entries()) {
    await onPart?.(i + 1, parts.length);
    const res = await model.generate({
      systemPrompt: SESHAT_READER_SYSTEM,
      prompt: seshatReaderPrompt(doc, part, i + 1, parts.length),
      toolArm: "arm_a_flat",
      temperature: 0.1,
      maxTokens: READER_NOTES_TOKENS,
      role: "seshat",
      // Measurement rule 4a: the read-in-parts pass, counted apart from the answer.
      task: "read_document",
    });
    notes.push(`Part ${i + 1} of ${parts.length}:\n${stripReasoning(res.text).trim()}`);
  }
  return { parts: parts.length, notes: notes.join("\n\n"), windowTokens };
}

/**
 * Seshat's thread in a repository, as a live session's owner (models rule
 * 20i): one per repository, no path in it.
 */
export function seshatThreadId(repoPath: string): string {
  return `seshat-${createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 12)}`;
}

/** Ask the PM model to answer the queued messages. One request, no side effects. */
export async function answer(
  model: LocalInferenceAdapter,
  snapshot: PmSnapshot,
  history: PmMessage[],
  queued: PmMessage[],
  summary?: { upToSeq: number; text: string },
  /**
   * The registry search, through the research network policy (`researchFetch`);
   * absent — research not allowed — `find_library` searches nothing and says so.
   */
  libraries?: LibrarySearch,
  /** The Researcher, when one is configured (the fourth model). */
  researcher?: (question: string, opts?: { deep?: boolean }) => Promise<ResearchAnswer>,
  /** The thread's live session (models rule 20i): its slot is saved and restored across swaps. */
  threadId?: string,
  /**
   * A new project's proposal group (planner-pm §2.9, PM-P2-1): computed for
   * each `start_project` call, creating nothing; the caller passes
   * `draftProjectGroup` over its repository and ledger.
   */
  draftProject?: (sentence: string) => Promise<ProjectGroup>,
): Promise<PmAnswer> {
  const session = threadId ? { session: { owner: threadId, kind: "thread" as const } } : {};
  const tools = researcher ? [...PM_TOOLS, ASK_RESEARCHER_TOOL] : PM_TOOLS;
  const systemPrompt = pmSystemPrompt(snapshot);
  // CX-N3-7: every request is fitted to the Planner's configured context.
  let fitted = fitSeshatPrompt(
    model,
    systemPrompt,
    tools,
    seshatSections(snapshot, history, queued, summary),
  );

  // Up to two lookup rounds: Seshat may search registries, read the results,
  // then answer. Proposal tool calls from every round are kept.
  const lookupsSoFar: string[] = [];
  const calls: ToolCall[] = [];
  const researchCites: PmCite[] = [];
  let res = await model.generate({
    systemPrompt,
    prompt: fitted.prompt,
    tools,
    toolArm: "arm_a_flat",
    temperature: 0.3,
    maxTokens: SESHAT_ANSWER_TOKENS,
    role: "seshat",
    ...session,
  });
  for (let round = 0; round < 2; round++) {
    const isLookup = (c: ToolCall) => c.name === "find_library" || c.name === "ask_researcher";
    const lookups = res.toolCalls.filter(isLookup);
    if (lookups.length === 0) break;
    calls.push(...res.toolCalls.filter((c) => !isLookup(c)));
    const found: string[] = [];
    for (const c of lookups.slice(0, 3)) {
      if (c.name === "ask_researcher" && researcher) {
        const q = String(c.arguments?.question ?? "").slice(0, 500);
        const deep = c.arguments?.depth === "deep";
        const r: Pick<ResearchAnswer, "answer" | "sources" | "grounded"> &
          Partial<Pick<ResearchAnswer, "confidence" | "badCitations">> = await researcher(q, {
          deep,
        }).catch((err) => ({
          // Model-facing (Seshat's prompt reads it through `found`): wording
          // frozen by PROMPT_STANDARD until a suite A/B; DEC-31 governs
          // person-facing text.
          answer: `The Researcher failed: ${err instanceof Error ? err.message : String(err)}`,
          sources: [],
          grounded: false,
        }));
        const verdict = r.grounded
          ? `grounded, confidence ${(r.confidence ?? 0).toFixed(2)}${r.badCitations?.length ? `; citations [${r.badCitations.join(", ")}] point at nothing it read, ignore those claims` : ""}`
          : "NOT grounded: treat as unverified, do not plan on it";
        found.push(
          `ask_researcher("${q}"${deep ? ", deep" : ""}) [${verdict}]:\n${r.answer}\nSources: ${r.sources.join("; ") || "none"}`,
        );
        for (const src of r.sources) {
          const url = /https?:\/\/\S+/.exec(src)?.[0];
          researchCites.push({ label: src, ...(url ? { url } : {}) });
        }
        continue;
      }
      const q = String(c.arguments?.query ?? "").slice(0, 120);
      const eco = c.arguments?.ecosystem === "pypi" ? "pypi" : "npm";
      if (!libraries) {
        found.push(`find_library("${q}", ${eco}):\n${researchCopy.registrySearchOff}`);
        continue;
      }
      // DS-S8-8: a registry the person's yes did not name is said plainly.
      const hits = await libraries(q, eco).catch((err: unknown) =>
        err instanceof ResearchHostAwaitsYes ? err.message : [],
      );
      found.push(
        `find_library("${q}", ${eco}):\n${typeof hits === "string" ? hits : formatHits(q, hits)}`,
      );
    }
    lookupsSoFar.push(...found);
    fitted = fitSeshatPrompt(
      model,
      systemPrompt,
      tools,
      seshatSections(snapshot, history, queued, summary, { lookups: lookupsSoFar.join("\n\n") }),
    );
    res = await model.generate({
      systemPrompt,
      prompt: fitted.prompt,
      tools,
      toolArm: "arm_a_flat",
      temperature: 0.3,
      maxTokens: SESHAT_ANSWER_TOKENS,
      role: "seshat",
      ...session,
    });
  }
  calls.push(
    ...res.toolCalls.filter((c) => c.name !== "find_library" && c.name !== "ask_researcher"),
  );
  const { proposals: drafted, unreasoned } = proposalsFrom(calls, snapshot.cards);
  const proposals = draftProject ? await withProjectGroups(drafted, draftProject) : drafted;
  // PM-P13-6, -14: a claim that the project, a slice or a release is
  // complete or ready changes nothing; while a must-have is unproven the
  // reply states the proven count instead.
  let text = guardCompletionClaim(stripReasoning(res.text), snapshot.storyMap).text;
  if (!text) {
    text =
      proposals.length > 0
        ? `I have ${proposals.length} proposed change${proposals.length > 1 ? "s" : ""} for you to review.`
        : "I could not produce an answer to that. Could you rephrase it or point me at an issue?";
  }
  // PM-P6-6: asked why an issue failed, the reply names the evidence's
  // facts and cites its id — the harness adds them from the bundle when the
  // model's text leaves the id out, so the facts never rest on the model.
  const asked = queued.some((m) => isWhyFailedQuestion(m.text));
  const facts = asked ? (snapshot.failures ?? []) : [];
  for (const f of facts) {
    if (!text.includes(f.evidenceId)) {
      text = `${text}\n\n${SESHAT_FACTS.failure(f, failureWords(f))}`;
    }
  }
  // PM-N9-4: said, not silently dropped.
  if (unreasoned > 0) {
    text = `${text}\n\n${unreasoned === 1 ? "One proposed change was left out because it gave no reason." : `${unreasoned} proposed changes were left out because they gave no reason.`}`;
  }
  const seen = new Set<string>();
  const sources = researchCites.filter((c) => {
    const key = c.url ?? c.label ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // PM-N10-3: the reply cites each document it read — only when the prompt
  // it was made from (the last request's) kept the documents; otherwise it
  // cites none of them and says so (§2.8 item 18: nothing is cut silently).
  const readable = (snapshot.documents ?? []).filter((d) => d.text !== undefined);
  const documentsHeld = fitted.allocation.sections.some((x) => x.id === "documents");
  if (readable.length && !documentsHeld) text = `${text}\n\n${documentsNotHeldWords(readable)}`;
  const documentCites: PmCite[] = (documentsHeld ? readable : []).map((d) => ({
    documentId: d.id,
    label: `Attached document ${d.name}`,
    ...(d.path ? { path: d.path } : {}),
  }));
  return {
    text,
    proposals,
    cites: [...citesFrom(text, snapshot.cards, snapshot), ...documentCites, ...sources],
    skillVersion: SESHAT_SKILL_VERSION,
    promptSections: fitted.allocation.sectionTokens,
    promptBudget: {
      role: "seshat",
      windowTokens: fitted.windowTokens,
      budgetTokens: fitted.allocation.budgetTokens,
      usedTokens: fitted.allocation.usedTokens,
    },
  };
}

/**
 * Hybrid compaction for Seshat's own conversation (after "The Complexity Trap",
 * NeurIPS 2025 DL4Code): recent messages stay verbatim; older ones are folded
 * into a rolling summary by the model that is already loaded to answer. The
 * 27B manager can summarise faithfully where the small Worker could not, and
 * the full thread stays on the ledger regardless.
 */
export async function summarizeConversation(
  model: LocalInferenceAdapter,
  previous: string | undefined,
  messages: PmMessage[],
): Promise<string> {
  const text = messages
    .map(
      (m) =>
        `${m.role === "user" ? "Human" : "Seshat"}: ${m.text.replace(/\s+/g, " ").slice(0, 700)}`,
    )
    .join("\n");
  const res = await model.generate({
    systemPrompt:
      "You compress a project manager's conversation with the human who leads the project. Keep decisions, commitments, preferences the human stated, open questions and card ids. Drop pleasantries. Plain sentences, at most 150 words.",
    prompt: `${previous ? `Summary so far: ${previous}\n\n` : ""}Conversation to fold in:\n${text}\n\nWrite the updated summary.`,
    toolArm: "arm_a_flat",
    temperature: 0.1,
    maxTokens: 400,
    role: "seshat",
    task: "summarize",
  });
  return stripReasoning(res.text).slice(0, 1500);
}

/** "status", "standup", "where are we?": answerable from the ledger alone. */
export function isStatusQuestion(text: string): boolean {
  return /^\s*(status|standup|stand-up|update|progress|where are we|how are we doing|what'?s (the )?(status|progress))\s*[?.!]*\s*$/i.test(
    text,
  );
}

/** The chat's footer on an answer made from the ledger. */
export const LEDGER_FOOTER =
  "\n\n_Answered from the Activity log without loading a model. Ask a specific question for my judgement._";

/**
 * The standup, built from the board and run data without loading any model
 * (loading the Planner costs 40-120 s of swap on this host; the facts are
 * already on the ledger). One builder for the chat, the notifier and the CLI
 * (PM-P6-3, `standupLines`): the snapshot's `standup` facts when the ledger
 * gave them, else the board's columns alone.
 */
export function ledgerStandup(s: PmSnapshot): string {
  return `${standupBody(s)}${LEDGER_FOOTER}`;
}

/** The standup's text with no footer: what a channel posts. */
export function standupBody(s: PmSnapshot): string {
  const extra: string[] = [];
  // PM-P13-3, -8: the current release's requirements done — Status's key number,
  // in its words (FINDINGS STA-01) — and the Must haves not started, by title.
  const map = s.storyMap;
  if (map && map.slices.length > 0) {
    const done = requirementsWords(map.slices as unknown as StatusSliceLike[]).value;
    const notStarted = map.unplanned.map((r) => r.title?.trim() || r.id);
    extra.push(
      `Requirements: ${done}.${notStarted.length ? ` Not started: ${notStarted.join(", ")}.` : ""}${map.projectDone ? " The project is done: a person accepted its last release." : ""}`,
    );
    const waiting = map.slices.filter((x) => x.state === "proven");
    if (waiting.length) {
      extra.push(
        `Requirements done, waiting for your acceptance: ${waiting.map((x) => x.title?.trim() || x.id).join(", ")}.`,
      );
    }
  }
  if (s.forecast) extra.push(`Forecast: ${s.forecast}`);
  // GT-N1-1: an invariant no gate checks is said, never silently assumed to hold.
  const loose = s.unenforcedInvariants ?? [];
  if (loose.length) {
    extra.push(
      `Not enforced (restate as ${loose[0]?.restate.join(" or ")} for the architecture check to enforce it): ${loose.map((l) => `"${l.line}"`).join("; ")}.`,
    );
  }
  return standupLines(s.standup ?? boardOnlyFacts(s.cards), extra).join("\n");
}
