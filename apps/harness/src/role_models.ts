import {
  type AssignedRole,
  type LocalInferenceAdapter,
  MODEL_ROLES,
  type ModelRegistry,
  type ModelRole,
  ROLE_WORDS,
  type RoleAssignmentRecord,
  UNFILLED,
  currentAssignment,
  fillReviewerDefault,
  hostFingerprintHash,
} from "@sekhemet/models";
import { defaultWorkerName, effectiveConfig } from "./config_apply.js";
import { describeModel } from "./model_access.js";
import { DEFAULT_PM_MODEL } from "./pm/service.js";
import { type CombinationDeps, verifiedReviewerRole } from "./qualify.js";
import { familyOf, resolveReviewerRole } from "./review_flow.js";

/**
 * Each role's model as this project runs it, and where it comes from
 * (S1B-B25; models rule 30a, MD-N10-3; NAMING's role names, DEC-31). One
 * resolution for `models list` and `init`'s report, in the order `run`, the
 * queue and Seshat take: a person's assignment on this host, then
 * `config.toml`'s `[models]` (the Coding and Planning models), then the
 * environment (the Research model, `SEKHEMET_RESEARCHER`), then the default.
 */
export interface RoleModel {
  role: AssignedRole;
  /** NAMING: *Coding model*, *Planning model*, *Review model*, *Research model*. */
  label: string;
  /** Undefined when the role has no model: an unfilled Review model, no Research model. */
  model?: string;
  source: "assigned" | "shipped" | "config" | "env" | "default" | "planning" | "unfilled" | "none";
  /** The source in words, as the report prints it. */
  from: string;
  /** The recorded baseline, when one is (`models list`). */
  baseline?: string;
}

/** The one role type's order (MD-N4-1): `out[0]` is the Coding model, `out[1]` the Planning model. */
const ROLES: readonly AssignedRole[] = MODEL_ROLES;

function fromAssignment(a: RoleAssignmentRecord): Pick<RoleModel, "source" | "from"> {
  return a.scope === "personal"
    ? { source: "assigned", from: `your assignment on this machine, ${a.date.slice(0, 10)}` }
    : { source: "shipped", from: "the shipped default for this machine" };
}

/** Why the Review role is unfilled when no model of another family is verified here. */
const NO_REVIEWER =
  "no model of another family than the Coding model's is verified on this machine, so a change reaches you without an AI review";

/**
 * The four roles' models (S1B-B25). The Review model's shipped default is
 * filled first, as `models list` always has (MD-N4-9, `fillReviewerDefault`):
 * a model of another family than the Coding model's verified here, or
 * recorded unfilled. The Review model shown is the one `run` and the queue
 * use: `resolveReviewerRole` (the assigned or shipped Review model, else the
 * Planning model, when of another family than the Coding model's) passed
 * through `verifiedReviewerRole` (verified for Review on this machine).
 */
