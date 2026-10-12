import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// Wave 9 B11 and B9 (sweep 5): a deleted middle row is named as the missing
// seq, and `verifyProjections` says how many events it read. Real SQLite
// files (DEFINITION_OF_DONE §2A).

let disk: DiskDb;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  disk = openDiskDb("kernel-chain-gap-");
  db = disk.db;
  log = new EventLog(db);
});
afterEach(() => disk.dispose());

describe("kernel rule 10: a deleted row is named at its own seq", () => {
  it("names the missing seq, not the row after it", async () => {
    for (let n = 1; n <= 5; n++) await log.append({ actor: "system", type: "t", payload: { n } });
    db.exec("DROP TRIGGER IF EXISTS events_no_delete");
    db.exec("DELETE FROM events WHERE seq = 3");
    const v = await new EventLog(db).verifyHashChain({ full: true });
    expect(v.valid).toBe(false);
    expect(v.corruptedSeq).toBe(3);
    expect(v.reason).toMatch(/seq 3 is missing/);
    expect(v.reason).toMatch(/after 2 is 4/);
  });

  it("names a run of missing seqs as a range", async () => {
    for (let n = 1; n <= 6; n++) await log.append({ actor: "system", type: "t", payload: { n } });
    db.exec("DROP TRIGGER IF EXISTS events_no_delete");
    db.exec("DELETE FROM events WHERE seq IN (3, 4)");
    const v = await new EventLog(db).verifyHashChain({ full: true });
    expect(v.corruptedSeq).toBe(3);
    expect(v.reason).toMatch(/seqs 3–4 are missing/);
  });
});

describe("K8: verifyProjections counts the events it read", () => {
  it("eventsRead is the ledger's event count, whatever applyEvent projected", async () => {
    const store = new CardStore(db, log);
    await store.createCard({ id: "c1", tier: "story", title: "One" });
    await log.append({ actor: "system", type: "not/a/projection", payload: {} });
    await log.append({ actor: "system", type: "not/a/projection", payload: {} });
    const total = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const verdict = await store.verifyProjections();
    expect(verdict.identical).toBe(true);
    expect(verdict.eventsRead).toBe(total);
    expect(verdict.eventsApplied).toBeLessThan(total);
  });
});
