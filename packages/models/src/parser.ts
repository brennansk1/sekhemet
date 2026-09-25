import { randomUUID } from "node:crypto";
import type { TextPatch, ToolArm, ToolCall } from "./types.js";

/** Reasoning wrappers emitted by Qwen3.x, DeepSeek-R1 and similar models. */
const REASONING_TAGS = ["think", "thinking", "reasoning", "scratchpad"];

/**
 * Remove reasoning blocks before any tool parsing happens.
 *
 * This is a correctness requirement, not a cosmetic one: reasoning text
 * routinely contains a worked example of the very JSON the model is about to
 * emit. Parsing before stripping executes the model's rehearsal as if it were
 * a decision. An unterminated opening tag is treated as running to end-of-text,
 * which is what a truncated generation actually looks like.
 */
export function stripReasoning(text: string): string {
  let out = text;
  for (const tag of REASONING_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, "i"), "");
  }
  return out.trim();
}

/** Repair the malformed JSON local models emit most often. */
function repairJson(raw: string): string {
  return raw
    .replace(/,\s*([}\]])/g, "$1") // trailing comma before a close
    .replace(/^﻿/, "")
    .trim();
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(repairJson(raw));
    } catch {
      return undefined;
    }
  }
}

/** Extract balanced `{...}` regions, skipping braces inside string literals. */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      if (ch === "\\") i++;
      else if (ch === quote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  return objects;
}

/** Keys that identify the call itself rather than carry an argument value. */
const CALL_META_KEYS = new Set(["name", "tool", "function", "id", "type", "thought", "reasoning"]);

function toToolCall(item: Record<string, unknown>): ToolCall | null {
  const name = item.name ?? item.tool ?? item.function;
  if (typeof name !== "string" || name.length === 0) return null;

  const nested = item.arguments ?? item.parameters ?? item.args ?? item.input;
  let resolved: Record<string, unknown>;

  if (typeof nested === "string") {
    // Some servers double-encode the argument object as a JSON string.
    resolved = (tryParse(nested) as Record<string, unknown>) ?? {};
  } else if (nested && typeof nested === "object") {
    resolved = nested as Record<string, unknown>;
  } else {
    // Flat form: `{"tool":"write_file","path":"a.ts","content":"..."}`. Local
    // models emit this constantly; reading only the nested key silently yields
    // an argument-less call that executes as a no-op.
    resolved = {};
    for (const [key, value] of Object.entries(item)) {
      if (!CALL_META_KEYS.has(key)) resolved[key] = value;
    }
  }

  return {
    id: typeof item.id === "string" ? item.id : `call_${randomUUID().slice(0, 8)}`,
    name,
    arguments: resolved,
    raw: JSON.stringify(item),
  };
}

function collect(parsed: unknown, sink: ToolCall[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) collect(item, sink);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  const record = parsed as Record<string, unknown>;
  // Wrapper shapes: {"tool_calls": [...]} / {"calls": [...]} / {"actions": [...]}
  for (const key of ["tool_calls", "toolCalls", "calls", "actions"]) {
    if (Array.isArray(record[key])) {
      collect(record[key], sink);
      return;
    }
  }

  const call = toToolCall(record);
  if (call) sink.push(call);
}

/**
 * Parse `tool_name(key="value", other=2)` call syntax.
 *
 * Local models frequently answer in this form rather than JSON, even when asked
 * for JSON — it is how most tool-calling fine-tunes were trained. Rejecting it
 * means a perfectly well-formed decision is discarded and the agent looks
 * stalled, which is exactly what it did here. The `key=` form is required, so
 * ordinary calls appearing in generated code are not mistaken for tool calls.
 */
