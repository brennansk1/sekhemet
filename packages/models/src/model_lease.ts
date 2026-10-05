import { execFileSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { sekhemetConfigDir } from "./models_dir.js";

/**
 * One machine-wide model lease (models NEW-models-17, MD-N17-1, MD-N17-2;
 * FINDINGS REL-07). The residency lock is in-process, so two projects (two
 * workspaces, or a dashboard and a `run` of one) could each load weights at
 * the same moment on a 24 GB host. Every managed load takes this lease first
 * and keeps it while its weights are resident; the unload gives it up.
 *
 * The lease is `<user dir>/model.lock`, taken by exclusive creation
 * (`open(…, "wx")`), so of two processes racing for it exactly one gets it,
 * as the runner lease (`apps/harness/src/runner_lease.ts`). It names its
 * holder by pid and process start time, so a holder killed outright, or a pid
 * the system has since given to another process, leaves a stale lease that
 * the next process takes over without manual cleanup; and it names the
 * workspace, project, and each model it holds with its port, so a process
 * that must wait can say who holds what. One process holds it once for every
 * model it loads (co-resident roles) and gives it up after the last.
 *
 * It is a lock, not a record: nothing durable lives in it (the spine: the
 * event log is the only durable channel), and a lost file loses nothing.
 */

export interface ModelLeaseEntry {
  model: string;
  port: number;
  since: string;
  /** Which hold in the holding process this entry is (one per load). */
  hold: string;
}

export interface ModelLease {
  pid: number;
  /** The holder's start time from `ps -o lstart=`: a recycled pid does not match. */
  processStart?: string;
  token: string;
  since: string;
  /** The holder's workspace: its id (`ws_…`) when known, else its folder. */
  workspace: string;
  /** The holder's project: its folder. */
  project: string;
  models: ModelLeaseEntry[];
}

export interface ModelLeaseOwner {
  workspace: string;
  project: string;
}

/** What one load asks the lease for. */
export interface ModelLeaseHold {
  model: string;
  port: number;
}

let owner: ModelLeaseOwner | undefined;

/**
 * Who this process is, as its lease names it. The harness sets it from the
 * workspace it serves (`ModelAccess`); otherwise the working folder.
 */
export function setModelLeaseOwner(o: Partial<ModelLeaseOwner>): void {
  owner = { ...modelLeaseOwner(), ...o };
}

export function modelLeaseOwner(): ModelLeaseOwner {
  return owner ?? { workspace: process.cwd(), project: process.cwd() };
}

/** `<user dir>/model.lock`. */
export function modelLeasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(sekhemetConfigDir(env), "model.lock");
}

/**
 * A process's start time as `ps -o lstart=` gives it, in UTC and the C
 * locale; undefined when the process is gone. The same reading as
 * `@sekhemet/sandbox`'s `processStartTime`, which this package does not
 * depend on.
 */
export function leaseProcessStart(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 5_000,
    })
      .trim()
      .replace(/\s+/g, " ");
    return out || undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lease's holder runs: its pid is alive with the start time it recorded. */
export function modelLeaseLive(lease: ModelLease): boolean {
  if (typeof lease.pid !== "number" || !pidAlive(lease.pid)) return false;
  if (lease.processStart === undefined) return true;
  return leaseProcessStart(lease.pid) === lease.processStart;
}

/** The lease file's contents, or undefined when absent or half-written. */
export function readModelLease(path: string = modelLeasePath()): ModelLease | undefined {
  try {
    const lease = JSON.parse(readFileSync(path, "utf8")) as ModelLease;
    return typeof lease.pid === "number" && Array.isArray(lease.models) ? lease : undefined;
  } catch {
    return undefined;
  }
}

/** The live holder, or undefined when no process holds it. */
export function liveModelLease(path: string = modelLeasePath()): ModelLease | undefined {
  const lease = readModelLease(path);
  return lease && modelLeaseLive(lease) ? lease : undefined;
}

/** Who holds which model, in a person's words. */
export function modelLeaseHolderWords(holder: ModelLease): string {
  const what =
    holder.models.length > 0
      ? holder.models.map((m) => `${m.model} on port ${m.port}`).join(" and ")
      : "the lease";
  return `project ${holder.project} (workspace ${holder.workspace}) holds ${what} (pid ${holder.pid}, since ${holder.since})`;
}

/** The line a process prints once when it must wait (MD-N17-2). */
export function modelLeaseWaitLine(holder: ModelLease): string {
  return `Waiting for this machine's model lease: ${modelLeaseHolderWords(holder)}.`;
}

/** A load refused because another process kept the lease past the wait. */
export class ModelLeaseHeld extends Error {
  /**
   * The machine's state, not the issue's: a card stopped by it is
   * `model_unavailable` (held in Ready, the queue halts), never `error`
   * (kernel `isModelUnavailableError`).
   */
  public readonly code = "MODEL_LEASE_HELD";
  constructor(public readonly holder: ModelLease) {
    super(
      `Another process holds this machine's model lease: ${modelLeaseHolderWords(holder)}; nothing was loaded. Wait for it to finish, or stop it, then try again.`,
    );
    this.name = "ModelLeaseHeld";
  }
}

/** Written whole, through a temporary file, so a reader never sees half a lease. */
function writeLease(path: string, lease: ModelLease): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const exitHooks = new Set<string>();

