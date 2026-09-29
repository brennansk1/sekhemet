/** The milestone runners' primitives, shared by every module (it imports none of them). */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(ROOT, "apps", "harness", "dist", "index.js");

/** Import a built module of this checkout (`tsc -b` first). */
export const built = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

/**
 * PASS only when every check passed; FAIL when any failed; otherwise (a
 * check not run, or no checks at all) NOT RUN — never a verdict not earned.
 */
export function verdictOf(checks) {
  if (checks.length === 0) return "NOT RUN";
  if (checks.some((c) => c.ok === false)) return "FAIL";
  if (checks.some((c) => c.ok !== true)) return "NOT RUN";
  return "PASS";
}

/** One check: `ok` true, false, or null for not run. */
export const check = (name, ok, detail) => ({ name, ok, ...(detail ? { detail } : {}) });

/**
 * The environment every process a runner starts gets: a temporary HOME and
 * Sekhemet user directory, its own model registry, machine profile, trust
 * store and keychain switch, model loads refused, and a stand-in for the
 * CLI a server launches (so a server's "run" starts nothing a runner does
 * not drive itself). `userConfig` is written as the user's config.toml.
 */
export function isolatedEnv(base, options = {}) {
  const home = join(base, "home");
  const user = join(home, ".sekhemet");
  mkdirSync(user, { recursive: true });
  const noop = join(base, "noop.mjs");
  writeFileSync(noop, "");
  const config = join(user, "config.toml");
  if (options.userConfig) writeFileSync(config, options.userConfig);
  return {
    ...process.env,
    HOME: home,
    SEKHEMET_CONFIG_DIR: user,
    SEKHEMET_USER_CONFIG: config,
    SEKHEMET_MODEL_REGISTRY: join(user, "models.json"),
    SEKHEMET_MACHINE_PROFILE: join(user, "machine.json"),
    SEKHEMET_TRUST_DIR: join(user, "trust"),
    SEKHEMET_KEYCHAIN: "off",
    SEKHEMET_MODEL_LOADS: "off",
    SEKHEMET_CLI: noop,
  };
}

/**
 * This process's environment as it started, before `useIsolatedEnv`: for the
 * tools that need the person's own (pnpm's store, for an offline install).
 */
export const ORIGINAL_ENV = Object.freeze({ ...process.env });

/** Make this process use an isolated environment too (a runner's in-process parts). */
export function useIsolatedEnv(env) {
  for (const k of Object.keys(env)) {
    if (k === "HOME" || k.startsWith("SEKHEMET_")) process.env[k] = env[k];
  }
}

/**
 * Run a CLI (this build's by default) from the repository it names with
 * `--repo`, so no other checkout's project configuration is read: exit
 * code, stdout and stderr.
 */
export function runCli(args, { env, cwd, cli = CLI, timeout = 120_000 } = {}) {
  const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: cwd ?? repo ?? ROOT,
    env,
    encoding: "utf8",
    timeout,
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
