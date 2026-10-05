import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { processStartTime, sameProcess } from "@sekhemet/sandbox";
import {
  type SleepAssertion,
  findOnPath,
  holdSleepAssertion,
  sleepAssertionCommand,
} from "./sleep_assertion.js";
import { workspaceFolderOf } from "./workspace_locator.js";

/**
 * The runner lease (runtime.md item 3, NEW-runtime-1): one runner per
 * repository. It is taken by exclusive creation of `.sekhemet/runner.lock`
 * (`open(…, "wx")`), so of two processes racing for it exactly one gets it
 * (RUN-2); it carries the holder's pid, the process's start time and a random
 * token, and a heartbeat refreshes it every 3 s. A lease whose holder is gone
 * — pid absent, or alive with another start time (a recycled pid) — is stale
 * and is taken over without manual cleanup (RUN-5). `run <card>`, `queue` and
 * `overnight` all take it; a second runner is refused, naming the holder.
 */

export interface RosterEntry {
  role: "worker" | "manager" | "reviewer" | "researcher";
  model?: string;
}

export interface Lease {
  pid: number;
  /** The holder's start time from `ps -o lstart=`: a recycled pid does not match. */
  processStart?: string;
  /** Random per acquisition: a heartbeat never rewrites another holder's lease. */
  token: string;
  startedAt: string;
  heartbeatAt: string;
  /** What holds it: `run` (one card), `queue`, `overnight`, or a quick `benchmark` (MS-N5-6). */
  kind?: "run" | "queue" | "overnight" | "benchmark" | "qualify";
  cardId?: string;
  /** A child running under this lease (an overnight round), while it lives. */
  borrower?: { pid: number; processStart?: string };
  pmModel?: string;
  roster?: RosterEntry[];
  /** The role whose model is resident right now. */
  active?: string;
  /** Every role whose model is resident right now. */
  resident?: string[];
  coResident?: boolean;
}

export type LiveLeaseInfo = () => {
  pmModel?: string;
  roster?: RosterEntry[];
  active?: string;
  resident?: string[];
  coResident?: boolean;
};

export interface AcquireOptions {
  kind?: Lease["kind"];
  cardId?: string;
  pmModel?: string;
  /** Published with every heartbeat: the roster and residency, for the Machine view. */
  live?: LiveLeaseInfo;
  heartbeatMs?: number;
}

export const LEASE_HEARTBEAT_MS = 3_000;

/**
 * One lease per workspace (runtime item 2, DEC-57): a project root's
 * locator leads to the workspace folder, where the supervisor's files are.
 */
export const leasePath = (repoPath: string) =>
  join(workspaceFolderOf(repoPath), ".sekhemet", "runner.lock");

/** A lease file's contents, or undefined when absent or half-written. */
export function readLeaseFile<T extends Lease = Lease>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const readLease = (repoPath: string): Lease | undefined => readLeaseFile(leasePath(repoPath));

/** A lease's holder is alive: its pid runs with the start time it recorded. */
export function isLive(lease: Lease): boolean {
  return typeof lease.pid === "number" && sameProcess(lease.pid, lease.processStart);
}

/** A fresh lease body for this process. */
export function newLease(): Lease {
  const now = new Date().toISOString();
  const processStart = processStartTime(process.pid);
  return {
    pid: process.pid,
    ...(processStart ? { processStart } : {}),
    token: randomBytes(16).toString("hex"),
    startedAt: now,
    heartbeatAt: now,
  };
}

/** The live lease holder, or undefined when no runner holds it. */
export function runnerLease(repoPath: string): Lease | undefined {
  const lease = readLease(repoPath);
  return lease && isLive(lease) ? lease : undefined;
}

/** A second runner's refusal, naming the holder (CLI exit 1; HTTP 409). */
export function leaseRefusal(holder: Lease): string {
  const what = holder.kind === "run" && holder.cardId ? `run ${holder.cardId}` : holder.kind;
  return `Another runner holds the lease here (pid ${holder.pid}${what ? `, ${what}` : ""}, since ${holder.startedAt}); one runner at a time.`;
}

