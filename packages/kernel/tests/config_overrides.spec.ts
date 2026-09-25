import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// surface NEW-surface-3 (SUR-40): a card's configuration overrides are a
// field of its record — written by its own events, replayed, and added to a
// database already on disk by a numbered migration. Real SQLite files.

describe("NEW-surface-3: a card's configuration overrides", () => {
  let disk: DiskDb;
  let store: CardStore;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-overrides-");
    store = new CardStore(disk.db, new EventLog(disk.db));
  });
  afterEach(() => disk.dispose());

  it("SUR-40: are stored at creation, changed by an update, and replayed identically", async () => {
    const created = await store.createCard({
      id: "c",
      tier: "task",
      title: "Tune the loop",
      configOverrides: { loop: { default_step_budget: 12 } },
    });
    expect(created.configOverrides).toEqual({ loop: { default_step_budget: 12 } });
    expect(
      (await store.createCard({ id: "d", tier: "task", title: "Plain" })).configOverrides,
    ).toBeUndefined();
    await store.updateCard("c", { configOverrides: { models: { executor: "cyber-tiel" } } });
    expect((await store.getCard("c"))?.configOverrides).toEqual({
      models: { executor: "cyber-tiel" },
    });
    await store.updateCard("c", { configOverrides: null });
    expect((await store.getCard("c"))?.configOverrides).toBeUndefined();
    await store.updateCard("c", { configOverrides: { review: { wip: 2 } } });
    await store.rebuildProjections();
    expect((await store.getCard("c"))?.configOverrides).toEqual({ review: { wip: 2 } });
  });

  it("refuses overrides that are not a table of sections, appending nothing", async () => {
    await store.createCard({ id: "c", tier: "task", title: "T" });
    const before = (await store.cardEvents("c", ["card/created", "card/updated"])).length;
    await expect(store.updateCard("c", { configOverrides: { loop: 3 } as never })).rejects.toThrow(
      /configOverrides/,
    );
    expect((await store.cardEvents("c", ["card/created", "card/updated"])).length).toBe(before);
  });

  it("a database from before the field gains it by a numbered migration", () => {
    disk.db.exec("ALTER TABLE cards DROP COLUMN config_overrides");
    disk.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    initSchema(disk.db);
    const cols = (disk.db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("config_overrides");
    expect(
      (disk.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
  });
});
