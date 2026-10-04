import { isOllamaCloudTag, ollamaCloudRefusal } from "./ollama_cloud.js";
import type { ModelRegistry, QualificationLookup, RoleAssignmentRecord } from "./registry.js";
import type { ModelRole } from "./types.js";

/** The roles as a person reads them (DEC-31). */
export const ROLE_WORDS: Record<string, string> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/**
 * Who changes a role's model, and on what evidence (models rule 30a,
 * NEW-models-10):
 *
 * - **a person, for their own use** (`personal`): any model qualified on
 *   this host for the role (rule 27a), with or without a benchmark; a
 *   Worker whose failed combination a person overrode also counts (MD-N4-4);
 * - **the recorded baseline and the shipped defaults** (`baseline`,
 *   `default`): only with a recorded bake-off on this host, on the role's
 *   full evaluation set — never a quick-benchmark score (MD-N10-1); the
 *   shipped defaults at first run need none (MD-N10-3);
 * - in every case the previous assignment stays restorable in one step (MD-N10-2).
 */

/** The four roles (models rule 21): the one role type. */
export type AssignedRole = ModelRole;
export type AssignmentScope = RoleAssignmentRecord["scope"];

/** Each role's full evaluation set, which a bake-off for it must run (MD-N10-1). */
export const ROLE_EVALUATION_SET: Record<AssignedRole, string> = {
  worker: "frozen-suite",
  planner: "planning-measure",
  reviewer: "seeded-defects",
  researcher: "research-golden-set",
};

/** A recorded benchmark of a model for a role on a host (a `measure/benchmarked` event). */
export interface BakeOffEvidence {
  /** The recorded event's id. */
  id: string;
  host: string;
  role: AssignedRole;
  model: string;
  /** `overnight` is the full evaluation set; `quick` is the screening set. */
  tier: "overnight" | "quick";
  evaluationSet: string;
  date: string;
}

export class AssignmentRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentRefusal";
  }
}

export interface AssignInput {
  role: AssignedRole;
  model: string;
  scope: AssignmentScope;
  /** Who assigns: a person (`person: <name>`) or the harness at first run. */
  by: string;
  host: string;
  /** The model's qualification for this role's combination on this host. */
  qualification: QualificationLookup["status"];
  /** The recorded bake-off, for a baseline or default change. */
  bakeOff?: BakeOffEvidence;
  /** The shipped defaults assigned at first run (no bake-off, MD-N10-3). */
  firstRun?: boolean;
  /** The model's family and the Worker's, from the registry (MD-N4-9). */
  families?: { model?: string; worker?: string };
}

function history(
  registry: ModelRegistry,
  host: string,
  role: string,
  scope: AssignmentScope,
): RoleAssignmentRecord[] {
  return registry.roleAssignments(host).filter((a) => a.role === role && a.scope === scope);
}

/**
 * The assignment in force for a role. `personal` falls back to the shipped
 * default when a person has chosen none.
 */
export function currentAssignment(
  registry: ModelRegistry,
  host: string,
  role: AssignedRole,
  scope: AssignmentScope = "personal",
): RoleAssignmentRecord | undefined {
  const own = history(registry, host, role, scope).at(-1);
  if (own || scope !== "personal") return own;
  return history(registry, host, role, "default").at(-1);
}

/** Why a baseline or default change is refused, or undefined when its bake-off admits it. */
function bakeOffRefusal(input: AssignInput): string | undefined {
  const set = ROLE_EVALUATION_SET[input.role];
  const b = input.bakeOff;
  const what = `changing the ${input.scope === "baseline" ? "recorded baseline" : "shipped default"} ${input.role} to ${input.model}`;
  if (!b)
    return `${what} requires a recorded bake-off on this host on the ${input.role}'s full evaluation set (${set}); none was given.`;
  if (b.tier !== "overnight")
    return `${what} requires a bake-off on the full evaluation set (${set}); a quick-benchmark score does not satisfy it.`;
  if (b.host !== input.host) return `${what}: the bake-off ${b.id} was recorded on another host.`;
  if (b.role !== input.role || b.evaluationSet !== set)
    return `${what} requires a bake-off on ${set}; ${b.id} ran ${b.evaluationSet} for the ${b.role} role.`;
  if (b.model !== input.model) return `${what}: the bake-off ${b.id} measured ${b.model}.`;
  return undefined;
}

/**
 * Assign a model to a role (MD-N10-1, MD-N10-3). Refuses, with an
 * `AssignmentRefusal` naming what is missing, a model not qualified here for
 * the role, and a baseline or default change without its bake-off.
 */
