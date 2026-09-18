import { describe, expect, it } from "vitest";
import { colorize, parseArgs } from "../src/cli.js";

describe("onyx parseArgs: commands", () => {
  it("parses set with the default project", () => {
    expect(parseArgs(["set", "API_KEY", "abc"])).toEqual({
      kind: "set",
      project: "default",
      key: "API_KEY",
      value: "abc",
    });
  });

  it("parses get, list and export", () => {
    expect(parseArgs(["get", "API_KEY"])).toEqual({
      kind: "get",
      project: "default",
      key: "API_KEY",
    });
    expect(parseArgs(["list"])).toEqual({ kind: "list", project: "default" });
    expect(parseArgs(["export", "team.onyx"])).toEqual({
      kind: "export",
      project: "default",
      out: "team.onyx",
    });
  });

  it("accepts --project before or after the command", () => {
    expect(parseArgs(["--project", "web", "list"])).toEqual({ kind: "list", project: "web" });
    expect(parseArgs(["get", "K", "--project", "api"])).toEqual({
      kind: "get",
      project: "api",
      key: "K",
    });
  });

  it("parses run and keeps everything after -- verbatim, including flags", () => {
    expect(parseArgs(["run", "--project", "api", "--", "pnpm", "dev", "--project", "x"])).toEqual({
      kind: "run",
      project: "api",
      command: "pnpm",
      args: ["dev", "--project", "x"],
    });
  });

  it("parses scan", () => {
    expect(parseArgs(["scan"])).toEqual({ kind: "scan" });
  });
});

describe("onyx parseArgs: errors", () => {
  it("reports usage for an empty argv", () => {
    expect(parseArgs([])).toEqual({ kind: "error", message: "usage: onyx COMMAND" });
  });

  it("reports an unknown command by name", () => {
    expect(parseArgs(["destroy"])).toEqual({ kind: "error", message: "unknown command: destroy" });
  });

  it("reports usage when set has too few or too many arguments", () => {
    const usage = { kind: "error", message: "usage: onyx set KEY VALUE" };
    expect(parseArgs(["set", "ONLY_KEY"])).toEqual(usage);
    expect(parseArgs(["set", "A", "B", "C"])).toEqual(usage);
  });

  it("reports usage when get or export is missing its argument", () => {
    expect(parseArgs(["get"])).toEqual({ kind: "error", message: "usage: onyx get KEY" });
    expect(parseArgs(["export"])).toEqual({ kind: "error", message: "usage: onyx export FILE" });
  });

  it("requires -- and a command for run", () => {
    const usage = { kind: "error", message: "usage: onyx run -- CMD ARGS..." };
    expect(parseArgs(["run", "pnpm", "dev"])).toEqual(usage);
    expect(parseArgs(["run", "--"])).toEqual(usage);
  });

  it("reports a --project flag with no value", () => {
    expect(parseArgs(["list", "--project"])).toEqual({
      kind: "error",
      message: "missing value for --project",
    });
  });

  it("rejects extra arguments to list and scan", () => {
    expect(parseArgs(["list", "extra"])).toEqual({ kind: "error", message: "usage: onyx list" });
    expect(parseArgs(["scan", "extra"])).toEqual({ kind: "error", message: "usage: onyx scan" });
  });
});

describe("onyx colorize", () => {
  it("wraps text in ANSI codes when enabled", () => {
    expect(colorize("ok", "green", true)).toBe("\x1b[32mok\x1b[0m");
    expect(colorize("fail", "red", true)).toBe("\x1b[31mfail\x1b[0m");
    expect(colorize("warn", "yellow", true)).toBe("\x1b[33mwarn\x1b[0m");
  });

  it("returns the text unchanged when disabled", () => {
    expect(colorize("plain", "red", false)).toBe("plain");
    expect(colorize("", "green", false)).toBe("");
  });
});
