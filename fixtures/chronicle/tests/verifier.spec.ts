import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEvent } from "../src/hasher.js";
import type { ChronicleEvent } from "../src/types.js";
import { verifyChain } from "../src/verifier.js";

/** Build a well-formed chain of `count` events. */
function buildChain(count: number): ChronicleEvent[] {
  const events: ChronicleEvent[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 1; i <= count; i++) {
    const partial = {
      id: `${`${i}`.padStart(8, "0")}-0000-4000-8000-000000000000`,
      sequenceNumber: i,
      timestamp: 1700000000000 + i,
      type: "order.created",
      payload: { index: i },
      previousHash,
    };
    const hash = hashEvent(partial);
    events.push({ ...partial, hash });
    previousHash = hash;
  }

  return events;
}

describe("chronicle verifier", () => {
  it("accepts an intact chain", () => {
    const report = verifyChain(buildChain(5));
    expect(report.valid).toBe(true);
    expect(report.totalEvents).toBe(5);
    expect(report.corruptedAtSequence).toBeUndefined();
  });

  it("names the exact sequence number where a payload was tampered with", () => {
    const chain = buildChain(5);
    // Corrupt the payload of event 3 without updating its hash.
    const target = chain[2];
    if (!target) throw new Error("fixture chain too short");
    target.payload = { index: 999 };

    const report = verifyChain(chain);
    expect(report.valid).toBe(false);
    expect(report.corruptedAtSequence).toBe(3);
  });

  it("detects a broken link when a previousHash is rewritten", () => {
    const chain = buildChain(4);
    const target = chain[3];
    if (!target) throw new Error("fixture chain too short");
    target.previousHash = "b".repeat(64);

    const report = verifyChain(chain);
    expect(report.valid).toBe(false);
    expect(report.corruptedAtSequence).toBe(4);
  });

  it("rejects a non-monotonic sequence", () => {
    const chain = buildChain(3);
    const target = chain[1];
    if (!target) throw new Error("fixture chain too short");
    target.sequenceNumber = 7;

    const report = verifyChain(chain);
    expect(report.valid).toBe(false);
    expect(report.corruptedAtSequence).toBe(7);
  });

  it("treats an empty chain as valid with zero events", () => {
    const report = verifyChain([]);
    expect(report.valid).toBe(true);
    expect(report.totalEvents).toBe(0);
  });
});