export function assignRole(
  registry: ModelRegistry,
  input: AssignInput,
): { assignment: RoleAssignmentRecord; previous?: RoleAssignmentRecord } {
  // Rule 14c, MD-N20-1: an Ollama cloud model sends its prompts off the
  // machine; no evidence admits it for any role.
  if (isOllamaCloudTag(input.model))
    throw new AssignmentRefusal(ollamaCloudRefusal(input.model, input.role));
  const qualified =
    input.qualification === "qualified" ||
    (input.role === "worker" && input.qualification === "overridden");
  if (!qualified) {
    throw new AssignmentRefusal(
      `Refusing the assignment: ${input.model} is not verified on this machine for the ${ROLE_WORDS[input.role] ?? input.role} (${input.qualification}). Verify it first: sekhemet qualify --models ${input.model}${input.role === "worker" ? "" : ` --role ${input.role}`}`,
    );
  }
  // MD-N4-9: the Reviewer reads the Worker's diff, so it is of another family.
  const f = input.families;
  if (input.role === "reviewer" && f?.model && f.worker && f.model === f.worker) {
    throw new AssignmentRefusal(
      `Refusing the assignment: ${input.model} is of the ${f.model} family, the Coding model's (${f.worker}); the Review model must be of another family.`,
    );
  }
  const previous = history(registry, input.host, input.role, input.scope).at(-1);
  if (input.scope !== "personal") {
    const firstDefault = input.firstRun === true && previous === undefined;
    const why = firstDefault ? undefined : bakeOffRefusal(input);
    if (why) throw new AssignmentRefusal(`Refusing the assignment: ${why}`);
  }
  const assignment: RoleAssignmentRecord = {
    role: input.role,
    model: input.model,
    scope: input.scope,
    by: input.by,
    date: new Date().toISOString(),
    ...(input.scope !== "personal" && input.bakeOff ? { bakeOff: input.bakeOff.id } : {}),
  };
  registry.recordRoleAssignment(input.host, assignment);
  return { assignment, ...(previous ? { previous } : {}) };
}

/**
 * Restore the assignment a role had before its current one, in one step
 * (MD-N10-2): `sekhemet models restore <role>`.
 */
export function restoreRole(
  registry: ModelRegistry,
  host: string,
  role: AssignedRole,
  options: { by: string; scope?: AssignmentScope },
): { assignment: RoleAssignmentRecord; replaced?: RoleAssignmentRecord } {
  const scope = options.scope ?? "personal";
  const all = history(registry, host, role, scope);
  const replaced = all.at(-1);
  const earlier = replaced
    ? [...all.slice(0, -1)].reverse().find((a) => a.model !== replaced.model)
    : undefined;
  if (!earlier) throw new AssignmentRefusal(`There is no earlier ${role} assignment to restore.`);
  // Rule 14c, MD-N20-1: an earlier assignment of an Ollama cloud model (one
  // recorded before the rule) is never restored.
  if (isOllamaCloudTag(earlier.model))
    throw new AssignmentRefusal(ollamaCloudRefusal(earlier.model, role));
  const assignment: RoleAssignmentRecord = {
    ...earlier,
    by: options.by,
    date: new Date().toISOString(),
    restored: true,
  };
  registry.recordRoleAssignment(host, assignment);
  return { assignment, ...(replaced ? { replaced } : {}) };
}

/** The Reviewer's default when no model of another family has qualified here (MD-N4-9). */
export const UNFILLED = "(unfilled)";

/**
 * The shipped Reviewer default for this host (MD-N4-9): a model of another
 * family than the Worker's whose newest qualification on this host passed;
 * with none, the Reviewer is recorded unfilled (the diff reaches the person
 * unreviewed, rule 23). A filled default stays until it is replaced.
 */
export function fillReviewerDefault(
  registry: ModelRegistry,
  host: string,
  workerFamily: string | undefined,
): RoleAssignmentRecord {
  const current = currentAssignment(registry, host, "reviewer", "default");
  if (current && current.model !== UNFILLED) return current;
  const candidate = registry.list().find((e) => {
    if (!e.family || e.family === workerFamily) return false;
    const newest = new Map<string, string>();
    for (const q of e.qualifications ?? []) {
      if (q.combination.host === host) newest.set(q.key, q.status);
    }
    return [...newest.values()].includes("qualified");
  });
  const model = candidate?.id ?? UNFILLED;
  if (current?.model === model) return current;
  const record: RoleAssignmentRecord = {
    role: "reviewer",
    model,
    scope: "default",
    by: "harness",
    date: new Date().toISOString(),
  };
  registry.recordRoleAssignment(host, record);
  return record;
}
