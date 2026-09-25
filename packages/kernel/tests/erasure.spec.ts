import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/blobs.js";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { ERASED_MARKER } from "../src/types.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md NEW-kernel-7 (rule 34): an erasable ledger. Real SQLite files and
// real blob files; the database bytes on disk are read back to show erased
// text is gone (DEFINITION_OF_DONE §2A).

let disk: DiskDb;
let db: DatabaseSync;
let log: EventLog;
let register: string;
let owner: string;

const SECRET = "sk-live-4f9a2b7c1d0e";

beforeEach(async () => {
  disk = openDiskDb("kernel-erasure-");
  db = disk.db;
  register = join(disk.dir, "backups", "erasure-register.ndjson");
  log = new EventLog(db, { erasureRegister: register });
  owner = await log.ensureLocalPerson({ email: "ada@example.com" });
});
afterEach(() => disk.dispose());

/** The database and WAL bytes, as text, after a checkpoint. */
function bytesOnDisk(): string {
  const parts = [disk.path, `${disk.path}-wal`].filter(existsSync);
  return parts.map((p) => readFileSync(p).toString("latin1")).join("");
}

describe("K-N7-1: a recorded erasure by a person holding Accept", () => {
  it("deletes the private row with secure_delete, records ledger/erased, appends the register, checkpoints", async () => {
    const kept = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: "keep me" },
    });
    const leaked = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: `the key is ${SECRET}`, author: "Ada" },
    });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(bytesOnDisk()).toContain(SECRET);

    const report = await log.erase({ eventIds: [leaked.id], reason: "secret", principal: owner });

    expect(report.eventIds).toEqual([leaked.id]);
    expect(report.fields).toEqual({ [leaked.id]: ["author", "text"] });
    expect(report.outsideReach).toMatch(/outside this erasure's reach/);
    expect(db.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    expect(
      db.prepare("SELECT event_id FROM event_private WHERE event_id = ?").get(leaked.id),
    ).toBeUndefined();
    const erased = (await log.getEventsByTypes(["ledger/erased"]))[0];
    expect(erased?.seq).toBe(report.erasedBySeq);
    expect(erased?.principal).toBe(owner);
    expect(erased?.payload).toEqual({
      eventIds: [leaked.id],
      blobIds: [],
      fields: { [leaked.id]: ["author", "text"] },
      reason: "secret",
      principal: owner,
    });
    const lines = readFileSync(register, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      erasureId: erased?.id,
      seq: erased?.seq,
      eventIds: [leaked.id],
      reason: "secret",
    });
    expect(lines[0]).not.toContain(SECRET);
    // secure_delete + wal_checkpoint(TRUNCATE): the bytes are gone from the files.
    expect(bytesOnDisk()).not.toContain(SECRET);
    expect(bytesOnDisk()).toContain("keep me");
    expect((await log.getEvents()).find((e) => e.id === kept.id)?.private).toEqual({
      text: "keep me",
    });
  });

  it("refuses a ledger/erased written by anything but erase", async () => {
    const e = await log.append({ actor: "system", type: "x", payload: {}, private: { t: 1 } });
    db.prepare("DELETE FROM event_private WHERE event_id = ?").run(e.id);
    await expect(
      log.append({
        actor: "human",
        type: "ledger/erased",
        payload: { eventIds: [e.id], blobIds: [], fields: {}, reason: "erasure", principal: owner },
      }),
    ).rejects.toThrow(/only by EventLog.erase/);
    expect((await log.verifyHashChain({ full: true })).valid).toBe(false);
  });

  it("refuses a principal without the Accept permission and erases nothing", async () => {
    const e = await log.append({ actor: "system", type: "x", payload: {}, private: { t: 1 } });
    const before = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    await expect(
      log.erase({ eventIds: [e.id], reason: "erasure", principal: "p_notanaccepter" }),
    ).rejects.toThrow(/Accept permission/);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM event_private WHERE event_id = ?").get(e.id),
    ).toEqual({ n: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before);
    expect(existsSync(register)).toBe(false);
  });
});

describe("K-N7-2: the chain verifies after an erasure and names the gap", () => {
  it("reports valid and lists the erased event, not a corruption", async () => {
    const e = await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    const { erasedBySeq } = await log.erase({
      eventIds: [e.id],
      reason: "erasure",
      principal: owner,
    });
    for (const fresh of [new EventLog(db), log]) {
      const v = await fresh.verifyHashChain({ full: true });
      expect(v.valid).toBe(true);
      expect(v.erased).toEqual([
        {
          seq: e.seq,
          erasedBySeq,
          message: `erased at seq ${e.seq} by ledger/erased seq ${erasedBySeq}`,
        },
      ]);
    }
  });
});

