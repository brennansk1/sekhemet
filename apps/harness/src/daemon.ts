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
import { createServer } from "node:net";
import { join } from "node:path";
import { liveModelLease, modelLeaseHolderWords, modelLeasePath } from "@sekhemet/models";
import { processStartTime, sameProcess } from "@sekhemet/sandbox";
import { atLoginPath, portsRegisteredElsewhere, readAtLogin } from "./login_service.js";
import { userPaths } from "./user_dir.js";
import { readWorkspaces } from "./workspaces.js";

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
  asked: number,
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
  // MD-N17-3: the port asked for, else the next free one, chosen before the
  // launch so this record and the health check name the port it serves on.
  // RUN-75: never a port another workspace is registered at login on.
  const port = await freePortFrom(asked, portsRegisteredElsewhere(repoPath));
  const pid = (deps.launch ?? defaultLaunch)(
    ["serve", "--repo", repoPath, "--port", String(port)],
    log,
  );
  const moved = port !== asked ? `: port ${asked} was in use, so it serves` : "";
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
        message: `Started (pid ${pid})${moved} at http://127.0.0.1:${port}; log ${log}`,
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

/** How many ports from the one asked for `serve` tries before it refuses (MD-N17-3). */
export const SERVE_PORT_TRIES = 10;

/** Whether nothing listens on this loopback port: it can be bound now. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/**
 * The first free port from `port`, within the range `serve` itself tries
 * (MD-N17-3); the port asked for when none is free, so the server's own
 * refusal names the range.
 */
export async function freePortFrom(
  port: number,
  skip: ReadonlySet<number> = new Set(),
): Promise<number> {
  if (port === 0) return 0;
  for (let p = port; p < port + SERVE_PORT_TRIES; p++)
    if (!skip.has(p) && (await portFree(p))) return p;
  return port;
}

/** Whether any HTTP server answers at this address (Team's sign-in answers too). */
async function answers(address: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchFn(`${address}/api/board`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * `sekhemet daemon status --all` (MD-N17-3): every workspace this machine's
 * person has served, from `<user dir>/workspaces.json` — its name, the
 * address and port its server bound, whether that server answers now, and
 * its folder — and who holds the machine's model lease (MD-N17-1). A read:
 * it starts, stops and writes nothing.
 */
export async function daemonStatusAll(
  opts: {
    workspacesPath?: string;
    modelLeasePath?: string;
    fetch?: typeof fetch;
    /** The start-at-login registrations (RUN-77); `<user dir>/at-login.json` by default. */
    atLoginPath?: string;
  } = {},
): Promise<string> {
  const list = readWorkspaces(opts.workspacesPath ?? userPaths().workspaces);
  const registered = readAtLogin(opts.atLoginPath ?? atLoginPath());
  const atLogin = (folder?: string) => registered.find((r) => folder && r.folder === folder);
  const lines: string[] = [];
  if (list.length === 0) lines.push("No workspace has been served on this machine yet.");
  else {
    const width = Math.max(...list.map((w) => w.name.length));
    const rows = await Promise.all(
      list.map(async (w) => {
        const up = await answers(w.address, opts.fetch);
        const projects =
          (w.projectRoots?.length ?? 0) > 1 ? ` (${w.projectRoots?.length} projects)` : "";
        const login = atLogin(w.folder);
        return `  ${w.name.padEnd(width)}  ${w.address}  ${up ? "answering" : "not answering"}${w.folder ? `  ${w.folder}${projects}` : ""}  ${login ? `starts at login on port ${login.port}` : "not at login"}`;
      }),
    );
    lines.push("Workspaces on this machine:", ...rows);
  }
  // RUN-77: a registration whose workspace has not been served yet is listed too.
  const listed = new Set(list.map((w) => w.folder));
  for (const r of registered.filter((x) => !listed.has(x.folder)))
    lines.push(`  ${r.folder}  http://127.0.0.1:${r.port}  starts at login (not served yet)`);
  const holder = liveModelLease(opts.modelLeasePath ?? modelLeasePath());
  lines.push(`Model lease: ${holder ? `${modelLeaseHolderWords(holder)}.` : "free."}`);
  return lines.join("\n");
}
