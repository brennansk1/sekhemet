import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STEP_BUDGET, type TomlTable, parseToml } from "@sekhemet/kernel";
import { userDir } from "./user_dir.js";

export type MachineTier = "auto" | "S" | "M" | "L" | "XL";
/** Tri-state, not a boolean: "allowlist" is a distinct posture from open or offline. */
export type NetworkMode = "offline" | "allowlist" | "open";

export interface SekhemetConfig {
  machine: {
    tier: MachineTier;
    /** Hours reserved for interactive human use, e.g. "08:00-18:00 Mon-Fri". */
    hours: string;
    /** 0 means unlimited. */
    powerBudgetKwhDay: number;
  };
  models: { executor: string; planner: string; vision: string; pruner: string };
  context: {
    workingBudget: number | "auto";
    mapTokens: number;
    maskAfterObservations: number;
  };
  loop: { defaultStepBudget: number; stallWindow: number; maxRungs: number };
  review: {
    wip: number | "auto";
    reviewMinutesPerDay: number;
    /** External CI checks the project declares blocking (kernel rule 37, K-N8-4). */
    blockingChecks: string[];
    /** The branch cards are cut from and accepted into (review-git §2.6.2, RG-S5-14). */
    integrationBranch: string;
    /** The git remote pull-request-on-accept pushes to (integrations item 15, INT-12). */
    remote: string;
    /** An accept needs a code owner of the card's files (review-git §2.4.2, RG-N5-4). */
    requireCodeOwnerAccept: boolean;
    /**
     * A dependency bot's pull request that passes every gate is set to
     * auto-merge (integrations INT-16a); off, it is left for a person (INT-16).
     */
    autoMergeDependencies: boolean;
  };
  /**
   * Solo or the Team setup ([teams](teams.md) §3): read from the user
   * config only — a repository cannot switch its reader into solo (INT-26).
   */
  team: { mode: "solo" | "team" };
  network: { mode: NetworkMode; allow: string[] };
  sync: { github: boolean; forgejo: string };
  telemetry: { store: string };
}

/**
 * Built-in defaults.
 *
 * These are the design's stated values. Several differ from what the code used
 * to hardcode (step budget 50 vs 40, review WIP 3 vs auto, port 3333 vs 4040);
 * config is now the single place those live.
 */
export const DEFAULT_CONFIG: SekhemetConfig = {
  machine: { tier: "auto", hours: "08:00-18:00 Mon-Fri", powerBudgetKwhDay: 0 },
  models: { executor: "auto", planner: "auto", vision: "auto", pruner: "auto" },
  context: { workingBudget: "auto", mapTokens: 1024, maskAfterObservations: 2 },
  loop: { defaultStepBudget: DEFAULT_STEP_BUDGET, stallWindow: 3, maxRungs: 4 },
  review: {
    wip: "auto",
    reviewMinutesPerDay: 60,
    blockingChecks: [],
    integrationBranch: "main",
    remote: "origin",
    requireCodeOwnerAccept: false,
    autoMergeDependencies: false,
  },
  team: { mode: "solo" },
  network: { mode: "offline", allow: [] },
  sync: { github: false, forgejo: "" },
  telemetry: { store: "local" },
};

export interface ConfigLayer {
  name: string;
  path?: string;
  values: TomlTable;
}

function table(source: TomlTable | undefined, key: string): TomlTable {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TomlTable) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function strArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : fallback;
}

/** Deep-merge TOML tables, with later layers overriding earlier ones. */
function mergeTables(base: TomlTable, override: TomlTable): TomlTable {
  const out: TomlTable = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = mergeTables(existing as TomlTable, value as TomlTable);
    } else {
      out[key] = value as never;
    }
  }
  return out;
}

function readLayer(name: string, path: string): ConfigLayer | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return { name, path, values: parseToml(readFileSync(path, "utf8")) };
  } catch {
    // A malformed layer is skipped rather than aborting startup; `doctor`
    // surfaces it. Refusing to boot because of a stray character in an optional
    // user file is worse than running on defaults.
    return undefined;
  }
}

/**
 * `review_minutes_per_day` (review-git §2.2.3, RG-S6-8): greater than 0. A
 * value of 0 or less is refused — named in `problems` and not applied — so
 * ReviewWIP is never derived from it nor from a static limit.
 */
function positiveReviewMinutes(value: unknown, problems: string[]): number {
  if (value === undefined) return DEFAULT_CONFIG.review.reviewMinutesPerDay;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(
      `review.review_minutes_per_day must be greater than 0 (got ${String(value)}); the value was refused and ${DEFAULT_CONFIG.review.reviewMinutesPerDay} applies`,
    );
    return DEFAULT_CONFIG.review.reviewMinutesPerDay;
  }
  return value;
}

/** A plausible git branch name, else the fallback. */
function branchName(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\w./-]+$/.test(value) && !value.includes("..")
    ? value
    : fallback;
}

