import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type ProcessSandbox,
  confinedSandbox,
  sampleTreeMemory,
  stopProcessTree,
} from "./executor.js";
import { ledgerReadDenies } from "./seatbelt.js";
import type { ExecutionResult, SandboxOptions } from "./types.js";

/**
 * The one chokepoint for processes that execute worktree code (security
 * items 4, 6, 8a; S3a): the visual gate's dev server and browser, the
 * `browse` tool's browser, language servers, package gates and
 * `--validate-tools`. Everything goes through ProcessSandbox, so fail closed
 * (S3b) applies; the network is off unless an egress proxy port is given;
 * the environment is the executor's allowlist plus the variables the caller
 * names; the writable root and working directory come from the harness.
 */
export interface ConfinedOptions {
  /** The card's recorded root, chosen by the harness. Canonicalised (item 8a). */
  root: string;
  /**
   * The working directory. Inside `root` or clamped to it: a supplied path
   * never widens the sandbox (SEC-6b).
   */
  cwd?: string;
  /** Further harness-chosen writable directories (a browser profile). Never model-supplied. */
  writable?: string[];
  /**
   * Harness-chosen paths the process may read and never write (DS-N9-17: a
   * research probe's repository and dependency roots). Never model-supplied.
   * A project ledger inside one stays unreadable (SEC-23).
   */
  readOnly?: string[];
  /**
   * Harness-chosen paths whose contents are unreadable, the writable roots
   * and read-only grants inside them excepted (security item 8c: a research
   * packet's probe sees the dependencies, never the project). Never
   * model-supplied.
   */
  hiddenReads?: string[];
  /** Variables the caller names, on top of the allowlist (item 6). Keys and tokens are dropped. */
  env?: Record<string, string>;
  /** The egress proxy's loopback port: the only way out when given (S5). */
  egressProxyPort?: number;
  /** Loopback ports the process may listen on and connect to. */
  localPorts?: number[];
  /** Wall-clock limit. Background processes: 0 leaves the lifetime to the caller. */
  timeoutMs: number;
  /** Resident-memory cap for the process tree (S7). */
  maxMemoryBytes?: number;
  maxBufferBytes?: number;
  /** A private scratch directory (TMPDIR); by default a fresh one per run. */
  scratchDir?: string;
  /** A headless browser (SandboxOptions.browser). */
  browser?: boolean;
  /** Nothing under the user's home is readable but its toolchains (SandboxOptions.denyHomeReads). */
  denyHomeReads?: boolean;
  /** `--restricted`: no opt-out from confinement. */
  restricted?: boolean;
  /** The sandbox to use; default `confinedSandbox(restricted)`. */
  sandbox?: ProcessSandbox;
}

export interface ConfinedPlacement {
  /** The canonical root the profile is generated from. */
  root: string;
  /** The working directory actually used, inside `root`. */
  cwd: string;
  /** True when the requested cwd lay outside the root and was clamped to it. */
  cwdClamped: boolean;
}

/** Names that carry credentials: never passed in, whoever names them (item 6). */
const SECRET_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)/i;

function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Where a confined process runs: the canonical root, and a cwd inside it (item 8a, SEC-6b). */
export function confinedPlacement(root: string, cwd?: string): ConfinedPlacement {
  const canonRoot = canonical(root);
  if (cwd === undefined) return { root: canonRoot, cwd: canonRoot, cwdClamped: false };
  const wanted = canonical(isAbsolute(cwd) ? cwd : resolve(canonRoot, cwd));
  if (inside(canonRoot, wanted) && existsSync(wanted)) {
    return { root: canonRoot, cwd: wanted, cwdClamped: false };
  }
  return { root: canonRoot, cwd: canonRoot, cwdClamped: true };
}

function callerEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) if (!SECRET_NAME.test(k)) out[k] = v;
  return out;
}

