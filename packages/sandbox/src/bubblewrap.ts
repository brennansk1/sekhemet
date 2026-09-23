import { existsSync, mkdirSync } from "node:fs";
import { linkedDependencyCaches, protectedInsideRoots, realPath } from "./seatbelt.js";
import type { SandboxOptions } from "./types.js";

/** Where bubblewrap lives on Ubuntu, Debian and Fedora. */
export const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];

/**
 * The Linux counterpart of the Seatbelt profile, as a bubblewrap argv.
 *
 * Same contract as seatbelt.ts: the filesystem is readable (toolchains load
 * system libraries) but mounted read-only; only the granted paths, their
 * linked dependency targets and a private scratch directory are writable;
 * the network namespace is empty unless network was granted; /tmp is a
 * private tmpfs; the child dies with the harness and gets a new session so it
 * cannot reach the controlling terminal.
 *
 * Mount order matters: the read-only root comes first, the private /tmp next,
 * and the writable binds last, so a scratch directory under /tmp is still
 * writable.
 */
export function bubblewrapArgv(
  options: SandboxOptions,
  command: string,
  args: string[],
  /** File descriptor carrying the seccomp program (S3), when one is attached. */
  seccompFd?: number,
): string[] {
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  // Dependency code stays read-only; only its cache directories are writable,
  // created first because a bind needs an existing path.
  const caches = linkedDependencyCaches(roots);
  for (const c of caches) {
    try {
      mkdirSync(c, { recursive: true });
    } catch {
      // Unwritable from outside too: the toolchain reports the consequence.
    }
  }
  const writeRoots = [...new Set([...roots.map(realPath), ...caches])];
  // The git metadata inside a granted path is re-mounted read-only after the
  // writable binds: git runs outside the sandbox in that worktree.
  const protectedGit = protectedInsideRoots(roots).filter((p) => existsSync(p));
  return [
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...writeRoots.flatMap((p) => ["--bind", p, p]),
    ...protectedGit.flatMap((p) => ["--ro-bind", p, p]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.allowNetwork ? [] : ["--unshare-net"]),
    ...(seccompFd !== undefined ? ["--seccomp", String(seccompFd)] : []),
    "--chdir",
    options.cwd,
    "--",
    command,
    ...args,
  ];
}
