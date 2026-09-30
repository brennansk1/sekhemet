import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
