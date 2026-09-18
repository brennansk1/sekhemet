import { describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalJson, hashEvent } from "../src/hasher.js";

/**
 * Acceptance tests for card_chron_hasher, authored before the implementation.
 *
 * These assertions are the contract. An implementer may not modify them.
 */
describe("chronicle hasher", () => {
  it("serializes canonically so key order cannot change the hash", () => {
    // The whole point of canonical JSON: two objects that are equal as values
    // must serialize identically, or the chain breaks on a re-serialization.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"z":{"x":2,"y":1}}');
  });

  it("links the genesis event to sixty-four zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });

  it("produces a 64-character lowercase hex digest", () => {
    const hash = hashEvent({
      id: "11111111-1111-4111-8111-111111111111",
      sequenceNumber: 1,
      timestamp: 1700000000000,
      type: "order.created",
      payload: { total: 10 },
      previousHash: GENESIS_HASH,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes the previous hash, so event N depends on event N-1", () => {
    const base = {
      id: "22222222-2222-4222-8222-222222222222",
      sequenceNumber: 2,
      timestamp: 1700000000001,
      type: "order.paid",
      payload: { total: 10 },
    };

    const a = hashEvent({ ...base, previousHash: GENESIS_HASH });
    const b = hashEvent({ ...base, previousHash: "a".repeat(64) });
    expect(a).not.toBe(b);
  });

  it("is invariant to payload key order but sensitive to payload values", () => {
    const base = {
      id: "33333333-3333-4333-8333-333333333333",
      sequenceNumber: 3,
      timestamp: 1700000000002,
      type: "order.shipped",
      previousHash: GENESIS_HASH,
    };

    expect(hashEvent({ ...base, payload: { a: 1, b: 2 } })).toBe(
      hashEvent({ ...base, payload: { b: 2, a: 1 } }),
    );
    expect(hashEvent({ ...base, payload: { a: 1, b: 2 } })).not.toBe(
      hashEvent({ ...base, payload: { a: 1, b: 3 } }),
    );
  });
});
