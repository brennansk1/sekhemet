import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { BWRAP_CANDIDATES, bubblewrapUnavailableReason } from "./bubblewrap.js";
import {
  type HostRelays,
  type RelaySpec,
  commandRelayPlan,
  relayEnv,
  relayScriptPath,
  startHostRelays,
} from "./relay.js";
import {
  BROWSER_RULES,
  homeToolchainPaths,
  isolationRules,
  keychainRules,
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

/**
 * srt's own helpers (`vendor/`: the `apply-seccomp` program every Linux
 * command starts through, the Java proxy agent), inside Sekhemet's
 * installation. That is usually under the home, so `denyHomeReads` reads them
 * back as it does the toolchains (R9: without them every command under srt on
 * Linux exited 127 with the home emptied).
 */
function srtVendorDir(): string | undefined {
  try {
    const main = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
    const dir = join(dirname(dirname(main)), "vendor");
    return existsSync(dir) ? realPath(dir) : undefined;
  } catch {
    return undefined;
  }
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
    ...(options.denyPaths ?? []).filter((p) => platform() === "darwin" || !p.includes("*")),
  ];
  // S3a: `denyHomeReads` makes the whole home unreadable, its toolchains and
  // the granted roots excepted, as the native profile does.
  const homeDeny = options.denyHomeReads ? [realPath(home)] : [];
  const vendor = options.denyHomeReads ? srtVendorDir() : undefined;
  // DEC-50: on Linux srt runs the relay script as its socat, inside.
  const relayDir =
    options.denyHomeReads && platform() === "linux" ? [realPath(dirname(relayScriptPath()))] : [];
  const homeAllow = options.denyHomeReads
    ? [...homeToolchainPaths(home).map(realPath), ...(vendor ? [vendor] : []), ...relayDir]
    : [];
  // Item 8c: hidden paths, and the grants inside them read back.
  const hidden = [...new Set((options.hiddenReadPaths ?? []).map(realPath))];
  const inHidden = [
    ...new Set([...realRoots, ...(options.readOnlyPaths ?? []).map(realPath)]),
  ].filter((g) => hidden.some((h) => g === h || g.startsWith(`${h}/`)));
  return {
    denyRead: [
      ...homeDeny,
      ...hidden,
      ...secretReadDenies(home),
      ...sessionSecretDenies(),
      ...ledgerReadDenies(roots),
      // Item 10a: the card's view of other projects (no glob on Linux).
      ...(options.denyPaths ?? []).filter((p) => platform() === "darwin" || !p.includes("*")),
    ],
    allowRead: [...new Set([...realRoots, ...homeAllow, ...inHidden])],
    allowWrite,
    denyWrite,
  };
}

