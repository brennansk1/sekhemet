import { type StdioOptions, spawn } from "node:child_process";

/** How a child run ended. */
export interface ChildRun {
  /** The timeout stopped it. */
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Run a harness command as a child process and wait for it (live-test F19,
 * runtime rule on process lifetime). A stop of this process — SIGTERM or
 * SIGINT — is passed on to the child as SIGTERM, so the child stops what it
 * started (its managed llama-server, through `bindToParentLifetime`) before
 * it exits; this process then exits with the signal's code and runs nothing
 * after. A synchronous child (`execFileSync`) could not: this process died,
 * and the child and its server ran on. A child still running `graceMs` after
 * the stop or the timeout is killed with its whole process group.
 */
export function runChild(
  command: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    timeoutMs?: number;
    graceMs?: number;
    /** Exit this process once the child has stopped after a signal (default true). */
    exitOnSignal?: boolean;
  } = {},
): Promise<ChildRun> {
  const grace = opts.graceMs ?? 10_000;
  return new Promise((resolve, reject) => {
    // Its own process group, so the escalation reaches what the child started
    // (its llama-server) even when the child is stuck in a synchronous call
    // and never runs its SIGTERM handler (F19 review, major 1).
    const child = spawn(command, args, {
      stdio: opts.stdio ?? "inherit",
      detached: true,
      ...(opts.env ? { env: opts.env } : {}),
    });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    let timedOut = false;
    let stoppedBy: keyof typeof SIGNAL_CODES | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), grace);
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, opts.timeoutMs)
        : undefined;
    const handlers = (Object.keys(SIGNAL_CODES) as (keyof typeof SIGNAL_CODES)[]).map((sig) => {
      const on = () => {
        stoppedBy ??= sig;
        stop();
      };
      process.on(sig, on);
      return () => process.off(sig, on);
    });
    const done = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      for (const off of handlers) off();
    };
    child.once("error", (err) => {
      done();
      reject(err);
    });
    child.once("exit", (code, signal) => {
      done();
      if (stoppedBy && opts.exitOnSignal !== false) process.exit(SIGNAL_CODES[stoppedBy]);
      resolve({ timedOut, code, signal });
    });
  });
}
