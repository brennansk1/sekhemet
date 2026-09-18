import { randomUUID } from "node:crypto";
import type { TextPatch, ToolArm, ToolCall } from "./types.js";

export function parseToolCallsFromText(text: string, _arm: ToolArm): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Match ```json ... ``` blocks
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match: RegExpExecArray | null = jsonBlockRegex.exec(text);

  while (match !== null) {
    const rawJson = match[1]?.trim();
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === "object" && typeof item.name === "string") {
              toolCalls.push({
                id: item.id ?? `call_${randomUUID().slice(0, 8)}`,
                name: item.name,
                arguments: (item.arguments ?? item.parameters ?? {}) as Record<string, unknown>,
                raw: JSON.stringify(item),
              });
            }
          }
        } else if (parsed && typeof parsed === "object" && typeof parsed.name === "string") {
          toolCalls.push({
            id: parsed.id ?? `call_${randomUUID().slice(0, 8)}`,
            name: parsed.name,
            arguments: (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>,
            raw: rawJson,
          });
        }
      } catch {
        // Continue searching
      }
    }
    match = jsonBlockRegex.exec(text);
  }

  // If no fenced json found, check for naked json objects
  if (toolCalls.length === 0) {
    const nakedMatch = text.match(/\{[\s\S]*"name"\s*:\s*"[^"]+"[\s\S]*\}/);
    if (nakedMatch) {
      try {
        const parsed = JSON.parse(nakedMatch[0]);
        if (parsed && typeof parsed === "object" && typeof parsed.name === "string") {
          toolCalls.push({
            id: parsed.id ?? `call_${randomUUID().slice(0, 8)}`,
            name: parsed.name,
            arguments: (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>,
            raw: nakedMatch[0],
          });
        }
      } catch {
        // Ignore
      }
    }
  }

  return toolCalls;
}

export function parseArmCTextPatches(text: string): TextPatch[] {
  const patches: TextPatch[] = [];
  const patchRegex = /<<<<<<< SEARCH\s*([\s\S]*?)\s*=======\s*([\s\S]*?)\s*>>>>>>>/g;

  let match: RegExpExecArray | null = patchRegex.exec(text);
  while (match !== null) {
    const search = match[1] ?? "";
    const replace = match[2] ?? "";
    patches.push({ search, replace });
    match = patchRegex.exec(text);
  }

  return patches;
}
