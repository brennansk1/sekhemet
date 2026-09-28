import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEFAULT_STEP_BUDGET, type TomlTable, parseToml } from "@sekhemet/kernel";
import { parseHours } from "./scheduler.js";
import type { IdentitySource, Level, OidcSettings } from "./team/settings.js";
import { userDir } from "./user_dir.js";

export type MachineTier = "auto" | "S" | "M" | "L" | "XL";
/** Tri-state, not a boolean: "allowlist" is a distinct posture from open or offline. */
export type NetworkMode = "offline" | "allowlist" | "open";

/**
 * A model folder a person added on the Configuration page (models rule 4a,
 * MD-N13-1): `folders = ["/path", { path = "/path", subfolders = true }]`.
 * Subfolders are scanned only when set, to the depth and file-count limits.
 */
export interface ModelFolderSetting {
  path: string;
  includeSubfolders: boolean;
}

export interface SekhemetConfig {
  machine: {
    tier: MachineTier;
    /**
     * `[machine] reserved_hours` (surface item 23, models rule 20): the
     * person's hours, e.g. "08:00-18:00 Mon-Fri"; unattended runs go outside
     * them. The old key `hours` is read when this one is absent, and reported.
     */
    reservedHours: string;
    /**
     * The same value as `reservedHours`, under the old name its readers use.
     * @deprecated read `reservedHours`.
     */
    hours: string;
    /**
     * `[machine] overnight_hours` (models rule 20, MD-N3-4): optional; it
     * narrows the overnight window, the complement of `reservedHours`.
     */
    overnightHours?: string;
    /** 0 means unlimited. */
    powerBudgetKwhDay: number;
  };
  models: {
    executor: string;
    planner: string;
    vision: string;
    pruner: string;
    /**
     * Smart Swap's headroom probe (models rule 20g): off until a calibration
     * night sets its reserves on this host (models §4; measurement rule 16d).
     */
    headroomProbe: boolean;
    /**
     * The Planner role's quick answerer (models rule 20f b): a small model
     * that answers while the Worker runs, informational only, when the
     * measured headroom admits it beside the Worker. Empty: none.
     */
    quickAnswerer: string;
    /**
     * `[models] folders` (surface item 23, models rule 4a): the folders the
     * Configuration page scans besides `--models-dir` and
     * `SEKHEMET_MODELS_DIR`. Read from the user config only.
     */
    folders: ModelFolderSetting[];
  };
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
  team: { mode: "solo" | "team"; workspace: string };
  /** Who a request is in the Team setup (teams §3, B4.10); user config only (INT-26). */
  identity: {
    sources: IdentitySource[];
    userHeader: string;
    trustedProxies: string[];
    openSignupDomains: string[];
    inviteTtlDays: number;
    publicUrl: string;
    oidc?: OidcSettings;
  };
  /** Session limits (teams item 14); user config only. */
  sessions: { idleMinutes: number; absoluteHours: number };
  /** Personal access tokens (teams item 15); user config only. */
  tokens: { defaultDays: number; maxDays: number };
  /** The shared queue (teams §3, TEAM-30): user config only (INT-26). */
  queue: { agentIssuesPerPerson: number };
  /** Fair share and aging (runtime item 4a, RUN-34): user config only. */
  scheduler: { fairShare: boolean; maxWaitS: number };
  network: { mode: NetworkMode; allow: string[] };
  sync: { github: boolean; forgejo: string };
  telemetry: { store: string };
  /**
   * `[docs]` (design-stage DS-N3-3, -4, -6): the repository-relative folders
   * the project documents go to — unset, `docs/product` and the existing ADR
   * folder or `docs/decisions` — and whether they carry role labels in place
   * of names by default.
   */
  docs: { product?: string; decisions?: string; noNames: boolean };
}

/**
 * Built-in defaults.
 *
 * These are the design's stated values. Several differ from what the code used
 * to hardcode (step budget 50 vs 40, review WIP 3 vs auto, port 3333 vs 4040);
 * config is now the single place those live.
 */
