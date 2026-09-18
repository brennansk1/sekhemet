import type { CardRecord } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ToolCall, ToolDefinition } from "@sekhemet/models";
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
  today: string;
}

export type ProposalDraft = Omit<PmProposal, "id" | "state">;

export interface PmAnswer {
  text: string;
  proposals: ProposalDraft[];
  cites: PmCite[];
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
- Plan for the Worker you have. Cards should touch at most 3 files and 200 lines; a card the Worker failed or looped on is a candidate to split or to clarify, not just to retry. Its record: ${s.worker?.record ?? "no runs yet"}.
- Priority uses Linear's scale: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none. Estimates are points: 1, 2, 3, 5, 8.
- Refer to cards by title with their id in backticks, e.g. "Ledger (\`card_chron_ledger\`)".
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
  return `Today: ${s.today}\n\nBOARD\n${digest || "(empty)"}\n\nCYCLES\n${cycles}\n\nRECENT WORKER ATTEMPTS\n${runs}`;
}

/** The last few exchanges, so "split it" knows what "it" is. */
export function conversationDigest(history: PmMessage[], maxChars = 3500): string {
  const lines: string[] = [];
  for (const m of history.slice(-10)) {
    const who = m.role === "user" ? "Human" : "You";
    lines.push(`${who}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;

export const PM_TOOLS: ToolDefinition[] = [
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
        summary: `Update ${card.title}: ${Object.keys(patch).join(", ")}${reason ? `. ${reason}` : ""}`,
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
        summary: `Create ${title}${reason ? `. ${reason}` : ""}`,
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
        summary: `Split ${card.title} into ${drafts.length} cards${points ? ` (${points} pts)` : ""}${reason ? `. ${reason}` : ""}`,
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
        summary: `Move ${card.title} to ${to}${reason ? `. ${reason}` : ""}`,
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
        summary: `Plan cycle ${name} (${startsOn} to ${endsOn})${cardIds.length ? ` with ${cardIds.length} cards` : ""}${reason ? `. ${reason}` : ""}`,
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
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    .trim();
}

/** Ask the PM model to answer the queued messages. One request, no side effects. */
export async function answer(
  model: LocalInferenceAdapter,
  snapshot: PmSnapshot,
  history: PmMessage[],
  queued: PmMessage[],
): Promise<PmAnswer> {
  const questions = queued
    .map((m) => {
      const ctx = m.context?.cardId ? ` [looking at \`${m.context.cardId}\`]` : "";
      return `Human${ctx}: ${m.text}`;
    })
    .join("\n");
  const prompt = `${boardDigest(snapshot)}\n\nCONVERSATION SO FAR\n${conversationDigest(history) || "(new conversation)"}\n\nNEW MESSAGE${queued.length > 1 ? "S" : ""}\n${questions}\n\nReply to the human now. Use propose_* tools only for changes you recommend.`;

  const res = await model.generate({
    systemPrompt: pmSystemPrompt(snapshot),
    prompt,
    tools: PM_TOOLS,
    toolArm: "arm_a_flat",
    temperature: 0.3,
    maxTokens: 1200,
  });
  const proposals = toProposals(res.toolCalls, snapshot.cards);
  let text = stripThinking(res.text);
  if (!text) {
    text =
      proposals.length > 0
        ? `I have ${proposals.length} proposed change${proposals.length > 1 ? "s" : ""} for you to review.`
        : "I could not produce an answer to that. Could you rephrase it or point me at a card?";
  }
  return { text, proposals, cites: citesFrom(text, snapshot.cards) };
}
