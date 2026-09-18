import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore, type NewEvent } from "../src/store.js";

function event(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    source: "stripe",
    method: "POST",
    path: "/ingest/stripe",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=ab" },
    body: Buffer.from('{"ok":true}'),
    receivedAt: 1_700_000_000_000,
    verification: "verified",
    ...overrides,
  };
}

/** Acceptance tests for card_vang_3_store against a real on-disk database. */
describe("vanguard event store", () => {
  let dir: string;
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vanguard-store-"));
    dbPath = join(dir, "events.db");
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses WAL and creates webhook_events with exactly the specified columns", () => {
    const db = new DatabaseSync(dbPath);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const cols = (db.prepare("PRAGMA table_info(webhook_events)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual([
      "body",
      "headers_json",
      "id",
      "method",
      "path",
      "received_at",
      "source",
      "verification",
    ]);
    db.close();
  });

  it("assigns ids from 1 and returns the stored event", () => {
    const first = store.insert(event());
    const second = store.insert(event({ source: "github" }));
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(second.source).toBe("github");
    expect(store.count()).toBe(2);
  });

  it("round-trips raw, non-UTF-8 body bytes exactly as a Buffer", () => {
    const raw = Buffer.from([0xff, 0x00, 0xfe, 0x0a, 0x80]);
    const { id } = store.insert(event({ body: raw }));
    const loaded = store.get(id);
    expect(Buffer.isBuffer(loaded?.body)).toBe(true);
    expect(loaded?.body).toEqual(raw);
    expect(loaded?.body.length).toBe(5);
  });

  it("round-trips headers, method, path, timestamp and verification exactly", () => {
    const { id } = store.insert(
      event({
        headers: { "x-hub-signature-256": "sha256=00", "X-Mixed-Case": "Kept" },
        method: "PUT",
        path: "/ingest/github?x=1",
        receivedAt: 42,
        verification: "failed",
      }),
    );
    const loaded = store.get(id);
    expect(loaded?.headers).toEqual({ "x-hub-signature-256": "sha256=00", "X-Mixed-Case": "Kept" });
    expect([loaded?.method, loaded?.path, loaded?.receivedAt, loaded?.verification]).toEqual([
      "PUT",
      "/ingest/github?x=1",
      42,
      "failed",
    ]);
  });

  it("returns undefined for an unknown id", () => {
    expect(store.get(999)).toBeUndefined();
  });

  it("stores an empty body", () => {
    const { id } = store.insert(event({ body: Buffer.alloc(0) }));
    expect(store.get(id)?.body.length).toBe(0);
  });

  it("rejects an unknown verification status at the database level", () => {
    const bogus = event({ verification: "bogus" as NewEvent["verification"] });
    expect(() => store.insert(bogus)).toThrow(/CHECK/);
    expect(store.count()).toBe(0);
  });

  it("lists newest first, filtered by source and limited", () => {
    store.insert(event({ source: "stripe" }));
    store.insert(event({ source: "github" }));
    store.insert(event({ source: "stripe" }));
    store.insert(event({ source: "stripe" }));
    expect(store.list().map((e) => e.id)).toEqual([4, 3, 2, 1]);
    expect(store.list({ source: "stripe" }).map((e) => e.id)).toEqual([4, 3, 1]);
    expect(store.list({ source: "stripe", limit: 2 }).map((e) => e.id)).toEqual([4, 3]);
    expect(store.list({ source: "shopify" })).toEqual([]);
  });

  it("defaults the list limit to 50", () => {
    for (let i = 0; i < 55; i++) store.insert(event());
    expect(store.list().length).toBe(50);
    expect(store.list()[0]?.id).toBe(55);
  });

  it("rejects a limit below 1", () => {
    expect(() => store.list({ limit: 0 })).toThrow("limit must be >= 1");
    expect(() => store.list({ limit: -3 })).toThrow(RangeError);
  });

  it("persists events across reopening the database", () => {
    store.insert(event({ body: Buffer.from("persist me") }));
    store.close();
    store = new EventStore(dbPath);
    expect(store.count()).toBe(1);
    expect(store.get(1)?.body.toString()).toBe("persist me");
  });
});
