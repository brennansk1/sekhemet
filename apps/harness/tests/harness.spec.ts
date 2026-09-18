import { describe, expect, it } from "vitest";
import { checkMemoryPressure, parseCliArgs, runDoctor } from "../src/index.js";

describe("@sekhemet/harness CLI", () => {
  it("runDoctor verifies system prerequisites and returns passing status", () => {
    const report = runDoctor();
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(4);
    expect(report.checks.some((c) => c.includes("Unified memory"))).toBe(true);
  });

  it("parseCliArgs parses doctor command and restricted flag correctly", () => {
    const cfg1 = parseCliArgs(["doctor"]);
    expect(cfg1.isDoctor).toBe(true);
    expect(cfg1.restrictedMode).toBe(false);

    const cfg2 = parseCliArgs(["--restricted", "--model", "ollama/qwen2.5-coder"]);
    expect(cfg2.isDoctor).toBe(false);
    expect(cfg2.restrictedMode).toBe(true);
    expect(cfg2.modelId).toBe("ollama/qwen2.5-coder");
  });

  it("checks memory pressure thresholds and determines throttle states", () => {
    // 50% memory used: normal
    const normal = checkMemoryPressure(8 * 1024, 16 * 1024);
    expect(normal.level).toBe("normal");
    expect(normal.throttleMtp).toBe(false);

    // 86% memory used: warning (throttle speculative decoding MTP)
    const warning = checkMemoryPressure(14 * 1024, 16 * 1024);
    expect(warning.level).toBe("warning");
    expect(warning.throttleMtp).toBe(true);

    // 95% memory used: critical (pause execution to prevent OS panic)
    const critical = checkMemoryPressure(15.5 * 1024, 16 * 1024);
    expect(critical.level).toBe("critical");
    expect(critical.pauseExecution).toBe(true);
  });
});
