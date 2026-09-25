import { createHash } from "node:crypto";

/**
 * One recorded `RunProfile` (measurement rule 9a, MS-M9-4, MS-M9-5).
 *
 * A run's settings are resolved once — defaults, configuration, a named
 * settings file, the experiment switches, then flags — into one object that
 * is written into the run's evidence. Every flag sets exactly one setting; a
 * flag that would set others (`--profile full` pushed four) is refused, and
 * the same arm is named with `--settings <file>`, whose content hash is
 * recorded. [surface.md](surface.md) SUR-44/45 are the command line's share
 * of the same object (B3.3); this module is the one type both use.
 */

export type ThinkingPolicy = "off" | "surgical" | "all";
export type WorkerMethod = "baseline" | "strict";
export type PruneArm = "query" | "random";

export interface RunProfile {
  schema: 1;
  /** The model per role; a role absent here is not in the run. */
  roles: { worker?: string; manager?: string; reviewer?: string; researcher?: string };
  policies: {
    exploration: boolean;
    review: boolean;
    escalateRetries: boolean;
    /** The step cap every card's budget is held to; null is each card's own budget. */
    stepCap: number | null;
    autoAccept: boolean;
  };
  /** The experiment switches (CLAUDE.md), recorded in every evidence bundle. */
  switches: {
    thinking: ThinkingPolicy;
    workerMethod: WorkerMethod;
    /** The evidence-gated commit (worker-loop rule 29a, `SEKHEMET_EVIDENCE_GATE`); "off" by default. */
    evidenceGate: "off" | "on";
    /**
     * The Worker's tool set (M2, worker-loop rule 11): `progressive` (the
     * default) loads tools on demand; `fixed` offers the class's set at once.
     */
    toolArm: "progressive" | "fixed";
    /** A fixed sampling seed for the card's model (rule 10); unset is the server's own. */
    seed?: number;
    /**
     * How an oversized file is cut for the prompt (MS-T7-6): the context
     * pruner (`query`, the default) or its null arm (`random`).
     */
    prune?: PruneArm;
  };
  /** The arm an A/B varies, when this run is one arm of one. */
  armUnderTest?: string;
  /** The `--settings` file applied as one layer: its path, SHA-256 and contents (SUR-45). */
  settingsFile?: { path: string; sha256: string; contents?: string };
  /** Where each resolved value came from, for the record; not part of the hash. */
  sources: Record<string, ProfileSource>;
}

export type ProfileSource = "default" | "config" | "settings" | "env" | "flag";

/**
 * The experiment switches: environment variables that choose an arm of the
 * Worker's behaviour (CLAUDE.md), each recorded in the RunProfile.
 */
export const EXPERIMENT_SWITCHES = [
  "SEKHEMET_THINKING",
  "SEKHEMET_WORKER_METHOD",
  "SEKHEMET_PRUNE",
  "SEKHEMET_EVIDENCE_GATE",
] as const;

type Path =
  | `roles.${keyof RunProfile["roles"]}`
  | `policies.${keyof RunProfile["policies"]}`
  | "switches.seed"
  | "switches.prune"
  | "switches.toolArm";

/** Each flag sets exactly one setting. */
export const RUN_PROFILE_FLAGS: Readonly<Record<string, Path | "armUnderTest">> = {
  "--worker": "roles.worker",
  "--manager": "roles.manager",
  "--reviewer": "roles.reviewer",
  "--researcher": "roles.researcher",
  "--explore": "policies.exploration",
  "--review": "policies.review",
  "--escalate-retries": "policies.escalateRetries",
  "--max-turns": "policies.stepCap",
  "--auto-accept": "policies.autoAccept",
  "--arm": "armUnderTest",
  "--seed": "switches.seed",
  "--prune": "switches.prune",
  "--tool-arm": "switches.toolArm",
};

/** Flags that would set other settings, refused with what they would have set. */
const COMPOSITE_FLAGS: Readonly<Record<string, string>> = {
  "--profile": "--explore, --escalate-retries, --review and --max-turns",
};

const BOOLEAN_POLICIES = new Set(["exploration", "review", "escalateRetries", "autoAccept"]);

/** The number of switches a footprint compares (rule 16c: the switch count). */
export function profileSwitchCount(): number {
  return EXPERIMENT_SWITCHES.length + Object.keys(RUN_PROFILE_FLAGS).length;
}

export class RunProfileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunProfileRefusal";
  }
}

/** A partial profile: what configuration or a settings file may set. */
export interface ProfileLayer {
  roles?: Partial<RunProfile["roles"]>;
  policies?: Partial<RunProfile["policies"]>;
  switches?: Partial<RunProfile["switches"]>;
  armUnderTest?: string;
}

