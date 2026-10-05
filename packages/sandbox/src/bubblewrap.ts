import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { RELAY_NAME, type RelaySpec, relayEnv, relayScript } from "./relay.js";
import {
  homeToolchainPaths,
  ledgerReadDenies,
  protectedInsideRoots,
  realPath,
  secretReadDenies,
} from "./seatbelt.js";
import { sessionSecretDenies } from "./secret_paths.js";
import type { SandboxOptions } from "./types.js";

/** Where bubblewrap lives on Ubuntu, Debian and Fedora. */
export const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];

/** Why bubblewrap at `bwrap` cannot start a sandbox here; cached per path. */
const usableCache = new Map<string, string | undefined>();

/**
 * Installed is not usable (R9, Ubuntu 24.04): AppArmor's
 * `apparmor_restrict_unprivileged_userns` lets bwrap exist but refuses its
 * namespaces, so every command would fail with bwrap's own error. The check
 * starts a trivial command with the namespaces a card's commands get, the
 * network one included, and returns bwrap's error and the fix when it fails.
 */
export function bubblewrapUnavailableReason(bwrap: string): string | undefined {
  if (usableCache.has(bwrap)) return usableCache.get(bwrap);
  const probe = spawnSync(
    bwrap,
    [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-net",
      "--",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  let reason: string | undefined;
  if (probe.error) {
    reason = `${bwrap} cannot run (${probe.error.message})`;
  } else if (probe.status !== 0) {
    const said = (probe.stderr ?? "").trim().split("\n")[0] || `exit ${probe.status}`;
    reason = `${bwrap} cannot start a sandbox (${said}). On Ubuntu 24.04 and later, AppArmor's kernel.apparmor_restrict_unprivileged_userns refuses its namespaces: add an AppArmor profile that allows userns for ${bwrap} (the README's Linux requirements give it), then run \`sekhemet doctor\` again`;
  }
  // A probe that timed out says nothing lasting about the host: ask again next time.
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code !== "ETIMEDOUT") {
    usableCache.set(bwrap, reason);
  }
  return reason;
}

/** `inner` lies strictly below `outer`. */
function isBelow(inner: string, outer: string): boolean {
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * The mount that hides one existing path: an empty tmpfs over a directory,
 * an empty read-only `/dev/null` over a file (what srt does). A path that
 * does not exist gets nothing: bubblewrap cannot create a mount point on the
 * read-only root, and the sandbox cannot create the path either.
 */
function maskOf(path: string): { path: string; argv: string[] } | undefined {
  try {
    return statSync(path).isDirectory()
      ? { path, argv: ["--tmpfs", path] }
      : { path, argv: ["--ro-bind", "/dev/null", path] };
  } catch {
    return undefined;
  }
}

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
 * Reads are broad, except the user's secrets (security item 10, SEC-23, B-2):
 * every path of the shared table (`secret_paths.ts`, which Seatbelt denies
 * and srt receives as `denyRead`), the session's sockets (the runtime
 * directory under /run/user with its D-Bus session bus, the agent sockets,
 * the Docker socket: an empty network namespace does not isolate a socket
 * reached by its path) and the project ledgers above each root are hidden
 * behind an empty mount. Under `denyHomeReads` the whole home is an
 * empty tmpfs with its toolchains bound back read-only, as Seatbelt does.
 *
 * Mount order matters, later mounts covering earlier ones:
 * 1. the read-only root, the private /tmp, and (denyHomeReads) the empty home
 *    and its toolchains;
 * 2. the writable binds, so a scratch directory under /tmp and a root under
 *    the home are still reachable, then the read-only grants (L12), bound
 *    read-only;
 * 3. the secret masks, so a granted root that contains a secret (the home
 *    itself, say) still does not show it;
 * 4. any granted root inside a masked directory, bound again: the harness
 *    chose it (item 8a), so the run gets it and nothing beside it;
 * 5. each root's `.git` read-only and the ledger masks.
 *
 * DEC-50: with `relays`, the network namespace stays empty and the command
 * starts through the inside half of its port relays (`relay.ts`), which
 * listens on each named port, waits until it does, and execs the command.
 */
export function bubblewrapArgv(
  options: SandboxOptions,
  command: string,
  args: string[],
  /** File descriptor carrying the seccomp program (S3), when one is attached. */
  seccompFd?: number,
  /** DEC-50: the egress proxy's and the named ports' relays, whose host half the caller runs. */
  relays: readonly RelaySpec[] = [],
): string[] {
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  // S2: no grant reaches the main checkout's dependency tree (item 24).
  const writeRoots = [...new Set(roots.map(realPath))];
  // The git metadata inside a granted path is re-mounted read-only after the
  // writable binds: git runs outside the sandbox in that worktree.
  const protectedGit = protectedInsideRoots(roots).filter((p) => existsSync(p));

  // S3a: the home is empty but for its toolchains, bound back at the place a
  // path through the home reaches them (the home itself may be a symlink).
  const home = homedir();
  const realHome = realPath(home);
  const homeMount = options.denyHomeReads
    ? [
        "--tmpfs",
        realHome,
        ...homeToolchainPaths(home)
          .filter((p) => existsSync(p))
          .flatMap((p) => ["--ro-bind", realPath(p), join(realHome, relative(home, p))]),
      ]
    : [];

  // The home's secrets, then the session's sockets (G2/G3): the runtime
  // directory under /run/user, the agent sockets, the Docker socket. One
  // under the private /tmp is already gone, and one below another masked
  // directory is hidden with it; neither gets a mount of its own.
  const privateTmp = [...new Set(["/tmp", realPath("/tmp")])];
  const secretMasks = [
    ...new Set([...secretReadDenies(home), ...sessionSecretDenies()].map(realPath)),
  ]
    .map(maskOf)
    .filter((m) => m !== undefined)
    .filter((m, _, all) => {
      if (privateTmp.some((t) => m.path === t || isBelow(m.path, t))) return false;
      return !all.some((o) => o.argv[0] === "--tmpfs" && isBelow(m.path, o.path));
    });
  const maskedDirs = secretMasks.filter((m) => m.argv[0] === "--tmpfs").map((m) => m.path);
  const rebound = writeRoots.filter((r) => maskedDirs.some((d) => isBelow(r, d)));
  // L12: read-only grants, bound read-only after the private /tmp (a
  // worktree under the host's /tmp is otherwise hidden), never writable.
  const readOnly = [
    ...new Set((options.readOnlyPaths ?? []).filter((p) => existsSync(p)).map(realPath)),
  ].filter((p) => !writeRoots.includes(p));
  // Linux lists the ledgers as literal files; the darwin-only glob is Seatbelt's.
  const ledgerMasks = ledgerReadDenies([...roots, ...readOnly])
    .filter((p) => !p.includes("*"))
    .map(maskOf)
    .filter((m) => m !== undefined);

  const isolationMasks = (options.denyPaths ?? [])
    .filter((p) => !p.includes("*") && existsSync(p))
    .map(maskOf)
    .filter((m) => m !== undefined);

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
    ...homeMount,
    ...writeRoots.flatMap((p) => ["--bind", p, p]),
    ...readOnly.flatMap((p) => ["--ro-bind", p, p]),
    ...secretMasks.flatMap((m) => m.argv),
    ...rebound.flatMap((p) => ["--bind", p, p]),
    ...protectedGit.flatMap((p) => ["--ro-bind", p, p]),
    ...ledgerMasks.flatMap((m) => m.argv),
    // Item 10a: the card's view of other projects, masked after every bind.
    // A masked directory is an empty tmpfs mounted read-only: a write there
    // is refused, as Seatbelt and a file mask refuse it, rather than landing
    // in a private tmpfs nobody sees (R-C2c, the Linux run).
    ...isolationMasks.flatMap((m) =>
      m.argv[0] === "--tmpfs" ? [...m.argv, "--remount-ro", m.path] : m.argv,
    ),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(options.allowNetwork ? [] : ["--unshare-net"]),
    ...(seccompFd !== undefined ? ["--seccomp", String(seccompFd)] : []),
    ...(relays.length > 0 ? ["--setenv", "SEKHEMET_RELAYS", relayEnv(relays)] : []),
    "--chdir",
    options.cwd,
    "--",
    ...(relays.length > 0 ? ["/bin/sh", "-c", relayScript(), RELAY_NAME, "--"] : []),
    command,
    ...args,
  ];
}
