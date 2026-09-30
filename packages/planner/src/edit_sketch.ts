import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePromptTokens, outlineFile } from "@sekhemet/context";
import type { ChatTurn, LocalInferenceAdapter, ToolDefinition } from "@sekhemet/models";
import { ToolIndex, plannerCopy, reasoningForStep } from "@sekhemet/models";
import { extractJsonObject } from "./spidr.js";
import type { EditSketch, PlannedStory } from "./types.js";

/**
 * The planner-to-executor edit-sketch cascade (P7, design "Edit-sketch
 * cascades" and "Routing and escalation"): for a card of difficulty 4-7 the
 * planning model writes the sketch before the Worker starts: which symbols
 * change in which files, preconditions, invariants, the approach and the
 * blast radius. The sketch is grounded: every file must be in the card's
 * scope, and symbols are checked against the files' real outlines. A reply
 * that fails the check falls back to the template sketch, marked as such.
 */
export interface SketchResult {
  sketch: EditSketch;
  source: "model" | "template";
  rejected?: string;
}

/**
 * Tools the Planner may call while it sketches a card (extensibility item 23,
 * EXT-20): an approved MCP server's tools, and how to call one.
 */
export interface PlannerTools {
  definitions: readonly ToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The share of the prompt budget tool descriptions may take (default {@link PLANNER_TOOL_BUDGET_TOKENS}). */
  budgetTokens?: number;
}

/** Tokens the Planner's offered tools may take, descriptions and schemas together. */
export const PLANNER_TOOL_BUDGET_TOKENS = 1_500;
/** Tool rounds before the Planner must answer; calls per round. */
const PLANNER_TOOL_ROUNDS = 3;
const PLANNER_TOOL_CALLS_PER_ROUND = 4;
/** A tool result is cut to this many characters before the Planner reads it. */
const PLANNER_TOOL_RESULT_CHARS = 4_000;

/**
 * The tools that fit the budget, in the order offered: each is counted by its
 * name, description and parameter schema, and one that would overflow is
 * left out while later, smaller ones may still fit.
 */
export function plannerToolsWithinBudget(
  tools: readonly ToolDefinition[],
  budgetTokens: number = PLANNER_TOOL_BUDGET_TOKENS,
): ToolDefinition[] {
  const kept: ToolDefinition[] = [];
  let used = 0;
  for (const t of tools) {
    const cost = estimatePromptTokens(
      `${t.name} ${t.description ?? ""} ${JSON.stringify(t.parameters ?? {})}`,
    );
    if (used + cost > budgetTokens) continue;
    used += cost;
    kept.push(t);
  }
  return kept;
}

function outlineText(root: string | undefined, files: readonly string[]): string {
  if (!root) return "";
  return files
    .map((f) => {
      const p = join(root, f);
      if (!existsSync(p)) return `${f}: (new file)`;
      const o = outlineFile(f, readFileSync(p, "utf8"));
      return o.lines.length ? `${f}:\n${o.lines.join("\n")}` : `${f}: (no exports)`;
    })
    .join("\n");
}

function knownSymbols(root: string | undefined, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!root) return out;
  for (const f of files) {
    const p = join(root, f);
    if (existsSync(p)) for (const s of outlineFile(f, readFileSync(p, "utf8")).exports) out.add(s);
  }
  return out;
}

/**
 * The Planner's tool rounds over an indexed tool set (WL-N8-1): the index is
 * in the first message, the tools array is `tool_search` alone on every
 * request, a loaded schema arrives as a tool message, and each request's
 * messages extend the previous request's byte for byte.
 */