function defaults(): RunProfile {
  return {
    schema: 1,
    roles: {},
    policies: {
      exploration: false,
      review: false,
      escalateRetries: false,
      stepCap: null,
      autoAccept: false,
    },
    switches: {
      thinking: "off",
      workerMethod: "baseline",
      evidenceGate: "off",
      toolArm: "progressive",
    },
    sources: {},
  };
}

const THINKING = new Set<string>(["off", "surgical", "all"]);
const METHOD = new Set<string>(["baseline", "strict"]);

function applyLayer(
  p: RunProfile,
  layer: ProfileLayer,
  source: ProfileSource,
  where: string,
): void {
  const unknown = (key: string) =>
    new RunProfileRefusal(
      `${where}: unknown setting ${key}; a run's settings are ${Object.keys(defaults())
        .filter((k) => k !== "schema" && k !== "sources")
        .join(", ")} and armUnderTest`,
    );
  for (const key of Object.keys(layer)) {
    if (!["roles", "policies", "switches", "armUnderTest"].includes(key)) throw unknown(key);
  }
  for (const [k, v] of Object.entries(layer.roles ?? {})) {
    if (!["worker", "manager", "reviewer", "researcher"].includes(k)) throw unknown(`roles.${k}`);
    if (typeof v !== "string") continue;
    (p.roles as Record<string, string>)[k] = v;
    p.sources[`roles.${k}`] = source;
  }
  for (const [k, v] of Object.entries(layer.policies ?? {})) {
    if (!(k in p.policies)) throw unknown(`policies.${k}`);
    if (k === "stepCap") {
      if (v !== null && (typeof v !== "number" || !(v > 0)))
        throw new RunProfileRefusal(`${where}: policies.stepCap must be a positive number`);
      p.policies.stepCap = v as number | null;
    } else if (BOOLEAN_POLICIES.has(k)) {
      if (typeof v !== "boolean")
        throw new RunProfileRefusal(`${where}: policies.${k} must be true or false`);
      (p.policies as unknown as Record<string, boolean>)[k] = v;
    }
    p.sources[`policies.${k}`] = source;
  }
  for (const [k, v] of Object.entries(layer.switches ?? {})) {
    if (k === "thinking" && typeof v === "string" && THINKING.has(v)) {
      p.switches.thinking = v as ThinkingPolicy;
    } else if (k === "workerMethod" && typeof v === "string" && METHOD.has(v)) {
      p.switches.workerMethod = v as WorkerMethod;
    } else if (k === "seed" && Number.isInteger(v) && (v as number) >= 0) {
      p.switches.seed = v as number;
    } else if (k === "prune" && (v === "query" || v === "random")) {
      p.switches.prune = v;
    } else if (k === "evidenceGate" && (v === "off" || v === "on")) {
      p.switches.evidenceGate = v;
    } else if (k === "toolArm" && (v === "progressive" || v === "fixed")) {
      p.switches.toolArm = v;
    } else if (
      k === "thinking" ||
      k === "workerMethod" ||
      k === "seed" ||
      k === "prune" ||
      k === "evidenceGate" ||
      k === "toolArm"
    ) {
      throw new RunProfileRefusal(`${where}: switches.${k} cannot be ${JSON.stringify(v)}`);
    } else {
      throw unknown(`switches.${k}`);
    }
    p.sources[`switches.${k}`] = source;
  }
  if (layer.armUnderTest !== undefined) {
    p.armUnderTest = String(layer.armUnderTest);
    p.sources.armUnderTest = source;
  }
}

