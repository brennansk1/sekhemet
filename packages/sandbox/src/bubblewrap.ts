import { linkedDependencyTargets, realPath } from "./seatbelt.js";
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
export function bubblewrapArgv(options: SandboxOptions, command: string, args: string[]): string[] {
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  const writeRoots = [...new Set([...roots, ...linkedDependencyTargets(roots)].map(realPath))];
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
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.allowNetwork ? [] : ["--unshare-net"]),
    "--chdir",
    options.cwd,
    "--",
    command,
    ...args,
  ];
}
