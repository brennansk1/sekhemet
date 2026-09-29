import { createHash } from "node:crypto";
import type { ModelRole } from "@sekhemet/models";
import { ALLOCATOR_WINDOW_MARGIN_TOKENS, ROLE_ANSWER_TOKENS } from "./allocator.js";
import type { Exemplar } from "./exemplars.js";
import type { PlaybookRule } from "./playbook.js";
import { DEFAULT_PRESSURE_THRESHOLDS } from "./pressure.js";
import { rolePolicyText } from "./prompt_roles.js";
import { PROMPT_ZONE_1_SYSTEM } from "./prompts.js";
import type { SkillManifest } from "./skills.js";
import { FALLBACK_CHARS_PER_TOKEN } from "./tokens.js";
import type { ToolInterfaceSpec } from "./tool_interface.js";
import { WORKER_PRIORITIES } from "./worker_priorities.js";
import { PROMPT_ZONE_BUDGETS, PROMPT_ZONE_FRACTIONS } from "./zones.js";

/**
 * The context version (context rule 27, NEW-context-6): one hash over the
 * harness's own assets — the prompt templates, the tool catalog with its
 * descriptions, and the budget policies (zone caps and fractions, pressure
 * tiers, the allocator's margins and answer reserves, the estimator's ratio,
 * the Worker's priorities). A new version is a harness change, admitted only
 * by a suite A/B (rule 21a, CX-N6-2).
 *
 * The project's guidance — playbook rules, skills, exemplars, conventions
 * files — is not an input: approving a rule or editing `AGENTS.md` changes
 * the guidance list stamped on the pack (`guidanceList`), never the version,
 * and invalidates no qualification (CX-N6-3).
 */
export interface ContextVersion {
  /** Combined hash, 16 hex chars. */
  version: string;
  prompt: string;
  tools: string;
  policy: string;
}

export interface ContextVersionInput {
  tools: ToolInterfaceSpec[];
  /** Harness template text that is part of the prompt (copy modules, a literal inventory). */
  templates?: string[];
}

/** The input's fields, for the check that no guidance is among them (CX-N6-3). */
export const CONTEXT_VERSION_INPUTS = [
  "tools",
  "templates",
] as const satisfies readonly (keyof ContextVersionInput)[];

/** Guidance is never an input: tsc refuses this file if one is added (CX-N6-3). */
type Guidance = "rules" | "skills" | "exemplars" | "conventions" | "projectFiles";
const noGuidanceInput: Extract<keyof ContextVersionInput, Guidance> extends never ? true : never =
  true;
void noGuidanceInput;

const SEP = "\n--\n";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The budget policies, as text, in a stable order. */
export function budgetPolicyText(): string {
  const json = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());
  return [
    `chars per token ${FALLBACK_CHARS_PER_TOKEN}`,
    `zone budgets ${json(PROMPT_ZONE_BUDGETS)}`,
    `zone fractions ${json(PROMPT_ZONE_FRACTIONS)}`,
    `pressure ${json(DEFAULT_PRESSURE_THRESHOLDS)}`,
    `answer reserves ${json(ROLE_ANSWER_TOKENS)} margin ${ALLOCATOR_WINDOW_MARGIN_TOKENS}`,
    `worker priorities ${json(WORKER_PRIORITIES)}`,
  ].join("\n");
}

const toolsHash = (tools: readonly ToolInterfaceSpec[]) =>
  h(
    [...tools]
      .map((t) => JSON.stringify([t.name, t.summary, t.parameters, t.returns ?? ""]))
      .sort()
      .join(SEP),
  );

export function computeContextVersion(input: ContextVersionInput): ContextVersion {
  const prompt = h([PROMPT_ZONE_1_SYSTEM, ...(input.templates ?? [])].join(SEP));
  const tools = toolsHash(input.tools);
  const policy = h(budgetPolicyText());
  return { version: h(`${prompt}:${tools}:${policy}`), prompt, tools, policy };
}

/**
 * One role's prompt version (context rule 27, CX-N6-4; live-test F24): its
 * own templates (its copy modules and literals, and any tool definitions not
 * in the tool catalog), its tool catalog and its budget policy
 * (`rolePolicyText`). A role's qualification depends on this version and on
 * no other role's, so a Seshat prompt change leaves the Coding model
 * qualified. The full context version recorded on every card covers every
 * role's (PROMPT_STANDARD rule 37). Guidance is never an input (CX-N6-3).
 */
export function computeRolePromptVersion(
  role: ModelRole,
  input: ContextVersionInput,
): ContextVersion {
  const prompt = h([`role ${role}`, ...(input.templates ?? [])].join(SEP));
  const tools = toolsHash(input.tools);
  const policy = h(rolePolicyText(role));
  return { version: h(`${prompt}:${tools}:${policy}`), prompt, tools, policy };
}

/** One item of the project's guidance a pack carried: its kind, id and content hash. */
export interface GuidanceItem {
  kind: "rule" | "skill" | "exemplar" | "conventions";
  id: string;
  hash: string;
}

/**
 * The guidance list stamped on a pack (CX-N6-3): each rule, skill, exemplar
 * and the conventions text, with a content hash, in that order.
 */
export function guidanceList(input: {
  rules?: readonly PlaybookRule[];
  skills?: readonly SkillManifest[];
  exemplars?: readonly Exemplar[];
  conventions?: string;
}): GuidanceItem[] {
  return [
    ...(input.rules ?? []).map((r) => ({
      kind: "rule" as const,
      id: r.id,
      hash: h(
        JSON.stringify([r.instruction, r.pattern, r.errorPattern ?? "", r.triggerGate ?? ""]),
      ),
    })),
    ...(input.skills ?? []).map((s) => ({
      kind: "skill" as const,
      id: s.name,
      hash: h(`${s.description}${SEP}${s.content}`),
    })),
    ...(input.exemplars ?? []).map((e) => ({
      kind: "exemplar" as const,
      id: e.cardId,
      hash: h(JSON.stringify([e.title, e.trajectory])),
    })),
    ...(input.conventions
      ? [{ kind: "conventions" as const, id: "conventions", hash: h(input.conventions) }]
      : []),
  ];
}
