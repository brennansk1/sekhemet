import { createHash } from "node:crypto";
import type { EventLog } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, extractJsonObject, plannerCopy } from "@sekhemet/models";
import { queryFor } from "./keywords.js";

/**
 * What the survey searches for a capability (design-stage §2.5 item 1, P7):
 * one to three short capability queries the Planning model writes through
 * its adapter ("email sending", "smtp client"), or, when no Planning model
 * is assigned, its server is not on this machine, or its answer is unusable,
 * the need's own keywords (`queryFor`), deterministically. The model sees
 * the capability and the project's language only, so nothing else of the
 * spec reaches a query; each query it writes is cut to a few plain words
 * before it may leave the machine (DS-S8-3 as amended by C3).
 *
 * The owner's ruling of 2026-09-28 (DS-S8-3): the model's queries leave the
 * machine only once a live measurement has admitted that model
 * (`reuseQueriesAdmitted`); until then `plan` hands the survey no model and
 * the keywords are sent.
 */

export type QueryOrigin = "planning-model" | "keywords";

export interface CapabilityQueries {
  /** What is sent to the registries, best first; empty sends nothing (DS-S8-4). */
  queries: string[];
  origin: QueryOrigin;
}

export const MAX_QUERIES = 3;
const MAX_WORDS = 4;
const MAX_WORD = 30;

/** One model query as it may leave the machine: lower case, plain words, at most four. */
export function cleanQuery(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 0 && w.length <= MAX_WORD);
  return words.length ? words.slice(0, MAX_WORDS).join(" ") : undefined;
}

/** The queries a model's reply names, cleaned and deduplicated, at most three. */
export function queriesFromReply(text: string): string[] {
  const parsed = extractJsonObject(text) as { queries?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.queries)) return [];
  const out: string[] = [];
  for (const q of parsed.queries) {
    const clean = cleanQuery(q);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}

const LANGUAGE: Record<string, string> = {
  typescript: "TypeScript (npm)",
  python: "Python (PyPI)",
  rust: "Rust",
  go: "Go",
};

/** The capability's queries: the Planning model's, else its keywords. */
export async function capabilityQueries(
  need: string,
  o: { planner?: LocalInferenceAdapter; stack?: string } = {},
): Promise<CapabilityQueries> {
  const keywords = (): CapabilityQueries => {
    const q = queryFor(need);
    return { queries: q ? [q] : [], origin: "keywords" };
  };
  const model = o.planner;
  // A server off this machine never sees a spec's words (models: `remote`).
  if (!model || model.remote) return keywords();
  try {
    const res = await model.generate({
      systemPrompt: plannerCopy.reuseQueriesSystem,
      prompt: plannerCopy.reuseQueries(need, LANGUAGE[o.stack ?? "typescript"] ?? "TypeScript"),
      toolArm: model.supportedArms[0] ?? "arm_a_flat",
      temperature: 0,
      maxTokens: 200,
      purpose: "planning",
      // The Planning model's, whichever queue its weights serve first (measurement rule 4a).
      role: "planner",
      task: "reuse_queries",
    });
    const queries = queriesFromReply(res.text);
    return queries.length ? { queries, origin: "planning-model" } : keywords();
  } catch {
    return keywords();
  }
}

/** The measurement that admits a Planning model's queries (DS-S8-3, DS-P7-7). */
export const REUSE_QUERIES_MEASURED = "research/reuse_queries_measured";

/**
 * The rule an admission is judged by: PROMPT_STANDARD rule 35.4's, the
 * suite's resolution (C2c; DEV_LOG Entry 63 found the earlier "higher is
 * enough" looser than it). An event recorded without it never admits.
 */
export const REUSE_ADMISSION_RULE = "prompt-standard-35.4";

/**
 * The `planner.reuse_queries` prompt's hash: an admission holds for the
 * prompt it was measured with only (PROMPT_STANDARD rule 37).
 */
export function reuseQueriesPromptHash(): string {
  return createHash("sha256")
    .update(plannerCopy.reuseQueriesSystem)
    .update("\n")
    .update(plannerCopy.reuseQueries("{capability}", "{language}"))
    .digest("hex");
}

/**
 * True when the latest `research/reuse_queries_measured` for exactly this
 * model says admitted, measured on the current prompt and judged by
 * PROMPT_STANDARD rule 35.4 (`REUSE_ADMISSION_RULE`); otherwise the survey
 * sends the keywords (DS-S8-3 as the owner amended it on 2026-09-28).
 */
export async function reuseQueriesAdmitted(log: EventLog, modelId: string): Promise<boolean> {
  const latest = (await log.getEventsByTypes([REUSE_QUERIES_MEASURED]))
    .filter((e) => (e.payload as { model?: unknown }).model === modelId)
    .at(-1);
  const p = latest?.payload as
    | { admitted?: unknown; promptHash?: unknown; admissionRule?: unknown }
    | undefined;
  return (
    p?.admitted === true &&
    p.promptHash === reuseQueriesPromptHash() &&
    p.admissionRule === REUSE_ADMISSION_RULE
  );
}
