import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  type AllocationResult,
  type ContextSection,
  type SectionTokens,
  allocateContext,
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
import type { ResearchAnswer } from "../research/researcher.js";
import { formatHits, searchLibraries } from "./libraries.js";
import type { Cycle, PmCite, PmMessage, PmProposal } from "./types.js";

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
  today: string;
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
 * and never a silent change to the board.
 */
export function pmSystemPrompt(s: PmSnapshot): string {
  return `You are the project manager for "${s.project}", working with the human who leads it. You run on ${s.pmModel}. The code is written by the Worker, a local model (${s.worker?.model ?? "unknown"}); every card it finishes must pass executable gates (types, lint, tests, size) and then be accepted by the human.

How you work:
- Answer like a senior engineering manager: lead with the answer, then the reason, then the detail. Plain, exact, calm. Use numbers from the board, not adjectives. No filler, no exclamation marks.
- Ground every claim in the board and run data below. If the data does not say, say you do not know and what would tell you.
- You never change the board yourself. To change it, call a propose_* tool: the human sees a diff and applies or discards it. Explain each proposal in one sentence in your reply.
- Plan for the Worker you have, using its measured record under WORKER CAPABILITY. Cards should touch at most 3 files and 200 lines. Propose a split when a card is larger than the Worker's 80% size horizon, or its kind has a low measured pass rate, or the Worker failed or looped on it: split or clarify, do not just retry. Treat small samples as ranges, not facts.
- Priority uses Linear's scale: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none. Estimates are points: 1, 2, 3, 5, 8.
- Refer to cards by title with their id in backticks, e.g. "Ledger (\`card_chron_ledger\`)".
- Before proposing a card that builds something general (parsing, validation, HTTP, dates, retries, CLI args...), call find_library. Recommend only packages marked usable (permissive licence) and put the package in the card's spec, so the Worker uses it instead of reinventing it.
- Keep replies short: a few sentences, or a short list for standups and plans.`;
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
    c.stopReason ? `stopped: ${c.stopReason}` : undefined,
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
    sections.push(`${status} (${list.length}):\n${list.map(cardLine).join("\n")}`);
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
  const lines: string[] = summary ? [`(Summary of the earlier conversation) ${summary.text}`] : [];
  const recent = summary ? history.filter((m) => m.seq > summary.upToSeq) : history;
  for (const m of recent.slice(-10)) {
    const who = m.role === "user" ? "Human" : "You";
    lines.push(`${who}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;

/** Offered only when a Researcher model is configured. */
export const ASK_RESEARCHER_TOOL: ToolDefinition = {
  name: "ask_researcher",
  description:
    "Delegate a question that needs evidence (a library's API or licence, how a module really works, a security advisory, what research says, what the project did before) to the Researcher. Its answer cites sources and states its confidence. depth 'deep' runs a team of sub-researchers and a verifier: for decisions (choosing a technology, planning a feature), not for single facts.",
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
    description:
      "Search the npm or PyPI registry for an existing, permissively licensed package before proposing a card that would build the thing from scratch. Results include the licence and whether it is safe to use.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the package should do, or its name" },
        ecosystem: { type: "string", enum: ["npm", "pypi"] },
      },
      required: ["query"],
    },
  },
  {
    name: "propose_update_card",
    description:
      "Propose changing fields on an existing card. The human approves it. Only include fields that change.",
    parameters: {
      type: "object",
      properties: {
        card_id: str,
        title: str,
        spec: str,
        priority: { type: "number", description: "1 urgent, 2 high, 3 medium, 4 low, 0 none" },
        estimate: { type: "number", description: "points: 1, 2, 3, 5 or 8" },
        labels: { type: "array", items: str },
        cycle_id: str,
        assignee: str,
        due_date: { type: "string", description: "YYYY-MM-DD" },
        reason: str,
      },
      required: ["card_id", "reason"],
    },
  },
  {
    name: "propose_create_card",
    description: "Propose a new card. Keep it to at most 3 files and 200 lines of change.",
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
    description:
      "Propose splitting a card that is too large or that the Worker failed on into smaller cards. The original is parked.",
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
    name: "propose_move_card",
    description: "Propose moving a card to ready, backlog or parked.",
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
    description: "Propose a cycle (sprint) with a goal, and optionally the cards planned into it.",
    parameters: {
      type: "object",
      properties: {
        name: str,
        starts_on: { type: "string", description: "YYYY-MM-DD" },
        ends_on: { type: "string", description: "YYYY-MM-DD" },
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
  ["due_date", "dueDate", asString],
];

/**
 * Turn the model's tool calls into proposals, dropping anything invalid.
 *
 * The model's arguments are untrusted: an unknown card id, an out-of-range
 * priority or an empty split becomes nothing rather than a broken proposal
 * the human would have to reason about.
 */
const shortTitle = (t: string) => t.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");
/** "the API waits on it" -> ". The API waits on it." */
const because = (reason: string) =>
  reason ? `. ${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/[.\s]+$/, "")}.` : "";

export function toProposals(calls: ToolCall[], cards: CardRecord[]): ProposalDraft[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: ProposalDraft[] = [];
  for (const call of calls) {
    const a = call.arguments ?? {};
    const reason = asString(a.reason) ?? "";
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
      out.push({
        kind: "update_card",
        cardId: card.id,
        patch,
        before,
        summary: `Update ${shortTitle(card.title)}: ${Object.keys(patch).join(", ")}${because(reason)}`,
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
        summary: `Create ${title}${because(reason)}`,
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
        summary: `Split ${shortTitle(card.title)} into ${drafts.length} cards${points ? ` (${points} pts)` : ""}${because(reason)}`,
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
        summary: `Move ${shortTitle(card.title)} to ${to}${because(reason)}`,
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
        summary: `Plan cycle ${name} (${startsOn} to ${endsOn})${cardIds.length ? ` with ${cardIds.length} cards` : ""}${because(reason)}`,
      });
    }
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

/** Card ids the reply mentions in backticks, so the UI can link them. */
export function citesFrom(text: string, cards: CardRecord[]): PmCite[] {
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
  return out;
}

/** Remove reasoning blocks a model may emit despite being asked not to. */
export function stripThinking(text: string): string {
  // MD-N4-8: the one implementation, which the adapter already applied.
  return stripReasoning(text);
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
 */
export function seshatSections(
  s: PmSnapshot,
  history: PmMessage[],
  queued: PmMessage[],
  summary?: { upToSeq: number; text: string },
  extra?: { lookups?: string },
): ContextSection[] {
  const questions = queued
    .map((m) => {
      const ctx = m.context?.cardId ? ` [looking at \`${m.context.cardId}\`]` : "";
      return `Human${ctx}: ${m.text}`;
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
  const byStatus = new Map<string, CardRecord[]>();
  for (const c of s.cards) byStatus.set(c.status, [...(byStatus.get(c.status) ?? []), c]);
  const board = STATUS_ORDER.flatMap((status) => {
    const list = byStatus.get(status);
    return list?.length ? [`${status} (${list.length}):\n${list.map(cardLine).join("\n")}`] : [];
  }).join("\n\n");
  const cycles = s.cycles.length
    ? s.cycles
        .map(
          (c) =>
            `- \`${c.id}\` ${c.name} ${c.startsOn}..${c.endsOn} (${c.state})${c.goal ? `: ${c.goal}` : ""}`,
        )
        .join("\n")
    : "none";
  const conversation =
    conversationDigest(history, Number.POSITIVE_INFINITY, summary) || "(new conversation)";
  const out: ContextSection[] = [
    section("today", "notice", `Today: ${s.today}`, 100, { required: true }),
    section(
      "pm_rules",
      "rules",
      s.pmRules?.length
        ? `RULES FOR THE PM (approved)\n${s.pmRules.map((r) => `- ${r}`).join("\n")}`
        : "",
      89,
    ),
    section(
      "profile",
      "conventions",
      s.preferences?.length
        ? `WHAT THE HUMAN PREFERS (learned; adapt to it)\n${s.preferences.map((p) => `- ${p}`).join("\n")}`
        : "",
      70,
    ),
    section(
      "forecast",
      "notice",
      s.forecast ? `FORECAST (Monte Carlo from real throughput)\n${s.forecast}` : "",
      40,
    ),
    section("team", "team", s.team ? `YOUR TEAM\n${s.team}` : "", 60),
    section("board", "contract", `BOARD\n${board || "(empty)"}`, 88, {
      shrink: (t, max) => shrinkHead(t, max),
      minTokens: 200,
    }),
    section("cycles", "notice", `CYCLES\n${cycles}`, 35),
    section(
      "runs",
      "history_old",
      `RECENT WORKER ATTEMPTS\n${s.recentRuns.length ? s.recentRuns.slice(-12).join("\n") : "none"}`,
      45,
    ),
    section(
      "capability",
      "notice",
      `WORKER CAPABILITY\n${s.worker ? `${s.worker.model}: ${s.worker.record}` : "no runs yet"}`,
      65,
    ),
    section(
      "dossier",
      "dossier",
      s.dossier?.lines.length
        ? `DOSSIER OF \`${s.dossier.cardId}\`\n${s.dossier.lines.join("\n")}`
        : "",
      75,
    ),
    section("conversation", "history_recent", `CONVERSATION SO FAR\n${conversation}`, 80, {
      shrink: (t, max) => shrinkTail(t, max),
      minTokens: 120,
    }),
    section(
      "lookups",
      "failure",
      extra?.lookups ? `LIBRARY SEARCH RESULTS\n${extra.lookups}` : "",
      90,
      {
        shrink: (t, max) => shrinkHead(t, max),
        minTokens: 150,
      },
    ),
    section("newest", "goal", `NEW MESSAGE${queued.length > 1 ? "S" : ""}\n${questions}`, 1000, {
      required: true,
    }),
    section(
      "instruction",
      "goal",
      extra?.lookups
        ? "Now reply to the human."
        : "Reply to the human now. Use propose_* tools only for changes you recommend.",
      1000,
      { required: true },
    ),
  ];
  return out;
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
  /** Injectable registry search, for tests; production searches npm and PyPI. */
  libraries?: typeof searchLibraries,
  /** The Researcher, when one is configured (the fourth model). */
  researcher?: (question: string, opts?: { deep?: boolean }) => Promise<ResearchAnswer>,
  /** The thread's live session (models rule 20i): its slot is saved and restored across swaps. */
  threadId?: string,
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
      const hits = await (libraries ?? searchLibraries)(q, eco).catch(() => []);
      found.push(`find_library("${q}", ${eco}):\n${formatHits(hits)}`);
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
  const proposals = toProposals(calls, snapshot.cards);
  let text = stripThinking(res.text);
  if (!text) {
    text =
      proposals.length > 0
        ? `I have ${proposals.length} proposed change${proposals.length > 1 ? "s" : ""} for you to review.`
        : "I could not produce an answer to that. Could you rephrase it or point me at a card?";
  }
  const seen = new Set<string>();
  const sources = researchCites.filter((c) => {
    const key = c.url ?? c.label ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    text,
    proposals,
    cites: [...citesFrom(text, snapshot.cards), ...sources],
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
  });
  return stripThinking(res.text).slice(0, 1500);
}

/** "status", "standup", "where are we?": answerable from the ledger alone. */
export function isStatusQuestion(text: string): boolean {
  return /^\s*(status|standup|stand-up|update|progress|where are we|how are we doing|what'?s (the )?(status|progress))\s*[?.!]*\s*$/i.test(
    text,
  );
}

/**
 * A standup built from the board and run data without loading any model.
 * Loading the 27B for a status question costs 40-120 s of swap on this host;
 * the facts are already on the ledger.
 */
export function ledgerStandup(s: PmSnapshot): string {
  const by = (status: string) => s.cards.filter((c) => c.status === status);
  const name = (c: CardRecord) => `${c.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "")} (\`${c.id}\`)`;
  const lines: string[] = [];
  const working = [...by("in_progress"), ...by("verify")];
  lines.push(
    working.length ? `Working: ${working.map(name).join(", ")}.` : "Nothing is running right now.",
  );
  const review = by("review");
  if (review.length) lines.push(`Waiting for your review: ${review.map(name).join(", ")}.`);
  const failed = s.cards.filter(
    (c) => c.stopReason && c.stopReason !== "gate_passed" && c.status !== "done",
  );
  if (failed.length) {
    lines.push(
      `At risk: ${failed.map((c) => `${name(c)} stopped on ${c.stopReason}`).join("; ")}.`,
    );
  }
  const ready = [...by("ready")].sort((a, b) => (a.priority || 9) - (b.priority || 9));
  if (ready.length) lines.push(`Next up: ${ready.slice(0, 3).map(name).join(", ")}.`);
  lines.push(`Done: ${by("done").length} of ${s.cards.length} cards.`);
  if (s.forecast) lines.push(`Forecast: ${s.forecast}`);
  if (s.worker) lines.push(`Worker record: ${s.worker.record}`);
  return `${lines.join("\n")}\n\n_Answered from the ledger without loading a model. Ask a specific question for my judgement._`;
}