/**
 * Take the lease, or say who holds it. Exclusive creation decides a race; a
 * stale file is removed under a short takeover lock (itself exclusive), so
 * two processes that both find it stale cannot both delete a fresh lease.
 */
export function acquireRunnerLease(
  repoPath: string,
  options: AcquireOptions = {},
): { release: () => void; lease: Lease; awake: SleepAssertion } | { holder: Lease } {
  mkdirSync(join(workspaceFolderOf(repoPath), ".sekhemet"), { recursive: true });
  const lease: Lease = {
    ...newLease(),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.cardId ? { cardId: options.cardId } : {}),
    ...(options.pmModel ? { pmModel: options.pmModel } : {}),
  };
  const content = () =>
    JSON.stringify({
      ...lease,
      ...(options.live?.() ?? {}),
      heartbeatAt: new Date().toISOString(),
    });

  for (let tries = 0; tries < 50; tries++) {
    try {
      const fd = openSync(leasePath(repoPath), "wx");
      try {
        writeSync(fd, content());
      } finally {
        closeSync(fd);
      }
      // Every process group this runner starts is recorded, so a start after
      // a SIGKILL reaps what it left (RUN-12).
      process.env.SEKHEMET_PROCESS_REGISTRY ??= join(
        workspaceFolderOf(repoPath),
        ".sekhemet",
        "processes",
      );
      const releaseLease = startLeaseHeartbeat(
        leasePath(repoPath),
        lease.token,
        content,
        options.heartbeatMs,
      );
      // RUN-65: the machine stays awake while the lease is held, and the
      // assertion goes with the lease (and with this process, if killed).
      const awake = holdSleepAssertion({
        why: `Sekhemet ${options.kind ?? "run"}${options.cardId ? ` ${options.cardId}` : ""}`,
      });
      return {
        lease,
        awake,
        release: () => {
          awake.release();
          releaseLease();
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const current = readLease(repoPath);
    // Being written by its creator right now: look again.
    if (current === undefined) {
      sleepSync(5);
      continue;
    }
    if (isLive(current)) {
      // A round of `overnight` runs under its parent's lease (item 3): the
      // parent hands its token down, and only its own child may use it.
      const handed = process.env[LEASE_TOKEN_ENV];
      if (handed && handed === current.token && current.pid === process.ppid) {
        return borrow(repoPath, current, options);
      }
      return { holder: current };
    }
    removeStaleLease(leasePath(repoPath), current.token);
  }
  const holder = readLease(repoPath);
  if (holder) return { holder };
  throw new Error(`Could not take the runner lease at ${leasePath(repoPath)}`);
}

/** The environment variable a lease holder hands its token to its own child in. */
export const LEASE_TOKEN_ENV = "SEKHEMET_RUNNER_LEASE_TOKEN";

/**
 * Run under the parent's lease: the child publishes its live roster in it
 * (the Machine view) and, on release, hands it back unchanged.
 */
function borrow(
  repoPath: string,
  parent: Lease,
  options: AcquireOptions,
): { release: () => void; lease: Lease; awake: SleepAssertion } {
  const path = leasePath(repoPath);
  const processStart = processStartTime(process.pid);
  const borrower = { pid: process.pid, ...(processStart ? { processStart } : {}) };
  const write = (body: Lease) => {
    if (readLease(repoPath)?.token !== parent.token) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, path);
  };
  const beat = () => {
    try {
      write({
        ...parent,
        ...(options.live?.() ?? {}),
        borrower,
        heartbeatAt: new Date().toISOString(),
      });
    } catch {
      // A missed heartbeat only matters if the process is also gone.
    }
  };
  beat();
  const timer = setInterval(beat, options.heartbeatMs ?? LEASE_HEARTBEAT_MS);
  timer.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    process.off("exit", release);
    try {
      write({ ...parent, heartbeatAt: new Date().toISOString() });
    } catch {
      // The parent's own heartbeat rewrites it.
    }
  };
  process.once("exit", release);
  installShutdownSignals();
  return { lease: parent, release, awake: parentAwake() };
}

