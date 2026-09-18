import { describe, expect, it } from "vitest";
import { REPAIR_LADDER, RepairLadder } from "../src/ladder.js";

describe("@sekhemet/loop repair ladder", () => {
  it("applies the specified 2/1/1 attempt caps", () => {
    expect(REPAIR_LADDER[0]?.maxAttempts).toBe(2);
    expect(REPAIR_LADDER[1]?.maxAttempts).toBe(1);
    expect(REPAIR_LADDER[2]?.maxAttempts).toBe(1);
  });

  it("escalates through each rung in order and then stops", () => {
    const ladder = new RepairLadder();
    expect(ladder.current.rung).toBe("direct_repair");

    // Rung 1 permits two attempts before escalating.
    expect(ladder.recordFailure().rung).toBe("direct_repair");
    expect(ladder.recordFailure().rung).toBe("fresh_context");
    expect(ladder.recordFailure().rung).toBe("edit_sketch");
    expect(ladder.recordFailure().rung).toBe("escalate");
    expect(ladder.exhausted).toBe(true);

    // Once exhausted it stays exhausted rather than wrapping around.
    expect(ladder.recordFailure().rung).toBe("escalate");
  });

  it("changes strategy, not just attempt count", () => {
    const ladder = new RepairLadder();
    ladder.recordFailure();
    const fresh = ladder.recordFailure();
    // The second rung must clear context; retrying the same view of the tree is
    // what produces repeat-until-budget failure.
    expect(fresh.resetContext).toBe(true);
    expect(fresh.requireSketch).toBe(false);

    const sketch = ladder.recordFailure();
    expect(sketch.requireSketch).toBe(true);
  });

  it("gives every rung a distinct, non-empty directive", () => {
    const directives = REPAIR_LADDER.map((r) => r.directive);
    expect(new Set(directives).size).toBe(REPAIR_LADDER.length);
    for (const d of directives) expect(d.length).toBeGreaterThan(20);
  });

  it("counts total attempts across rungs", () => {
    const ladder = new RepairLadder();
    ladder.recordFailure();
    ladder.recordFailure();
    ladder.recordFailure();
    expect(ladder.snapshot.totalAttempts).toBe(3);
    expect(ladder.snapshot.rungIndex).toBe(2);
  });

  it("returns to the first rung after a reset, not to a partially spent one", () => {
    const ladder = new RepairLadder();
    ladder.recordFailure();
    ladder.recordFailure();
    ladder.reset();

    expect(ladder.current.rung).toBe("direct_repair");
    expect(ladder.snapshot).toEqual({ rungIndex: 0, attemptsAtRung: 0, totalAttempts: 0 });
    // A full fresh ladder must still take four failures to exhaust.
    ladder.recordFailure();
    expect(ladder.exhausted).toBe(false);
  });
});