/** The flags in `argv` that the profile reads, each once; refuses composite and repeated flags. */
function flagLayer(argv: string[]): ProfileLayer {
  for (const [f, sets] of Object.entries(COMPOSITE_FLAGS)) {
    if (argv.includes(f)) {
      throw new RunProfileRefusal(
        `${f} would set ${sets} at once, and a flag sets one setting only (measurement rule 9a). Name those settings with their own flags, or put them in a file and pass --settings <file>, which is recorded with its hash.`,
      );
    }
  }
  const seen = new Map<string, string>();
  const layer: ProfileLayer = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i] as string;
    const path = RUN_PROFILE_FLAGS[f];
    if (!path) continue;
    const [group, key] = path.split(".") as [string, string | undefined];
    const takesValue = group !== "policies" || !BOOLEAN_POLICIES.has(key ?? "");
    const value = takesValue ? argv[i + 1] : "true";
    if (value === undefined || (takesValue && value.startsWith("--")))
      throw new RunProfileRefusal(`${f} needs a value`);
    const before = seen.get(f);
    if (before !== undefined && before !== value)
      throw new RunProfileRefusal(`${f} is given twice (${before}, ${value}); give it once`);
    seen.set(f, value);
    if (takesValue) i++;
    if (path === "armUnderTest") layer.armUnderTest = value;
    else if (path === "switches.seed") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0)
        throw new RunProfileRefusal(`--seed must be a non-negative integer, not ${value}`);
      layer.switches = { ...layer.switches, seed: n };
    } else if (path === "switches.toolArm") {
      if (value !== "progressive" && value !== "fixed")
        throw new RunProfileRefusal(`--tool-arm is progressive or fixed, not ${value}`);
      layer.switches = { ...layer.switches, toolArm: value };
    } else if (path === "switches.prune") {
      if (value !== "query" && value !== "random")
        throw new RunProfileRefusal(`--prune is query or random, not ${value}`);
      layer.switches = { ...layer.switches, prune: value };
    } else if (group === "roles") layer.roles = { ...layer.roles, [key as string]: value };
    else if (key === "stepCap") {
      const n = Number(value);
      if (!(n > 0))
        throw new RunProfileRefusal(`--max-turns must be a positive number, not ${value}`);
      layer.policies = { ...layer.policies, stepCap: n };
    } else layer.policies = { ...layer.policies, [key as string]: true };
  }
  return layer;
}

function envLayer(env: Record<string, string | undefined>): ProfileLayer {
  const switches: Partial<RunProfile["switches"]> = {};
  const thinking = env.SEKHEMET_THINKING;
  // An unrecognised value is the default, off, as the loop reads it
  // (models `thinkingPolicyFromEnv`); only a recognised one is a layer.
  if (thinking && THINKING.has(thinking)) switches.thinking = thinking as ThinkingPolicy;
  if (env.SEKHEMET_WORKER_METHOD === "strict") switches.workerMethod = "strict";
  if (env.SEKHEMET_PRUNE === "random") switches.prune = "random";
  if (env.SEKHEMET_EVIDENCE_GATE === "on") switches.evidenceGate = "on";
  return Object.keys(switches).length ? { switches } : {};
}

/**
 * Resolve a run's one profile. Throws {@link RunProfileRefusal} for a flag
 * that would change another setting, a flag given twice with different
 * values, or a settings file with a setting the profile does not have.
 */
