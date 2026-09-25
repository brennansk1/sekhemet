import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processStartTime, sameProcess } from "@sekhemet/sandbox";

/**
 * `sekhemet daemon start|stop|status` (H1): the dashboard server running in
 * the background, detached from the terminal, with a PID file so the CLI,
 * the SDK and editors find it and a second start does not clash.
 *
 * The PID file (.sekhemet/daemon.json) records pid, port, start time and log
 * path, and the process's own start time as the operating system reports it,
 * so a pid the system has since given to another process is never taken for
 * the daemon (runtime item 5, RUN-1). A stale file (its process gone, or its
 * pid now another process's) is treated as not running and replaced. Output
 * goes to .sekhemet/daemon.log.
 */

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  /** The process's start time from `ps -o lstart=` (RUN-1); absent in files from older builds. */
  processStart?: string;
  log: string;
}

export function daemonFile(repoPath: string): string {
  return join(repoPath, ".sekhemet", "daemon.json");
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Process identity (RUN-1): a pid plus its start time names one process.
export { processStartTime, sameProcess };

/** A log's size limit and how many rotated files it keeps (runtime item 34, RUN-14). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;

/**
 * Rotate a log past its size limit (RUN-14): `log.1` … `log.<keep>`, the
 * oldest dropped. Copy-then-truncate, so a process still appending to the
 * file (the daemon's own output, opened in append mode) carries on at the
 * start of the emptied file. True when it rotated.
 */
export function rotateLog(
  path: string,
  options: { maxBytes?: number; keep?: number } = {},
): boolean {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, options.keep ?? LOG_KEEP);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  }
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
}

/** Keep the newest `keep` run logs in a directory, by name (they sort by start time). */
export function pruneLogDir(dir: string, keep = 50): number {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".log"))
      .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs);
  } catch {
    return 0;
  }
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const n of drop) rmSync(join(dir, n), { force: true });
  return drop.length;
}

export function readDaemon(repoPath: string): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(daemonFile(repoPath), "utf8")) as DaemonInfo;
    return sameProcess(info.pid, info.processStart) ? info : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(port: number, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/api/board`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface DaemonDeps {
  /** Spawns the detached server; returns its pid. Injectable for tests. */
  launch?: (args: string[], logPath: string) => number;
  fetch?: typeof fetch;
  waitMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function defaultLaunch(args: string[], logPath: string): number {
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1] ?? "", ...args], {
    detached: true,
    stdio: ["ignore", out, out],
    // The server rotates its own log while it runs (RUN-14).
    env: { ...process.env, SEKHEMET_DAEMON_LOG: logPath },
  });
  child.unref();
  return child.pid ?? 0;
}

export async function daemonStart(
  repoPath: string,
  port: number,
  deps: DaemonDeps = {},
): Promise<{ started: boolean; info: DaemonInfo; message: string }> {
  const running = readDaemon(repoPath);
  if (running) {
    return {
      started: false,
      info: running,
      message: `Already running (pid ${running.pid}) at http://127.0.0.1:${running.port}`,
    };
  }
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const log = join(repoPath, ".sekhemet", "daemon.log");
  rotateLog(log);
  const pid = (deps.launch ?? defaultLaunch)(
    ["serve", "--repo", repoPath, "--port", String(port)],
    log,
  );
  const processStart = processStartTime(pid);
  const info: DaemonInfo = {
    pid,
    port,
    startedAt: new Date().toISOString(),
    ...(processStart ? { processStart } : {}),
    log,
  };
  writeFileSync(daemonFile(repoPath), `${JSON.stringify(info, null, 2)}\n`);
  const deadline = Date.now() + (deps.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await healthy(port, deps.fetch)) {
      return {
        started: true,
        info,
        message: `Started (pid ${pid}) at http://127.0.0.1:${port}; log ${log}`,
      };
    }
    if (!alive(pid) && !deps.launch) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { started: false, info, message: `Did not answer on port ${port}; see ${log}` };
}

export async function daemonStop(repoPath: string, deps: DaemonDeps = {}): Promise<string> {
  const info = readDaemon(repoPath);
  if (!info) {
    if (existsSync(daemonFile(repoPath))) rmSync(daemonFile(repoPath));
    return "Not running.";
  }
  // Checked again right before the signal: only the recorded process (RUN-1).
  if (!sameProcess(info.pid, info.processStart)) {
    rmSync(daemonFile(repoPath), { force: true });
    return "Not running.";
  }
  (deps.kill ?? ((p, s) => process.kill(p, s)))(info.pid, "SIGTERM");
  for (let i = 0; i < 40 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
  rmSync(daemonFile(repoPath), { force: true });
  return `Stopped pid ${info.pid}.`;
}

export async function daemonStatus(repoPath: string, deps: DaemonDeps = {}): Promise<string> {
  const info = readDaemon(repoPath);
  if (!info) return "Not running.";
  const ok = await healthy(info.port, deps.fetch);
  return `Running (pid ${info.pid}) since ${info.startedAt} at http://127.0.0.1:${info.port}; ${ok ? "answering" : "NOT answering"}. Live stream: ws://127.0.0.1:${info.port}/api/ws (or SSE /api/stream).`;
}
