import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH } from "../src/hasher.js";
import { Ledger } from "../src/ledger.js";

/**
 * Ledger acceptance tests run against a real on-disk SQLite database.
 *
 * In-memory substitutes would hide exactly the failures that matter here:
 * WAL behaviour, UNIQUE constraint enforcement, and autoincrement semantics.
 */
describe("chronicle ledger", () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chronicle-"));
    ledger = new Ledger(join(dir, "chronicle.db"));
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns monotonic sequence numbers starting at one", () => {
    const a = ledger.append({ type: "order.created", payload: { id: 1 } });
    const b = ledger.append({ type: "order.paid", payload: { id: 1 } });

    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
  });

  it("links the first event to the genesis hash and each event to its predecessor", () => {
    const a = ledger.append({ type: "order.created", payload: {} });
    const b = ledger.append({ type: "order.paid", payload: {} });

    expect(a.previousHash).toBe(GENESIS_HASH);
    expect(b.previousHash).toBe(a.hash);
  });

  it("returns the existing event when an idempotency key is replayed", () => {
    const first = ledger.append({ type: "order.created", payload: {}, idempotencyKey: "k-1" });
    const replay = ledger.append({ type: "order.created", payload: {}, idempotencyKey: "k-1" });

    expect(replay.id).toBe(first.id);
    expect(replay.sequenceNumber).toBe(first.sequenceNumber);
    expect(ledger.list().length).toBe(1);
  });

  it("persists events across reopening the same database file", () => {
    ledger.append({ type: "order.created", payload: { n: 1 } });
    ledger.close();

    const reopened = new Ledger(join(dir, "chronicle.db"));
    expect(reopened.list().length).toBe(1);
    expect(reopened.list()[0]?.type).toBe("order.created");
    reopened.close();
  });

  it("produces a chain the verifier accepts", () => {
    for (let i = 0; i < 6; i++) ledger.append({ type: "order.created", payload: { i } });
    const report = ledger.audit();
    expect(report.valid).toBe(true);
    expect(report.totalEvents).toBe(6);
  });
});
