import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  FALLBACK_CHARS_PER_TOKEN,
  computeRolePromptVersion,
  literalInventoryForRole,
  workerCopy,
} from "@sekhemet/context";
import { gateCopy } from "@sekhemet/gates";
import { TOOL_CATALOG, replanCopy } from "@sekhemet/loop";
import { MODEL_ROLES, type ModelRole, plannerCopy } from "@sekhemet/models";
import { DESIGN_COPY } from "@sekhemet/planner";
import { sandboxCopy } from "@sekhemet/sandbox";
import {
  REVIEW_ANSWER_TOKENS,
  REVIEW_DEFAULT_WINDOW_TOKENS,
  REVIEW_THINKING_TOKENS,
} from "./learning/review.js";
import { reviewCopy } from "./learning/review_copy.js";
import {
  ASK_RESEARCHER_TOOL,
  PM_TOOLS,
  SESHAT_ANSWER_TOKENS,
  SESHAT_DEFAULT_WINDOW_TOKENS,
} from "./pm/agent.js";
import * as pmCopy from "./pm/pm_copy.js";
import { SESHAT_SKILL } from "./pm/seshat_skill.js";
import {
  APODEX_LOCAL_TOOLS,
  APODEX_WEB_TOOLS,
  FINALIZE_ANSWER,
  SUBMIT_REPORT,
  TEAM_TOOLS,
} from "./research/apodex_loop.js";
import { researchCopy } from "./research/research_copy.js";
import { FINALIZE_TOOL, WEB_TOOLS } from "./research/researcher.js";

/**
 * Each role's prompt version, and the full context version over all of them
 * (context rule 27, CX-N6-1, CX-N6-4; PROMPT_STANDARD rule 37).
 *
 * A role's qualification depends on its own version only: its copy modules,
 * its literals outside them, its tool schemas and its budget policy. So a
 * Seshat or Review model prompt change leaves the Coding model qualified
 * (live-test F24). Every card (its evidence bundle's `settings`, with the
 * Coding model's own version), benchmark, A/B and footprint records the full
 * version, which changes with any role's prompts, so results stay comparable
 * only within one version.
 */

/** A copy module as text: its strings, and each builder's source. */
export function copyText(copy: unknown): string {
  return JSON.stringify(copy, (_k, v) => (typeof v === "function" ? String(v) : v));
}

/**
 * Each role's copy modules, by their `COPY_MODULES` name; the context
 * package's `COPY_MODULE_ROLES` decides which role reads which, and a test
 * keeps the two the same.
 */
export const ROLE_COPY: Readonly<Record<ModelRole, Readonly<Record<string, unknown>>>> = {
  worker: { worker: workerCopy, gates: gateCopy, sandbox: sandboxCopy },
  planner: {
    pm: pmCopy,
    pm_skill: SESHAT_SKILL,
    planner: plannerCopy,
    design: DESIGN_COPY,
    replan: replanCopy,
  },
  reviewer: { review: reviewCopy },
  researcher: { research: researchCopy },
};

/**
 * Tools a role's model is offered outside the Worker's catalog, and the
 * role's own caps beyond the allocator's (its window default, answer and
 * thinking caps): part of its tool schemas and budget policy.
 */
function roleExtras(role: ModelRole): string[] {
  switch (role) {
    case "worker":
      return [];
    case "planner":
      return [
        copyText([...PM_TOOLS, ASK_RESEARCHER_TOOL]),
        `seshat window ${SESHAT_DEFAULT_WINDOW_TOKENS} answer ${SESHAT_ANSWER_TOKENS}`,
      ];
    case "reviewer":
      return [
        `review window ${REVIEW_DEFAULT_WINDOW_TOKENS} answer ${REVIEW_ANSWER_TOKENS} thinking ${REVIEW_THINKING_TOKENS}`,
      ];
    case "researcher":
      return [
        copyText([
          ...APODEX_WEB_TOOLS,
          ...APODEX_LOCAL_TOOLS,
          FINALIZE_ANSWER,
          SUBMIT_REPORT,
          ...TEAM_TOOLS,
          ...WEB_TOOLS,
          FINALIZE_TOOL,
        ]),
      ];
  }
}

