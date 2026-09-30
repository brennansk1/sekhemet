import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  homeToolchainPaths,
  ledgerReadDenies,
  realPath,
  secretReadDenies,
  unixSocketRules,
} from "./seatbelt.js";
import { sessionSecretDenies } from "./secret_paths.js";

// SEC-23's path lists live beside the native profile, which denies them too.
export { ledgerReadDenies, secretReadDenies };
import type { SandboxOptions } from "./types.js";

/**
 * The srt engine (DEC-39): Anthropic's `@anthropic-ai/sandbox-runtime`
 * generates the Seatbelt profile or bubblewrap argv, behind our
 * `ProcessSandbox`. Selected by SEKHEMET_SANDBOX_ENGINE=srt; `native` stays
 * the default until both platforms pass the containment suite.
 *
 * `SandboxManager` is a process singleton. The filesystem policy travels per
 * command as `customConfig`. The network posture cannot: srt reads the proxy
 * ports, `allowLocalBinding` and whether the network is restricted from its
 * global configuration only. So the global configuration is keyed by the
 * network posture, and a command whose posture differs re-initialises the
 * singleton (serialised). Commands already running keep the profile they were
 * wrapped with; a reset only stops srt's own deny-all proxy, which leaves
 * their network refused either way.
 */

export const SRT_VERSION = "0.0.77";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/bash";

/**
 * Paths srt makes writable on its own (`getDefaultWritePaths`). The native
 * engine grants none of them, so each is denied back.
 */
function srtConvenienceWrites(home: string): string[] {
  return [
    "/tmp/claude",
    "/private/tmp/claude",
    join(home, ".npm", "_logs"),
    join(home, ".claude", "debug"),
  ];
}

/** Escape glob syntax in a literal path prefix. */
function globQuote(p: string): string {
  return p.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}

/** The per-command filesystem policy as srt `customConfig`. */
export function srtFilesystem(
  options: SandboxOptions,
  home: string = homedir(),
): SandboxRuntimeConfig["filesystem"] {
  const roots = [...options.allowedPaths, ...(options.scratchDir ? [options.scratchDir] : [])];
  const realRoots = [...new Set(roots.map(realPath))];
  // S2: no grant reaches the main checkout's dependency tree (item 24).
  const allowWrite = [...new Set(realRoots)];
  // `.git` at any depth, in any case (APFS is case-insensitive), as the
  // native profile does. srt's own mandatory denies cover only `.git/hooks`
  // and `.git/config`. The literal covers the root pointer on Linux, where
  // srt drops write globs.
  const denyWrite = [
    ...realRoots.flatMap((r) => [join(r, ".git"), `${globQuote(r)}/**/.[Gg][Ii][Tt]`]),
    ...srtConvenienceWrites(home),
  ];
  // S3a: `denyHomeReads` makes the whole home unreadable, its toolchains and
  // the granted roots excepted, as the native profile does.
  const homeDeny = options.denyHomeReads ? [realPath(home)] : [];
  const homeAllow = options.denyHomeReads ? homeToolchainPaths(home).map(realPath) : [];
  return {
    denyRead: [
      ...homeDeny,
      ...secretReadDenies(home),
      ...sessionSecretDenies(),
      ...ledgerReadDenies(roots),
    ],
    allowRead: [...realRoots, ...homeAllow],
    allowWrite,
    denyWrite,
  };
}

/** The network posture a command needs; each distinct one is a global srt config. */
export interface SrtNetworkPosture {
  key: string;
  network: SandboxRuntimeConfig["network"];
}

/**
 * The global network configuration for a command.
 *
 * - `allowNetwork`: no restriction (`allowedDomains` absent, so srt emits
 *   `(allow network*)`). Both proxy ports are set so srt starts no proxy of
 *   its own; they appear in no profile and no environment in this posture.
 * - `egressProxyPort`: our EgressProxy is the only way out. srt treats it as
 *   an external HTTP and SOCKS proxy, starts none of its own, and the profile
 *   allows outbound connections to that loopback port only.
 * - otherwise: no domains allowed; srt's own proxy refuses every request.
 *
 * `localPorts` becomes `allowLocalBinding`, which srt cannot scope to ports.
 */
export function srtNetwork(options: SandboxOptions): SrtNetworkPosture {
  const local = (options.localPorts ?? []).length > 0;
  if (options.allowNetwork) {
    return {
      key: `open|${local}`,
      network: {
        // Deliberately absent: srt restricts the network whenever it is set.
        allowedDomains: undefined as unknown as string[],
        deniedDomains: [],
        httpProxyPort: 9,
        socksProxyPort: 9,
        allowLocalBinding: local,
      },
    };
  }
  if (options.egressProxyPort) {
    const port = Math.floor(options.egressProxyPort);
    return {
      key: `egress:${port}|${local}`,
      network: {
        allowedDomains: [],
        deniedDomains: [],
        httpProxyPort: port,
        socksProxyPort: port,
        allowLocalBinding: local,
      },
    };
  }
  return {
    key: `none|${local}`,
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: local },
  };
}

