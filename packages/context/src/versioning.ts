import { createHash } from "node:crypto";
import type { PlaybookRule } from "./playbook.js";
import { PROMPT_ZONE_1_SYSTEM } from "./prompts.js";
import type { ToolInterfaceSpec } from "./tool_interface.js";

/**
 * Joint prompt, playbook and tool versioning (C21, design "Versioning").
 * One version hash over the three things that together decide the Worker's
 * behaviour: the prompt templates, the rules in force and the tool catalog.
 * Stamped on every context pack and evidence record, so a result is always
 * attributable to the exact combination that produced it, and a change to
 * any one of them is a new version.
 */
export interface ContextVersion {
  /** Combined hash, 16 hex chars. */
  version: string;
  prompt: string;
  playbook: string;
  tools: string;
}

const SEP = "\n--\n";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function computeContextVersion(input: {
  tools: ToolInterfaceSpec[];
  rules?: PlaybookRule[];
  /** Extra template text that is part of the prompt (conventions, notes). */
  templates?: string[];
}): ContextVersion {
  const prompt = h([PROMPT_ZONE_1_SYSTEM, ...(input.templates ?? [])].join(SEP));
  const playbook = h(
    [...(input.rules ?? [])]
      .map((r) => JSON.stringify([r.id, r.instruction, r.pattern, r.errorPattern ?? ""]))
      .sort()
      .join(SEP),
  );
  const tools = h(
    [...input.tools]
      .map((t) => JSON.stringify([t.name, t.summary, t.parameters, t.returns ?? ""]))
      .sort()
      .join(SEP),
  );
  return { version: h(`${prompt}:${playbook}:${tools}`), prompt, playbook, tools };
}
