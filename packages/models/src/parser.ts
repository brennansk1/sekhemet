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
 * Parse tool calls from a model response.
 *
 * Arm C is a distinct dialect: the model emits SEARCH/REPLACE blocks rather
 * than JSON, so it is translated into `edit` calls instead of being parsed as
 * JSON and coming back empty.
 */
export function parseToolCallsFromText(text: string, arm: ToolArm): ToolCall[] {
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

  return calls;
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
