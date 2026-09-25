import { execFile } from "node:child_process";

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