/** Why srt cannot confine on this host, or undefined when it can. */
let supportCache: { reason: string | undefined } | undefined;
export function srtUnavailableReason(): string | undefined {
  if (supportCache) return supportCache.reason;
  let reason: string | undefined;
  try {
    if (!SandboxManager.isSupportedPlatform()) {
      reason = `srt does not support this platform (${platform()})`;
    } else if (platform() === "darwin" && !existsSync(SANDBOX_EXEC)) {
      // srt assumes sandbox-exec exists and does not check it.
      reason = `${SANDBOX_EXEC} is missing`;
    } else if (!existsSync(SHELL)) {
      reason = `${SHELL} is missing`;
    } else {
      const deps = SandboxManager.checkDependencies();
      if (deps.errors.length > 0) reason = deps.errors.join(", ");
    }
  } catch (err) {
    reason = (err as Error).message;
  }
  supportCache = { reason };
  return reason;
}

/** The fix to name when srt cannot run here. */
export function srtFix(): string {
  return platform() === "linux"
    ? "Install bubblewrap, socat and ripgrep"
    : "Use a macOS host with /usr/bin/sandbox-exec";
}

let currentKey: string | undefined;
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function ensurePosture(posture: SrtNetworkPosture): Promise<void> {
  if (currentKey === posture.key) return;
  if (currentKey !== undefined || SandboxManager.isSandboxingEnabled()) {
    await SandboxManager.reset();
  }
  currentKey = undefined;
  const config = {
    network: posture.network,
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  } as SandboxRuntimeConfig;
  await SandboxManager.initialize(config);
  currentKey = posture.key;
}

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

let commandSeq = 0;

/**
 * Wrap `command args` for srt. Returns the argv to spawn with the caller's
 * already-filtered environment: srt passes the environment through, so the
 * allowlist in `buildEnv` still decides what the command sees.
 */
export function srtWrap(
  command: string,
  args: string[],
  options: SandboxOptions,
): Promise<{ file: string; argv: string[] }> {
  const posture = srtNetwork(options);
  const filesystem = srtFilesystem(options);
  // srt sets TMPDIR=/tmp/claude when writes are restricted; the private
  // scratch directory wins. `exec` keeps the command as the process the
  // timeout signals.
  // With our egress proxy, every request goes through it (and is recorded),
  // as under the native engine: srt's NO_PROXY would send loopback and
  // private addresses direct, where the profile refuses them unrecorded.
  const proxy =
    !options.allowNetwork && options.egressProxyPort
      ? `http://127.0.0.1:${Math.floor(options.egressProxyPort)}`
      : undefined;
  const inner = [
    ...(options.scratchDir ? [`export TMPDIR=${shellQuote(options.scratchDir)};`] : []),
    ...(proxy
      ? [
          "unset NO_PROXY no_proxy;",
          ...[
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
          ].map((v) => `export ${v}=${shellQuote(proxy)};`),
        ]
      : []),
    "exec",
    shellQuote(command),
    ...args.map(shellQuote),
  ].join(" ");
  commandSeq += 1;
  const commandId = `sekhemet-${process.pid}-${commandSeq}`;
  return serialised(async () => {
    await ensurePosture(posture);
    const { argv } = await SandboxManager.wrapWithSandboxArgv(
      inner,
      SHELL,
      { filesystem },
      undefined,
      options.cwd,
      { commandId },
    );
    const [shell, flag, srtWrapped] = argv as [string, string, string];
    const wrapped =
      options.allowNetwork && platform() === "darwin"
        ? withUnixSocketRules(srtWrapped, [
            ...options.allowedPaths,
            ...(options.scratchDir ? [options.scratchDir] : []),
          ])
        : srtWrapped;
    // `exec` again at the outer level: the spawned pid is the command itself.
    return { file: shell, argv: [flag, `exec ${wrapped}`] };
  });
}

/** srt's open-network line in its macOS profile (SRT_VERSION), where the socket rules go. */
const SRT_OPEN_NETWORK = "\n(allow network*)\n";

/**
 * srt's macOS profile with the network open says `(allow network*)` and no
 * more, so a command could connect to the ssh-agent or any other Unix socket
 * by its path (W1 finding; srt's own Unix-socket rules apply only when it
 * restricts the network). The native engine's rules (`unixSocketRules`) are
 * placed right after that line; the profile is a single-quoted shell word in
 * srt's command, so each quote in them is written `'\''`. When the line is not
 * there exactly once the command is refused rather than run without them.
 */
export function withUnixSocketRules(wrapped: string, roots: string[]): string {
  const at = wrapped.indexOf(SRT_OPEN_NETWORK);
  if (at < 0 || wrapped.indexOf(SRT_OPEN_NETWORK, at + 1) >= 0) {
    throw new Error(
      `srt ${SRT_VERSION}'s profile did not have its open-network line exactly once, so the Unix-socket rules could not be added`,
    );
  }
  const rules = unixSocketRules(roots).replace(/'/g, "'\\''");
  const end = at + SRT_OPEN_NETWORK.length;
  return `${wrapped.slice(0, end)}${rules}\n${wrapped.slice(end)}`;
}

/** Linux only: remove the mount points bubblewrap left for absent deny paths. */
export function srtCleanup(): void {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Best effort.
  }
}

/** Test hook: drop the singleton's state. */
export async function srtReset(): Promise<void> {
  await serialised(async () => {
    currentKey = undefined;
    await SandboxManager.reset();
  });
}