export function resolveRunProfile(input: {
  config?: ProfileLayer;
  settingsFile?: { path: string; text: string };
  env: Record<string, string | undefined>;
  argv: string[];
  /**
   * Read the Researcher a person set with `SEKHEMET_RESEARCHER` as a role:
   * the queue honours it; `sekhemet run` does not, so it leaves this off.
   */
  envRoles?: boolean;
}): RunProfile {
  const p = defaults();
  const flags = flagLayer(input.argv);
  if (input.config) applyLayer(p, input.config, "config", "configuration");
  if (input.settingsFile) {
    let layer: ProfileLayer;
    try {
      layer = JSON.parse(input.settingsFile.text) as ProfileLayer;
    } catch (err) {
      throw new RunProfileRefusal(
        `${input.settingsFile.path}: not JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    applyLayer(p, layer, "settings", input.settingsFile.path);
    p.settingsFile = {
      path: input.settingsFile.path,
      sha256: createHash("sha256").update(input.settingsFile.text).digest("hex"),
      contents: input.settingsFile.text,
    };
  }
  applyLayer(p, envLayer(input.env), "env", "environment");
  if (input.envRoles && input.env.SEKHEMET_RESEARCHER) {
    applyLayer(p, { roles: { researcher: input.env.SEKHEMET_RESEARCHER } }, "env", "environment");
  }
  applyLayer(p, flags, "flag", "flags");
  return p;
}

/** The profile's identity: every resolved value, not where each came from. */
export function runProfileHash(
  p: Omit<RunProfile, "settingsFile" | "sources"> & {
    settingsFile?: RunProfile["settingsFile"] | undefined;
    sources?: unknown;
  },
): string {
  const { sources: _sources, settingsFile, ...rest } = p;
  const canonical = JSON.stringify({
    schema: rest.schema,
    roles: Object.fromEntries(Object.entries(rest.roles).sort()),
    policies: Object.fromEntries(Object.entries(rest.policies).sort()),
    switches: Object.fromEntries(Object.entries(rest.switches).sort()),
    armUnderTest: rest.armUnderTest ?? null,
    settingsFile: settingsFile?.sha256 ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** A profile's settings, without where each came from. */
type ProfileSettings = Pick<RunProfile, "schema" | "roles" | "policies" | "switches"> & {
  armUnderTest?: string;
};

/**
 * The settings two profiles differ in, by path (`policies.stepCap`,
 * `switches.thinking`, `armUnderTest`), sorted. Where a value came from and
 * the settings file that named it are not settings.
 */
export function profileDifferences(a: ProfileSettings, b: ProfileSettings): string[] {
  const out = new Set<string>();
  if (a.schema !== b.schema) out.add("schema");
  if ((a.armUnderTest ?? null) !== (b.armUnderTest ?? null)) out.add("armUnderTest");
  for (const group of ["roles", "policies", "switches"] as const) {
    const x = (a[group] ?? {}) as Record<string, unknown>;
    const y = (b[group] ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if ((x[k] ?? null) !== (y[k] ?? null)) out.add(`${group}.${k}`);
    }
  }
  return [...out].sort();
}

/** A card's recorded profile as a suite result keeps it: its settings and their hash. */
export type CardProfile = ProfileSettings & { hash: string };

/**
 * Each card's recorded profile against the one its repository's queue was
 * expected to resolve: the run's settings plus that repository's
 * configuration layer (SUITE_RUNS, ref-r1). A card with no evidence is
 * skipped; one that differs is named with the settings it differs in.
 */
export function scoreCardProfiles(
  cards: readonly {
    card: string;
    expected: ProfileSettings;
    recorded?: ProfileSettings | undefined;
  }[],
): {
  profileMismatch: string[];
  differences: Record<string, string[]>;
  cardProfiles: Record<string, CardProfile>;
} {
  const profileMismatch: string[] = [];
  const differences: Record<string, string[]> = {};
  const cardProfiles: Record<string, CardProfile> = {};
  for (const { card, expected, recorded } of cards) {
    if (!recorded) continue;
    const settings: ProfileSettings = {
      schema: recorded.schema,
      roles: recorded.roles,
      policies: recorded.policies,
      switches: recorded.switches,
      ...(recorded.armUnderTest !== undefined ? { armUnderTest: recorded.armUnderTest } : {}),
    };
    cardProfiles[card] = { ...settings, hash: runProfileHash(settings) };
    const diff = profileDifferences(expected, recorded);
    if (diff.length) {
      profileMismatch.push(card);
      differences[card] = diff;
    }
  }
  return { profileMismatch, differences, cardProfiles };
}

/**
 * The profile as the product's command line takes it: one flag per setting
 * and the experiment switches as environment variables, always both set so
 * a child process never inherits a different switch. Resolving the result
 * gives the same profile back (the settings file's hash is recorded by the
 * caller that read the file).
 */
export function profileArgs(p: RunProfile): { argv: string[]; env: Record<string, string> } {
  const argv: string[] = [];
  const flagFor = Object.fromEntries(
    Object.entries(RUN_PROFILE_FLAGS).map(([f, path]) => [path, f]),
  );
  for (const [role, model] of Object.entries(p.roles)) {
    if (model) argv.push(flagFor[`roles.${role}`] as string, model);
  }
  for (const [key, value] of Object.entries(p.policies)) {
    const f = flagFor[`policies.${key}`] as string;
    if (key === "stepCap") {
      if (value !== null) argv.push(f, String(value));
    } else if (value === true) argv.push(f);
  }
  if (p.armUnderTest !== undefined) argv.push("--arm", p.armUnderTest);
  if (p.switches.seed !== undefined) argv.push("--seed", String(p.switches.seed));
  if (p.switches.prune !== undefined) argv.push("--prune", p.switches.prune);
  if (p.switches.toolArm !== "progressive") argv.push("--tool-arm", p.switches.toolArm);
  return {
    argv,
    env: {
      SEKHEMET_THINKING: p.switches.thinking,
      SEKHEMET_WORKER_METHOD: p.switches.workerMethod,
      SEKHEMET_PRUNE: p.switches.prune ?? "query",
      SEKHEMET_EVIDENCE_GATE: p.switches.evidenceGate,
    },
  };
}

/**
 * The one way every measured path starts the product's queue (MS-M9-1): the
 * suite runner, and through it the bake-off and the rule gate, and m0. Same
 * profile, same invocation, so the same card gets the same first prompt.
 */
export function queueInvocation(
  profile: RunProfile,
  repo: string,
): { args: string[]; env: Record<string, string> } {
  const { argv, env } = profileArgs(profile);
  return { args: ["queue", "--repo", repo, ...argv], env };
}
