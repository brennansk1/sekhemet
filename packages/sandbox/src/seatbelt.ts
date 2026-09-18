import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SandboxOptions } from "./types.js";

/**
 * Resolve a path through symlinks for use in a Seatbelt `subpath` rule.
 *
 * Seatbelt matches on the real filesystem path. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so a profile written against the unresolved path silently
 * fails to grant the access it appears to grant.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
  const writeRoots = [...new Set([...options.allowedPaths, tmpdir()].map(realPath))];

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
(allow signal (target self))
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
