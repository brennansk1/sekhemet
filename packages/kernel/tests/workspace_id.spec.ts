import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { restoreBackup } from "../src/ledger_backup.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 38a, NEW-kernel-12 K-N12-1 (C2a's part): a server opening a
// ledger written before DEC-57 adopts it without appending or rewriting
// anything, and derives the workspace's id from its first event's hash, so
// the id is the same after a backup and a restore. The ledger here is
// written by today's kernel, whose ledger code is unchanged since 80dca8b
// (`git log 80dca8b..HEAD -- packages/kernel` is empty). Real SQLite files.

let disk: DiskDb;
let db: DatabaseSync;

beforeEach(() => {
  disk = openDiskDb("kernel-wsid-");
  db = disk.db;
});
afterEach(() => disk.dispose());

const head = (d: DatabaseSync) =>
  d.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as {
    seq: number;
    hash: string;
  };

describe("the workspace id (K-N12-1)", () => {
  it("is ws_ and 12 hex of the first event's hash, and reading it appends nothing", async () => {
    const log = new EventLog(db);
    expect(log.workspaceId()).toBeUndefined();
    const cards = new CardStore(db, log);
    const p1 = await cards.ensureProject({ name: "Chronicle", rootPath: join(disk.dir, "a") });
    const p2 = await cards.ensureProject({ name: "Storefront", rootPath: join(disk.dir, "b") });
    await cards.createCard({ tier: "task", title: "One", status: "ready", projectId: p1.id });
    const first = db.prepare("SELECT hash FROM events ORDER BY seq ASC LIMIT 1").get() as {
      hash: string;
    };
    const before = head(db);
    const id = log.workspaceId();
    expect(id).toMatch(/^ws_[0-9a-f]{12}$/);
    expect(id).toBe(`ws_${first.hash.replace(/[^0-9a-f]/g, "").slice(0, 12)}`);
    // A second server opening the same ledger: the same id, the same head, the same projects.
    const again = new EventLog(db);
    expect(again.workspaceId()).toBe(id);
    expect(head(db)).toEqual(before);
    expect(
      new CardStore(db, again)
        .listProjects()
        .map((p) => [p.id, p.rootPath])
        .sort(),
    ).toEqual(
      [
        [p1.id, p1.rootPath],
        [p2.id, p2.rootPath],
      ].sort(),
    );
  });

  it("is the same after a backup and a restore", async () => {
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    await cards.ensureProject({ name: "Chronicle", rootPath: join(disk.dir, "a") });
    const id = log.workspaceId();
    const backup = join(disk.dir, "backup.db");
    await log.backup(backup);
    const target = join(disk.dir, "restored.db");
    await restoreBackup({
      backupPath: backup,
      targetPath: target,
      registerPath: join(disk.dir, "register.ndjson"),
    });
    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      expect(new EventLog(restored).workspaceId()).toBe(id);
    } finally {
      restored.close();
    }
  });
});
