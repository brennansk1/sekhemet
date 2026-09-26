import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  // The optional mutation tools (GT-N5-2, DEC-44), run confined over the diff.
  mutmut: BIN_DIRS.map((d) => `${d}/mutmut`),
  // `cargo install cargo-mutants` puts it in ~/.cargo/bin.
  "cargo-mutants": [...BIN_DIRS, join(homedir(), ".cargo", "bin")].map((d) => `${d}/cargo-mutants`),
  mvn: BIN_DIRS.map((d) => `${d}/mvn`),
  gradle: BIN_DIRS.map((d) => `${d}/gradle`),
};

/** The absolute path of an allowlisted program, or undefined (refused, or not installed). */
export function resolveProgram(
  name: string,
  allowlist: Readonly<Record<string, readonly string[]>> = PROGRAM_ALLOWLIST,
): string | undefined {
  if (!Object.hasOwn(allowlist, name)) return undefined;
  return (allowlist[name] ?? []).find((p) => isAbsolute(p) && existsSync(p));
}
