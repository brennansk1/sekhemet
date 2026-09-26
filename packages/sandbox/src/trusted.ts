import { execFile, execFileSync } from "node:child_process";

/**
 * Processes the harness trusts (security item 5, S3a): its own git, model
 * servers, the dashboard, doctor's probes. They run unconfined with the
 * caller's environment, so only modules on the written allowlist
 * (`child_process.allowlist.json`, SEC-18) start processes at all; code from
 * a worktree goes through `runConfined()` instead.
 */
export interface TrustedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface TrustedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a trusted program to completion; never throws for a non-zero exit. */
export function runTrusted(
  command: string,
  args: readonly string[],
  options: TrustedOptions = {},
): Promise<TrustedResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
        const exitCode =
          e === null ? 0 : e.killed ? 124 : typeof e.code === "number" ? e.code : 127;
        resolve({ exitCode, stdout, stderr, timedOut: e?.killed === true });
      },
    );
  });
}

/**
 * Resident bytes of the given processes and all their descendants, from one
 * `ps` listing (macOS and Linux both report RSS in KiB). Zero when `ps`
 * cannot run: the guard then sees only what it measures itself. The harness's
 * own `ps`, a trusted process like the rest of this module (SEC-18).
 */
export function processTreeResidentBytes(roots: readonly number[]): number {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return 0;
  }
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || kib === undefined) continue;
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(kib)) continue;
    rss.set(pid, kib);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const seen = new Set<number>();
  const stack = [...roots];
  let total = 0;
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += (rss.get(pid) ?? 0) * 1024;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}
