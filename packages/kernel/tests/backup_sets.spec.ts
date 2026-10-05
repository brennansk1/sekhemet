import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/blobs.js";
import { ledgerBlobIds } from "../src/ledger_backup.js";
import { EventLog } from "../src/log.js";
import { MIGRATIONS, MigrationRefused, SCHEMA_VERSION, runMigrations } from "../src/schema.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// runtime.md NEW-runtime-11 / NEW-runtime-18 (RUN-59, RUN-87: a set holds
// the blobs the ledger names that are not erased), item 37 (SPEC-02: the
// export reuses that enumeration) and item 38 (FINDINGS_C1 REL-18: the
// newer-database refusal names the pre-migration backup and `sekhemet
// restore`). Real SQLite files and a real blob store (DEFINITION_OF_DONE §2A).

let disk: DiskDb;
let log: EventLog;
let owner: string;

beforeEach(() => {
  disk = openDiskDb("sekhemet-backup-sets-");
  log = new EventLog(disk.db);
  owner = log.localPrincipal();
  log.ensureLocalPerson({ name: "Ada" });
});
afterEach(() => disk.dispose());

describe("RUN-59: the blobs a backup set holds", () => {
  it("are the blobs the ledger names, in a payload or a private part, held by the store and not erased", async () => {
    const blobs = new BlobStore(disk.dir);
    const named = blobs.put(JSON.stringify({ prompt: "a step's pack" }));
    const privatelyNamed = blobs.put(JSON.stringify({ prompt: "named in a private part" }));
    const unnamed = blobs.put(JSON.stringify({ prompt: "nothing names me" }));
    const erased = blobs.put(JSON.stringify({ prompt: "erased later" }));
    const gone = "f".repeat(64);
    await log.append({ actor: "executor", type: "step/x", payload: { contextPackId: named } });
    await log.append({
      actor: "executor",
      type: "step/x",
      payload: {},
      private: { refs: [privatelyNamed] },
    });
    await log.append({ actor: "executor", type: "step/x", payload: { packs: [erased, gone] } });
    await log.erase({ eventIds: [], blobIds: [erased], blobs, reason: "secret", principal: owner });
    expect(existsSync(blobs.path(erased))).toBe(false);

    const found = ledgerBlobIds(disk.db, blobs);
    expect(found.held.sort()).toEqual([named, privatelyNamed].sort());
    expect(found.held).not.toContain(unnamed);
    expect(found.held).not.toContain(erased);
    // Named, never erased, but not in the store: reported, so a set can say so.
    expect(found.missing).toEqual([gone]);
  });

  it("leaves out a blob whose bytes no longer hash to its id", async () => {
    const blobs = new BlobStore(disk.dir);
    const id = blobs.put(JSON.stringify({ prompt: "will be damaged" }));
    await log.append({ actor: "executor", type: "step/x", payload: { contextPackId: id } });
    rmSync(blobs.path(id));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blobs.path(id), "damaged");
    expect(ledgerBlobIds(disk.db, blobs)).toEqual({ held: [], missing: [id] });
  });
});

describe("REL-18: a database newer than this build, after a rollback", () => {
  it("is refused naming the backup taken before it was migrated past this build, and `sekhemet restore`", async () => {
    const backups = join(disk.dir, "backups");
    // A newer build migrated this ledger one version further, backing it up first.
    const next = {
      version: SCHEMA_VERSION + 1,
      name: "a newer build's migration",
      up: () => undefined,
    };
    const forward = runMigrations(disk.db, [...MIGRATIONS, next], { backupDir: backups });
    expect(forward.applied).toEqual([SCHEMA_VERSION + 1]);
    const backupPath = forward.backupPath as string;
    expect(existsSync(backupPath)).toBe(true);
    // This build, rolled back to, opens it.
    let refusal: unknown;
    try {
      runMigrations(disk.db, MIGRATIONS, { backupDir: backups });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(MigrationRefused);
    const message = (refusal as Error).message;
    expect(message).toMatch(
      new RegExp(
        `schema version ${SCHEMA_VERSION + 1}, newer than this build's version ${SCHEMA_VERSION}`,
      ),
    );
    expect(message).toContain(`sekhemet restore ${backupPath}`);
    expect(message).toMatch(/events recorded since then are not in it/);
    expect(message).toContain("sekhemet backup --list");
  });

  it("still names `sekhemet backup --list` when no pre-migration backup is there", () => {
    disk.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`);
    expect(() => runMigrations(disk.db, MIGRATIONS, { backupDir: join(disk.dir, "none") })).toThrow(
      /upgrade Sekhemet to open it.*sekhemet backup --list/s,
    );
  });
});
