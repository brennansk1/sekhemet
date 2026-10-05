import { spawn as nodeSpawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The machine stays awake while it works (runtime item 17b, NEW-runtime-12:
 * RUN-65, RUN-66, RUN-67; FINDINGS REL-04). While a runner holds the lease,
 * the operating system's own tool holds an idle-sleep assertion for this
 * process — `caffeinate -i -w <pid>` on macOS, `systemd-inhibit
 * --what=idle:sleep … tail --pid=<pid> -f /dev/null` on Linux — so it ends
 * by itself even when the holder is killed with SIGKILL, and it is killed
 * when the lease is released. No library is used. Where no tool exists the
 * run report says so once.
 *
 * A round's wall-clock time is compared with its monotonic time
 * (`process.hrtime`, which stops while the machine sleeps on macOS and
 * Linux): more than 60 s apart, the report records "the machine slept N
 * min", and only monotonic time is charged to the energy budget (item 18).
 */

export interface SleepAssertionCommand {
  tool: "caffeinate" | "systemd-inhibit";
  args: string[];
}

/** The tool and arguments that keep this machine awake while `pid` lives. */
export function sleepAssertionCommand(
  platform: NodeJS.Platform,
  pid: number,
  why = "running issues",
): SleepAssertionCommand | undefined {
  if (platform === "darwin") return { tool: "caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux")
    return {
      tool: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=Sekhemet",
        `--why=${why}`,
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
    };
  return undefined;
}

/** The executable `name` on PATH, or undefined. */
export function findOnPath(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** What a spawned assertion process must offer (a `ChildProcess` does). */
export interface AssertionProcess {
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  unref(): unknown;
}

export interface SleepAssertion {
  /** Whether the assertion was taken (a later spawn failure or an early exit clears it). */
  held: boolean;
  /**
   * Resolves once `held` can be believed: the tool exited at once (refused,
   * as `systemd-inhibit` is by polkit in a headless session), or it still
   * runs after a short grace. A report awaits it before saying "kept awake".
   */
  settled?: Promise<void>;
  tool?: string;
  /** One sentence for the run report when nothing keeps the machine awake (RUN-66). */
  note?: string;
  release(): void;
}

export interface SleepAssertionOptions {
  platform?: NodeJS.Platform;
  /** The process whose life the assertion follows; default this one. */
  pid?: number;
  why?: string;
  findTool?: (name: string) => string | undefined;
  spawn?: (cmd: string, args: string[]) => AssertionProcess;
}

const defaultSpawn = (cmd: string, args: string[]): AssertionProcess =>
  nodeSpawn(cmd, args, { stdio: "ignore" });

/** Take the sleep assertion for the lease's holder (RUN-65). Never throws. */
export function holdSleepAssertion(options: SleepAssertionOptions = {}): SleepAssertion {
  const platform = options.platform ?? process.platform;
  const command = sleepAssertionCommand(platform, options.pid ?? process.pid, options.why);
  if (!command) {
    return {
      held: false,
      note: `Nothing keeps this ${platform} machine awake while issues run: it may sleep and stop the run.`,
      release: () => {},
    };
  }
  const path = (options.findTool ?? findOnPath)(command.tool);
  if (!path) {
    return {
      held: false,
      note: `${command.tool} is not installed, so nothing keeps this machine awake while issues run: it may sleep and stop the run.`,
      release: () => {},
    };
  }
  const assertion: SleepAssertion = {
    held: true,
    tool: command.tool,
    release: () => {},
  };
  let child: AssertionProcess;
  try {
    child = (options.spawn ?? defaultSpawn)(path, command.args);
  } catch (err) {
    assertion.held = false;
    assertion.note = `${command.tool} could not start (${err instanceof Error ? err.message : String(err)}): the machine may sleep and stop the run.`;
    return assertion;
  }
  let released = false;
  let settle: () => void = () => {};
  assertion.settled = new Promise<void>((resolve) => {
    settle = resolve;
    // The grace: a refused tool exits within milliseconds. Not unref'd: a
    // caller awaiting it must not see the process end first.
    setTimeout(resolve, SLEEP_ASSERTION_GRACE_MS);
  });
  child.on("error", (err) => {
    assertion.held = false;
    assertion.note = `${command.tool} could not start (${err instanceof Error ? err.message : String(err)}): the machine may sleep and stop the run.`;
    settle();
  });
  // RUN-65, RUN-66: an assertion that ends before its release holds nothing
  // (C4 review: `systemd-inhibit` refused by polkit exits 1 at once).
  child.on("exit", (code, signal) => {
    if (released) return;
    assertion.held = false;
    assertion.note = `${command.tool} ended at once (${code !== null && code !== undefined ? `exit ${String(code)}` : String(signal)}), so nothing keeps this machine awake while issues run: it may sleep and stop the run.`;
    settle();
  });
  // It must never keep the harness alive, and it ends with the holder anyway.
  child.unref();
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  assertion.release = release;
  return assertion;
}

/** How long a just-spawned assertion tool must keep running to count as held. */
export const SLEEP_ASSERTION_GRACE_MS = 300;

/**
 * The arguments that ask `tool` for an assertion and give it straight back
 * (`doctor`, RUN-66): permission is checked the way a run would take it.
 */
export function sleepAssertionProbe(tool: SleepAssertionCommand["tool"]): string[] {
  return tool === "caffeinate"
    ? ["-i", "true"]
    : ["--what=idle:sleep", "--who=Sekhemet", "--why=doctor's check", "--mode=block", "true"];
}

/** What a run report says about the sleep assertion, once (RUN-66). */
export function awakeReport(a: Pick<SleepAssertion, "held" | "tool" | "note">): string {
  return a.held ? `kept awake by ${a.tool}` : (a.note ?? "nothing keeps the machine awake");
}

/** A wall-clock gap over this, beyond the monotonic time, is reported as sleep (RUN-67). */
export const SLEEP_REPORT_THRESHOLD_MS = 60_000;

export interface RunClockSource {
  now?: () => number;
  hrtime?: () => bigint;
}

export interface RunClock {
  wallMs(): number;
  /** Time the process ran, not counting time the machine slept. */
  monotonicMs(): number;
  /** Wall-clock time beyond the monotonic time: the machine slept. */
  sleptMs(): number;
}

/** A round's two clocks, started now (RUN-67). */
export function startRunClock(source: RunClockSource = {}): RunClock {
  const now = source.now ?? Date.now;
  const hr = source.hrtime ?? process.hrtime.bigint;
  const wall0 = now();
  const mono0 = hr();
  const wallMs = () => Math.max(0, now() - wall0);
  const monotonicMs = () => Math.max(0, Number((hr() - mono0) / 1_000_000n));
  return { wallMs, monotonicMs, sleptMs: () => Math.max(0, wallMs() - monotonicMs()) };
}

/** "the machine slept N min" when the gap is over the threshold; else undefined. */
export function sleptNote(sleptMs: number): string | undefined {
  if (sleptMs <= SLEEP_REPORT_THRESHOLD_MS) return undefined;
  return `the machine slept ${Math.round(sleptMs / 60_000)} min`;
}