/** Item 10a's masked folders that exist as folders: srt hides each behind a tmpfs on Linux. */
function maskedFolders(denyPaths: readonly string[] | undefined): string[] {
  return (denyPaths ?? []).filter((p) => {
    if (p.includes("*")) return false;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
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
 * `localPorts` becomes `allowLocalBinding`, which srt cannot scope to ports;
 * on macOS `localPortRules` scopes it back to the named ports (F29), and on
 * Linux only the relayed ports cross srt's network namespace (DEC-50).
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

/**
 * Where srt's Linux sandbox listens for HTTP proxy requests (SRT_VERSION's
 * `buildSandboxCommand`): a socat inside its empty network namespace relays
 * this port, through a Unix socket srt binds in, to `httpProxyPort` on the
 * host, our EgressProxy. The proxy's host port itself is unreachable there.
 */
export const SRT_LINUX_PROXY_PORT = 3128;

/**
 * The proxy URL a command under srt is given when our EgressProxy is its only
 * way out (S5), or undefined when there is none. On macOS the profile allows
 * the proxy's loopback port; on Linux the command reaches it through srt's
 * relay (R9: pointing it at the host port left every request unanswered).
 */
export function srtProxyUrl(
  options: SandboxOptions,
  os: NodeJS.Platform = platform(),
): string | undefined {
  if (options.allowNetwork || !options.egressProxyPort) return undefined;
  const port = os === "linux" ? SRT_LINUX_PROXY_PORT : Math.floor(options.egressProxyPort);
  return `http://127.0.0.1:${port}`;
}

/**
 * DEC-50: what srt's command runs inside its seccomp filter before the
 * command when a card's ports are relayed: wait until each relay listens
 * (they were started before the filter, by the relay script srt runs as its
 * socat), then drop the variable that named them.
 */
export function srtRelayInner(plan: readonly RelaySpec[], script = relayScriptPath()): string {
  if (plan.length === 0) return "";
  return `/bin/sh ${shellQuote(script)} --wait; unset SEKHEMET_RELAYS;`;
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
      // srt runs bubblewrap on Linux: installed is not usable (SEC-17c).
      const bwrap = BWRAP_CANDIDATES.find((p) => existsSync(p));
      if (reason === undefined && platform() === "linux" && bwrap) {
        reason = bubblewrapUnavailableReason(bwrap);
      }
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
    // DEC-50: srt starts its proxy listener inside the sandbox through its
    // socat, before its seccomp filter refuses Unix sockets; the relay
    // script starts a card's port relays there too, then execs socat.
    ...(platform() === "linux" ? { socatPath: relayScriptPath() } : {}),
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
 * allowlist in `buildEnv` still decides what the command sees. On Linux a
 * card's named ports cross srt's empty network namespace through relays
 * (DEC-50; srt relays the proxy itself), whose host half is returned
 * running: the caller closes it when the command exits.
 */
export function srtWrap(
  command: string,
  args: string[],
  options: SandboxOptions,
): Promise<{ file: string; argv: string[]; relays?: HostRelays }> {
  const posture = srtNetwork(options);
  const filesystem = srtFilesystem(options);
  // srt sets TMPDIR=/tmp/claude when writes are restricted; the private
  // scratch directory wins. `exec` keeps the command as the process the
  // timeout signals.
  // With our egress proxy, every request goes through it (and is recorded),
  // as under the native engine: srt's NO_PROXY would send loopback and
  // private addresses direct, where the profile refuses them unrecorded.
  const proxy = srtProxyUrl(options);
  const plan =
    platform() === "linux"
      ? commandRelayPlan({
          allowNetwork: options.allowNetwork,
          ...(options.localPorts ? { localPorts: options.localPorts } : {}),
          ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
        })
      : [];
  const relayInner = srtRelayInner(plan);
  const inner = [
    ...(relayInner ? [relayInner] : []),
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
    const withSockets =
      options.allowNetwork && platform() === "darwin"
        ? withUnixSocketRules(srtWrapped, [
            ...options.allowedPaths,
            ...(options.scratchDir ? [options.scratchDir] : []),
          ])
        : srtWrapped;
    // SEC-23b: srt's allowlist names the keychain's services itself.
    // Item 10a: a card's denies placed last too, where no srt allow reopens them.
    // Item 11a (C2c): certificate trust only with the network open.
    // Item 11a (B1): a headless browser's rules, the native engine's own.
    const wrapped =
      platform() === "darwin"
        ? withKeychainRules(
            withSockets,
            [
              trustRulesFor(options),
              browserRulesFor(options),
              localPortRules(options, srtWrapped),
              isolationRules(options.denyPaths),
            ]
              .filter(Boolean)
              .join("\n"),
          )
        : withReadOnlyMasks(withSockets, maskedFolders(options.denyPaths));
    // `exec` again at the outer level: the spawned pid is the command itself.
    if (plan.length === 0) return { file: shell, argv: [flag, `exec ${wrapped}`] };
    return {
      file: shell,
      argv: [flag, `export SEKHEMET_RELAYS=${shellQuote(relayEnv(plan))}; exec ${wrapped}`],
      relays: startHostRelays(plan),
    };
  });
}

/**
 * Security item 11a (C2c): srt's allowlist leaves out trustd, so under srt a
 * certificate check (`SecTrustEvaluateWithError`: Go, `native-tls`, the
 * `security` tool) never trusts a system root. trustd holds no secret (the
 * keychain's services stay denied, last, by `keychainRules`), but it runs
 * outside the sandbox and fetches the AIA, OCSP and CRL URLs a certificate
 * names: this one lookup is srt's own `enableWeakerNetworkIsolation`, which
 * srt calls an exfiltration route and SANDBOX_REUSE risk 7 keeps off.
 */
export const TRUSTD_RULES = '(allow mach-lookup (global-name "com.apple.trustd.agent"))';

/**
 * trustd's lookup only where it opens no route the command lacks: the
 * network is open (C2c review). With only the egress proxy or a named
 * loopback port granted — a card's usual posture — it stays off, since
 * trustd's fetches would pass the allowlist unrecorded; TLS verification
 * through the system's trust store then fails under srt (item 11a's cost).
 */
export function trustRulesFor(options: Pick<SandboxOptions, "allowNetwork">): string {
  return options.allowNetwork ? TRUSTD_RULES : "";
}

/**
 * The one lookup srt's macOS profile lacks for a headless browser: Chromium's
 * child processes look up the services its browser process registered
 * (`org.chromium.…MachPortRendezvousServer.<pid>`). The native profile
 * allows every `mach-lookup`, so this is narrower than it.
 */
export const SRT_BROWSER_LOOKUP = '(allow mach-lookup (global-name-prefix "org.chromium."))';

/**
 * Security item 11a (B1): srt's macOS profile has nothing for a headless
 * browser: Chromium could not register its own Mach services and died at
 * start, and its renderer could not reach them. A command that runs one
 * (`SandboxOptions.browser`) gets the native profile's rules
 * (`seatbelt.ts` BROWSER_RULES) and the lookup of the same names, placed
 * with the other additions, before the keychain's. Nothing is wider than the
 * native profile, whose `mach-lookup` is unrestricted.
 */
export function browserRulesFor(options: Pick<SandboxOptions, "browser">): string {
  return options.browser ? `${BROWSER_RULES.trim()}\n${SRT_BROWSER_LOOKUP}` : "";
}

/**
 * F29: srt maps a card's `localPorts` to `allowLocalBinding`, and its macOS
 * profile (SRT_VERSION) then allows outbound to `localhost:*` — every
 * loopback listener on the host (the model server, the dashboard, another
 * card's app) for a command that was granted one port. These rules, placed
 * after srt's own (the later rule wins), deny loopback outbound again and
 * allow back only the named ports and the loopback ports srt's profile
 * names itself (its proxy, or our egress proxy), as the native profile does
 * (`seatbelt.ts` portRules). With the network open there is nothing to scope.
 */
export function localPortRules(
  options: Pick<SandboxOptions, "allowNetwork" | "localPorts" | "egressProxyPort">,
  profile: string,
): string {
  if (options.allowNetwork || (options.localPorts ?? []).length === 0) return "";
  const named = (options.localPorts ?? []).map((p) => Math.floor(p));
  const srts = [
    ...profile.matchAll(/\(allow network-outbound \(remote ip "localhost:(\d+)"\)\)/g),
  ].map((m) => Number(m[1]));
  const proxy = options.egressProxyPort ? [Math.floor(options.egressProxyPort)] : [];
  const ports = [...new Set([...named, ...srts, ...proxy])].sort((a, b) => a - b);
  return [
    ";; F29: a card's named loopback ports only (srt's allowLocalBinding allows localhost:*).",
    '(deny network-outbound (remote ip "localhost:*"))',
    ...ports.map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
  ].join("\n");
}

/**
 * A word as srt's `quote` renders it (SRT_VERSION, `utils/shell-quote.js`):
 * bare when nothing in it is special to a shell, else single-quoted.
 */
function srtWord(word: string): string {
  if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(word)) return word;
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

/** A word of srt's command: its text once unquoted, where it starts, and whether any of it was quoted. */
interface SrtToken {
  text: string;
  start: number;
  quoted: boolean;
}

/**
 * srt's command split into words by its own quoting rules (SRT_VERSION,
 * `utils/shell-quote.js`: a word is bare, or single-quoted with each quote
 * written '"'"'), read as a POSIX shell reads them: single quotes, double
 * quotes and a backslash outside quotes. A word with any quoted part is marked
 * quoted, so an owner-controlled path holding " --dev /dev " stays one word.
 * Refuses an unterminated quote rather than guess.
 */
function srtWords(command: string): SrtToken[] {
  const words: SrtToken[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command.charAt(i))) i += 1;
    if (i >= command.length) break;
    const start = i;
    let text = "";
    let quoted = false;
    while (i < command.length && !/\s/.test(command.charAt(i))) {
      const c = command.charAt(i);
      if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) throw new Error(`srt ${SRT_VERSION}'s command had an unterminated quote`);
        text += command.slice(i + 1, close);
        quoted = true;
        i = close + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < command.length && command.charAt(j) !== '"') {
          if (command.charAt(j) === "\\" && j + 1 < command.length) j += 1;
          text += command.charAt(j);
          j += 1;
        }
        if (j >= command.length) {
          throw new Error(`srt ${SRT_VERSION}'s command had an unterminated quote`);
        }
        quoted = true;
        i = j + 1;
      } else if (c === "\\" && i + 1 < command.length) {
        text += command.charAt(i + 1);
        quoted = true;
        i += 2;
      } else {
        text += c;
        i += 1;
      }
    }
    words.push({ text, start, quoted });
  }
  return words;
}