export function effectiveRoleModels(
  repoPath: string,
  opts: {
    registry: ModelRegistry;
    host?: string;
    env?: NodeJS.ProcessEnv;
    /** How a model is described for its verification check; `describeModel` by default. */
    describe?: (name: string, role: ModelRole) => LocalInferenceAdapter;
    combinationDeps?: CombinationDeps;
  },
): RoleModel[] {
  const { registry } = opts;
  const host = opts.host ?? hostFingerprintHash();
  const env = opts.env ?? process.env;
  let models: { executor?: string; planner?: string } = {};
  try {
    models = effectiveConfig(repoPath).config.models;
  } catch {
    // An unreadable configuration is the configuration check's to report.
  }
  const assigned = (role: AssignedRole) => {
    const a = currentAssignment(registry, host, role);
    return a && a.model !== UNFILLED ? a : undefined;
  };
  const configured = (key: "executor" | "planner") => {
    const v = models[key]?.trim();
    return v && v !== "auto" && v !== "none" ? v : undefined;
  };

  const out: RoleModel[] = [];
  for (const role of ROLES) {
    const label = ROLE_WORDS[role] ?? role;
    const baseline = currentAssignment(registry, host, role, "baseline")?.model;
    const base = { role, label, ...(baseline ? { baseline } : {}) };
    if (role === "reviewer") {
      const worker = out[0]?.model;
      const family = (worker ? registry.get(worker)?.family : undefined) ?? "qwen";
      fillReviewerDefault(registry, host, family);
    }
    const a = assigned(role);
    if (role === "reviewer") {
      out.push({ ...base, ...reviewerModel(a, out, opts, host) });
      continue;
    }
    if (a) {
      out.push({ ...base, model: a.model, ...fromAssignment(a) });
      continue;
    }
    if (role === "worker" || role === "planner") {
      const key = role === "worker" ? "executor" : "planner";
      const fromConfig = configured(key);
      out.push(
        fromConfig
          ? { ...base, model: fromConfig, source: "config", from: `config.toml [models] ${key}` }
          : {
              ...base,
              model: role === "worker" ? defaultWorkerName() : DEFAULT_PM_MODEL,
              source: "default",
              from: role === "worker" ? "the default for this machine's memory" : "the default",
            },
      );
    } else if (role === "researcher" && env.SEKHEMET_RESEARCHER) {
      out.push({
        ...base,
        model: env.SEKHEMET_RESEARCHER,
        source: "env",
        from: "SEKHEMET_RESEARCHER",
      });
    } else {
      out.push({
        ...base,
        source: "none",
        from: "research runs once one is assigned: sekhemet models assign researcher <model>",
      });
    }
  }
  return out;
}

/**
 * The Review role as `run` and the queue resolve it (S1B-B25): the assigned
 * or shipped Review model, else the Planning model, of another family than
 * the Coding model's and verified for Review here; else unfilled, saying why.
 */
function reviewerModel(
  a: RoleAssignmentRecord | undefined,
  out: readonly RoleModel[],
  opts: {
    registry: ModelRegistry;
    describe?: (name: string, role: ModelRole) => LocalInferenceAdapter;
    combinationDeps?: CombinationDeps;
  },
  host: string,
): Pick<RoleModel, "model" | "source" | "from"> {
  const { registry } = opts;
  const worker = out[0]?.model ?? defaultWorkerName();
  const resolved = resolveReviewerRole({
    reviewer: a?.model,
    planner: out[1]?.model,
    worker,
    familyOf: (m) => familyOf(m, registry),
  });
  const role = verifiedReviewerRole(
    registry,
    resolved,
    opts.describe ?? ((name, r) => describeModel(name, r, { registry })),
    { host: () => host, ...opts.combinationDeps },
  );
  if (role.state === "filled") {
    return role.queue === "reviewer" && a
      ? { model: role.model, ...fromAssignment(a) }
      : {
          model: role.model,
          source: "planning",
          from: "the Planning model, of another family than the Coding model's",
        };
  }
  // Verified out: the refusal says which model and how to verify it.
  if (resolved.state === "filled") return { source: "unfilled", from: role.reason };
  if (!a) return { source: "unfilled", from: NO_REVIEWER };
  // resolveReviewerRole fails closed: a family not known is not another family.
  const family = familyOf(a.model, registry);
  const why =
    family !== undefined && family === familyOf(worker, registry)
      ? `${a.model} is of the Coding model's family`
      : `${a.model}'s family, or the Coding model's, is not known`;
  return { source: "unfilled", from: `${why}; ${NO_REVIEWER}` };
}

/** One line per role: `Coding model: nail-mtp (config.toml [models] executor)`. */
export function roleModelLines(roles: readonly RoleModel[]): string[] {
  return roles.map((r) =>
    r.model
      ? `${r.label}: ${r.model} (${r.from})${r.baseline ? `; baseline ${r.baseline}` : ""}`
      : `${r.label}: ${r.source === "unfilled" ? "unfilled" : "none"} — ${r.from}`,
  );
}
