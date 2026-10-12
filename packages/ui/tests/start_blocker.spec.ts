import { describe, expect, it } from "vitest";
import { agentPanel } from "../src/issue.js";
import { aiStateLine, tileAiState } from "../src/teammates.js";

// Wave 9 A3 (sweep 5): the issue page said *Queued: the Agent starts this
// issue when a slot is free.* on a Ready issue whose *Ready to start* rows
// the start checks were not met, so it would not start. The board's
// `startBlocker` reason replaces the queue's words; a Coding model missing
// is said first (wave 8 B3).
const BLOCKER = "It declares no files it may change.";

describe("a Ready issue the board would not start is not shown queued", () => {
  it("the issue page names what it waits for, never a queue or a slot", () => {
    const p = agentPanel({ status: "ready" }, [], { startBlocker: BLOCKER });
    expect(p.label).toBe("");
    expect(p.sentence).toBe(
      "Waiting to start: it declares no files it may change. The Agent starts it once that is met.",
    );
    expect(p.sentence).not.toMatch(/queued|slot/i);
    // No Coding model is said first: nothing starts without one.
    const both = agentPanel({ status: "ready" }, [], {
      startBlocker: BLOCKER,
      noCodingModel: true,
    });
    expect(both.sentence).toMatch(/^Waiting for a Coding model/);
    // Nothing unmet: the queue's words stand.
    expect(agentPanel({ status: "ready" }, []).label).toBe("queued");
  });

  it("the teammate line and the tile say the same", () => {
    const fact = {
      who: "agent" as const,
      state: "queued" as const,
      standing: "1st in queue, about 10 minutes",
      blockedBy: BLOCKER,
    };
    const line = aiStateLine(fact);
    expect(line.label).toBe("");
    expect(line.sentence).toBe(
      "Waiting to start: it declares no files it may change. The Agent starts it once that is met.",
    );
    expect(tileAiState([fact])).toBeUndefined();
  });
});