/**
 * The recorded inventory of model-facing literals outside the copy modules
 * (context CX-M1-13): editing a literal that has not moved into a copy
 * module yet changes it, and so the version of the role that reads it.
 */
export function recordedLiteralInventory(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("@sekhemet/context/package.json");
    return readFileSync(join(dirname(pkg), "prompt_literals_baseline.json"), "utf8");
  } catch {
    return "no recorded inventory";
  }
}

const shipped = new Map<ModelRole, string>();

export interface PromptVersionInputs {
  /** The recorded literal inventory's text; the shipped one by default. */
  inventory?: string;
  /** The token estimator's characters-per-token ratio (CX-N1-2). */
  charsPerToken?: number;
}

/**
 * One role's prompt version: what that role's qualification depends on
 * (CX-N6-4). The Coding model's also holds the Worker's tool catalog; the
 * playbook, skills and conventions are the project's guidance and never
 * part of it (CX-N6-3).
 */
export function rolePromptVersion(role: ModelRole, inputs: PromptVersionInputs = {}): string {
  // The shipped inputs do not change while a build runs: computed once.
  if (inputs.inventory === undefined && inputs.charsPerToken === undefined) {
    const cached = shipped.get(role);
    if (cached) return cached;
    const v = rolePromptVersion(role, { inventory: recordedLiteralInventory() });
    shipped.set(role, v);
    return v;
  }
  const inventory = inputs.inventory ?? recordedLiteralInventory();
  const charsPerToken = inputs.charsPerToken ?? FALLBACK_CHARS_PER_TOKEN;
  return computeRolePromptVersion(role, {
    tools: role === "worker" ? TOOL_CATALOG : [],
    templates: [
      ...Object.entries(ROLE_COPY[role]).map(([name, copy]) => `${name} ${copyText(copy)}`),
      literalInventoryForRole(inventory, role),
      // The estimator's ratio sizes every budget the prompt is cut to (CX-N1-2).
      `chars per token ${charsPerToken}`,
      ...roleExtras(role),
    ],
  }).version;
}

/** Every role's prompt version, for this build. */
export function rolePromptVersions(
  inputs: PromptVersionInputs = {},
): Readonly<Record<ModelRole, string>> {
  const shippedInputs = inputs.inventory === undefined && inputs.charsPerToken === undefined;
  const inventory = inputs.inventory ?? recordedLiteralInventory();
  return Object.fromEntries(
    MODEL_ROLES.map((r) => [
      r,
      shippedInputs ? rolePromptVersion(r) : rolePromptVersion(r, { ...inputs, inventory }),
    ]),
  ) as Record<ModelRole, string>;
}

/**
 * The full context version (PROMPT_STANDARD rule 37): every role's prompt
 * version and the whole literal inventory, recorded on every card, footprint,
 * benchmark and A/B, and checked by the release gate (CX-N6-2). It changes
 * whenever any role's prompts do, so no role's change ships unmeasured.
 */
let shippedFull: string | undefined;

export function fullContextVersion(inputs: PromptVersionInputs = {}): string {
  // The shipped inputs do not change while a build runs: computed once (every card records it).
  if (inputs.inventory === undefined && inputs.charsPerToken === undefined) {
    shippedFull ??= fullContextVersion({ inventory: recordedLiteralInventory() });
    return shippedFull;
  }
  const inventory = inputs.inventory ?? recordedLiteralInventory();
  const versions = rolePromptVersions({ ...inputs, inventory });
  return createHash("sha256")
    .update(
      [...MODEL_ROLES.map((r) => `${r} ${versions[r]}`), `inventory ${inventory}`].join("\n--\n"),
    )
    .digest("hex")
    .slice(0, 16);
}
