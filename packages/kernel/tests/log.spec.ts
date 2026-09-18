import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

describe("@sekhemet/kernel EventLog", () => {
  let disk: DiskDb;
  let db: DatabaseSync;
  let log: EventLog;

  beforeEach(() => {
    disk = openDiskDb();
    db = disk.db;
    log = new EventLog(db);
  });

  afterEach(() => disk.dispose());

  it("appends events with strictly monotonic sequence and valid SHA-256 hash chain", async () => {
    const e1 = await log.append({
      actor: "system",
      type: "project/init",
      payload: { name: "Sekhemet" },
    });
    const e2 = await log.append({
      actor: "planner",
      type: "card/create",
      payload: { title: "Spike Reliability Arm", tier: "task" },
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.prevHash).toBe("0000000000000000000000000000000000000000000000000000000000000000");

    const verification = await log.verifyHashChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEvents).toBe(2);
  });

  it("detects tampering when an event payload in the hash chain is modified", async () => {
    await log.append({ actor: "human", type: "msg/1", payload: { text: "hello" } });
    await log.append({ actor: "human", type: "msg/2", payload: { text: "world" } });
    await log.append({ actor: "human", type: "msg/3", payload: { text: "end" } });

    // Directly tamper with seq 2 payload behind the event log's back
    db.prepare("UPDATE events SET payload = ? WHERE seq = 2").run(
      JSON.stringify({ text: "tampered" }),
    );

    const verification = await log.verifyHashChain();
    expect(verification.valid).toBe(false);
    expect(verification.corruptedSeq).toBe(2);
    expect(verification.reason).toContain("Hash mismatch at seq 2");
  });

  it("retrieves events chronologically", async () => {
    await log.append({ actor: "executor", type: "step/1", payload: { step: 1 } });
    await log.append({ actor: "executor", type: "step/2", payload: { step: 2 } });

    const events = await log.getEvents();
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("step/1");
    expect(events[1]?.type).toBe("step/2");

    const last = await log.getLastEvent();
    expect(last?.type).toBe("step/2");
  });

  it("runs on a real WAL database file, and the chain survives a reopen", async () => {
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    await log.append({ actor: "executor", type: "step/1", payload: { step: 1 } });
    await log.append({ actor: "executor", type: "step/2", payload: { step: 2 } });
    disk.close();

    const reopened = new DatabaseSync(disk.path);
    try {
      const again = new EventLog(reopened);
      const events = await again.getEvents();
      expect(events.map((e) => [e.seq, e.type])).toEqual([
        [1, "step/1"],
        [2, "step/2"],
      ]);
      expect(await again.verifyHashChain()).toEqual({ valid: true, totalEvents: 2 });
    } finally {
      reopened.close();
    }
  });

  it("detects a single flipped bit in a payload byte on disk, naming the exact seq", async () => {
    await log.append({ actor: "human", type: "msg/1", payload: { text: "alpha" } });
    await log.append({ actor: "human", type: "msg/2", payload: { text: "bravo-target" } });
    await log.append({ actor: "human", type: "msg/3", payload: { text: "charlie" } });
    // Move every page out of the WAL into the main file, then close.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    disk.close();

    const bytes = readFileSync(disk.path);
    const needle = Buffer.from('"bravo-target"');
    const at = bytes.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    // Exactly one occurrence, so the flip lands in seq 2's payload and nowhere else.
    expect(bytes.indexOf(needle, at + 1)).toBe(-1);
    const target = at + 3; // the "a" in "bravo"
    bytes[target] = (bytes[target] as number) ^ 0x01;
    writeFileSync(disk.path, bytes);

    const reopened = new DatabaseSync(disk.path);
    try {
      const verification = await new EventLog(reopened).verifyHashChain();
      expect(verification.valid).toBe(false);
      expect(verification.corruptedSeq).toBe(2);
      expect(verification.reason).toContain("Hash mismatch at seq 2");
    } finally {
      reopened.close();
    }
  });

  it("detects a flipped bit in a stored hash on disk", async () => {
    await log.append({ actor: "human", type: "msg/1", payload: { n: 1 } });
    const second = await log.append({ actor: "human", type: "msg/2", payload: { n: 2 } });
    await log.append({ actor: "human", type: "msg/3", payload: { n: 3 } });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    disk.close();

    const bytes = readFileSync(disk.path);
    // The hash is stored as hex text, as seq 2's hash and seq 3's prev_hash
    // (and possibly in an index). Flip one bit in every copy on disk.
    const needle = Buffer.from(second.hash);
    let flipped = 0;
    for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
      bytes[at + 10] = (bytes[at + 10] as number) ^ 0x01;
      flipped++;
    }
    expect(flipped).toBeGreaterThanOrEqual(2);
    writeFileSync(disk.path, bytes);

    const reopened = new DatabaseSync(disk.path);
    try {
      const verification = await new EventLog(reopened).verifyHashChain();
      expect(verification.valid).toBe(false);
      expect(verification.corruptedSeq).toBe(2);
    } finally {
      reopened.close();
    }
  });
});
