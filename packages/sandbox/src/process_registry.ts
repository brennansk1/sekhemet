import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Process identity and the live process groups this harness started
 * (runtime.md items 3, 5, 7 and 9; NEW-runtime-1, NEW-runtime-2).
 *
 * A pid alone does not name a process: the system reuses it. A pid plus the
 * start time `ps` reports names one process for good, so the runner lease and
 * the daemon file never take a recycled pid for their holder.
 *
 * Every command and background process runs as the leader of its own process
 * group; the group is tracked while it lives, so a kill reaches the whole
 * tree and the harness's exit takes every group with it. With
 * `SEKHEMET_PROCESS_REGISTRY` set (the runner sets it to
 * `.sekhemet/processes/`), each live group is also recorded on disk: a runner
 * killed with SIGKILL runs no exit handler, and the next start reaps the
 * groups it left (`reapOrphanedGroups`, RUN-12).
 */

/** A process's start time from `ps -o lstart=`, or undefined when no process has that pid. */
export function processStartTime(pid: number): string | undefined {
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

/**
 * Whether `pid` is the very process recorded: alive and, when a start time
 * was recorded, started then. A different start time is a recycled pid.
 */
export function sameProcess(pid: number, processStart: string | undefined): boolean {
  if (!pidAlive(pid)) return false;
  if (processStart === undefined) return true;
  const now = processStartTime(pid);
  return now !== undefined && now === processStart;
}

interface GroupRecord {
  pid: number;
  processStart?: string;
  /** The harness process that started it, and that process's start time. */
  owner: number;
  ownerStart?: string;
}

const live = new Set<number>();
let ownStart: string | undefined;
let exitHookInstalled = false;

function registryDir(): string | undefined {
  const dir = process.env.SEKHEMET_PROCESS_REGISTRY;
  return dir && dir.trim() !== "" ? dir : undefined;
}

/** Signal a whole process group (0: only test it exists); false when it no longer exists. */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Kill every group this process started and still tracks (the harness's exit, RUN-8). */
export function killTrackedGroups(signal: NodeJS.Signals = "SIGKILL"): number[] {
  const killed: number[] = [];
  for (const pid of live) {
    if (signalGroup(pid, signal)) killed.push(pid);
    try {
      process.kill(pid, signal);
    } catch {
      // Gone.
    }
  }
  if (signal === "SIGKILL") for (const pid of killed) untrackGroup(pid);
  return killed;
}

/** Record a group leader this process started (a command or a background process). */
export function trackGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  live.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Synchronous, so it runs on every exit path that runs exit handlers,
    // including a signal handler's `process.exit`.
    process.on("exit", () => killTrackedGroups("SIGKILL"));
  }
  const dir = registryDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    ownStart ??= processStartTime(process.pid);
    const start = processStartTime(pid);
    const record: GroupRecord = {
      pid,
      ...(start ? { processStart: start } : {}),
      owner: process.pid,
      ...(ownStart ? { ownerStart: ownStart } : {}),
    };
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify(record));
  } catch {
    // The registry is a backstop for SIGKILL; the in-memory set still works.
  }
}

/** Forget a group once it has exited. */
export function untrackGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  live.delete(pid);
  const dir = registryDir();
  if (dir) rmSync(join(dir, `${pid}.json`), { force: true });
}

/**
 * Kill the groups a dead runner left behind (RUN-12): every recorded group
 * whose owner is gone and whose leader is still the process recorded, or whose
 * leader has exited while members of its group live on. A group whose owner
 * lives is left alone; a record whose whole group is gone is removed.
 * Returns the pids reaped.
 */
export function reapOrphanedGroups(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const reaped: number[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: GroupRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as GroupRecord;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    // A live owner (this process included) still owns its groups.
    if (sameProcess(record.owner, record.ownerStart)) continue;
    if (sameProcess(record.pid, record.processStart)) {
      signalGroup(record.pid, "SIGKILL");
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        // Gone.
      }
      reaped.push(record.pid);
    } else if (!pidAlive(record.pid) && signalGroup(record.pid, 0)) {
      // The leader has exited but members of its group live on (a grandchild
      // it backgrounded). While any member lives the group's id is not reused
      // as a pid, so the group is still the one recorded: kill it.
      signalGroup(record.pid, "SIGKILL");
      reaped.push(record.pid);
    }
    rmSync(path, { force: true });
  }
  return reaped;
}