/**
 * Where srt's Linux mounts end (SRT_VERSION): it binds a fresh /dev right
 * after them, as the unquoted words `--dev` `/dev`. The index of `--dev` in
 * `words`; refused when the pair is missing or appears more than once, since
 * then the end of the mounts is not known (C4, from C3's review).
 */
function srtMountsEnd(words: readonly SrtToken[]): number {
  const ends: number[] = [];
  for (let k = 0; k + 1 < words.length; k += 1) {
    const [a, b] = [words[k], words[k + 1]];
    if (a && b && !a.quoted && !b.quoted && a.text === "--dev" && b.text === "/dev") ends.push(k);
  }
  if (ends.length === 0) {
    throw new Error(
      `srt ${SRT_VERSION}'s command had no end of its mounts, so the masked folders could not be made read-only`,
    );
  }
  if (ends.length > 1) {
    throw new Error(
      `srt ${SRT_VERSION}'s command had more than one end of its mounts, so the masked folders could not be made read-only`,
    );
  }
  return ends[0] as number;
}

/**
 * Item 10a under srt on Linux (B1): srt hides a read-denied folder behind a
 * tmpfs it leaves writable, by design, and applies `denyWrite` only within
 * the writable roots; a write at the top of a masked folder then exited 0
 * into a private copy nobody sees. The native engine mounts the same folders
 * read-only (`bubblewrap.ts`). Each masked folder srt mounted a tmpfs for is
 * remounted read-only the same way, after all of srt's mounts, so a mount srt
 * restores inside it is unaffected. A folder srt mounted nothing for gets
 * nothing only when it does not exist or a remounted masked folder above
 * covers it; any other is refused (B1 review). The command is also refused
 * when srt's mounts cannot be read (passed through a file, or no single end
 * found), rather than run with a writable mask. srt's command is read word by
 * word under its own quoting rules (`srtWords`), so a quoted path is never
 * taken for a mount or for the end of the mounts (C4).
 */
