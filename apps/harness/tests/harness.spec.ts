import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import {
  checkMemoryPressure,
  initLocalKernel,
  parseCliArgs,
  printEventLog,
  printTerminalBoard,
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

  it("runDoctor probes real subsystems and reports a status per check", async () => {
    const report = await runDoctor(tempRepo);

    // Every specified probe must actually run.
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("Unified memory");
    expect(names).toContain("Local inference socket");
    expect(names).toContain("Git worktree isolation");
    expect(names).toContain("Sandbox confinement");
    expect(names).toContain("Node runtime");

    // Statuses must be real verdicts, not decoration.
    for (const c of report.checks) {
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(c.detail.length).toBeGreaterThan(0);
    }

    // ok must be derived from the checks, not hardcoded.
    expect(report.ok).toBe(report.checks.every((c) => c.status !== "fail"));

    // The toolchain running this very test is present, so these cannot fail.
    expect(report.checks.find((c) => c.name === "Node runtime")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "Node runtime")?.detail).toMatch(/^v\d+\./);
  });

  it("runDoctor reports a real git failure outside a repository", async () => {
    // tempRepo is not a git repo, so worktree isolation must FAIL rather than
    // report a hardcoded pass.
    const report = await runDoctor(tempRepo);
    const worktree = report.checks.find((c) => c.name === "Git worktree isolation");
    expect(worktree?.status).toBe("fail");
    expect(report.ok).toBe(false);
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