export function parseFunctionCallSyntax(text: string, knownTools?: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const known = knownTools && knownTools.length > 0 ? new Set(knownTools) : undefined;
  const head = /(?:^|[\s`>])([a-z_][a-z0-9_]{2,40})\s*\(/gi;

  let match: RegExpExecArray | null = head.exec(text);
  while (match !== null) {
    const name = match[1] as string;
    const open = match.index + match[0].length - 1;
    const args = readBalancedArgs(text, open);

    if (args !== null && (known === undefined || known.has(name))) {
      // With a known catalog an empty argument list is a real call — the model
      // must be able to say finish_card(). Without one, requiring a `key=` pair
      // is what keeps ordinary code in prose from being read as a tool call.
      const parsed =
        known?.has(name) && args.body.trim() === "" ? {} : parseNamedArguments(args.body);
      if (parsed !== null) {
        calls.push({
          id: `call_${randomUUID().slice(0, 8)}`,
          name,
          arguments: parsed,
          raw: `${name}(${args.body})`,
        });
      }
      head.lastIndex = args.end;
    }

    match = head.exec(text);
  }

  return calls;
}

/** Read to the parenthesis matching `open`, respecting string literals. */
function readBalancedArgs(text: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < text.length; i++) {
    const ch = text[i] as string;

    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }

  return null;
}

/** Split `key=value, key2=value2` into an argument object, or null if not that shape. */
function parseNamedArguments(body: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let i = 0;
  let sawPair = false;

  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i] as string)) i++;
    if (i >= body.length) break;

    const keyMatch = /^([A-Za-z_][\w]*)\s*=\s*/.exec(body.slice(i));
    // Every argument must be named; a positional list is not this form.
    if (!keyMatch) return sawPair ? out : null;

    const key = keyMatch[1] as string;
    i += keyMatch[0].length;

    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let value = "";
      i++;
      while (i < body.length) {
        const c = body[i] as string;
        if (c === "\\") {
          const next = body[i + 1] ?? "";
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          i += 2;
          continue;
        }
        if (c === quote) break;
        value += c;
        i++;
      }
      i++;
      out[key] = value;
      sawPair = true;
      continue;
    }

    // Unquoted scalar, array or object: read to the next top-level comma.
    let depth = 0;
    const start = i;
    while (i < body.length) {
      const c = body[i] as string;
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) break;
      i++;
    }
    const raw = body.slice(start, i).trim();
    if (raw === "true") out[key] = true;
    else if (raw === "false") out[key] = false;
    else if (raw === "null") out[key] = null;
    else if (/^-?\d+(?:\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else {
      const structured = tryParse(raw);
      out[key] = structured === undefined ? raw : structured;
    }
    sawPair = true;
  }

  return sawPair ? out : null;
}

/**
 * Parse tool calls from a model response.
 *
 * Arm C is a distinct dialect: the model emits SEARCH/REPLACE blocks rather
 * than JSON, so it is translated into `edit` calls instead of being parsed as
 * JSON and coming back empty.
 */
export function parseToolCallsFromText(
  text: string,
  arm: ToolArm,
  knownTools?: string[],
): ToolCall[] {
  const cleaned = stripReasoning(text);

  if (arm === "arm_c_sketch") {
    const fromPatches = parseArmCTextPatches(cleaned).map((patch) => ({
      id: `call_${randomUUID().slice(0, 8)}`,
      name: "edit",
      arguments: {
        ...(patch.filePath ? { path: patch.filePath } : {}),
        search: patch.search,
        replace: patch.replace,
      },
      raw: `${patch.search}\n=======\n${patch.replace}`,
    }));
    if (fromPatches.length > 0) return fromPatches;
    // Fall through: a model may still answer Arm C with JSON.
  }

  const calls: ToolCall[] = [];

  // Fenced blocks first — the highest-confidence signal.
  const fenceRegex = /```(?:json|tool_code|tool|js)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null = fenceRegex.exec(cleaned);
  while (match !== null) {
    const body = match[1]?.trim();
    if (body) {
      const parsed = tryParse(body);
      if (parsed !== undefined) collect(parsed, calls);
      else for (const obj of extractJsonObjects(body)) collect(tryParse(obj), calls);
    }
    match = fenceRegex.exec(cleaned);
  }

  // Unfenced JSON, scanned with balanced braces so several objects in one
  // response are each recovered rather than swallowed by a greedy match.
  if (calls.length === 0) {
    for (const obj of extractJsonObjects(cleaned)) collect(tryParse(obj), calls);
  }

  // Last resort: `tool_name(key="value")` call syntax.
  if (calls.length === 0) {
    calls.push(...parseFunctionCallSyntax(cleaned, knownTools));
  }

  return calls;
}

/**
 * Whether a reply with no parsable tool call was trying to make one
 * (worker-loop WL-M2-5). Outside reasoning blocks, an attempt is:
 * - a tool-call tag (`<tool_call>`, `<function_call>`), or the Qwen3-Coder
 *   XML form `<function=name>` / `<parameter=name>`, with or without the
 *   wrapper — lowercase tags only, so JSX such as `<Tool />` is not one;
 * - a JSON object with a `"name"`, `"tool"` or `"function"` key;
 * - a SEARCH/REPLACE marker (Arm C);
 * - outside fenced code, a known tool's name directly followed by `(`, then
 *   `)`, `key=`, `{` or a quote — so "check (again)" in prose and
 *   `function check(x)` in a code block are not attempts.
 * Such a reply is a format error; one with none of these is prose only, and
 * the two are counted apart so prose does not inflate an arm's error rate.
 */
export function looksLikeToolCallAttempt(
  text: string,
  knownTools: readonly string[] = [],
): boolean {
  const cleaned = stripReasoning(text);
  if (cleaned === "") return false;
  if (/<\/?(?:tool_call|function_call)\b|<(?:function|parameter)=\w/.test(cleaned)) return true;
  if (/"(?:name|tool|function)"\s*:/.test(cleaned)) return true;
  if (/^<{7}\s*SEARCH/m.test(cleaned)) return true;
  const prose = cleaned.replace(/```[\s\S]*?(?:```|$)/g, " ");
  return knownTools.some((t) => {
    const name = t.replace(/[^a-z0-9_]/gi, "");
    return (
      name !== "" &&
      new RegExp(
        `(?:^|[^\\w.])${name}\\((?:\\s*\\)|\\s*[a-z_]\\w*\\s*=|\\s*\\{|\\s*["'])`,
        "i",
      ).test(prose)
    );
  });
}

/** Parse Arm C SEARCH/REPLACE blocks, with an optional preceding file path. */
export function parseArmCTextPatches(text: string): TextPatch[] {
  const patches: TextPatch[] = [];
  const cleaned = stripReasoning(text);
  const patchRegex =
    /(?:^|\n)[ \t]*(?:([^\n<>:]+?)[ \t]*\n)?[ \t]*<{5,9} SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9}(?:[ \t]*REPLACE)?/g;

  let match: RegExpExecArray | null = patchRegex.exec(cleaned);
  while (match !== null) {
    const candidatePath = match[1]?.trim();
    patches.push({
      // Only treat the preceding line as a path when it looks like one.
      ...(candidatePath && /\.[A-Za-z0-9]+$/.test(candidatePath)
        ? { filePath: candidatePath }
        : {}),
      search: match[2] ?? "",
      replace: match[3] ?? "",
    });
    match = patchRegex.exec(cleaned);
  }

  return patches;
}
