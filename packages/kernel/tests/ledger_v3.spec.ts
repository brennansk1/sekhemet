import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical_json.js";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { RunLedger } from "../src/records.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md NEW-kernel-1 (hash chain v3 with a private part) and NEW-kernel-2
// (a principal column), plus the on_behalf_of field v3 fixes once
// (NEW-kernel-10's chain share). Real SQLite files (DEFINITION_OF_DONE §2A).

let disk: DiskDb;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  disk = openDiskDb("kernel-ledger-v3-");
  db = disk.db;
  log = new EventLog(db);
});
afterEach(() => disk.dispose());

/** What a person with file access can do: drop the append-only guard, then edit. */
function tamper(sql: string, ...params: (string | number)[]): void {
  db.exec("DROP TRIGGER IF EXISTS events_no_update");
  db.exec("DROP TRIGGER IF EXISTS events_no_delete");
  db.exec("DROP TRIGGER IF EXISTS event_private_no_update");
  db.prepare(sql).run(...params);
}

describe("K-N1-1: the chain covers created_at", () => {
  it("reports the chain invalid at the row whose created_at was edited", async () => {
    await log.append({ actor: "system", type: "a", payload: { n: 1 } });
    await log.append({ actor: "system", type: "b", payload: { n: 2 } });
    await log.append({ actor: "system", type: "c", payload: { n: 3 } });
    tamper("UPDATE events SET created_at = '2020-01-01T00:00:00.000Z' WHERE seq = 2");
    const v = await new EventLog(db).verifyHashChain();
    expect(v.valid).toBe(false);
    expect(v.corruptedSeq).toBe(2);
  });

  it("records hash_version 3 on every new row", async () => {
    await log.append({ actor: "system", type: "a", payload: {} });
    expect(db.prepare("SELECT hash_version FROM events").get()).toEqual({ hash_version: 3 });
  });
});

describe("K-N1-2: UPDATE and DELETE on events are aborted", () => {
  it("aborts an UPDATE and a DELETE, leaving the row", async () => {
    await log.append({ actor: "system", type: "a", payload: { n: 1 } });
    expect(() => db.exec("UPDATE events SET type = 'x' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events WHERE seq = 1")).toThrow(/append-only/);
    expect(db.prepare("SELECT type FROM events").all()).toEqual([{ type: "a" }]);
    expect((await log.verifyHashChain()).valid).toBe(true);
  });
});

describe("K-N1-3: incremental verification", () => {
  it("hashes exactly the M events appended since the last verification", async () => {
    for (let i = 0; i < 5; i++) await log.append({ actor: "system", type: "a", payload: { i } });
    const first = await log.verifyHashChain();
    expect(first).toMatchObject({ valid: true, totalEvents: 5, hashedEvents: 5 });
    for (let i = 0; i < 3; i++) await log.append({ actor: "system", type: "b", payload: { i } });
    const second = await log.verifyHashChain();
    expect(second).toMatchObject({ valid: true, totalEvents: 8, hashedEvents: 3 });
    expect(await log.verifyHashChain()).toMatchObject({ valid: true, hashedEvents: 0 });
    expect(await log.verifyHashChain({ full: true })).toMatchObject({ hashedEvents: 8 });
  });

  it("falls back to a full pass when the last verified row no longer matches", async () => {
    for (let i = 0; i < 3; i++) await log.append({ actor: "system", type: "a", payload: { i } });
    await log.verifyHashChain();
    const before = (db.prepare("SELECT hash FROM events WHERE seq = 3").get() as { hash: string })
      .hash;
    // Flip the first hex digit to a different one: a fixed 'f' left the row
    // unchanged whenever its hash already began with 'f' (1 run in 16).
    tamper(
      "UPDATE events SET hash = (CASE WHEN substr(hash, 1, 1) = 'f' THEN '0' ELSE 'f' END) || substr(hash, 2) WHERE seq = 3",
    );
    const after = (db.prepare("SELECT hash FROM events WHERE seq = 3").get() as { hash: string })
      .hash;
    expect(after).not.toBe(before);
    const v = await log.verifyHashChain();
    expect(v.valid).toBe(false);
    expect(v.corruptedSeq).toBe(3);
  });
});

