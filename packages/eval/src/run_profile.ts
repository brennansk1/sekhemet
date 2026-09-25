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
  switches: { thinking: ThinkingPolicy; workerMethod: WorkerMethod };
  /** The arm an A/B varies, when this run is one arm of one. */
  armUnderTest?: string;
  settingsFile?: { path: string; sha256: string };
  /** Where each resolved value came from, for the record; not part of the hash. */
  sources: Record<string, ProfileSource>;
}

export type ProfileSource = "default" | "config" | "settings" | "env" | "flag";

/**
 * The experiment switches: environment variables that choose an arm of the
 * Worker's behaviour. `SEKHEMET_EVIDENCE_GATE` joins when worker-loop rule
 * 29a is built.
 */
export const EXPERIMENT_SWITCHES = ["SEKHEMET_THINKING", "SEKHEMET_WORKER_METHOD"] as const;

type Path = `roles.${keyof RunProfile["roles"]}` | `policies.${keyof RunProfile["policies"]}`;

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
    switches: { thinking: "off", workerMethod: "baseline" },
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
    } else if (k === "thinking" || k === "workerMethod") {
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
    else if (group === "roles") layer.roles = { ...layer.roles, [key as string]: value };
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
  return {
    argv,
    env: {
      SEKHEMET_THINKING: p.switches.thinking,
      SEKHEMET_WORKER_METHOD: p.switches.workerMethod,
    },
  };
}