async function sketchWithToolIndex(
  adapter: LocalInferenceAdapter,
  request: Parameters<LocalInferenceAdapter["generate"]>[0],
  prompt: string,
  index: ToolIndex,
  tools: PlannerTools,
): Promise<string> {
  const turns: ChatTurn[] = [{ role: "user", content: `${prompt}\n\n${index.indexText()}` }];
  let text = "";
  // One more round than without the index: loading a schema takes one.
  for (let round = 0; round <= PLANNER_TOOL_ROUNDS + 1; round++) {
    const res = await adapter.generate({
      ...request,
      messages: [...turns],
      tools: [...index.tools],
    });
    text = res.text;
    if (res.toolCalls.length === 0 || round === PLANNER_TOOL_ROUNDS + 1) break;
    const calls = res.toolCalls.slice(0, PLANNER_TOOL_CALLS_PER_ROUND);
    turns.push({ role: "assistant", content: res.text, toolCalls: calls });
    for (const c of calls) {
      const args = c.arguments as Record<string, unknown>;
      const out =
        c.name === "tool_search"
          ? index.search(String(args.query ?? "")).content
          : index.callable(c.name)
            ? await tools.call(c.name, args).catch((err: unknown) => `[ERROR]: ${String(err)}`)
            : plannerCopy.notLoaded(c.name);
      turns.push({
        role: "tool",
        toolCallId: c.id,
        content: out.slice(0, PLANNER_TOOL_RESULT_CHARS),
      });
    }
  }
  return text;
}

