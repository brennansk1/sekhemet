import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RestoreRefused,
  applyErasures,
  exportLedger,
  readErasureRegister,
  restoreBackup,
  verifyLedgerExport,
} from "../src/ledger_backup.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md NEW-kernel-7 (K-N7-4, K-N7-5, K-N7-9, rule 35) and runtime.md
// NEW-runtime-8 (RUN-42, RUN-43): backups that respect erasure, and an
// export a verifier can check alone. Real SQLite files and a real writer
// process (DEFINITION_OF_DONE §2A).

let disk: DiskDb;
let db: DatabaseSync;
let log: EventLog;
let register: string;
let owner: string;
const SECRET = "ghp_restoredMustNotReturn42";

beforeEach(async () => {
  disk = openDiskDb("kernel-backup-");
  db = disk.db;
  register = join(disk.dir, "backups", "erasure-register.ndjson");
  log = new EventLog(db, { erasureRegister: register });
  owner = await log.ensureLocalPerson({ email: "ada@example.com" });
});
afterEach(() => disk.dispose());

const count = (d: DatabaseSync) =>
  (d.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

describe("K-N7-4: a consistent backup while a writer appends", () => {
  it("copies while another process appends; the copy verifies; ledger/backed_up records it", async () => {
    const dist = resolve(import.meta.dirname, "../dist/log.js");
    const stop = join(disk.dir, "stop");
    const script = join(disk.dir, "writer.mjs");
    writeFileSync(
      script,
      `import { DatabaseSync } from "node:sqlite";
       import { existsSync } from "node:fs";
       import { EventLog } from ${JSON.stringify(dist)};
       const db = new DatabaseSync(${JSON.stringify(disk.path)});
       db.exec("PRAGMA busy_timeout = 5000");
       const log = new EventLog(db);
       let i = 0;
       while (!existsSync(${JSON.stringify(stop)})) {
         await log.append({ actor: "system", type: "load", payload: { i: i++ } });
         if (i === 20) process.stdout.write("ready\\n");
       }
       for (let k = 0; k < 20; k++) await log.append({ actor: "system", type: "load", payload: { i: i++ } });
       db.close();`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    await new Promise<void>((r) => child.stdout.once("data", () => r()));

    const target = join(disk.dir, "backups", "b1.db");
    const { seq } = await log.backup(target, { principal: owner });
    writeFileSync(stop, "");
    expect(await exited).toBe(0);

    const copy = new DatabaseSync(target, { readOnly: true });
    expect(await new EventLog(copy).verifyHashChain({ full: true })).toMatchObject({
      valid: true,
      totalEvents: seq,
    });
    copy.close();
    // The writer had begun, and kept going after the copy.
    expect(seq).toBeGreaterThanOrEqual(21);
    expect(count(db)).toBeGreaterThan(seq + 20);
    const recorded = (await log.getEventsByTypes(["ledger/backed_up"]))[0];
    expect(recorded?.payload).toEqual({ path: target, seq });
    expect(recorded?.principal).toBe(owner);
    expect((await new EventLog(db).verifyHashChain({ full: true })).valid).toBe(true);
  });
});

describe("K-N7-5: restore re-applies erasures newer than the backup", () => {
  async function backupThenErase() {
    const leaked = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: SECRET },
    });
    const backup = join(disk.dir, "backups", "before.db");
    const { seq } = await log.backup(backup, { principal: owner });
    const erasure = await log.erase({ eventIds: [leaked.id], reason: "secret", principal: owner });
    const erasureId = (await log.getEventsByTypes(["ledger/erased"]))[0]?.id;
    return { leaked, backup, seq, erasure, erasureId };
  }

  it("re-applies them before the restored ledger is put in place", async () => {
    const { leaked, backup, seq, erasure, erasureId } = await backupThenErase();
    expect(readFileSync(backup).toString("latin1")).toContain(SECRET);
    disk.close();

    const result = await restoreBackup({
      backupPath: backup,
      targetPath: disk.path,
      registerPath: register,
    });
    expect(result.backupSeq).toBe(seq);
    expect(result.reapplied.map((e) => e.seq)).toEqual([erasure.erasedBySeq]);
    expect(result.previousKeptAt && existsSync(result.previousKeptAt)).toBe(true);
    expect(readFileSync(disk.path).toString("latin1")).not.toContain(SECRET);
    expect(existsSync(`${disk.path}.restoring`)).toBe(false);

    const restored = new DatabaseSync(disk.path);
    const rlog = new EventLog(restored);
    const v = await rlog.verifyHashChain({ full: true });
    expect(v.valid).toBe(true);
    expect(v.erased?.map((e) => e.seq)).toEqual([leaked.seq]);
    const reapplied = (await rlog.getEventsByTypes(["ledger/erased"]))[0];
    expect(reapplied?.payload).toMatchObject({ reapplies: erasureId, eventIds: [leaked.id] });
    restored.close();
  });

  it("refuses when erasures are known to exist and the register is missing", async () => {
    const { backup } = await backupThenErase();
    disk.close();
    rmSync(register);
    const before = readFileSync(disk.path);
    await expect(
      restoreBackup({ backupPath: backup, targetPath: disk.path, registerPath: register }),
    ).rejects.toThrow(RestoreRefused);
    await expect(
      restoreBackup({ backupPath: backup, targetPath: disk.path, registerPath: register }),
    ).rejects.toThrow(/erasure register .* is missing/);
    expect(readFileSync(disk.path).equals(before)).toBe(true);
  });
});