describe("K-N1-4: rows under two formula versions", () => {
  it("verifies a v2 row by v2 and a v3 row by v3", async () => {
    // A row an earlier build wrote: v2 formula, no hash_version, DB-default created_at.
    const payload = { n: 1 };
    const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const prev = "0".repeat(64);
    const hash = EventLog.computeHash({
      prevHash: prev,
      seq: 1,
      actor: "system",
      type: "old",
      payloadHash,
      id: "e-old",
    });
    db.prepare(
      "INSERT INTO events (id, actor, type, payload, payload_hash, hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("e-old", "system", "old", JSON.stringify(payload), payloadHash, hash, prev);
    await log.append({ actor: "system", type: "new", payload: { n: 2 } });
    const rows = db.prepare("SELECT hash_version FROM events ORDER BY seq").all();
    expect(rows).toEqual([{ hash_version: null }, { hash_version: 3 }]);
    expect(await new EventLog(db).verifyHashChain()).toMatchObject({ valid: true, totalEvents: 2 });
  });
});

describe("K-N1-6: a private part with a salted commitment", () => {
  it("stores a fresh 32-byte salt and the body in event_private, committed in the chain", async () => {
    const a = await log.append({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_abc" },
      private: { email: "ada@example.com" },
    });
    const b = await log.append({
      actor: "system",
      type: "person/created",
      payload: { principal: "p_def" },
      private: { email: "ada@example.com" },
    });
    const rows = db
      .prepare("SELECT event_id, salt, body FROM event_private ORDER BY rowid")
      .all() as unknown as { event_id: string; salt: string; body: string }[];
    expect(rows.map((r) => r.event_id)).toEqual([a.id, b.id]);
    for (const r of rows) expect(r.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.salt).not.toBe(rows[1]?.salt);
    const commitment = (r: { salt: string; body: string }) =>
      createHash("sha256")
        .update(Buffer.concat([Buffer.from(r.salt, "hex"), Buffer.from(r.body, "utf8")]))
        .digest("hex");
    expect(a.commitment).toBe(commitment(rows[0] as never));
    expect(b.commitment).toBe(commitment(rows[1] as never));
    expect(a.commitment).not.toBe(b.commitment);
    // The private body is never in the structural payload.
    expect(JSON.stringify(db.prepare("SELECT payload FROM events").all())).not.toContain("ada@");
    expect((await log.getEvents())[0]?.private).toEqual({ email: "ada@example.com" });
    expect((await log.verifyHashChain()).valid).toBe(true);
  });

  it("K-N1-7: reports the chain invalid when a private row is altered, not deleted", async () => {
    await log.append({ actor: "system", type: "a", payload: {} });
    const e = await log.append({
      actor: "system",
      type: "b",
      payload: {},
      private: { note: "original" },
    });
    tamper("UPDATE event_private SET body = ? WHERE event_id = ?", '{"note":"altered"}', e.id);
    const v = await new EventLog(db).verifyHashChain();
    expect(v.valid).toBe(false);
    expect(v.corruptedSeq).toBe(2);
  });

  it("refuses an UPDATE of a private row outright", async () => {
    const e = await log.append({ actor: "system", type: "b", payload: {}, private: { x: 1 } });
    expect(() =>
      db.prepare("UPDATE event_private SET body = '{}' WHERE event_id = ?").run(e.id),
    ).toThrow(/erasure/);
  });

  it("reports a private row deleted without a recorded erasure as corrupt", async () => {
    const e = await log.append({ actor: "system", type: "b", payload: {}, private: { x: 1 } });
    db.prepare("DELETE FROM event_private WHERE event_id = ?").run(e.id);
    const v = await new EventLog(db).verifyHashChain();
    expect(v.valid).toBe(false);
    expect(v.corruptedSeq).toBe(1);
    expect(v.reason).toMatch(/no recorded erasure/);
  });
});

describe("NEW-kernel-2: a principal column on events", () => {
  it("K-N2-1: refuses an event with actor human and no principal when none can be resolved", async () => {
    const team = new EventLog(db, { setup: "team" });
    await expect(team.append({ actor: "human", type: "a", payload: {} })).rejects.toThrow(
      /principal/,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("K-N2-1 (solo): a human event carries the install's one principal", async () => {
    const e = await log.append({ actor: "human", type: "a", payload: {} });
    expect(e.principal).toMatch(/^p_[0-9a-z]+$/);
    const f = await new EventLog(db).append({ actor: "human", type: "b", payload: {} });
    expect(f.principal).toBe(e.principal);
  });

  it("K-N2-2: an answered decision records the acting principal", async () => {
    const runs = new RunLedger(db, log);
    const d = await runs.requestDecision({
      kind: "clarify",
      question: "Which?",
      context: "ctx",
      options: ["a", "b"],
    });
    await runs.answerDecision(d.id, 1, "human", "p_owner1");
    const row = db
      .prepare("SELECT principal FROM events WHERE type = 'decision/answered'")
      .get() as { principal: string };
    expect(row.principal).toBe("p_owner1");
  });

  it("K-N2-3: an edited principal breaks the chain at that seq", async () => {
    await log.append({ actor: "system", type: "a", payload: {} });
    await log.append({ actor: "human", type: "b", payload: {}, principal: "p_one" });
    tamper("UPDATE events SET principal = 'p_two' WHERE seq = 2");
    const v = await new EventLog(db).verifyHashChain();
    expect(v).toMatchObject({ valid: false, corruptedSeq: 2 });
  });

  it("K-N2-4: rebuilt projections are identical and every principal is kept", async () => {
    const store = new CardStore(db, log);
    const card = await store.createCard({ title: "Principal", tier: "task" } as never);
    await log.append({
      actor: "human",
      type: "card/note_by_person",
      cardId: card.id,
      payload: {},
      principal: "p_kept",
    });
    const before = db.prepare("SELECT seq, principal FROM events ORDER BY seq").all();
    await store.rebuildProjections();
    expect(db.prepare("SELECT seq, principal FROM events ORDER BY seq").all()).toEqual(before);
    expect((await store.verifyProjections()).identical).toBe(true);
    expect((await log.getEventsByCard(card.id)).find((e) => e.principal)?.principal).toBe("p_kept");
  });

  it("K-N2-5: an MCP move records actor mcp and the person as principal", async () => {
    const e = await log.append({ actor: "mcp", type: "card/status_changed", payload: {} });
    expect(e.actor).toBe("mcp");
    expect(e.principal).toMatch(/^p_[0-9a-z]+$/);
    const team = new EventLog(db, { setup: "team" });
    await expect(team.append({ actor: "mcp", type: "x", payload: {} })).rejects.toThrow(
      /principal/,
    );
  });

  it("K-N2-6: a machine event stores a null principal", async () => {
    const e = await log.append({ actor: "gate", type: "gate/result", payload: {} });
    expect(e.principal).toBeUndefined();
    expect(db.prepare("SELECT principal FROM events").get()).toEqual({ principal: null });
  });

  it("K-N2-7: refuses a principal that is not an opaque id", async () => {
    await expect(
      log.append({ actor: "human", type: "a", payload: {}, principal: "ada@example.com" }),
    ).rejects.toThrow(/opaque/);
    await expect(
      log.append({ actor: "human", type: "a", payload: {}, principal: "Ada Lovelace" }),
    ).rejects.toThrow(/opaque/);
  });

  it("K-N2-7: the install's person record keeps the email only in the private part", async () => {
    const principal = await log.ensureLocalPerson({ email: "ada@example.com", name: "Ada" });
    expect(principal).toMatch(/^p_[0-9a-z]+$/);
    expect(await log.ensureLocalPerson({ email: "ada@example.com" })).toBe(principal);
    const human = await log.append({ actor: "human", type: "a", payload: {} });
    expect(human.principal).toBe(principal);
    const structural = JSON.stringify(
      db
        .prepare(
          "SELECT id, actor, type, card_id, attempt_id, step_id, payload, principal, on_behalf_of FROM events",
        )
        .all(),
    );
    expect(structural).not.toContain("ada@example.com");
    expect(structural).not.toContain("Ada");
    expect(JSON.stringify(db.prepare("SELECT body FROM event_private").all())).toContain(
      "ada@example.com",
    );
  });
});

describe("on_behalf_of in the v3 chain (K-N10-2, K-N10-3 refusal)", () => {
  it("breaks the chain when on_behalf_of is edited", async () => {
    await log.append({ actor: "worker", type: "card/step", payload: {}, onBehalfOf: "p_one" });
    tamper("UPDATE events SET on_behalf_of = 'p_two' WHERE seq = 1");
    expect(await new EventLog(db).verifyHashChain()).toMatchObject({
      valid: false,
      corruptedSeq: 1,
    });
  });

  it("refuses on_behalf_of on an event whose actor is not the worker", async () => {
    await expect(
      log.append({ actor: "gate", type: "x", payload: {}, onBehalfOf: "p_one" }),
    ).rejects.toThrow(/on_behalf_of/);
  });
});

describe("migration 2 brings a v2 ledger to v3 (rule 38)", () => {
  it("adds the v3 columns, the private table and the triggers, and the old chain still verifies", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { initSchema } = await import("../src/schema.js");
    const dir = mkdtempSync(join(tmpdir(), "kernel-v3-migrate-"));
    try {
      // A version-1 database: today's schema without what migration 2 adds.
      const old = new DatabaseSync(join(dir, "events.db"));
      initSchema(old);
      old.exec(`DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;
        DROP TRIGGER event_private_no_update; DROP TABLE event_private;
        DROP INDEX idx_events_principal;
        ALTER TABLE events DROP COLUMN hash_version; ALTER TABLE events DROP COLUMN principal;
        ALTER TABLE events DROP COLUMN on_behalf_of; ALTER TABLE events DROP COLUMN commitment;`);
      let prev = "0".repeat(64);
      for (let seq = 1; seq <= 2; seq++) {
        const payload = { seq };
        const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
        const hash = EventLog.computeHash({
          prevHash: prev,
          seq,
          actor: "system",
          type: "old",
          payloadHash,
          id: `e${seq}`,
        });
        old
          .prepare(
            "INSERT INTO events (id, actor, type, payload, payload_hash, hash, prev_hash) VALUES (?, 'system', 'old', ?, ?, ?, ?)",
          )
          .run(`e${seq}`, JSON.stringify(payload), payloadHash, hash, prev);
        prev = hash;
      }
      old.exec("PRAGMA user_version = 1");
      old.close();
      const reopened = new DatabaseSync(join(dir, "events.db"));
      const report = initSchema(reopened, { backupDir: join(dir, "backups") });
      // Migration 2 and every later one (other workstreams add card columns).
      expect(report.applied[0]).toBe(2);
      expect(report.addedColumns.filter((c) => c.startsWith("events."))).toEqual([
        "events.hash_version",
        "events.principal",
        "events.on_behalf_of",
        "events.commitment",
      ]);
      const migrated = new EventLog(reopened);
      await migrated.append({ actor: "system", type: "new", payload: {}, private: { a: 1 } });
      expect(await migrated.verifyHashChain()).toMatchObject({ valid: true, totalEvents: 3 });
      expect(() => reopened.exec("DELETE FROM events WHERE seq = 1")).toThrow(/append-only/);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
