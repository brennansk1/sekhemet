import { describe, expect, it, vi } from "vitest";

// The browser module's DOM helpers need a page; its words and choices do not.
vi.mock("../web/dom.js", () => ({
  esc: (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  getJSON: async () => ({ ok: true, status: 200, data: {} }),
  postJSON: async () => ({ ok: true, status: 200, data: {} }),
}));

const {
  QUICK_COPY,
  assignAction,
  comparisonLabel,
  estimateLabel,
  pickerOptions,
  roleScoreText,
  runStateText,
} = await import("../web/config_benchmark.js");

// Dashboard NEW-dashboard-6: DB-N6-9 (Run quick with its estimate, the copy,
// pickers offering only models that fit), DB-N6-10 (run state), DB-N6-12
// (scores with intervals and ranges, Indistinguishable), DB-N6-13 (assign or
// qualify), DB-N6-18 (Not measured yet).

describe("the Benchmark section's words (DB-N6-9–13, DB-N6-18)", () => {
  it("shows Run quick with minutes from the roles not cached, marking what is over its target", () => {
    expect(
      estimateLabel({
        totalMinutes: 23.5,
        overTarget: false,
        roles: [{ role: "worker", state: "to_measure", minutes: 17.5, overTarget: true }],
        endToEnd: { minutes: 6, overTarget: false, cached: false },
      }),
    ).toBe("Run quick — about 24 min (Worker over its target)");
    expect(
      estimateLabel({
        totalMinutes: 0,
        overTarget: false,
        roles: [{ role: "worker", state: "cached", minutes: 0, overTarget: false }],
        endToEnd: { minutes: 0, overTarget: false, cached: true },
      }),
    ).toBe("Run quick — everything is cached");
    expect(QUICK_COPY).toBe(
      "The quick benchmark shows speed, fit and large differences; the overnight benchmark settles close calls",
    );
  });

  it("offers only models that fit, the others disabled with Needs N GB", () => {
    const opts = pickerOptions(
      [
        { id: "a", name: "Small", fits: { worker: "yes" }, fitReason: {} },
        { id: "b", name: "Big", fits: { worker: "no" }, fitReason: { worker: "needs 21 GB" } },
        { id: "c", name: "Swaps", fits: { worker: "swaps" }, fitReason: {} },
      ],
      "worker",
    );
    expect(opts).toEqual([
      { value: "a", label: "Small", disabled: false },
      { value: "b", label: "Big — Needs 21 GB", disabled: true },
      { value: "c", label: "Swaps (swaps)", disabled: false },
    ]);
  });

  it("shows a graded score as its mean with the number of items and their range, and its secondary measures", () => {
    expect(
      roleScoreText({
        role: "worker",
        model: "m",
        state: "measured",
        score: { value: 0.8333, n: 6, low: 0.5, high: 1, kind: "graded" },
        capped: 1,
        secondary: { secondsPerItem: 95, validToolCallRate: 0.98, stepsToPass: 12, fits: true },
      }),
    ).toBe(
      "0.83 over 6 items (0.50–1.00) · 95 s per item · 98% valid tool calls · 12 steps · 1 capped",
    );
    expect(
      roleScoreText({
        role: "worker",
        model: "m",
        state: "measured",
        score: { value: 0.7, n: 30, low: 0.51, high: 0.85, kind: "rate" },
      }),
    ).toBe("70% (95% CI 51%–85%)");
    expect(roleScoreText({ role: "reviewer", model: "m", state: "not_measured" })).toBe(
      "Not measured yet",
    );
  });

  it("labels two candidates Indistinguishable and ranks neither when the paired test does not reject", () => {
    expect(
      comparisonLabel({
        role: "worker",
        a: "x",
        b: "y",
        better: 5,
        worse: 0,
        ties: 1,
        p: 0.0625,
        indistinguishable: true,
      }),
    ).toBe("Indistinguishable (5 better, 0 worse, 1 tied; p = 0.063)");
    expect(
      comparisonLabel({
        role: "worker",
        a: "x",
        b: "y",
        better: 6,
        worse: 0,
        ties: 0,
        p: 0.03125,
        indistinguishable: false,
      }),
    ).toBe("x ahead (6 better, 0 worse, 0 tied; p = 0.031)");
  });

  it("states a run's progress, and keeps a stopped run's results as partial", () => {
    expect(
      runStateText({
        runId: "r",
        tier: "quick",
        combinations: [],
        state: "running",
        partial: false,
        progress: { done: 3, total: 6, elapsedSeconds: 60 },
      }),
    ).toBe("Running — 3 of 6");
    expect(
      runStateText({
        runId: "r",
        tier: "quick",
        combinations: [],
        state: "stopped",
        partial: true,
      }),
    ).toBe("Stopped — results so far kept (partial)");
    expect(
      runStateText({
        runId: "r",
        tier: "overnight",
        combinations: ["a", "b"],
        state: "queued",
        partial: false,
        schedule: { window: { start: "22:00", end: "03:00" }, fitsTonight: 1 },
      }),
    ).toBe("Queued — Tonight 22:00–03:00: 1 of 2 combinations fits");
  });

  it("offers Assign this combination only when every model is qualified, else Qualify to assign", () => {
    expect(assignAction({ worker: true, planner: true })).toBe("Assign this combination");
    expect(assignAction({ worker: true, planner: false })).toBe("Qualify to assign");
  });
});
