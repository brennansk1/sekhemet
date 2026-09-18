import { describe, expect, it } from "vitest";
import {
  checkExecutionHeadroom,
  classifyMemoryPressure,
  readSwapUsedBytes,
} from "../src/memory.js";

describe("@sekhemet/models memory guard", () => {
  it("reads real swap usage on supported hosts", () => {
    const swap = readSwapUsedBytes();
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(typeof swap).toBe("number");
      expect(swap).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses a turn once swap exceeds the absolute limit", () => {
    const current = readSwapUsedBytes();
    if (current === undefined) return;
    // A limit below current usage must trip, whatever this machine is doing.
    const verdict = checkExecutionHeadroom(undefined, { maxSwapBytes: current - 1 });
    if (current > 0) {
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("exceeds");
    }
  });

  it("refuses a turn once swap has grown past the per-card limit", () => {
    const current = readSwapUsedBytes();
    if (current === undefined) return;
    // Pretend the card started with 2GB less swap than now.
    const verdict = checkExecutionHeadroom(current - 2 * 1024 ** 3, {
      maxSwapBytes: Number.MAX_SAFE_INTEGER,
      maxSwapGrowthBytes: 1024 ** 3,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("grew");
  });

  it("permits a turn with ample headroom", () => {
    const current = readSwapUsedBytes();
    if (current === undefined) return;
    const verdict = checkExecutionHeadroom(current, {
      maxSwapBytes: current + 10 * 1024 ** 3,
      maxSwapGrowthBytes: 10 * 1024 ** 3,
    });
    expect(verdict.ok).toBe(true);
  });

  it("classifies pressure by used ratio at the specified thresholds", () => {
    expect(classifyMemoryPressure(50, 100).level).toBe("normal");
    expect(classifyMemoryPressure(86, 100).level).toBe("warning");
    expect(classifyMemoryPressure(95, 100).level).toBe("critical");
    expect(classifyMemoryPressure(95, 100).pauseExecution).toBe(true);
  });
});