describe("K-N7-9: applyErasures is idempotent", () => {
  it("re-applies once and leaves the ledger identical on the second run", async () => {
    const leaked = await log.append({
      actor: "human",
      type: "card/note",
      payload: {},
      private: { text: SECRET },
    });
    const backup = join(disk.dir, "backups", "b.db");
    const { seq } = await log.backup(backup);
    const erasure = await log.erase({ eventIds: [leaked.id], reason: "secret", principal: owner });
    const entries = readErasureRegister(register) ?? [];
    expect(entries).toHaveLength(1);

    const copy = new DatabaseSync(backup);
    const clog = new EventLog(copy);
    const first = await applyErasures(clog, entries, seq);
    expect(first.reapplied.map((e) => e.erasureId)).toEqual([
      (await log.getEventsByTypes(["ledger/erased"]))[0]?.id,
    ]);
    expect(first.reapplied[0]?.seq).toBe(erasure.erasedBySeq);
    const snapshot = JSON.stringify(copy.prepare("SELECT * FROM events ORDER BY seq").all());
    const privateRows = JSON.stringify(copy.prepare("SELECT * FROM event_private").all());
    const second = await applyErasures(clog, entries, seq);
    expect(second.reapplied).toEqual([]);
    expect(second.alreadyApplied).toEqual([entries[0]?.erasureId]);
    expect(JSON.stringify(copy.prepare("SELECT * FROM events ORDER BY seq").all())).toBe(snapshot);
    expect(JSON.stringify(copy.prepare("SELECT * FROM event_private").all())).toBe(privateRows);
    copy.close();
  });
});

describe("RUN-42, RUN-43: the NDJSON ledger export", () => {
  it("carries seq, hash, prevHash, commitment and CloudEvents attributes; its verifier matches the ledger", async () => {
    await log.append({ actor: "system", type: "x", payload: { n: 1 }, private: { t: SECRET } });
    const e = await log.append({ actor: "human", type: "y", payload: {}, private: { t: "gone" } });
    await log.erase({ eventIds: [e.id], reason: "erasure", principal: owner });
    const text = exportLedger(db, { includePrivate: true });
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(count(db));
    expect(lines[0]).toMatchObject({
      specversion: "1.0",
      source: "sekhemet/ledger",
      seq: 1,
      type: "person/created",
    });
    for (const l of lines) {
      expect(l).toHaveProperty("hash");
      expect(l).toHaveProperty("prevhash");
      expect(l).toHaveProperty("time");
      expect(l).toHaveProperty("id");
    }
    expect(lines.find((l) => l.seq === 2)?.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLedgerExport(text)).toMatchObject({ valid: true, totalEvents: count(db) });
    expect(text).toContain(SECRET);
  });

  it("reaches the ledger's verdict on a tampered ledger", async () => {
    await log.append({ actor: "system", type: "x", payload: { n: 1 } });
    await log.append({ actor: "system", type: "x", payload: { n: 2 } });
    db.exec("DROP TRIGGER events_no_update");
    db.exec(`UPDATE events SET payload = '{"n":9}' WHERE seq = 3`);
    const ledger = await new EventLog(db).verifyHashChain({ full: true });
    const exported = verifyLedgerExport(exportLedger(db, { includePrivate: true }));
    expect(ledger).toMatchObject({ valid: false, corruptedSeq: 3 });
    expect(exported).toMatchObject({ valid: false, corruptedSeq: 3 });
  });

  it("omits every private part with --no-private, and the exported chain still verifies", async () => {
    await log.append({ actor: "system", type: "x", payload: {}, private: { t: SECRET } });
    const text = exportLedger(db, { includePrivate: false });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toMatch(/"private"/);
    expect(verifyLedgerExport(text)).toMatchObject({ valid: true, totalEvents: count(db) });
  });
});
