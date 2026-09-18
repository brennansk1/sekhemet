import { classifyMemoryPressure } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { memoryCheck } from "../src/doctor.js";

const GB = 1024 ** 3;
const gb = (n: number) => (n / GB).toFixed(1);

describe("doctor memory check", () => {
  // 97% "used" on macOS is mostly reclaimable cache; the kernel says normal.
  const pressure = classifyMemoryPressure(23.3 * GB, 24 * GB);

  it("follows the kernel pressure level, not the cache-inflated ratio", () => {
    const c = memoryCheck(pressure, 0.7 * GB, 24 * GB, gb, 1);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("system pressure normal");
    expect(c.detail).toContain("97% used");
  });

  it("warns and fails on the kernel's warning and critical levels", () => {
    expect(memoryCheck(pressure, 0.7 * GB, 24 * GB, gb, 2).status).toBe("warn");
    expect(memoryCheck(pressure, 0.7 * GB, 24 * GB, gb, 4).status).toBe("fail");
  });

  it("falls back to the ratio where no kernel level exists", () => {
    const c = memoryCheck(pressure, 0.7 * GB, 24 * GB, gb, null);
    expect(c.status).toBe("fail");
  });
});
