import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sekhemetConfigDir } from "@sekhemet/kernel";

/**
 * Git configuration the harness always overrides for its own git calls
 * (security items 18–22, S1).
 *
 * The harness runs git outside the sandbox, in worktrees the Worker has
 * written to. Configuration that makes git run a program — `core.fsmonitor`,
 * hooks, filters, signing, credential helpers — would then run with the
 * user's full privileges (Phase A finding S1). The sandbox keeps the Worker
 * away from `.git`; this is the second layer, so a gap in the first cannot
 * become code execution. The worktree preflight (`git_preflight.ts`) is the
 * third: it refuses a worktree whose own config sets such a key.
 *
 * Applied through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,
 * which git treats like `-c` on every command.
 *
 * Two of item 19's keys are not pinned here, found in B1:
 * - `include.path`: git refuses an empty include on the command line
 *   ("relative config includes must come from files"), failing every call;
 * - `diff.external`: an empty value makes git try to run "" on every diff
 *   that prints a patch.
 * The preflight refuses both in repository config instead (item 21), and
 * every harness diff passes `--no-ext-diff --no-textconv` (item 20).
 */
export const HARDENED_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.untrackedCache", "false"],
  ["core.sshCommand", "false"],
  ["credential.helper", ""],
  ["gpg.program", "false"],
  ["commit.gpgSign", "false"],
  // `git log` must never run a signature program the worktree names.
  ["log.showSignature", "false"],
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "all"],
  // A bare repository nested in the worktree is not one git may enter
  // implicitly (the Copilot CLI CVE-2026-45033 route); honoured only from
  // protected config, which includes these command-level overrides.
  ["safe.bareRepository", "explicit"],
];

/**
 * Pinned only for git in a card's worktree, never process-wide: in the
 * user's own checkout they would write every symlink as a text file and
 * refuse local-path clones (B1 review).
 */
export const WORKTREE_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.symlinks", "false"],
  ["protocol.file.allow", "never"],
];

/** `env` with extra config pairs appended after any GIT_CONFIG_* already present. */
export function withGitConfig(
  env: NodeJS.ProcessEnv,
  pairs: readonly (readonly [string, string])[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  let n = Number.parseInt(out.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Environment pinned for every harness git call (item 19). */
export const HARDENED_GIT_PINS: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
};

const IDENTITY_FILE = "global.gitconfig";

/**
 * The global config git sees: the user's name and email only (item 19 pins
 * `GIT_CONFIG_GLOBAL`). Pointing it at /dev/null would drop the identity the
 * user's commits carry; copying just `[user]` keeps it, keeps a repository's
 * own identity first, and carries none of the global keys that run programs.
 */
export function identityConfig(env: NodeJS.ProcessEnv, identityDir: string): string {
  const file = join(identityDir, IDENTITY_FILE);
  const lookup = (key: string): string | undefined => {
    try {
      const v = execFileSync("git", ["config", "--global", "--get", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH,
          HOME: env.HOME ?? process.env.HOME,
          GIT_CONFIG_NOSYSTEM: "1",
          ...(env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL } : {}),
        },
      }).trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  };
  // git config quoting: only \\ and \" are escaped; a value with any other
  // control character is not carried over.
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const safe = (v: string | undefined) =>
    v && ![...v].some((c) => c.charCodeAt(0) < 0x20) ? v : undefined;
  const name = safe(lookup("user.name"));
  const email = safe(lookup("user.email"));
  const body =
    name || email
      ? `[user]\n${name ? `\tname = ${quote(name)}\n` : ""}${email ? `\temail = ${quote(email)}\n` : ""}`
      : "";
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** `env` hardened: the pins, the identity-only global config and the config pairs. */
export function hardenedGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { identityDir?: string } = {},
): NodeJS.ProcessEnv {
  // The harness's own user directory, through the one resolver: it refuses a
  // directory inside a repository and resolves a relative one (W1 finding).
  const identityDir = options.identityDir ?? join(sekhemetConfigDir(process.env), "git");
  const out: NodeJS.ProcessEnv = { ...env, ...HARDENED_GIT_PINS };
  const identityFile = join(identityDir, IDENTITY_FILE);
  out.GIT_CONFIG_GLOBAL =
    env.GIT_CONFIG_GLOBAL === identityFile ? identityFile : identityConfig(env, identityDir);
  return withGitConfig(out, HARDENED_GIT_CONFIG);
}

/**
 * Item 22: "already hardened" is decided by the keys being present, never by
 * trusting an environment flag (SEC-5).
 */
export function isHardened(env: NodeJS.ProcessEnv): boolean {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const pairs = new Set<string>();
  for (let i = 0; i < (Number.isFinite(count) ? count : 0); i++) {
    pairs.add(`${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
  }
  return (
    HARDENED_GIT_CONFIG.every(([k, v]) => pairs.has(`${k}=${v}`)) &&
    Object.entries(HARDENED_GIT_PINS).every(([k, v]) => env[k] === v) &&
    typeof env.GIT_CONFIG_GLOBAL === "string"
  );
}

/** Harden this process's environment so every child git inherits it. */
export function hardenGitForProcess(): void {
  if (isHardened(process.env)) return;
  Object.assign(process.env, hardenedGitEnv(process.env), { SEKHEMET_GIT_HARDENED: "1" });
}