/** A git remote's name: no path, no option, nothing git would read as a URL. */
function remoteName(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\w][\w.-]*$/.test(value) && !value.includes("..")
    ? value
    : fallback;
}

function project(merged: TomlTable, problems: string[] = [], user?: TomlTable): SekhemetConfig {
  const d = DEFAULT_CONFIG;
  const machine = table(merged, "machine");
  const models = table(merged, "models");
  const context = table(merged, "context");
  const loop = table(merged, "loop");
  const review = table(merged, "review");
  const network = table(merged, "network");
  const sync = table(merged, "sync");
  const telemetry = table(merged, "telemetry");

  const modeRaw = str(network.mode, d.network.mode);
  const mode: NetworkMode =
    modeRaw === "offline" || modeRaw === "allowlist" || modeRaw === "open"
      ? modeRaw
      : d.network.mode;

  const tierRaw = str(machine.tier, d.machine.tier);
  const tier = (["auto", "S", "M", "L", "XL"] as const).includes(tierRaw as MachineTier)
    ? (tierRaw as MachineTier)
    : d.machine.tier;

  return {
    machine: {
      tier,
      hours: str(machine.hours, d.machine.hours),
      powerBudgetKwhDay: num(machine.power_budget_kwh_day, d.machine.powerBudgetKwhDay),
    },
    models: {
      executor: str(models.executor, d.models.executor),
      planner: str(models.planner, d.models.planner),
      vision: str(models.vision, d.models.vision),
      pruner: str(models.pruner, d.models.pruner),
    },
    context: {
      workingBudget:
        context.working_budget === "auto" || context.working_budget === undefined
          ? d.context.workingBudget
          : num(context.working_budget, 0),
      mapTokens: num(context.map_tokens, d.context.mapTokens),
      maskAfterObservations: num(context.mask_after_observations, d.context.maskAfterObservations),
    },
    loop: {
      defaultStepBudget: num(loop.default_step_budget, d.loop.defaultStepBudget),
      stallWindow: num(loop.stall_window, d.loop.stallWindow),
      maxRungs: num(loop.max_rungs, d.loop.maxRungs),
    },
    review: {
      wip: review.wip === "auto" || review.wip === undefined ? "auto" : num(review.wip, 3),
      reviewMinutesPerDay: positiveReviewMinutes(review.review_minutes_per_day, problems),
      blockingChecks: strArray(review.blocking_checks, d.review.blockingChecks),
      integrationBranch: branchName(review.integration_branch, d.review.integrationBranch),
      remote: remoteName(review.remote, d.review.remote),
      requireCodeOwnerAccept: bool(
        review.require_code_owner_accept,
        d.review.requireCodeOwnerAccept,
      ),
      autoMergeDependencies: bool(review.auto_merge_dependencies, d.review.autoMergeDependencies),
    },
    team: { mode: user?.team && table(user, "team").mode === "team" ? "team" : "solo" },
    network: { mode, allow: strArray(network.allow, d.network.allow) },
    sync: {
      github: bool(sync.github, d.sync.github),
      forgejo: str(sync.forgejo, d.sync.forgejo),
    },
    telemetry: { store: str(telemetry.store, d.telemetry.store) },
  };
}

export interface ResolveConfigOptions {
  repoPath: string;
  /** Per-card overrides, applied between project config and CLI flags. */
  cardOverrides?: TomlTable;
  /** CLI flags win over everything. */
  cliOverrides?: TomlTable;
  /** Override the user config location, mainly for tests. */
  userConfigPath?: string;
}

export interface ResolvedConfig {
  config: SekhemetConfig;
  /** Layers actually applied, in precedence order, for `doctor` to report. */
  layers: string[];
  /** Values refused, each naming its key (RG-S6-8). */
  problems: string[];
}

/**
 * Resolve configuration across all five layers.
 *
 * Order is defaults -> user -> project -> card overrides -> CLI flags. The card
 * layer is the one most easily dropped, and it is the one that lets a single
 * difficult card raise its own step budget without changing the project's.
 */
export function resolveConfig(options: ResolveConfigOptions): ResolvedConfig {
  const layers: ConfigLayer[] = [{ name: "defaults", values: {} }];

  const userPath =
    options.userConfigPath ?? process.env.SEKHEMET_USER_CONFIG ?? join(userDir(), "config.toml");
  const user = readLayer("user", userPath);
  if (user) layers.push(user);

  const proj = readLayer("project", join(options.repoPath, ".sekhemet", "config.toml"));
  if (proj) layers.push(proj);

  if (options.cardOverrides) layers.push({ name: "card", values: options.cardOverrides });
  if (options.cliOverrides) layers.push({ name: "cli", values: options.cliOverrides });

  const merged = layers.reduce<TomlTable>((acc, layer) => mergeTables(acc, layer.values), {});

  const problems: string[] = [];
  const config = project(merged, problems, user?.values);
  return { config, layers: layers.map((l) => l.name), problems };
}
