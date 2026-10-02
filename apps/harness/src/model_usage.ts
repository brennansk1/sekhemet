import type { EventLog } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type InferenceResponse,
  type LocalInferenceAdapter,
  MODEL_ROLES,
  type ModelRole,
} from "@sekhemet/models";

/**
 * Every role's token usage on the ledger (measurement rule 4a, fix round F2).
 *
 * A card's step records its own usage (`card/step`). Every other model
 * request that goes through the one path to a model (`ModelAccess`) —
 * Seshat's answers and its read-in-parts pass, the Planning model's plans
 * and re-plans, the Review model's reviews, the Research model's questions,
 * the Coding model's reflections — is recorded as one `model/usage` event:
 * whose request it was, what it was for, the model and the counts, never
 * the prompt or the reply. Insights and the capstone total the two, so no
 * role's tokens are left out of a cost.
 */
export const MODEL_USAGE = "model/usage";

/** The roles that spend tokens: every model role, and Seshat apart from the planner's own passes. */
export const USAGE_ROLES: readonly UsageRole[] = [
  MODEL_ROLES[0],
  "seshat",
  ...MODEL_ROLES.slice(1),
];
export type UsageRole = ModelRole | "seshat";

/** A role's own work, the purpose of a request that names no task. */
const DEFAULT_PURPOSE: Record<UsageRole, string> = {
  worker: "code",
  planner: "plan",
  seshat: "answer",
  reviewer: "review",
  researcher: "research",
};

/** The purpose a card's step is totalled under. */
export const CARD_STEP_PURPOSE = "card_step";

const PURPOSE = /^[a-z][a-z0-9_]*$/;

export interface ModelUsagePayload {
  role: UsageRole;
  purpose: string;
  model: string;
  promptTokens: number;
  cachedPromptTokens?: number;
  completionTokens: number;
  thinkingTokens: number;
  answerTokens: number;
  durationMs: number;
}

const count = (n: number | undefined): number =>
  Number.isFinite(n) ? Math.max(0, Math.round(n as number)) : 0;

/**
 * Whose request it was: the role it names, else the role of the queues its
 * weights serve (the first, when they serve more than one role).
 */
export function usageRole(named: string | undefined, served: readonly ModelRole[]): UsageRole {
  if (named && (USAGE_ROLES as readonly string[]).includes(named)) return named as UsageRole;
  return served[0] ?? "planner";
}

/** One request's usage record, from its request and the adapter's reply. */
export function usagePayload(
  model: string,
  req: InferenceRequest,
  res: InferenceResponse,
  served: readonly ModelRole[],
): ModelUsagePayload {
  const role = usageRole(req.role, served);
  const u = res.usage;
  const completion = count(u.completionTokens);
  const thinking = Math.min(completion, count(u.thinkingTokens));
  return {
    role,
    purpose: req.task && PURPOSE.test(req.task) ? req.task : DEFAULT_PURPOSE[role],
    model,
    promptTokens: count(u.promptTokens),
    ...(u.cachedPromptTokens !== undefined
      ? { cachedPromptTokens: count(u.cachedPromptTokens) }
      : {}),
    completionTokens: completion,
    thinkingTokens: thinking,
    answerTokens: u.answerTokens !== undefined ? count(u.answerTokens) : completion - thinking,
    durationMs: count(u.durationMs),
  };
}

const metered = new WeakSet<object>();

/**
 * Meter an adapter in place (its identity kept, as `measureThroughput`
 * does): after each reply, unless the caller records it as a card's step,
 * `record` is given the request's usage. A failed request records nothing;
 * a record that cannot be written never costs the reply, and is said on
 * `warn`.
 */