describe("K-N7-3: projections after an erasure", () => {
  it("rebuilds identical projections and reads each erased field as the marker", async () => {
    const store = new CardStore(db, log);
    const card = await store.createCard({ title: "Erasure", tier: "task" } as never);
    const note = await log.append({
      actor: "human",
      type: "card/private_note",
      cardId: card.id,
      payload: {},
      private: { text: SECRET },
    });
    expect((await store.verifyProjections()).identical).toBe(true);
    const { erasedBySeq } = await log.erase({
      eventIds: [note.id],
      reason: "erasure",
      principal: owner,
    });
    expect((await store.verifyProjections()).identical).toBe(true);
    await store.rebuildProjections();
    expect((await store.verifyProjections()).identical).toBe(true);
    const read = (await new EventLog(db).getEventsByCard(card.id)).find((e) => e.id === note.id);
    expect(read?.private).toEqual({ text: ERASED_MARKER });
    expect(read?.erasedBySeq).toBe(erasedBySeq);
  });
});

describe("K-N7-7: findPrivate", () => {
  it("returns exactly the events whose private part contains the needle", async () => {
    const a = await log.append({
      actor: "system",
      type: "x",
      payload: {},
      private: { t: `a ${SECRET}` },
    });
    await log.append({ actor: "system", type: "x", payload: { t: SECRET }, private: { t: "no" } });
    const c = await log.append({
      actor: "system",
      type: "x",
      payload: {},
      private: { nested: { deep: `"${SECRET}"` } },
    });
    expect(log.findPrivate(SECRET).map((e) => e.id)).toEqual([a.id, c.id]);
    expect(log.findPrivate(`"${SECRET}"`).map((e) => e.id)).toEqual([c.id]);
  });

  it("writes the needle nowhere: not the ledger, a log or a blob", async () => {
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: "plain" } });
    const needle = "needle-never-stored-81c3";
    const before = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(log.findPrivate(needle)).toEqual([]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before);
    expect(bytesOnDisk()).not.toContain(needle);
    const files = readdirSync(disk.dir, { recursive: true }) as string[];
    for (const f of files) {
      const p = join(disk.dir, f);
      try {
        expect(readFileSync(p).toString("latin1")).not.toContain(needle);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EISDIR") throw err;
      }
    }
  });
});

describe("K-N7-8: blobs named by an erasure", () => {
  it("deletes them, lists them in ledger/erased, and reports them erased, not missing", async () => {
    const blobs = new BlobStore(disk.dir);
    const pack = blobs.put(JSON.stringify({ prompt: `use ${SECRET}` }));
    const other = blobs.put(JSON.stringify({ prompt: "harmless" }));
    const store = new CardStore(db, log);
    await store.createCard({ title: "Blob", tier: "task" } as never);
    expect(blobs.findContaining(SECRET)).toEqual([pack]);
    const report = await log.erase({
      eventIds: [],
      blobIds: [pack],
      blobs,
      reason: "secret",
      principal: owner,
    });
    expect(blobs.has(pack)).toBe(false);
    expect(blobs.has(other)).toBe(true);
    expect(report.blobIds).toEqual([pack]);
    expect((await log.getEventsByTypes(["ledger/erased"]))[0]?.payload).toMatchObject({
      blobIds: [pack],
    });
    expect(new EventLog(db).blobErasure(pack)).toBe(report.erasedBySeq);
    expect(log.blobErasure(other)).toBeUndefined();
    expect((await store.verifyProjections()).identical).toBe(true);
    expect((await log.verifyHashChain({ full: true })).valid).toBe(true);
  });
});

describe("K-N7-8: a blob whose recorded deletion did not finish", () => {
  it("is deleted when the ledger is next opened (retryBlobErasures), and nothing else is", async () => {
    const blobs = new BlobStore(disk.dir);
    const content = JSON.stringify({ prompt: `use ${SECRET}` });
    const pack = blobs.put(content);
    const other = blobs.put(JSON.stringify({ prompt: "harmless" }));
    await log.erase({ eventIds: [], blobIds: [pack], blobs, reason: "secret", principal: owner });
    // A crash between COMMIT and the unlink leaves the file behind.
    expect(blobs.put(content)).toBe(pack);
    expect(new EventLog(db).retryBlobErasures(blobs)).toEqual([pack]);
    expect(blobs.has(pack)).toBe(false);
    expect(blobs.has(other)).toBe(true);
    expect(new EventLog(db).retryBlobErasures(blobs)).toEqual([]);
  });
});

describe("SEC-50: a secret in a structural payload", () => {
  it("findInPayload names the seqs whose payload holds it, which erasure cannot reach", async () => {
    const leaked = await log.append({ actor: "system", type: "x", payload: { note: SECRET } });
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    await log.append({ actor: "system", type: "x", payload: { note: "clean" } });
    expect(log.findInPayload(SECRET)).toEqual([leaked.seq]);
    expect(log.findInPayload("")).toEqual([]);
  });
});
