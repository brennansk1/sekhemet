import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `sekhemet daemon start|stop|status` (H1): the dashboard server running in
 * the background, detached from the terminal, with a PID file so the CLI,
 * the SDK and editors find it and a second start does not clash.
 *
 * The PID file (.sekhemet/daemon.json) records pid, port, start time and log
 * path. A stale file (its process gone) is treated as not running and
 * replaced. Output goes to .sekhemet/daemon.log.
 */

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
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

export function readDaemon(repoPath: string): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(daemonFile(repoPath), "utf8")) as DaemonInfo;
    return alive(info.pid) ? info : undefined;
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
  const pid = (deps.launch ?? defaultLaunch)(
    ["serve", "--repo", repoPath, "--port", String(port)],
    log,
  );
  const info: DaemonInfo = { pid, port, startedAt: new Date().toISOString(), log };
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