/**
 * A borrowed lease's sleep assertion is its holder's (an overnight round runs
 * under the night's): held when this machine has the tool, which the holder
 * took it with; otherwise the same note the holder's report gives.
 */
function parentAwake(): SleepAssertion {
  const command = sleepAssertionCommand(process.platform, process.ppid);
  if (command && findOnPath(command.tool))
    return { held: true, tool: `${command.tool} (the lease holder's)`, release: () => {} };
  return { ...holdSleepAssertion({ findTool: () => undefined }), release: () => {} };
}

/**
 * Take the lease for this process or throw, naming the holder. Returns the
 * release; released on exit too.
 */
export function holdRunnerLease(
  repoPath: string,
  pmModel?: string,
  live?: LiveLeaseInfo,
  kind: Lease["kind"] = "queue",
): () => void {
  const got = acquireRunnerLease(repoPath, {
    kind,
    ...(pmModel ? { pmModel } : {}),
    ...(live ? { live } : {}),
  });
  if ("holder" in got) throw new RunnerLeaseHeld(got.holder);
  return got.release;
}

export class RunnerLeaseHeld extends Error {
  constructor(public readonly holder: Lease) {
    super(leaseRefusal(holder));
  }
}

/**
 * Refresh the lease file at `path` every `heartbeatMs` while it still carries
 * `token`; the returned release removes it (only if still ours), and runs on
 * exit too. The runner lease and each slot lease (RUN-35) beat this way.
 */
export function startLeaseHeartbeat(
  path: string,
  token: string,
  content: () => string,
  heartbeatMs = LEASE_HEARTBEAT_MS,
): () => void {
  const ours = () => readLeaseFile(path)?.token === token;
  const beat = setInterval(() => {
    try {
      const current = readLeaseFile(path);
      if (current?.token !== token) return;
      // A child running under this lease publishes it meanwhile.
      if (current.borrower && sameProcess(current.borrower.pid, current.borrower.processStart)) {
        return;
      }
      const tmp = `${path}.${token}.tmp`;
      writeFileSync(tmp, content());
      renameSync(tmp, path);
    } catch {
      // A missed heartbeat only matters if the process is also gone.
    }
  }, heartbeatMs);
  beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    process.off("exit", release);
    try {
      if (ours()) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  installShutdownSignals();
  return release;
}

let shutdownInstalled = false;

/**
 * SIGTERM and SIGHUP end a lease holder through `process.exit` (runtime item
 * 9, RUN-8), so the synchronous exit handlers run first: the lease is
 * released and every process group this process started is killed
 * (`@sekhemet/sandbox`'s tracked groups). Without a listener, Node would die
 * on the signal and run no exit handler at all.
 */
function installShutdownSignals(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGHUP", () => process.exit(129));
}

/**
 * Run `fn` holding a short exclusive lock at `lock` (created with "wx"), or
 * return undefined when another process holds it. A lock left by a process
 * killed while holding it is itself stale after 10 s.
 */
export function tryWithLock<T>(lock: string, fn: () => T): { value: T } | undefined {
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
    } catch {
      // Removed by its holder meanwhile.
    }
    sleepSync(5);
    return undefined;
  }
  try {
    return { value: fn() };
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** Remove the lease file only if it is still the stale one read (by token). */
export function removeStaleLease(path: string, staleToken: string | undefined): void {
  tryWithLock(`${path}.takeover`, () => {
    const current = readLeaseFile(path);
    if (current && current.token === staleToken && !isLive(current)) {
      rmSync(path, { force: true });
    }
  });
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
