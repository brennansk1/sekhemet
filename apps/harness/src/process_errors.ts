import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { redactSecrets } from "@sekhemet/gates";
import { killTrackedGroups } from "@sekhemet/sandbox";

/**
 * What happens when an error reaches the top of the process (surface item
 * 18a, SUR-14, SUR-57; runtime item 9, RUN-8b).
 *
 * The person reads one plain line: what stopped, and where the details are.
 * The details — the stack, the command, the versions — go to a report file
 * under the user directory's `logs/`, readable only by its owner, and are
 * printed on the terminal too under `--debug` (or `SEKHEMET_DEBUG=1`). Every
 * word of both passes through the secret redaction first (security item 34).
 *
 * The report is a file, not a ledger event: the ledger may be the very thing
 * that failed, and a run that stops this way is recorded on the ledger by the
 * next start's crash sweep (RUN-9), which finishes its attempt as `crashed`.
 *
 * An error nothing handled (an unhandled rejection, an uncaught exception)
 * stops the process at once: the process groups it started get SIGTERM, then
 * the exit handlers kill what is left with SIGKILL after the same 500 ms a
 * command's timeout allows (runtime item 7) and release the runner lease, and
 * the exit code is 1 (surface item 18).
 */

/** How long children have after SIGTERM before the exit kills them (runtime item 7). */
export const CHILD_GRACE_MS = 500;
/** Error reports kept; older ones are removed (runtime item 34: bounded logs). */
export const REPORTS_KEPT = 50;

export type FatalKind = "rejection" | "exception" | "command";

const KIND_WORDS: Record<FatalKind, string> = {
  rejection: "an unhandled promise rejection",
  exception: "an uncaught exception",
  command: "an error the command did not handle",
};

/**
 * Remove `--debug` from the command line (before a `--`), so no command's
 * own parser sees it, and say whether it was there. `SEKHEMET_DEBUG=1` asks
 * the same, and is set here so the processes this one starts inherit it.
 */
export function takeDebugFlag(argv: string[], from = 2): boolean {
  let found = false;
  for (let i = from; i < argv.length; ) {
    if (argv[i] === "--") break;
    if (argv[i] === "--debug") {
      argv.splice(i, 1);
      found = true;
    } else i++;
  }
  if (found) process.env.SEKHEMET_DEBUG = "1";
  return found || process.env.SEKHEMET_DEBUG === "1";
}

/** The error's message on one line, redacted, never `undefined`. */
export function describeError(err: unknown): string {
  let text: string;
  if (err instanceof Error) text = err.message || err.name || "";
  else if (typeof err === "string") text = err;
  else if (err === undefined || err === null) text = "";
  else text = inspect(err, { depth: 1, breakLength: Number.POSITIVE_INFINITY });
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" — ");
  const plain = redactSecrets(line);
  if (plain === "") return "something failed without saying what";
  return plain.length > 400 ? `${plain.slice(0, 399)}…` : plain;
}

/** Everything known about the error, redacted: stack, cause and extra fields. */
export function errorDetails(err: unknown): string {
  const text =
    err instanceof Error
      ? inspect(err, { depth: 4 })
      : err === undefined
        ? "(the rejection carried no reason)"
        : inspect(err, { depth: 4 });
  return redactSecrets(text);
}

export interface ReportContext {
  version: string;
  /** The command line as given, after `sekhemet`. */
  argv: readonly string[];
  /**
   * The user directory; the report goes into its `logs/`. A function is
   * called only when the report is written: resolving the directory can
   * itself fail (a `SEKHEMET_CONFIG_DIR` inside a repository is refused), and
   * then there is no report, but the one line still prints.
   */
  userDir: string | (() => string);
  now?: Date;
}

/**
 * Write the redacted report, keep the newest {@link REPORTS_KEPT}, and return
 * its path; undefined when it could not be written.
 */
