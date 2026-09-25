import { constants, accessSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where this machine keeps model weights (design "Getting the weights").
 *
 * A shipped path that names the author's external drive is a harness that
 * runs for one person: it resolves for nobody else, and the failure arrives
 * on the first card rather than at startup. So shipped source carries a file
 * name relative to a directory the user configures, never a location, and the
 * resolution has one override — `--models-dir`, or `SEKHEMET_MODELS_DIR`,
 * which is one of the two variables that may outrank a config file because it
 * must be readable before one can be found.
 */
export interface ModelsDirOptions {
  /** `--models-dir`, or its config equivalent. */
  modelsDir?: string;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The user's Sekhemet directory: `SEKHEMET_CONFIG_DIR`, else `~/.sekhemet`.
 * The override is resolved to an absolute path — the sandbox denies it by
 * that path (SEC-23), and a relative one would name a different directory
 * from each working directory. It holds tokens and trust records, so one
 * inside a repository or a worktree — where a card is granted access and
 * git could commit it — is refused.
 */
export function sekhemetConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SEKHEMET_CONFIG_DIR?.trim();
  if (!override) return join(homedir(), ".sekhemet");
  const dir = resolve(override);
  const repo = enclosingRepository(dir);
  if (repo) {
    throw new Error(
      `SEKHEMET_CONFIG_DIR ${dir} is inside the repository ${repo}; the user directory holds tokens and trust records, so put it outside any repository or worktree`,
    );
  }
  return dir;
}

/** The nearest directory at or above `dir` with a `.git` (a directory, or a worktree's file). */
function enclosingRepository(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

export function resolveModelsDir(options: ModelsDirOptions = {}): string {
  const env = options.env ?? process.env;
  return options.modelsDir || env.SEKHEMET_MODELS_DIR || join(sekhemetConfigDir(env), "models");
}

/**
 * A catalogue file name resolved against the models directory. An absolute
 * path is the user's own choice (a config value, an air-gap manifest) and
 * passes through untouched.
 */
export function resolveModelPath(file: string, options: ModelsDirOptions = {}): string {
  return isAbsolute(file) ? file : join(resolveModelsDir(options), file);
}

export interface WeightsProbe {
  modelId: string;
  path: string;
  ok: boolean;
  detail: string;
}

export interface WeightsReport {
  modelsDir: string;
  /** Does the models directory itself exist? Nothing is configured when it does not. */
  modelsDirExists: boolean;
  probes: WeightsProbe[];
  present: number;
  missing: string[];
}

/**
 * Check that the weights a resolved profile names are really there (design
 * "Getting the weights": a diagnostic that reports all-clear and is followed
 * by a file-not-found on the first card is worse than no diagnostic).
 * Existence and readability, both of which a caller can act on; the hash
 * belongs to the air-gap manifest, which is the only place a checksum for a
 * given build is recorded.
 */
export function probeModelWeights(
  models: readonly { modelId: string; path: string }[],
  options: ModelsDirOptions = {},
): WeightsReport {
  const modelsDir = resolveModelsDir(options);
  const probes = models.map((m): WeightsProbe => {
    if (!existsSync(m.path)) return { ...m, ok: false, detail: "not found" };
    try {
      accessSync(m.path, constants.R_OK);
    } catch {
      return { ...m, ok: false, detail: "not readable" };
    }
    const gb = statSync(m.path).size / 1024 ** 3;
    return { ...m, ok: true, detail: `${gb.toFixed(1)} GB` };
  });
  return {
    modelsDir,
    modelsDirExists: existsSync(modelsDir),
    probes,
    present: probes.filter((p) => p.ok).length,
    missing: probes.filter((p) => !p.ok).map((p) => p.modelId),
  };
}