export const DEFAULT_CONFIG: SekhemetConfig = {
  machine: {
    tier: "auto",
    reservedHours: "08:00-18:00 Mon-Fri",
    hours: "08:00-18:00 Mon-Fri",
    powerBudgetKwhDay: 0,
  },
  models: {
    executor: "auto",
    planner: "auto",
    vision: "auto",
    pruner: "auto",
    headroomProbe: false,
    quickAnswerer: "",
    folders: [],
  },
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
  team: { mode: "solo", workspace: "Sekhemet" },
  identity: {
    sources: ["accounts"],
    userHeader: "x-forwarded-email",
    trustedProxies: [],
    openSignupDomains: [],
    inviteTtlDays: 7,
    publicUrl: "",
  },
  sessions: { idleMinutes: 60, absoluteHours: 24 },
  tokens: { defaultDays: 90, maxDays: 365 },
  queue: { agentIssuesPerPerson: 1 },
  scheduler: { fairShare: true, maxWaitS: 600 },
  network: { mode: "offline", allow: [] },
  sync: { github: false, forgejo: "" },
  telemetry: { store: "local" },
  docs: { noNames: false },
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

/**
 * `[models] folders` from the user config only (models rule 4a: "kept in the
 * user configuration"): a repository, a card or a flag cannot point the
 * scan at a folder the person did not add.
 */
function modelFolders(user: TomlTable | undefined): ModelFolderSetting[] {
  const raw = table(user, "models").folders;
  if (!Array.isArray(raw)) return [];
  const out: ModelFolderSetting[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push({ path: entry, includeSubfolders: false });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const t = entry as TomlTable;
      if (typeof t.path === "string" && t.path.length > 0) {
        out.push({ path: t.path, includeSubfolders: t.subfolders === true });
      }
    }
  }
  return out;
}

/**
 * `[machine] reserved_hours`, else the old `hours` (surface item 25: renamed,
 * the old name read and reported for one release).
 */
function reservedHours(machine: TomlTable, problems: string[]): string {
  if (typeof machine.reserved_hours === "string") return machine.reserved_hours;
  if (typeof machine.hours === "string") {
    problems.push(
      "machine.hours is the old name of machine.reserved_hours; it was read as reserved_hours — rename it",
    );
    return machine.hours;
  }
  return DEFAULT_CONFIG.machine.reservedHours;
}

/** `[machine] overnight_hours`: optional; a value `parseHours` cannot read is refused. */
function overnightHours(value: unknown, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      parseHours(value);
      return value;
    } catch {
      // refused below
    }
  }
  problems.push(
    `machine.overnight_hours cannot be read (got ${JSON.stringify(value)}); use e.g. "22:00-06:00". It was refused and the overnight window is the complement of reserved_hours`,
  );
  return undefined;
}

const DOCS_KEYS = ["product", "decisions", "no_names"];

/**
 * `[docs]` (DS-N3-3, -4, -6): each folder repository-relative, inside the
 * repository; `no_names` true or false. Anything else — a folder outside the
 * repository, another value, a key not listed — is refused and named in
 * `problems`, and the default applies.
 */
