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
/**
 * The cache directories inside linked dependency trees that toolchains must
 * write (vitest's `.vite-temp`, bundler caches), and nothing else.
 *
 * The first version granted writes to the whole linked tree, which is the
 * user's main checkout's `node_modules`: a card could then change code the
 * user runs unconfined (Phase A security review, 2026-09-22). The dependency
 * code itself stays read-only.
 */
export const DEPENDENCY_CACHE_DIRS = [".vite-temp", ".vite", ".cache"] as const;

export function linkedDependencyCaches(roots: string[]): string[] {
  return linkedDependencyTargets(roots)
    .filter((t) => t.endsWith("node_modules"))
    .flatMap((t) => DEPENDENCY_CACHE_DIRS.map((d) => join(t, d)));
}

/**
 * Paths inside a writable root that the sandbox must never write: the git
 * metadata. A worktree's `.git` pointer tells git where its metadata lives,
 * and the harness runs git outside the sandbox in that worktree, so a Worker
 * able to rewrite it could aim git at configuration it controls (Phase A
 * security review, 2026-09-22).
 */
export function protectedInsideRoots(roots: string[]): string[] {
  return roots.map((r) => join(realPath(r), ".git"));
}

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

/** Escape a path for embedding in a Seatbelt regex literal. */
function regexQuote(p: string): string {
  return p.replace(/[\\^$.*+?()[\]{}|"#]/g, (c) => `\\${c}`);
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
  const writeRoots = [...new Set([...roots.map(realPath), ...linkedDependencyCaches(roots)])];

  const writeRules = writeRoots
    .map((p) => `  (allow file-write* (subpath "${quote(p)}"))`)
    .join("\n");
  // Denials come after the grants: in a Seatbelt profile the later rule wins.
  // `.git` at any depth and in any case (APFS is case-insensitive): a nested
  // sub/.git is metadata the harness's git would descend into (review G2).
  const protectRules = [...new Set(roots.map(realPath))]
    .map((r) => `  (deny file-write* (regex #"^${regexQuote(r)}/(.*/)?[.][Gg][Ii][Tt](/|$)"))`)
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
  const networkRule = options.allowNetwork
    ? "  (allow network*)"
    : options.egressProxyPort
      ? `  (deny network*)\n  ;; S5: the allowlisting egress proxy is the only way out.\n  (allow network-outbound (remote tcp "localhost:${Math.floor(options.egressProxyPort)}"))`
      : "  (deny network*)";

  const portRules = (options.localPorts ?? [])
    .map((p) => Math.floor(p))
    .map(
      (p) =>
        `  (allow network-bind network-inbound (local ip "localhost:${p}"))\n  (allow network-outbound (remote ip "localhost:${p}"))`,
    )
    .join("\n");

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

;; Never the git metadata inside a granted path: git runs outside the sandbox.
${protectRules}

;; Network egress.
${networkRule}
${portRules ? `\n;; L23: the card's own loopback ports.\n${portRules}\n` : ""}`;
}
