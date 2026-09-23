/**
 * Git configuration the harness always overrides for its own git calls.
 *
 * The harness runs git outside the sandbox, in worktrees the Worker has
 * written to. Repository configuration that makes git run a program —
 * `core.fsmonitor`, hooks — would then run with the user's full privileges
 * (Phase A security finding S1, 2026-09-22). The sandbox and the permission
 * engine keep the Worker away from `.git`; this is the second layer, so a gap
 * in the first cannot become code execution.
 *
 * Applied through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,
 * which git treats like `-c` on every command, so one call at start-up covers
 * every git invocation the process makes.
 */
export const HARDENED_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  // A bare repository nested in the worktree is not a repository git may
  // enter implicitly — the Copilot CLI CVE-2026-45033 route. Git honours this
  // key only from protected config, which includes these command-level
  // overrides.
  ["safe.bareRepository", "explicit"],
  // `git log` must never run a signature program the worktree names.
  ["log.showSignature", "false"],
];

/** `env` with the hardened keys appended to any GIT_CONFIG_* already present. */
export function hardenedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  let n = Number.parseInt(out.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  for (const [key, value] of HARDENED_GIT_CONFIG) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Harden this process's environment, once, so every child git inherits it. */
export function hardenGitForProcess(): void {
  if (process.env.SEKHEMET_GIT_HARDENED === "1") return;
  Object.assign(process.env, hardenedGitEnv(process.env), { SEKHEMET_GIT_HARDENED: "1" });
}
