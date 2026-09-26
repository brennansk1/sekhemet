import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// gates rules 29 and 6b: what a card declares to its gates — DOM assertions
// and intended overlaps for the visual gate (GT-N4-4, GT-N4-6), a refactor's
// declared surface change (GT-TQ-8), an upgrade's kept tests (GT-TQ-11) — is
// a field of its record: written by its own events, replayed, checked before
// anything is appended, and added to a database on disk by migration 18.

describe("a card's gate checks", () => {
  let disk: DiskDb;
  let store: CardStore;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-gate-checks-");
    store = new CardStore(disk.db, new EventLog(disk.db));
  });
  afterEach(() => disk.dispose());

  it("are stored at creation, changed by an update, and replayed identically", async () => {
    const checks = {
      visualAssertions: [
        { selector: "#title", text: "Board" },
        { selector: "#gone", present: false },
      ],
      allowOverlap: [["#badge", "#title"]] as [string, string][],
    };
    expect(
      (await store.createCard({ id: "c", tier: "task", title: "Board", gateChecks: checks }))
        .gateChecks,
    ).toEqual(checks);
    await store.updateCard("c", { gateChecks: { keptTests: ["tests/a.spec.ts > adds"] } });
    await store.rebuildProjections();
    expect((await store.getCard("c"))?.gateChecks).toEqual({
      keptTests: ["tests/a.spec.ts > adds"],
    });
    await store.updateCard("c", { gateChecks: null });
    expect((await store.getCard("c"))?.gateChecks).toBeUndefined();
  });

  it("refuses a malformed declaration, appending nothing", async () => {
    await store.createCard({ id: "c", tier: "task", title: "T" });
    const before = (await store.cardEvents("c", ["card/created", "card/updated"])).length;
    for (const bad of [
      { visualAssertions: [{ text: "no selector" }] },
      { allowOverlap: [["#one"]] },
      { surfaceChange: "yes" },
      { keptTests: [3] },
      { somethingElse: true },
    ]) {
      await expect(store.updateCard("c", { gateChecks: bad as never })).rejects.toThrow(
        /gateChecks/,
      );
    }
    expect((await store.cardEvents("c", ["card/created", "card/updated"])).length).toBe(before);
  });

  it("a database from before the field gains it by migration 18", () => {
    disk.db.exec("ALTER TABLE cards DROP COLUMN gate_checks");
    disk.db.exec("PRAGMA user_version = 17");
    initSchema(disk.db);
    const cols = (disk.db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("gate_checks");
    expect(
      (disk.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });
});
