import { describe, expect, it } from "vitest";
import { memoryGuardView } from "../src/machine_tier.js";

/**
 * Wave 2 A7 (dashboard §2.4 Machine, models rule 19): the Memory card says
 * what the run guard that runs acts on. Where the system reports a pressure
 * level (macOS), the guard follows it and swap, not the used-memory marks,
 * so the page never says 94% pauses the Agent while it shows 99% and the
 * guard lets running issues continue.
 */
const thresholds = { warning: 0.85, throttle: 0.9, critical: 0.94 };

describe("A7: the Memory card's words follow the guard that runs", () => {
  it("kernel source at 99% used and warning pressure: no claim that 94% pauses the Agent", () => {
    const v = memoryGuardView({
      level: "critical",
      guardLevel: "warning",
      guardSource: "kernel",
      usedRatio: 0.99,
      thresholds,
    });
    expect(v.label).toBe("Warning");
    expect(v.legend).toBe(
      "85% · 90% · 94%: used-memory marks. On this machine the run guard follows the system's pressure level and swap instead, and pauses the Agent only at critical pressure.",
    );
    expect(v.text).toBe(
      "The system reports warning pressure. Running issues continue; the Agent is paused if pressure reaches critical.",
    );
    expect(`${v.legend} ${v.text}`).not.toMatch(/94% pause|Above 94%/);
  });

  it("ratio source (no system level): the marks are the guard's, as before", () => {
    const v = memoryGuardView({
      level: "normal",
      guardSource: "ratio",
      usedRatio: 0.5,
      thresholds,
    });
    expect(v.label).toBe("Normal");
    expect(v.legend).toBe("85% warning · 90% no new worktrees · 94% pause the Agent");
    expect(v.text).toBe(
      "Issues run normally. Sekhemet stops adding worktrees at 90% and pauses the Agent at 94%.",
    );
  });
});
