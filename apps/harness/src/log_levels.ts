import { format } from "node:util";

/**
 * Log levels for the server's log (surface item 21a, SUR-91; FINISH_LINE_PLAN
 * B-16). `.sekhemet/daemon.log` is the server's own standard output and
 * error, so its lines are given their time and level where they are
 * written: the server's console is routed through {@link formatLogLine},
 * and a line below the level is not written. No logging library is used.
 *
 * Levels, most severe first: `error`, `warn`, `info` (the default), `debug`.
 * `[log] level` in a `config.toml` sets it, `SEKHEMET_LOG_LEVEL` overrides
 * that, and `--debug` (`SEKHEMET_DEBUG=1`) means `debug`.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * `[log] level` from a merged configuration: a known level, else the
 * default, with the refused value named in `problems` (SUR-91).
 */
export function configuredLogLevel(value: unknown, problems: string[]): LogLevel {
  if (value === undefined) return DEFAULT_LOG_LEVEL;
  if (isLogLevel(value)) return value;
  problems.push(
    `log.level must be one of ${LOG_LEVELS.join(", ")} (got ${JSON.stringify(value)}); it was refused and ${DEFAULT_LOG_LEVEL} applies`,
  );
  return DEFAULT_LOG_LEVEL;
}

/**
 * The level in force: `--debug` (`SEKHEMET_DEBUG=1`) first, then
 * `SEKHEMET_LOG_LEVEL` when it names a level, then the configuration's.
 */
export function effectiveLogLevel(
  configured: LogLevel,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  if (env.SEKHEMET_DEBUG === "1") return "debug";
  const fromEnv = env.SEKHEMET_LOG_LEVEL?.trim().toLowerCase();
  if (isLogLevel(fromEnv)) return fromEnv;
  return configured;
}

/** Whether a line at `level` is written under `threshold`. */
export function logs(threshold: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(threshold);
}

/**
 * One log line: the UTC time, the level in capitals padded to five, then
 * the message. A message of several lines keeps its later lines indented,
 * so every line of the file still starts with a time or with spaces.
 */
export function formatLogLine(level: LogLevel, message: string, now: Date = new Date()): string {
  const head = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} `;
  return `${head}${message.replace(/\n(?!$)/g, `\n${" ".repeat(head.length)}`)}`;
}

/** The console methods the server writes through, the level each is, and its stream. */
const CONSOLE_LEVELS: readonly {
  method: keyof Console & string;
  level: LogLevel;
  stream: "out" | "err";
}[] = [
  { method: "error", level: "error", stream: "err" },
  { method: "warn", level: "warn", stream: "err" },
  { method: "log", level: "info", stream: "out" },
  { method: "info", level: "info", stream: "out" },
  { method: "debug", level: "debug", stream: "out" },
];

/**
 * Route this process's console through the formatter at `threshold`, for
 * the server `daemon start` launches (its standard output and error are
 * `daemon.log`). Returns a function that puts the console back.
 */
export function installLogLevels(
  threshold: LogLevel,
  write: { out: (text: string) => void; err: (text: string) => void } = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  },
  now: () => Date = () => new Date(),
): () => void {
  const saved = new Map<string, unknown>();
  const target = console as unknown as Record<string, unknown>;
  for (const { method, level, stream } of CONSOLE_LEVELS) {
    saved.set(method, target[method]);
    target[method] = (...args: unknown[]) => {
      if (!logs(threshold, level)) return;
      write[stream](`${formatLogLine(level, format(...args), now())}\n`);
    };
  }
  return () => {
    for (const [method, fn] of saved) target[method] = fn;
  };
}
