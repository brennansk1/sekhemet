import { describe, expect, expectTypeOf, it } from "vitest";
import type { AuditReport, ChronicleEvent } from "../src/types.js";

/**
 * Contract tests for card_chron_iface.
 *
 * A types-only card is otherwise gated by tsc alone, so a contract that
 * compiles but is wrong passes — and then makes later cards impossible: a live
 * run made AuditReport.expectedHash required, and the verifier card could never
 * build a valid report without editing a file outside its scope. These
 * assignments only typecheck when the contract is exactly as specified.
 */
describe("chronicle contract", () => {
  it("defaults the event payload type to unknown", () => {
    // Compiles only if ChronicleEvent's type parameter has a default.
    const event: ChronicleEvent = {
      id: "e1",
      sequenceNumber: 1,
      timestamp: 1700000000000,
      type: "order.created",
      payload: { anything: true },
      previousHash: "0".repeat(64),
      hash: "a".repeat(64),
    };
    expectTypeOf(event.payload).toEqualTypeOf<unknown>();
    expect(event.sequenceNumber).toBe(1);
  });

  it("keeps idempotencyKey optional and typed as a string", () => {
    expectTypeOf<ChronicleEvent["idempotencyKey"]>().toEqualTypeOf<string | undefined>();
    const keyed: ChronicleEvent<{ n: number }> = {
      id: "e2",
      sequenceNumber: 2,
      timestamp: 1700000000001,
      type: "order.paid",
      payload: { n: 1 },
      previousHash: "a".repeat(64),
      hash: "b".repeat(64),
      idempotencyKey: "k-1",
    };
    expectTypeOf(keyed.payload).toEqualTypeOf<{ n: number }>();
    expect(keyed.idempotencyKey).toBe("k-1");
  });

  it("requires only valid and totalEvents on an AuditReport", () => {
    // Compiles only if the three diagnostic fields are optional.
    const clean: AuditReport = { valid: true, totalEvents: 0 };
    expect(clean).toEqual({ valid: true, totalEvents: 0 });

    const broken: AuditReport = {
      valid: false,
      totalEvents: 3,
      corruptedAtSequence: 2,
      expectedHash: "a".repeat(64),
      actualHash: "b".repeat(64),
    };
    expect(broken.corruptedAtSequence).toBe(2);
  });

  it("types every field exactly", () => {
    expectTypeOf<AuditReport["valid"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AuditReport["totalEvents"]>().toEqualTypeOf<number>();
    expectTypeOf<AuditReport["corruptedAtSequence"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AuditReport["expectedHash"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditReport["actualHash"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChronicleEvent["timestamp"]>().toEqualTypeOf<number>();
    expectTypeOf<ChronicleEvent["previousHash"]>().toEqualTypeOf<string>();
  });
});