export function writeErrorReport(
  err: unknown,
  kind: FatalKind,
  ctx: ReportContext,
): string | undefined {
  try {
    const dir = join(typeof ctx.userDir === "function" ? ctx.userDir() : ctx.userDir, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = ctx.now ?? new Date();
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const path = join(dir, `error-${stamp}-${process.pid}.log`);
    const body = [
      `Sekhemet ${ctx.version} stopped on ${KIND_WORDS[kind]}.`,
      `When: ${now.toISOString()}`,
      `Command: ${redactSecrets(["sekhemet", ...ctx.argv].join(" "))}`,
      `Node ${process.version} on ${process.platform} ${process.arch}`,
      "",
      errorDetails(err),
      "",
    ].join("\n");
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
    pruneReports(dir);
    return path;
  } catch {
    return undefined;
  }
}

function pruneReports(dir: string): void {
  const reports = readdirSync(dir)
    .filter((n) => /^error-.*\.log$/.test(n))
    .sort();
  for (const old of reports.slice(0, Math.max(0, reports.length - REPORTS_KEPT)))
    rmSync(join(dir, old), { force: true });
}

/** The one line the person reads (DEC-31 words; no stack, no internal names). */
export function fatalLine(err: unknown, reportPath: string | undefined): string {
  const where = reportPath
    ? ` — details are in ${reportPath}; run again with --debug to print them here.`
    : " — run again with --debug to see the details.";
  return `sekhemet stopped: ${describeError(err)}${where}`;
}

/** Write to stderr synchronously: a pipe on macOS is asynchronous, and the process is about to exit. */
function writeStderr(text: string): void {
  try {
    writeSync(2, text);
  } catch {
    // Nowhere left to say it.
  }
}

let reported = false;

/**
 * Report an error that reached the top: the report file, then the one line
 * (and, under debug, the details). Only the first report prints; a later one
 * is written to its file silently, so the person still reads one line.
 */
export function reportFatal(
  err: unknown,
  kind: FatalKind,
  ctx: ReportContext & { debug: boolean },
): void {
  // writeErrorReport never throws: a report that cannot be written is none.
  const path = writeErrorReport(err, kind, ctx);
  if (reported) return;
  reported = true;
  writeStderr(`${fatalLine(err, path)}\n`);
  if (ctx.debug) writeStderr(`${errorDetails(err)}\n`);
}

/**
 * The context, or, when building it fails, one that writes no report: the
 * line that says what stopped must print whatever else went wrong (G4).
 */
export function safeContext(
  ctx: () => ReportContext & { debug: boolean },
): ReportContext & { debug: boolean } {
  try {
    return ctx();
  } catch {
    return {
      debug: process.env.SEKHEMET_DEBUG === "1",
      version: "unknown",
      argv: process.argv.slice(2),
      userDir: () => {
        throw new Error("no user directory");
      },
    };
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop now: SIGTERM to every process group this process started, a grace of
 * {@link CHILD_GRACE_MS} when there were any, then `process.exit(1)`, whose
 * synchronous exit handlers SIGKILL what is left and release the lease.
 */
export function stopAfterFatal(): never {
  try {
    if (killTrackedGroups("SIGTERM").length > 0) sleepSync(CHILD_GRACE_MS);
  } catch {
    // The exit handlers still kill every group.
  }
  process.exit(1);
}

/**
 * Install the process-level handlers for the CLI and the server it runs:
 * an unhandled rejection or an uncaught exception is reported and stops the
 * process with exit code 1.
 */
export function installProcessErrorHandlers(ctx: () => ReportContext & { debug: boolean }): void {
  const fatal = (kind: FatalKind) => (err: unknown) => {
    try {
      reportFatal(err, kind, safeContext(ctx));
    } finally {
      stopAfterFatal();
    }
  };
  process.on("unhandledRejection", fatal("rejection"));
  process.on("uncaughtException", fatal("exception"));
}
