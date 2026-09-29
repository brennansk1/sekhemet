import { MODEL_ROLES, type ModelRole } from "@sekhemet/models";
import {
  ALLOCATOR_WINDOW_MARGIN_TOKENS,
  type ContextRole,
  ROLE_ANSWER_TOKENS,
} from "./allocator.js";
import { DEFAULT_PRESSURE_THRESHOLDS } from "./pressure.js";
import type { LiteralInventory } from "./prompt_literals.js";
import type { COPY_MODULES } from "./prompt_tags.js";
import { FALLBACK_CHARS_PER_TOKEN } from "./tokens.js";
import { WORKER_PRIORITIES } from "./worker_priorities.js";
import { PROMPT_ZONE_BUDGETS, PROMPT_ZONE_FRACTIONS } from "./zones.js";

/**
 * Which role reads each model-facing text (context rule 27, CX-N6-4; live-test
 * F24): a role's prompt version hashes only its own copy modules, literals,
 * tool schemas and budget policy, so a Seshat or Review model prompt change
 * leaves the Coding model's version, and its qualification, as they were.
 */

/**
 * Each registered copy module's roles: the role whose model reads its
 * sentences. The qualification suite's copy is the suite's own text,
 * versioned by the suite version, and belongs to no role.
 */
export const COPY_MODULE_ROLES: Readonly<Record<keyof typeof COPY_MODULES, readonly ModelRole[]>> =
  {
    design: ["planner"],
    // Gate remedies and sandbox refusals reach the Worker as observations.
    gates: ["worker"],
    pm: ["planner"],
    pm_skill: ["planner"],
    planner: ["planner"],
    qualification: [],
    // The re-plan is written by the Planning model.
    replan: ["planner"],
    research: ["researcher"],
    review: ["reviewer"],
    sandbox: ["worker"],
    worker: ["worker"],
  };

/**
 * Files holding model-facing literals outside a copy module, by path prefix,
 * with the roles that read them; the first match decides. A text no model
 * reads in a role (a protocol error to an external client, the speed probe)
 * belongs to none.
 */
export const LITERAL_FILE_ROLES: readonly (readonly [
  prefix: string,
  roles: readonly ModelRole[],
])[] = [
  ["packages/loop/", ["worker"]],
  ["packages/context/", ["worker"]],
  ["packages/sandbox/", ["worker"]],
  ["packages/gates/", ["worker"]],
  // The rebase directive a card's re-run reads.
  ["packages/sync/", ["worker"]],
  ["packages/planner/", ["planner"]],
  // Mined skills are written by the Planning model.
  ["packages/eval/src/loops.ts", ["planner"]],
  ["packages/models/src/calibration.ts", []],
  // Apodex's required system prompt, the Research model's.
  ["packages/models/src/llama_server.ts", ["researcher"]],
  ["apps/harness/src/research/", ["researcher"]],
  ["apps/harness/src/pm/", ["planner"]],
  // Seshat's answer to the Worker's mid-card question.
  ["apps/harness/src/index.ts", ["planner"]],
  // Seshat's lessons and the lead's profile.
  ["apps/harness/src/learning/reflect.ts", ["planner"]],
  ["apps/harness/src/learning/review", ["reviewer"]],
  // An attached image described for planning, and a split proposed.
  ["apps/harness/src/attachments.ts", ["planner"]],
  ["apps/harness/src/rest_extra.ts", ["planner"]],
  ["apps/harness/src/onboard.ts", ["planner"]],
  // The ACP method error goes to an external client, not a role's model.
  ["apps/harness/src/acp.ts", []],
];

/**
 * The roles a literal's file belongs to. A file no prefix names counts for
 * every role, so a new file can only make a version stricter; the inventory
 * test keeps every recorded file named.
 */
export function literalFileRoles(file: string): { roles: ModelRole[]; mapped: boolean } {
  const hit = LITERAL_FILE_ROLES.find(([prefix]) => file.startsWith(prefix));
  return hit ? { roles: [...hit[1]], mapped: true } : { roles: [...MODEL_ROLES], mapped: false };
}

/**
 * The recorded literal inventory (`prompt_literals_baseline.json`) narrowed
 * to one role's files, as stable text. An inventory that cannot be read is
 * taken whole, for every role.
 */
export function literalInventoryForRole(inventoryText: string, role: ModelRole): string {
  let inventory: LiteralInventory;
  try {
    inventory = JSON.parse(inventoryText) as LiteralInventory;
    if (!Array.isArray(inventory.literals)) return inventoryText;
  } catch {
    return inventoryText;
  }
  return JSON.stringify(
    inventory.literals
      .filter((l) => literalFileRoles(l.file).roles.includes(role))
      .map((l) => [l.file, l.hash]),
  );
}

/** The context roles whose answer reserve a model role's calls use: Seshat is the Planning model's. */
const CONTEXT_ROLES: Readonly<Record<ModelRole, readonly ContextRole[]>> = {
  worker: ["worker"],
  planner: ["planner", "seshat"],
  reviewer: ["reviewer"],
  researcher: ["researcher"],
};

/**
 * One role's budget policy as stable text (context rule 27): the estimator's
 * ratio, the role's answer reserves and the allocator's margin; for the
 * Coding model also the zone caps and fractions, the pressure tiers and its
 * section priorities (DEC-27).
 */
export function rolePolicyText(
  role: ModelRole,
  reserves: Readonly<Record<ContextRole, number>> = ROLE_ANSWER_TOKENS,
): string {
  const json = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());
  const own = Object.fromEntries(CONTEXT_ROLES[role].map((r) => [r, reserves[r]]));
  return [
    `role ${role}`,
    `chars per token ${FALLBACK_CHARS_PER_TOKEN}`,
    `answer reserves ${json(own)} margin ${ALLOCATOR_WINDOW_MARGIN_TOKENS}`,
    ...(role === "worker"
      ? [
          `zone budgets ${json(PROMPT_ZONE_BUDGETS)}`,
          `zone fractions ${json(PROMPT_ZONE_FRACTIONS)}`,
          `pressure ${json(DEFAULT_PRESSURE_THRESHOLDS)}`,
          `worker priorities ${json(WORKER_PRIORITIES)}`,
        ]
      : []),
  ].join("\n");
}
