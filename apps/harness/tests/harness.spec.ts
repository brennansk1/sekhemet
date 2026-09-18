import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkMemoryPressure,
  initLocalKernel,
  parseCliArgs,
  printEventLog,
  printTerminalBoard,
  runDoctor,
} from "../src/index.js";

describe("@sekhemet/harness CLI", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), "sekhemet-cli-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("runDoctor verifies system prerequisites and returns passing status", () => {
    const report = runDoctor();
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(4);
    expect(report.checks.some((c) => c.includes("Unified memory"))).toBe(true);
  });

  it("parseCliArgs parses all subcommands correctly", () => {
    expect(parseCliArgs(["doctor"]).command).toBe("doctor");
    expect(parseCliArgs(["board"]).command).toBe("board");
    expect(parseCliArgs(["log"]).command).toBe("log");
    expect(parseCliArgs(["serve"]).command).toBe("serve");
    expect(parseCliArgs(["ui"]).command).toBe("serve");
    expect(parseCliArgs([]).command).toBe("help");

    const custom = parseCliArgs([
      "serve",
      "--port",
      "8080",
      "--restricted",
      "--model",
      "ollama/llama3.2:3b",
    ]);
    expect(custom.command).toBe("serve");
    expect(custom.port).toBe(8080);
    expect(custom.restrictedMode).toBe(true);
    expect(custom.modelId).toBe("ollama/llama3.2:3b");
  });

  it("checks memory pressure thresholds and determines throttle states", () => {
    const normal = checkMemoryPressure(8 * 1024, 16 * 1024);
    expect(normal.level).toBe("normal");
    expect(normal.throttleMtp).toBe(false);

    const warning = checkMemoryPressure(14 * 1024, 16 * 1024);
    expect(warning.level).toBe("warning");
    expect(warning.throttleMtp).toBe(true);

    const critical = checkMemoryPressure(15.5 * 1024, 16 * 1024);
    expect(critical.level).toBe("critical");
    expect(critical.pauseExecution).toBe(true);
  });

  it("initializes local SQLite WAL kernel and renders terminal kanban and event log", async () => {
    const { log, cardStore, boardService } = initLocalKernel(tempRepo);

    await cardStore.createCard({
      id: "card_term_1",
      tier: "task",
      title: "Terminal View Test",
      status: "ready",
    });

    // Verify printTerminalBoard executes without error
    await expect(printTerminalBoard(boardService)).resolves.not.toThrow();

    // Verify printEventLog executes without error
    await expect(printEventLog(log)).resolves.not.toThrow();
  });
});
