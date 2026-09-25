import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/home/linuxbrew/.linuxbrew/bin",
];

/**
 * Programs the harness itself runs over a card's content (security item
 * 20b, SEC-19a): each by absolute path from this fixed list. A name not here
 * is refused, and a program found only on PATH is never used — a worktree
 * or a shell profile could put anything first on PATH.
 */
export const PROGRAM_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  difft: BIN_DIRS.map((d) => `${d}/difft`),
  gitleaks: BIN_DIRS.map((d) => `${d}/gitleaks`),
  "osv-scanner": BIN_DIRS.map((d) => `${d}/osv-scanner`),
  semgrep: BIN_DIRS.map((d) => `${d}/semgrep`),
  python3: ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"],
  bash: ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"],
};

/** The absolute path of an allowlisted program, or undefined (refused, or not installed). */
export function resolveProgram(
  name: string,
  allowlist: Readonly<Record<string, readonly string[]>> = PROGRAM_ALLOWLIST,
): string | undefined {
  if (!Object.hasOwn(allowlist, name)) return undefined;
  return (allowlist[name] ?? []).find((p) => isAbsolute(p) && existsSync(p));
}