export function withReadOnlyMasks(wrapped: string, dirs: readonly string[]): string {
  if (dirs.length === 0) return wrapped;
  const words = srtWords(wrapped);
  const end = srtMountsEnd(words);
  const mounts = words.slice(0, end);
  if (mounts.some((w) => !w.quoted && w.text === "--args")) {
    throw new Error(
      `srt ${SRT_VERSION} passed its mounts through a file, so the masked folders could not be made read-only`,
    );
  }
  const tmpfsCount = (dir: string) =>
    mounts.filter((w, k) => !w.quoted && w.text === "--tmpfs" && mounts[k + 1]?.text === dir)
      .length;
  const remounts: string[] = [];
  for (const dir of dirs) {
    const count = tmpfsCount(dir);
    if (count === 0) {
      // srt mounts nothing for a folder that does not exist, and --remount-ro
      // on a masked folder above makes everything under it read-only. Any
      // other folder would stay writable: refuse rather than fail open.
      const covered = dirs.some((up) => up !== dir && isUnder(dir, up) && tmpfsCount(up) > 0);
      if (!existsSync(dir) || covered) continue;
      throw new Error(
        `srt ${SRT_VERSION} mounted no tmpfs for ${dir}, so it could not be made read-only`,
      );
    }
    if (count > 1) {
      throw new Error(
        `srt ${SRT_VERSION} mounted ${dir} more than once, so it could not be made read-only`,
      );
    }
    remounts.push(`--remount-ro ${srtWord(dir)}`);
  }
  if (remounts.length === 0) return wrapped;
  const at = (words[end] as SrtToken).start;
  return `${wrapped.slice(0, at)}${remounts.join(" ")} ${wrapped.slice(at)}`;
}

/** Whether `dir` is strictly inside `up`. */
function isUnder(dir: string, up: string): boolean {
  const rel = relative(up, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

/** Where srt's command hands its profile to Seatbelt (SRT_VERSION): a single-quoted shell word follows. */
const SRT_PROFILE_START = "/usr/bin/sandbox-exec -p '";

/**
 * srt's macOS profile allows `mach-lookup` of `com.apple.SecurityServer` and
 * `com.apple.securityd.xpc`, the keychain's own services, with no setting to
 * remove them, so a sandboxed `security find-generic-password -w` read
 * Sekhemet's items (W2b finding, SEC-23b). The native engine's keychain rules
 * (`keychainRules`) are placed last in the profile, where they win over every
 * allow before them. The profile is a single-quoted shell word; a quote
 * inside it is written `'"'"'` by srt (and `'\''` by `withUnixSocketRules`),
 * so the word ends at the first quote that begins neither. When srt's command
 * has no such profile the command is refused rather than run without them.
 */
export function withKeychainRules(wrapped: string, extra = ""): string {
  const start = wrapped.indexOf(SRT_PROFILE_START);
  if (start < 0) {
    throw new Error(
      `srt ${SRT_VERSION}'s command did not hand Seatbelt a profile, so the keychain rules could not be added`,
    );
  }
  let at = start + SRT_PROFILE_START.length;
  for (;;) {
    const q = wrapped.indexOf("'", at);
    if (q < 0) {
      throw new Error(
        `srt ${SRT_VERSION}'s profile did not end, so the keychain rules could not be added`,
      );
    }
    if (wrapped.startsWith(`'"'"'`, q)) at = q + 5;
    else if (wrapped.startsWith(`'\\''`, q)) at = q + 4;
    else {
      const rules = `${extra ? `${extra}\n` : ""}${keychainRules()}`.replace(/'/g, `'"'"'`);
      return `${wrapped.slice(0, q)}\n${rules}\n${wrapped.slice(q)}`;
    }
  }
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