function docsSettings(docs: TomlTable, problems: string[]): SekhemetConfig["docs"] {
  for (const key of Object.keys(docs)) {
    if (!DOCS_KEYS.includes(key)) {
      problems.push(`docs.${key} is not a setting (${DOCS_KEYS.join(", ")}); it was refused`);
    }
  }
  const folder = (key: "product" | "decisions"): string | undefined => {
    const v = docs[key];
    if (v === undefined) return undefined;
    const path = typeof v === "string" ? v.trim().replace(/^\.\//, "").replace(/\/+$/, "") : "";
    if (
      path &&
      !isAbsolute(path) &&
      !/^[a-z]:/i.test(path) &&
      !path.split(/[\\/]/).includes("..")
    ) {
      return path;
    }
    problems.push(
      `docs.${key} must be a folder inside the repository (got ${JSON.stringify(v)}); it was refused and the default applies`,
    );
    return undefined;
  };
  const product = folder("product");
  const decisions = folder("decisions");
  let noNames = DEFAULT_CONFIG.docs.noNames;
  if (typeof docs.no_names === "boolean") noNames = docs.no_names;
  else if (docs.no_names !== undefined) {
    problems.push(
      `docs.no_names must be true or false (got ${JSON.stringify(docs.no_names)}); it was refused and false applies`,
    );
  }
  return { ...(product ? { product } : {}), ...(decisions ? { decisions } : {}), noNames };
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

  const reserved = reservedHours(machine, problems);
  const overnight = overnightHours(machine.overnight_hours, problems);

  return {
    machine: {
      tier,
      reservedHours: reserved,
      hours: reserved,
      ...(overnight !== undefined ? { overnightHours: overnight } : {}),
      powerBudgetKwhDay: num(machine.power_budget_kwh_day, d.machine.powerBudgetKwhDay),
    },
    models: {
      executor: str(models.executor, d.models.executor),
      planner: str(models.planner, d.models.planner),
      vision: str(models.vision, d.models.vision),
      pruner: str(models.pruner, d.models.pruner),
      headroomProbe: bool(models.headroom_probe, d.models.headroomProbe),
      quickAnswerer: str(models.quick_answerer, d.models.quickAnswerer),
      folders: modelFolders(user),
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
    ...userOnly(user),
    scheduler: {
      fairShare: bool(table(user, "scheduler").fair_share, d.scheduler.fairShare),
      maxWaitS: Math.max(1, num(table(user, "scheduler").max_wait_s, d.scheduler.maxWaitS)),
    },
    network: { mode, allow: strArray(network.allow, d.network.allow) },
    sync: {
      github: bool(sync.github, d.sync.github),
      forgejo: str(sync.forgejo, d.sync.forgejo),
    },
    telemetry: { store: str(telemetry.store, d.telemetry.store) },
    docs: docsSettings(table(merged, "docs"), problems),
  };
}

function positive(value: unknown, fallback: number, max = Number.POSITIVE_INFINITY): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : fallback;
}

const SOURCES: readonly IdentitySource[] = ["accounts", "proxy", "oidc", "passkeys"];
const LEVEL_NAMES: readonly Level[] = ["admin", "member", "stakeholder", "viewer"];

function oidcOf(identity: TomlTable): OidcSettings | undefined {
  const o = table(identity, "oidc");
  if (typeof o.issuer !== "string" || typeof o.client_id !== "string") return undefined;
  const levels: Record<string, Level> = {};
  for (const [claim, level] of Object.entries(table(o, "levels"))) {
    if (LEVEL_NAMES.includes(level as Level)) levels[claim] = level as Level;
  }
  return {
    issuer: o.issuer,
    clientId: o.client_id,
    ...(typeof o.display_name === "string" ? { displayName: o.display_name } : {}),
    ...(typeof o.client_secret_env === "string" ? { clientSecretEnv: o.client_secret_env } : {}),
    ...(typeof o.redirect_uri === "string" ? { redirectUri: o.redirect_uri } : {}),
    claim: str(o.claim, "groups"),
    levels,
    strict: bool(o.strict, true),
    levelsManagedBy: o.levels_managed_by === "provider" ? "provider" : "sekhemet",
  };
}

/**
 * `[team]`, `[identity]`, `[sessions]`, `[tokens]` and `[queue]` (teams §3):
 * read from the user config only. A repository's `.sekhemet/config.toml`
 * cannot switch its reader's setup, trust a proxy, lengthen a session or
 * raise a cap (integrations INT-26).
 */
function userOnly(
  user: TomlTable | undefined,
): Pick<SekhemetConfig, "team" | "identity" | "sessions" | "tokens" | "queue"> {
  const d = DEFAULT_CONFIG;
  const team = table(user, "team");
  const identity = table(user, "identity");
  const sessions = table(user, "sessions");
  const tokens = table(user, "tokens");
  const queue = table(user, "queue");
  const sources = strArray(identity.sources, d.identity.sources).filter((s): s is IdentitySource =>
    SOURCES.includes(s as IdentitySource),
  );
  const oidc = oidcOf(identity);
  return {
    team: {
      mode: team.mode === "team" ? "team" : "solo",
      workspace: str(team.workspace, d.team.workspace),
    },
    identity: {
      sources: sources.length > 0 ? sources : d.identity.sources,
      userHeader: str(identity.user_header, d.identity.userHeader).toLowerCase(),
      trustedProxies: strArray(identity.trusted_proxies, d.identity.trustedProxies),
      openSignupDomains: strArray(identity.open_signup_domains, d.identity.openSignupDomains),
      inviteTtlDays: positive(identity.invite_ttl_days, d.identity.inviteTtlDays, 30),
      publicUrl: str(identity.public_url, d.identity.publicUrl),
      ...(oidc ? { oidc } : {}),
    },
    sessions: {
      idleMinutes: positive(sessions.idle_minutes, d.sessions.idleMinutes),
      absoluteHours: positive(sessions.absolute_hours, d.sessions.absoluteHours),
    },
    tokens: {
      defaultDays: positive(tokens.default_days, d.tokens.defaultDays, 365),
      maxDays: positive(tokens.max_days, d.tokens.maxDays, 365),
    },
    queue: {
      agentIssuesPerPerson: Math.floor(
        positive(queue.agent_issues_per_person, d.queue.agentIssuesPerPerson),
      ),
    },
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
  /** The layer each value a file sets came from, by dotted key (DB-N4-1); the rest are defaults. */
  sources: Record<string, string>;
}

/**
 * Resolve configuration across all five layers.
 *
 * Order is defaults -> user -> project -> card overrides -> CLI flags. The card
 * layer is the one most easily dropped, and it is the one that lets a single
 * difficult card raise its own step budget without changing the project's.
 */
/** The user config: `SEKHEMET_USER_CONFIG`, else `<user dir>/config.toml`. */
export function userConfigPath(): string {
  return process.env.SEKHEMET_USER_CONFIG ?? join(userDir(), "config.toml");
}

/**
 * Why the user config cannot be read, or undefined when it can or is absent
 * (teams M6). `[team] mode` lives only there, so a file that exists but
 * cannot be read or parsed is an error: guessing Solo would hand every
 * request an Admin's access on a Team install.
 */
export function userConfigError(path = userConfigPath()): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    parseToml(readFileSync(path, "utf8"));
    return undefined;
  } catch (err) {
    return `The user config ${path} cannot be read (${err instanceof Error ? err.message : String(err)}). Fix it: Sekhemet will not guess Solo or Team.`;
  }
}