export function meterModelUsage<A extends LocalInferenceAdapter>(
  adapter: A,
  opts: {
    record: (payload: ModelUsagePayload) => void;
    /** The roles of the queues this adapter's weights serve, read at each request. */
    served: () => readonly ModelRole[];
    warn?: (line: string) => void;
  },
): A {
  // Metered once: an adapter handed out again is not counted twice.
  if (metered.has(adapter)) return adapter;
  metered.add(adapter);
  const original = adapter.generate.bind(adapter);
  const generate = async (req: InferenceRequest): Promise<InferenceResponse> => {
    const res = await original(req);
    if (req.recordedAsCardStep) return res;
    try {
      opts.record(usagePayload(adapter.modelId, req, res, opts.served()));
    } catch (err) {
      opts.warn?.(
        `The model's token use for this request could not be recorded in the Activity log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return res;
  };
  (adapter as { generate: LocalInferenceAdapter["generate"] }).generate = generate;
  return adapter;
}

/** Record a metered request on a ledger, as the harness. */
export function recordUsageOn(
  ledger: Pick<EventLog, "appendNow">,
): (payload: ModelUsagePayload) => void {
  return (payload) => {
    ledger.appendNow({ actor: "harness", type: MODEL_USAGE, payload });
  };
}

export interface ModelUseRow {
  role: UsageRole;
  requests: number;
  promptTokens: number;
  /** Of the prompt tokens, those the server reused from its cache, where it said. */
  cachedPromptTokens: number;
  completionTokens: number;
  thinkingTokens: number;
  answerTokens: number;
  /** Requests by purpose (`card_step` for a card's steps). */
  purposes: Record<string, number>;
}

export interface ModelUse {
  since: string;
  /** One row per role that used tokens, in the roster's order. */
  rows: ModelUseRow[];
  total: Omit<ModelUseRow, "role" | "purposes">;
}

type Counts = Partial<Record<keyof Omit<ModelUseRow, "role" | "requests" | "purposes">, number>>;

/** Events read per query while totalling a window. */
const PAGE = 5_000;

/**
 * Every role's token use over the last `days` (Insights, measurement rule
 * 4a): a card's steps as the Coding model's, every `model/usage` by its role.
 * Reads from the window's first event (`firstSeqSince`, by the time index),
 * in pages, so the cost follows the window rather than the ledger's age and
 * no request in it is cut off.
 */
export async function modelUse(
  log: Pick<EventLog, "getEventsByTypes" | "firstSeqSince">,
  days: number,
  now = new Date(),
): Promise<ModelUse> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const until = now.toISOString();
  const rows = new Map<UsageRole, ModelUseRow>();
  const add = (role: UsageRole, purpose: string, c: Counts) => {
    const row = rows.get(role) ?? {
      role,
      requests: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
      thinkingTokens: 0,
      answerTokens: 0,
      purposes: {},
    };
    row.requests++;
    row.promptTokens += count(c.promptTokens);
    row.cachedPromptTokens += count(c.cachedPromptTokens);
    row.completionTokens += count(c.completionTokens);
    row.thinkingTokens += count(c.thinkingTokens);
    row.answerTokens += count(c.answerTokens);
    row.purposes[purpose] = (row.purposes[purpose] ?? 0) + 1;
    rows.set(role, row);
  };
  const first = await log.firstSeqSince(since);
  const events: Awaited<ReturnType<EventLog["getEventsByTypes"]>> = [];
  for (let from = first; from !== undefined; ) {
    const page = await log.getEventsByTypes(["card/step", MODEL_USAGE], from, PAGE);
    events.push(...page);
    from = page.length === PAGE ? (page.at(-1)?.seq ?? 0) + 1 : undefined;
  }
  for (const e of events) {
    if (e.createdAt < since || e.createdAt > until) continue;
    if (e.type === "card/step") {
      const u = (e.payload as { usage?: Counts } | undefined)?.usage;
      if (u) add("worker", CARD_STEP_PURPOSE, u);
      continue;
    }
    const p = e.payload as ModelUsagePayload;
    if (!(USAGE_ROLES as readonly string[]).includes(p.role)) continue;
    add(p.role, p.purpose, p);
  }
  const ordered = USAGE_ROLES.map((r) => rows.get(r)).filter((r): r is ModelUseRow => !!r);
  const sum = (k: keyof ModelUse["total"]) => ordered.reduce((n, r) => n + r[k], 0);
  return {
    since,
    rows: ordered,
    total: {
      requests: sum("requests"),
      promptTokens: sum("promptTokens"),
      cachedPromptTokens: sum("cachedPromptTokens"),
      completionTokens: sum("completionTokens"),
      thinkingTokens: sum("thinkingTokens"),
      answerTokens: sum("answerTokens"),
    },
  };
}
