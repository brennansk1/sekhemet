import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  configuredLogLevel,
  effectiveLogLevel,
  formatLogLine,
  installLogLevels,
  logs,
} from "../src/log_levels.js";
import { BIN, sandboxDirs, scriptedWorkerProject } from "./cli_fixture.js";

/**
 * Surface item 21a, SUR-91 (FINISH_LINE_PLAN B-16): the server's log has the
 * levels error, warn, info and debug, set by `[log] level` or
 * `SEKHEMET_LOG_LEVEL`, and each line of `daemon.log` begins with its UTC
 * time and level. The entry point is `sekhemet daemon start`, a real server
 * process writing its real log file.
 */

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|WARN |INFO |DEBUG) /;

describe("log levels (SUR-91)", () => {
  it("formats a line with its UTC time and level, later lines indented", () => {
    const at = new Date("2026-10-05T09:00:00.000Z");
    expect(formatLogLine("warn", "disk low", at)).toBe("2026-10-05T09:00:00.000Z WARN  disk low");
    expect(formatLogLine("error", "a\nb", at)).toBe(
      `2026-10-05T09:00:00.000Z ERROR a\n${" ".repeat(31)}b`,
    );
  });

  it("orders error, warn, info, debug, and writes only lines at the level or more severe", () => {
    expect(logs("warn", "error")).toBe(true);
    expect(logs("warn", "warn")).toBe(true);
    expect(logs("warn", "info")).toBe(false);
    expect(logs("debug", "debug")).toBe(true);
  });

  it("[log] level is read and an unknown one refused, naming the key; the environment overrides it; --debug means debug", () => {
    const where = sandboxDirs();
    const userPath = join(where.home, "config.toml");
    writeFileSync(userPath, '[log]\nlevel = "warn"\n');
    expect(resolveConfig({ repoPath: where.cwd, userConfigPath: userPath }).config.log.level).toBe(
      "warn",
    );
    const problems: string[] = [];
    expect(configuredLogLevel("loud", problems)).toBe("info");
    expect(problems.join()).toMatch(/^log\.level must be one of error, warn, info, debug/);
    expect(effectiveLogLevel("warn", { SEKHEMET_LOG_LEVEL: "debug" })).toBe("debug");
    expect(effectiveLogLevel("warn", { SEKHEMET_LOG_LEVEL: "nonsense" })).toBe("warn");
    expect(effectiveLogLevel("error", { SEKHEMET_DEBUG: "1", SEKHEMET_LOG_LEVEL: "warn" })).toBe(
      "debug",
    );
  });

  it("routes the console through the formatter, and puts it back", () => {
    const out: string[] = [];
    const restore = installLogLevels(
      "info",
      { out: (t) => out.push(t), err: (t) => out.push(t) },
      () => new Date("2026-10-05T09:00:00.000Z"),
    );
    try {
      console.log("served %d", 3);
      console.debug("hidden");
      console.error(new Error("boom").message);
    } finally {
      restore();
    }
    expect(out).toEqual([
      "2026-10-05T09:00:00.000Z INFO  served 3\n",
      "2026-10-05T09:00:00.000Z ERROR boom\n",
    ]);
  });
});

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

describe("daemon.log through `sekhemet daemon start` (SUR-91)", () => {
  for (const level of ["info", "warn"] as const) {
    it(`at ${level}: every line carries a time and a level, and none is below ${level}`, async () => {
      const where = sandboxDirs();
      const env = await scriptedWorkerProject(where);
      const port = await freePort();
      const vars = { ...env.vars, SEKHEMET_MODEL_LOADS: "off", SEKHEMET_LOG_LEVEL: level };
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [BIN, ...args], {
          cwd: where.cwd,
          encoding: "utf8",
          timeout: 60_000,
          env: vars,
        });
      const started = run("daemon", "start", "--port", String(port));
      try {
        expect(started.status, started.stderr).toBe(0);
      } finally {
        run("daemon", "stop");
      }
      const log = join(where.cwd, ".sekhemet", "daemon.log");
      expect(existsSync(log)).toBe(true);
      const lines = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      // At info the start-up lines are there; at warn they are not written.
      if (level === "info") expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(new RegExp(`${LINE.source}|^ {31}`));
      const levels = new Set(lines.map((l) => LINE.exec(l)?.[1]?.trim()).filter(Boolean));
      if (level === "info") expect(levels.has("INFO")).toBe(true);
      else expect(levels.has("INFO")).toBe(false);
    }, 90_000);
  }
});