/** The setup `[team] mode` names (teams §3); throws when the user config cannot be read (M6). */
export function userSetup(): "solo" | "team" {
  const problem = userConfigError();
  if (problem) throw new Error(problem);
  return resolveConfig({ repoPath: process.cwd() }).config.team.mode;
}

export function resolveConfig(options: ResolveConfigOptions): ResolvedConfig {
  const layers: ConfigLayer[] = [{ name: "defaults", values: {} }];

  const userPath = options.userConfigPath ?? userConfigPath();
  const user = readLayer("user", userPath);
  if (user) layers.push(user);

  const proj = readLayer("project", join(options.repoPath, ".sekhemet", "config.toml"));
  if (proj) layers.push(proj);

  if (options.cardOverrides) layers.push({ name: "card", values: options.cardOverrides });
  if (options.cliOverrides) layers.push({ name: "cli", values: options.cliOverrides });

  const merged = layers.reduce<TomlTable>((acc, layer) => mergeTables(acc, layer.values), {});

  const problems: string[] = [];
  const config = project(merged, problems, user?.values);
  return {
    config,
    layers: layers.map((l) => l.name),
    problems,
    sources: keySources(layers, problems),
  };
}

/**
 * Which layer each value set in a file came from (dashboard DB-N4-1): the
 * last layer to set a dotted key wins. A key no layer sets is the default's
 * and is absent; so is a value that was refused, whose default applies.
 */
function keySources(layers: ConfigLayer[], problems: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (values: TomlTable, prefix: string, layer: string) => {
    for (const [key, value] of Object.entries(values)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as TomlTable, dotted, layer);
      } else {
        out[dotted] = layer;
      }
    }
  };
  for (const layer of layers) walk(layer.values, "", layer.name);
  for (const key of Object.keys(out)) {
    if (problems.some((p) => p.startsWith(`${key} `))) delete out[key];
  }
  return out;
}