/** On this process's exit its lease goes with it (a kill -9 leaves it stale instead). */
function removeOnExit(path: string): void {
  if (exitHooks.has(path)) return;
  exitHooks.add(path);
  process.once("exit", () => {
    try {
      if (readModelLease(path)?.pid === process.pid) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  });
}

/** A release that removes this hold's entry, and the file after the last. */
function releaser(path: string, hold: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const lease = readModelLease(path);
      if (!lease || lease.pid !== process.pid) return;
      const models = lease.models.filter((m) => m.hold !== hold);
      if (models.length === 0) rmSync(path, { force: true });
      else writeLease(path, { ...lease, models });
    } catch {
      // A lease that cannot be rewritten is stale once this process ends.
    }
  };
}

/**
 * Remove a stale lease under a short exclusive takeover lock, only if it is
 * still the one read (by token), so two processes that both found it stale
 * cannot both delete a fresh one. A takeover lock left by a killed process
 * is itself stale after 10 s.
 */
function removeStale(path: string, staleToken: string | undefined): void {
  const takeover = `${path}.takeover`;
  let fd: number;
  try {
    fd = openSync(takeover, "wx");
  } catch {
    try {
      if (Date.now() - statSync(takeover).mtimeMs > 10_000) rmSync(takeover, { force: true });
    } catch {
      // Removed by its holder meanwhile.
    }
    return;
  }
  try {
    const current = readModelLease(path);
    if (current && current.token === staleToken && !modelLeaseLive(current))
      rmSync(path, { force: true });
    if (!current) {
      // Unreadable: a file half-written by a process that died writing it.
      try {
        if (Date.now() - statSync(path).mtimeMs > 10_000) rmSync(path, { force: true });
      } catch {
        // Gone.
      }
    }
  } finally {
    closeSync(fd);
    rmSync(takeover, { force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the lease for one model, or say who holds it (MD-N17-1). A process
 * that already holds it adds the model to it; the returned release removes
 * that model, and the lease with the last one.
 */
export function tryModelLease(
  want: ModelLeaseHold,
  path: string = modelLeasePath(),
): { release: () => void } | { holder: ModelLease } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const hold = randomBytes(8).toString("hex");
  const now = () => new Date().toISOString();
  const entry: ModelLeaseEntry = { model: want.model, port: want.port, since: now(), hold };
  for (let tries = 0; tries < 50; tries++) {
    const current = readModelLease(path);
    if (current && current.pid === process.pid) {
      // Ours already (a co-resident role): one more model under it.
      writeLease(path, { ...current, models: [...current.models, entry] });
      removeOnExit(path);
      return { release: releaser(path, hold) };
    }
    const processStart = leaseProcessStart(process.pid);
    const lease: ModelLease = {
      pid: process.pid,
      ...(processStart ? { processStart } : {}),
      token: randomBytes(16).toString("hex"),
      since: now(),
      ...modelLeaseOwner(),
      models: [entry],
    };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(lease, null, 2));
      } finally {
        closeSync(fd);
      }
      removeOnExit(path);
      return { release: releaser(path, hold) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const there = readModelLease(path);
    if (there === undefined) {
      // Being written by its creator right now, or left half-written: look again.
      removeStale(path, undefined);
      sleepSync(5);
      continue;
    }
    if (modelLeaseLive(there)) return { holder: there };
    removeStale(path, there.token);
  }
  const holder = readModelLease(path);
  if (holder) return { holder };
  throw new Error(`Could not take the model lease at ${path}`);
}

export interface AcquireModelLeaseOptions {
  path?: string;
  signal?: AbortSignal;
  /** How long to wait for another process's lease; default 30 minutes. */
  waitMs?: number;
  pollMs?: number;
  /**
   * MD-N17-2: whether an engine already serves this load's exact profile
   * (its port answers, with this model, window and MTP state), in which case
   * the load attaches to it and takes no lease.
   */
  attach?: () => Promise<boolean>;
  /** Said once, when the wait begins; default the standard error. */
  onWait?: (line: string) => void;
}

/** The default wait for another project's lease. */
export const MODEL_LEASE_WAIT_MS = 30 * 60 * 1000;

/**
 * Take the lease for one load, waiting while another process holds it
 * (MD-N17-2): attach instead when an engine with a matching profile already
 * serves, else say once which project holds which model, and wait until the
 * lease is free, the signal aborts, or the wait ends (`ModelLeaseHeld`).
 */
export async function acquireModelLease(
  want: ModelLeaseHold,
  opts: AcquireModelLeaseOptions = {},
): Promise<{ release: () => void } | { attached: true }> {
  const path = opts.path ?? modelLeasePath();
  const deadline = Date.now() + (opts.waitMs ?? MODEL_LEASE_WAIT_MS);
  let said = false;
  for (;;) {
    if (opts.signal?.aborted)
      throw new Error("the load was aborted while it waited for the model lease");
    const got = tryModelLease(want, path);
    if ("release" in got) return got;
    if (opts.attach && (await opts.attach())) return { attached: true };
    if (!said) {
      said = true;
      (opts.onWait ?? ((l: string) => process.stderr.write(`${l}\n`)))(
        modelLeaseWaitLine(got.holder),
      );
    }
    if (Date.now() >= deadline) throw new ModelLeaseHeld(got.holder);
    await new Promise((r) =>
      setTimeout(r, Math.min(opts.pollMs ?? 1000, Math.max(0, deadline - Date.now()))),
    );
  }
}
