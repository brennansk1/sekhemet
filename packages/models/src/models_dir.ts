import { constants, accessSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sekhemetConfigDir } from "@sekhemet/kernel";

/** The one user-directory resolver lives in the kernel, so every package below this one uses it too. */
export { sekhemetConfigDir };

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

/**
 * The likely model folders on this machine (models rule 4a, MD-N12-8):
 * `SEKHEMET_MODELS_DIR`, Ollama's model store, LM Studio's models folder,
 * the Hugging Face hub cache and llama.cpp's cache — exactly those that
 * exist here and are not yet configured. Only suggested: none is scanned
 * until a person adds it.
 */
export function suggestedModelFolders(
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    configured?: readonly string[];
  } = {},
): string[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const hfHome = env.HF_HOME?.trim();
  const candidates = [
    env.SEKHEMET_MODELS_DIR?.trim(),
    env.OLLAMA_MODELS?.trim() || join(home, ".ollama", "models"),
    join(home, ".lmstudio", "models"),
    join(home, ".cache", "lm-studio", "models"),
    env.HF_HUB_CACHE?.trim() ||
      (hfHome ? join(hfHome, "hub") : join(home, ".cache", "huggingface", "hub")),
    env.LLAMA_CACHE?.trim() ||
      (platform === "darwin"
        ? join(home, "Library", "Caches", "llama.cpp")
        : join(home, ".cache", "llama.cpp")),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  const configured = new Set((options.configured ?? []).map((p) => resolve(p)));
  const out: string[] = [];
  for (const c of candidates) {
    const p = resolve(c);
    if (configured.has(p) || out.includes(p)) continue;
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // Not on this machine.
    }
  }
  return out;
}
