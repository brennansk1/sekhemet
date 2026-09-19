import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { outlineFile } from "@sekhemet/context";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { reasoningForStep } from "@sekhemet/models";
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

export async function sketchWithModel(
  adapter: LocalInferenceAdapter,
  story: PlannedStory,
  options: { repoRoot?: string; blastRadius?: string[] } = {},
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
  let text: string;
  try {
    const res = await adapter.generate({
      systemPrompt:
        "You are the planner. Write an edit sketch for a small coding model: what to change, where, and what must stay true. Do not write the code.",
      prompt,
      toolArm: "arm_b_json",
      purpose: "planning",
      reasoning: thinking.reasoning,
      reasoningBudgetTokens: thinking.reasoningBudgetTokens,
      maxTokens: 700,
    });
    text = res.text;
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
  return {
    source: "model",
    sketch: {
      cardId: story.card.id,
      targetSymbols: targets,
      preconditions: strings(raw.preconditions, template.preconditions),
      invariants: strings(raw.invariants, template.invariants),
      diffSketch:
        typeof raw.diffSketch === "string" && raw.diffSketch.trim()
          ? raw.diffSketch.trim()
          : template.diffSketch,
      blastRadius: [...new Set([...scope, ...(options.blastRadius ?? [])])].sort(),
    },
  };
}
