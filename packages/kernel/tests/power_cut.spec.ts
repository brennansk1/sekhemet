import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { LEDGER_SYNC_DECISION, initSchema } from "../src/schema.js";

// kernel.md rule 38, NEW-kernel-11 (FINDINGS_C1 REL-16). K-N11-1: the
// synchronous mode every ledger opens with is the one the measurement chose
// (scripts/measure_append_sync.mjs, evidence/append_sync_2026-10-05.json).
// K-N11-2: W8's power-cut fault, done for real — a writer process killed
// with SIGKILL mid-stream, its WAL then cut at random byte offsets (a torn
// last frame included), and each copy reopened (DEFINITION_OF_DONE §2A:
// real SQLite files, a real killed process; nothing mocked).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sekhemet-power-cut-"));
  dirs.push(d);
  return d;
}

const pragma = (db: DatabaseSync, name: string): number =>
  Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0]);

describe("K-N11-1: the synchronous mode is the recorded decision", () => {
  it("opens every ledger with synchronous = FULL, fullfsync and checkpoint_fullfsync on", () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    // The decision as measured: FULL (2), with F_FULLFSYNC on darwin for
    // commits and checkpoints alike (plain fsync does not flush the drive's cache).
    expect(LEDGER_SYNC_DECISION.synchronous).toBe("FULL");
    expect(pragma(db, "synchronous")).toBe(2);
    expect(pragma(db, "fullfsync")).toBe(1);
    expect(pragma(db, "checkpoint_fullfsync")).toBe(1);
    db.close();
    // The decision names its measurement, and the measurement chose it.
    const evidence = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../..", LEDGER_SYNC_DECISION.evidence), "utf8"),
    ) as { adoptFull: boolean; modes: { FULL: { p95Ms: number } } };
    expect(evidence.adoptFull).toBe(true);
    expect(evidence.modes.FULL.p95Ms).toBeLessThanOrEqual(LEDGER_SYNC_DECISION.p95BoundMs);
  });
});

/** A seeded generator, so a failing offset can be replayed from the seed printed with it. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("K-N11-2: a WAL cut at any frame reopens to its last intact event", () => {
  it("verifies the chain to the last intact event and corrupts none, for a killed writer's WAL cut at random offsets", async () => {
    const dir = tempDir();
    const path = join(dir, "events.db");
    // Ten events checkpointed into the database file, as a ledger that ran before.
    {
      const db = new DatabaseSync(path);
      initSchema(db);
      const log = new EventLog(db);
      for (let i = 0; i < 10; i++) {
        await log.append({ actor: "system", type: "before", payload: { i } });
      }
      db.close();
    }
    const dist = resolve(import.meta.dirname, "../dist/index.js");
    const script = join(dir, "writer.mjs");
    writeFileSync(
      script,
      `import { DatabaseSync } from "node:sqlite";
       import { writeFileSync } from "node:fs";
       import { EventLog, initSchema } from ${JSON.stringify(dist)};
       const db = new DatabaseSync(${JSON.stringify(path)});
       initSchema(db);
       // Keep every frame in the WAL, so the cut has frames to land in.
       db.exec("PRAGMA wal_autocheckpoint = 0");
       const log = new EventLog(db);
       const rows = [];
       for (let i = 0; i < 60; i++) {
         const e = await log.append({
           actor: "executor", type: "step/recorded", cardId: "card_p",
           payload: { i, note: "n".repeat(i * 37 % 900) },
           private: { text: "private " + i },
         });
         rows.push([e.seq, e.id, e.hash]);
       }
       writeFileSync(${JSON.stringify(join(dir, "written.json"))}, JSON.stringify(rows));
       process.kill(process.pid, "SIGKILL");`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] });
    const signal = await new Promise<NodeJS.Signals | null>((r) =>
      child.on("exit", (_code, sig) => r(sig)),
    );
    expect(signal).toBe("SIGKILL");
    const written = JSON.parse(readFileSync(join(dir, "written.json"), "utf8")) as [
      number,
      string,
      string,
    ][];
    expect(written).toHaveLength(60);
    const wal = `${path}-wal`;
    expect(existsSync(wal)).toBe(true);
    const walSize = statSync(wal).size;
    expect(walSize).toBeGreaterThan(32);
    const originals = new Map(written.map(([seq, id, hash]) => [seq, { id, hash }]));

    const seed = 0x5eed_c4;
    const next = rng(seed);
    // The header alone, the whole WAL, and random cuts between (torn frames).
    const offsets = [
      32,
      walSize,
      ...Array.from({ length: 14 }, () => 32 + Math.floor(next() * (walSize - 32))),
    ];
    const seen = new Set<number>();
    for (const offset of offsets) {
      const trial = mkdtempSync(join(dir, "trial-"));
      const copy = join(trial, "events.db");
      copyFileSync(path, copy);
      copyFileSync(wal, `${copy}-wal`);
      truncateSync(`${copy}-wal`, offset);
      const db = new DatabaseSync(copy);
      initSchema(db);
      const where = `seed ${seed}, WAL cut at byte ${offset} of ${walSize}`;
      expect(db.prepare("PRAGMA integrity_check").get(), where).toEqual({ integrity_check: "ok" });
      const log = new EventLog(db);
      const chain = log.verifyHashChainSync({ full: true });
      expect(chain.valid, where).toBe(true);
      const last = log.lastSeq();
      seen.add(last);
      expect(last, where).toBeGreaterThanOrEqual(10);
      expect(last, where).toBeLessThanOrEqual(70);
      // Every event that survived is the one the writer committed, byte for byte.
      const rows = db.prepare("SELECT seq, id, hash FROM events WHERE seq > 10").all() as {
        seq: number;
        id: string;
        hash: string;
      }[];
      expect(rows.length, where).toBe(last - 10);
      for (const r of rows) expect({ id: r.id, hash: r.hash }, where).toEqual(originals.get(r.seq));
      // The ledger takes the next append on top of its last intact event.
      const appended = log.appendNow({ actor: "system", type: "after", payload: {} });
      expect(appended.seq).toBe(last + 1);
      expect(log.verifyHashChainSync({ full: true }).valid, where).toBe(true);
      db.close();
    }
    // The whole WAL keeps all 60; the header alone keeps none of them.
    expect(seen.has(70)).toBe(true);
    expect(seen.has(10)).toBe(true);
  });
});
