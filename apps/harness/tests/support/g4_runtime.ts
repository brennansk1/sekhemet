import { type ChildProcess, spawn } from "node:child_process";
import { afterEach } from "vitest";
import { BIN } from "./g2_cli.js";

/**
 * The built command (`apps/harness/dist/index.js`) started and left running,
 * with its process in hand, for the runtime entry-point tests that signal it
 * (SIGTERM, SIGKILL) or race two of it (FINISH_LINE_PLAN C2d). Every process
 * started here is killed after the test.
 */
export interface Running {
  child: ChildProcess;
  pid: number;
  /** stdout and stderr so far. */
  out: () => string;
  /** Resolves with the exit code, or the signal's name. */
  exited: Promise<number | string | null>;
}

const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

export function startCli(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; preload?: string },
): Running {
  const pre = opts.preload ? ["--import", opts.preload] : [];
  const child = spawn(process.execPath, [...pre, BIN, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(child);
  let text = "";
  child.stdout?.on("data", (d) => {
    text += String(d);
  });
  child.stderr?.on("data", (d) => {
    text += String(d);
  });
  const exited = new Promise<number | string | null>((r) =>
    child.once("exit", (code, signal) => r(code ?? signal)),
  );
  return { child, pid: child.pid ?? 0, out: () => text, exited };
}

/** Whether a process of this pid is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