function sandboxOptions(options: ConfinedOptions, place: ConfinedPlacement): SandboxOptions {
  const readOnly = [...new Set((options.readOnly ?? []).map(canonical))];
  // Every engine masks the ledgers above a writable root; those inside a
  // read-only grant are masked here, as bubblewrap already does (SEC-23).
  const ledgers = readOnly.length > 0 ? ledgerReadDenies(readOnly) : [];
  return {
    allowedPaths: [place.root, ...(options.writable ?? []).map(canonical)],
    ...(readOnly.length ? { readOnlyPaths: readOnly } : {}),
    ...(options.hiddenReads?.length
      ? { hiddenReadPaths: [...new Set(options.hiddenReads.map(canonical))] }
      : {}),
    ...(ledgers.length ? { denyPaths: ledgers } : {}),
    allowNetwork: false,
    timeoutMs: options.timeoutMs,
    cwd: place.cwd,
    env: callerEnv(options.env),
    ...(options.egressProxyPort ? { egressProxyPort: options.egressProxyPort } : {}),
    ...(options.localPorts?.length ? { localPorts: options.localPorts } : {}),
    ...(options.maxMemoryBytes ? { maxMemoryBytes: options.maxMemoryBytes } : {}),
    ...(options.maxBufferBytes ? { maxBufferBytes: options.maxBufferBytes } : {}),
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
    ...(options.browser ? { browser: true } : {}),
    ...(options.denyHomeReads ? { denyHomeReads: true } : {}),
  };
}

/** Run worktree code to completion, confined (item 4). */
export async function runConfined(
  command: string,
  args: string[],
  options: ConfinedOptions,
): Promise<ExecutionResult & ConfinedPlacement> {
  const place = confinedPlacement(options.root, options.cwd);
  const sandbox = options.sandbox ?? confinedSandbox(options.restricted === true);
  const result = await sandbox.execute(command, args, sandboxOptions(options, place));
  return { ...result, ...place };
}

/** A confined background process; `stop()` ends it and every descendant. */
export type ConfinedChild = ChildProcessWithoutNullStreams & { stop: () => Promise<void> };

/** Attach `stop()` and hold the tree to its memory cap and time limit. */
function watch(child: ChildProcessWithoutNullStreams, options: ConfinedOptions): ConfinedChild {
  const confined = Object.assign(child, { stop: () => stopProcessTree(child) });
  const timers: NodeJS.Timeout[] = [];
  if (options.timeoutMs > 0) {
    const t = setTimeout(() => void confined.stop(), options.timeoutMs);
    t.unref?.();
    timers.push(t);
  }
  if (options.maxMemoryBytes) {
    const cap = options.maxMemoryBytes;
    const t = setInterval(() => {
      if (child.pid === undefined) return;
      void sampleTreeMemory(child.pid).then(({ bytes }) => {
        if (bytes > cap) void confined.stop();
      });
    }, 500);
    t.unref?.();
    timers.push(t);
  }
  child.once("exit", () => {
    for (const t of timers) clearTimeout(t);
  });
  return confined;
}

/**
 * Start a long-lived confined process (a dev server, a browser, a language
 * server). `null` when confinement is required and unavailable: the caller
 * reports it rather than running the code unconfined.
 */
export async function spawnConfined(
  command: string,
  args: string[],
  options: ConfinedOptions,
): Promise<ConfinedChild | null> {
  const place = confinedPlacement(options.root, options.cwd);
  const sandbox = options.sandbox ?? confinedSandbox(options.restricted === true);
  const child = await sandbox.spawnBackgroundAsync(command, args, sandboxOptions(options, place));
  return child ? watch(child, options) : null;
}

/** `spawnConfined` for synchronous callers (a language-server client's constructor). */
export function spawnConfinedSync(
  command: string,
  args: string[],
  options: ConfinedOptions,
): ConfinedChild | null {
  const place = confinedPlacement(options.root, options.cwd);
  const sandbox = options.sandbox ?? confinedSandbox(options.restricted === true);
  const child = sandbox.spawnBackground(command, args, sandboxOptions(options, place));
  return child ? watch(child, options) : null;
}