/** A code fence, a unified-diff header or hunk, or added/removed lines. */
export function isLiteralPatch(text: string): boolean {
  return (
    /```/.test(text) ||
    /^(?:diff --git|@@ |--- |\+\+\+ )/m.test(text) ||
    text.split("\n").filter((l) => /^[+-](?![+-])\S/.test(l)).length >= 2
  );
}

export async function sketchWithModel(
  adapter: LocalInferenceAdapter,
  story: PlannedStory,
  options: { repoRoot?: string; blastRadius?: string[]; tools?: PlannerTools } = {},
): Promise<SketchResult> {
  const fallback = story.editSketch;
  const scope = story.card.scopeFiles;
  const template: EditSketch = fallback ?? {
    cardId: story.card.id,
    targetSymbols: scope.map((filePath) => ({
      filePath,
      symbol: story.keywords[0] ?? "feature",
      change: "add",
    })),
    preconditions: ["The acceptance tests for this card exist and fail for the stated reason."],
    invariants: ["No gate is relaxed to make this card pass."],
    diffSketch: story.rationale,
    blastRadius: [...scope],
  };
  const prompt = [
    `Card: ${story.card.title}`,
    `Why: ${story.rationale}`,
    `Scope files (the ONLY files you may name): ${scope.join(", ") || "none"}`,
    `Acceptance tests: ${story.acceptanceTests.map((t) => t.assertion).join("; ")}`,
    options.repoRoot ? `Current outlines:\n${outlineText(options.repoRoot, scope)}` : "",
    options.blastRadius?.length
      ? `Files that depend on the scope: ${options.blastRadius.join(", ")}`
      : "",
    'Reply with JSON only: {"targetSymbols":[{"filePath":"...","symbol":"...","change":"add|modify|remove"}],"preconditions":["..."],"invariants":["..."],"diffSketch":"two or three sentences"}',
  ]
    .filter(Boolean)
    .join("\n\n");
  const thinking = reasoningForStep({ purpose: "planning" });
  const request = {
    systemPrompt:
      "You are the planner. Write an edit sketch for a small coding model: what to change, where, and what must stay true. Do not write the code.",
    prompt,
    toolArm: "arm_b_json" as const,
    purpose: "planning" as const,
    reasoning: thinking.reasoning,
    reasoningBudgetTokens: thinking.reasoningBudgetTokens,
    maxTokens: 700,
    // The Planning model's, whichever queue its weights serve first (measurement rule 4a).
    role: "planner",
    task: "edit_sketch",
  };
  // WL-N8-1: more than ten tools are offered as a one-line index and
  // `tool_search`; a loaded schema is appended as a message.
  const index = options.tools ? new ToolIndex(options.tools.definitions) : undefined;
  // EXT-20: an approved MCP server's tools, within the prompt budget. With
  // none, the request is the single call it always was.
  const offered =
    options.tools && !index?.indexed
      ? plannerToolsWithinBudget(options.tools.definitions, options.tools.budgetTokens)
      : [];
  let text: string;
  try {
    if (index?.indexed && options.tools) {
      text = await sketchWithToolIndex(adapter, request, prompt, index, options.tools);
    } else if (offered.length === 0 || !options.tools) {
      text = (await adapter.generate(request)).text;
    } else {
      const turns: ChatTurn[] = [{ role: "user", content: prompt }];
      text = "";
      for (let round = 0; round <= PLANNER_TOOL_ROUNDS; round++) {
        const last = round === PLANNER_TOOL_ROUNDS;
        const res = await adapter.generate({
          ...request,
          messages: turns,
          ...(last ? {} : { tools: offered }),
        });
        text = res.text;
        if (last || res.toolCalls.length === 0) break;
        const calls = res.toolCalls.slice(0, PLANNER_TOOL_CALLS_PER_ROUND);
        turns.push({ role: "assistant", content: res.text, toolCalls: calls });
        for (const c of calls) {
          const known = offered.some((t) => t.name === c.name);
          const out = known
            ? await options.tools
                .call(c.name, c.arguments as Record<string, unknown>)
                .catch((err: unknown) => `[ERROR]: ${String(err)}`)
            : `[ERROR]: ${c.name} is not offered to the Planner.`;
          turns.push({
            role: "tool",
            toolCallId: c.id,
            content: out.slice(0, PLANNER_TOOL_RESULT_CHARS),
          });
        }
      }
    }
  } catch (err) {
    return { sketch: template, source: "template", rejected: `model error: ${String(err)}` };
  }
  const raw = extractJsonObject(text) as Partial<EditSketch> | undefined;
  const reject = (why: string): SketchResult => ({
    sketch: template,
    source: "template",
    rejected: why,
  });
  if (!raw || !Array.isArray(raw.targetSymbols) || raw.targetSymbols.length === 0) {
    return reject("no targetSymbols in the reply");
  }
  const symbols = knownSymbols(options.repoRoot, scope);
  const targets: EditSketch["targetSymbols"] = [];
  for (const t of raw.targetSymbols) {
    if (!t || typeof t.filePath !== "string" || typeof t.symbol !== "string")
      return reject("malformed target");
    const file = t.filePath.replace(/^\.\//, "");
    if (!scope.includes(file)) return reject(`names ${file}, which is outside the card's scope`);
    const change = t.change === "modify" || t.change === "remove" ? t.change : "add";
    if (
      change !== "add" &&
      options.repoRoot &&
      existsSync(join(options.repoRoot, file)) &&
      !symbols.has(t.symbol)
    ) {
      return reject(`${change}s ${t.symbol}, which ${file} does not export`);
    }
    targets.push({ filePath: file, symbol: t.symbol, change });
  }
  const strings = (v: unknown, dflt: string[]) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : dflt;
  const outline = typeof raw.diffSketch === "string" ? raw.diffSketch : "";
  const preconditions = strings(raw.preconditions, template.preconditions);
  const invariants = strings(raw.invariants, template.invariants);
  // PM-P1-16: a prose outline, never a literal patch — checked over every
  // free-text field a model fills, not only `diffSketch` (a literal diff
  // dumped into `preconditions` or `invariants` instead is still a patch).
  const literalField = [outline, ...preconditions, ...invariants].find((t) => isLiteralPatch(t));
  if (literalField !== undefined) {
    return reject("the outline is a literal patch; the sketch describes the change in prose");
  }
  return {
    source: "model",
    sketch: {
      cardId: story.card.id,
      targetSymbols: targets,
      preconditions,
      invariants,
      diffSketch:
        typeof raw.diffSketch === "string" && raw.diffSketch.trim()
          ? raw.diffSketch.trim()
          : template.diffSketch,
      blastRadius: [...new Set([...scope, ...(options.blastRadius ?? [])])].sort(),
    },
  };
}
