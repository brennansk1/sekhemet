import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardStore,
  EventLog,
  MigrationRefused,
  SCHEMA_VERSION,
  initSchema,
  ledgerErasures,
} from "../src/index.js";

/**
 * Upgrade tests (FINISH_LINE_PLAN W8; C-18; kernel rule 38, K-N4-1..5): one
 * ledger recorded by the build that first wrote each schema version, from
 * its own commit in a git worktree (`scripts/record_schema_fixtures.mjs`),
 * is opened by this build. Each must load, migrate, verify its chain and
 * replay its projections with no gap and no refusal, keeping every event
 * the old build wrote and every card as the old build saw it; a database
 * newer than this build is still refused (K-N4-2).
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "schemas");
const NAMES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".db"))
  .map((f) => f.slice(0, -3))
  .sort();

interface Recorded {
  schemaVersion: number;
  events: number;
  head: string;
  cards: { id: string; status: string; title: string }[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of a fixture, so the checked-in file is never written. */
function copyOf(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `sek-upgrade-${name}-`));
  dirs.push(dir);
  const path = join(dir, "events.db");
  copyFileSync(join(FIXTURES, `${name}.db`), path);
  return { dir, path };
}

describe("a ledger from each earlier schema loads, migrates, verifies and replays (W8, C-18)", () => {
  it("has one recorded fixture per schema boundary, the previous release's among them", () => {
    expect(NAMES).toEqual(["legacy-pre-migrations", "v15", "v16", "v18", "v21-previous-release"]);
  });

  for (const name of NAMES) {
    it(`${name}: no gap, no refusal, every old event and card kept`, async () => {
      const recorded = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Recorded;
      const { dir, path } = copyOf(name);
      const db = new DatabaseSync(path);
      const report = initSchema(db, { backupDir: join(dir, "backups") });
      // Every migration above the stored version ran, and only those.
      expect(report.applied).toEqual(
        Array.from({ length: SCHEMA_VERSION - recorded.schemaVersion }, (_, i) => i + 1).map(
          (n) => n + recorded.schemaVersion,
        ),
      );
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(SCHEMA_VERSION);
      // A backup was written before migrating (K-N4-5), unless nothing was pending.
      if (report.applied.length) expect(report.backupPath).toMatch(/pre-migration-v\d+-to-v\d+/);
      const log = new EventLog(db);
      // The chain verifies, and every event the old build wrote is still there, its hash unchanged.
      const chain = log.verifyHashChainSync({ full: true });
      expect(chain).toMatchObject({ valid: true });
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
      ).toBeGreaterThanOrEqual(recorded.events);
      expect(db.prepare("SELECT seq FROM events WHERE hash = ?").get(recorded.head)).toBeDefined();
      // No gap: nothing erased, and no event lost its private part.
      expect(ledgerErasures(db).byEvent.size).toBe(0);
      // Replay: the projections rebuilt from the events are identical to the
      // migrated ones, and every card is as the old build left it.
      const store = new CardStore(db, log);
      const replay = await store.verifyProjections();
      expect(replay.mismatched).toEqual([]);
      expect(replay.identical).toBe(true);
      const cards = db
        .prepare("SELECT id, status, title FROM cards ORDER BY id")
        .all()
        .map((c) => ({ ...c }));
      expect(cards).toEqual(recorded.cards);
      // The upgraded ledger takes new events.
      await store.createCard({ id: "card_after_upgrade", tier: "task", title: "After" });
      expect(log.verifyHashChainSync().valid).toBe(true);
      db.close();
    });
  }

  it("K-N4-2: a database newer than this build is still refused, naming both versions", () => {
    const { path } = copyOf("v21-previous-release");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    let err: unknown;
    try {
      initSchema(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationRefused);
    expect(String((err as Error).message)).toContain(
      `schema version ${SCHEMA_VERSION + 1}, newer than this build's version ${SCHEMA_VERSION}`,
    );
    db.close();
  });
});
