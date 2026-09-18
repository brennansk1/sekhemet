import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SandboxOptions } from "./types.js";

/**
 * Resolve a path through symlinks for use in a Seatbelt `subpath` rule.
 *
 * Seatbelt matches on the real filesystem path. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so a profile written against the unresolved path silently
 * fails to grant the access it appears to grant.
 */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve dependency directories that are symlinked into an allowed root.
 *
 * Per-card worktrees link `node_modules` rather than copying it, so the real
 * tree lives outside the worktree. Toolchains write inside it as a matter of
 * course — vitest alone needs `node_modules/.vite-temp` — so without this every
 * gate fails on EPERM rather than on the card's work. The grant is deliberately
 * narrow: the dependency tree only, never its parent.
 */
export function linkedDependencyTargets(roots: string[]): string[] {
  const targets: string[] = [];

  for (const root of roots) {
    for (const name of ["node_modules", ".venv"]) {
      const candidate = join(root, name);
      if (!existsSync(candidate)) continue;
      try {
        if (lstatSync(candidate).isSymbolicLink()) targets.push(realpathSync(candidate));
      } catch {
        // Unreadable link: the gate reports the real consequence instead.
      }
    }
  }

  return targets;
}

/** Escape a path for embedding in a Seatbelt profile string literal. */
function quote(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generate a macOS Seatbelt profile confining a subprocess to `allowedPaths`.
 *
 * The policy is deny-by-default. Reads are permitted broadly because
 * toolchains must load system libraries, interpreters and language servers;
 * it is *writes* and *network egress* that carry the blast radius, and those
 * are restricted to explicitly granted subpaths.
 */
export function generateSeatbeltProfile(options: SandboxOptions): string {
  // Only what the caller granted, plus an explicit scratch directory if one was
  // supplied. Granting the whole of TMPDIR would let a confined process write
  // into any other card's scratch space — which is still an escape, just a
  // quieter one.
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  const writeRoots = [...new Set([...roots, ...linkedDependencyTargets(roots)].map(realPath))];

  const writeRules = writeRoots
    .map((p) => `  (allow file-write* (subpath "${quote(p)}"))`)
    .join("\n");

  // Build tools legitimately write to these character devices; denying them
  // breaks ordinary stdout/stderr redirection rather than improving safety.
  const deviceRules = [
    '  (allow file-write-data (literal "/dev/null"))',
    '  (allow file-write-data (literal "/dev/stdout"))',
    '  (allow file-write-data (literal "/dev/stderr"))',
    '  (allow file-write-data (literal "/dev/dtracehelper"))',
    '  (allow file-ioctl (literal "/dev/tty"))',
  ].join("\n");

  // `(deny default)` already blocks egress; the explicit rule is kept so the
  // profile states its network posture rather than implying it.
  const networkRule = options.allowNetwork ? "  (allow network*)" : "  (deny network*)";

  return `;; Sekhemet Seatbelt Containment Profile
(version 1)
(deny default)

;; Process primitives required to run a toolchain at all.
(allow process-exec)
(allow process-fork)
;; Test runners and build tools manage worker pools, so they must be able to
;; signal their own descendants. Restricting this to self made vitest fail
;; with kill EPERM while tearing down workers: a sandbox that breaks the
;; toolchain reports the sandbox, not the card.
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read-metadata)

;; Reads are broad: compilers and runtimes must load system libraries.
(allow file-read*)

;; Writes are confined to explicitly granted subpaths.
${writeRules}
${deviceRules}

;; Network egress.
${networkRule}
`;
}
