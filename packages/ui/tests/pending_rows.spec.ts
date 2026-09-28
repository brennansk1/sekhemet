import { describe, expect, it } from "vitest";
import { type PmStatusLike, pendingView } from "../src/pm.js";

// DB-N2-8, dashboard §2.7.8: every state of the pending block under Seshat's
// header, rendered from a fixture, gives its specified rows and note — in
// DEC-31's words (the Worker is "the agent" on screen). The page module
// (`pm_thread.js`) renders exactly what this model returns.

const view = (
  status: PmStatusLike,
  opts: { workerInvolved?: boolean; step?: number; elapsedMs?: number } = {},
) => pendingView(status, { name: "Seshat", ...opts });

describe("the pending block (§2.7.8)", () => {
  it("queued, before the server picks it up: no rows, the queued note", () => {
    expect(view({ phase: "idle" })).toEqual({
      rows: [],
      note: "Queued. Seshat starts as soon as the server picks it up.",
    });
  });

  it("waiting_for_step: pausing the agent after the named step, never mid-edit", () => {
    const v = view({ phase: "waiting_for_step", step: 5 }, { step: 5 });
    expect(v.rows.map((r) => [r.label, r.state])).toEqual([
      ["Pausing the agent after step 5", "current"],
      ["Loading the PM", "todo"],
      ["Thinking", "todo"],
      ["Resuming the agent", "todo"],
    ]);
    expect(v.note).toBe("Waiting for step 5 to finish. The agent is never stopped mid-edit.");
    expect(view({ phase: "waiting_for_step" }).note).toBe(
      "Waiting for the current step to finish. The agent is never stopped mid-edit.",
    );
  });

  it("loading_pm: the ETA on the row, and past it the row reads taking longer than usual", () => {
    const status: PmStatusLike = { phase: "loading_pm", etaSeconds: 40, workerPaused: true };
    const v = view(status, { workerInvolved: true, step: 5, elapsedMs: 10_000 });
    expect(v.rows.map((r) => [r.label, r.state])).toEqual([
      ["Paused the agent after step 5", "done"],
      ["Loading the PM · about 40s", "current"],
      ["Thinking", "todo"],
      ["Resuming the agent", "todo"],
    ]);
    expect(v.note).toBe(
      "Only one model fits in memory, so the agent waits at a safe step boundary and continues from step 6 once Seshat has replied. You can keep working; the reply lands here.",
    );
    expect(view(status, { workerInvolved: true, step: 5, elapsedMs: 41_000 }).note).toBe(
      "Taking longer than usual. The model is still loading. Only one model fits in memory, so the agent waits at a safe step boundary and continues from step 6 once Seshat has replied. You can keep working; the reply lands here.",
    );
    expect(view({ phase: "loading_pm" }).note).toBe(
      "Seshat runs on this machine. You can keep working; the reply lands here.",
    );
    // Without a stated ETA, 40 seconds is the bound (models rule 20).
    expect(view({ phase: "loading_pm" }, { elapsedMs: 40_001 }).note).toMatch(
      /^Taking longer than usual\./,
    );
  });

  it("thinking: after 90 seconds the long-answer note", () => {
    expect(view({ phase: "thinking" }).rows.map((r) => [r.label, r.state])).toEqual([
      ["Loaded the PM", "done"],
      ["Thinking", "current"],
    ]);
    expect(view({ phase: "thinking" }, { elapsedMs: 5_000 }).note).toBe(
      "Reading the board, the runs and the ledger.",
    );
    expect(view({ phase: "thinking" }, { elapsedMs: 90_001 }).note).toBe(
      "Long answers can take up to two minutes on this machine.",
    );
  });

  it("resuming_worker: the agent reloads and the next step starts", () => {
    const v = view({ phase: "resuming_worker" }, { step: 5 });
    expect(v.rows.at(-1)).toMatchObject({ label: "Resuming the agent", state: "current" });
    expect(v.note).toBe("Reloading the agent; step 6 starts next.");
    expect(view({ phase: "resuming_worker" }).note).toBe(
      "Reloading the agent; its next step starts next.",
    );
  });
});
