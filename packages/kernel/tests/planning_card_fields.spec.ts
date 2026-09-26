import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore, cardCriteria } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { SCHEMA_VERSION, initSchema } from "../src/schema.js";
import { CARD_ESTIMATES, nearestCardEstimate } from "../src/types.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// planner-pm B4.3 step 0: the card fields the planner writes — split depth
// (PM-P1-13), the interface its staged test imports (PM-P1-15), criteria with
// stable ids (PM-P1-17), points in {1, 2, 3, 5, 8} (PM-N1-1) and why a card
// waits on another (PM-N8-2). Real SQLite files (DEFINITION_OF_DONE §2A).

describe("the planner's card fields", () => {
  let disk: DiskDb;
  let store: CardStore;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-planning-fields-");
    store = new CardStore(disk.db, new EventLog(disk.db));
  });
  afterEach(() => disk.dispose());

  it("PM-P1-13, PM-P1-15, PM-P1-17: split depth, interface and criterion ids are stored, patched and replayed", async () => {
    const iface = [
      { symbol: "hashEvent", file: "src/hasher.ts", signature: "(e: Event) => string" },
    ];
    const card = await store.createCard({
      id: "c",
      tier: "task",
      title: "Hash events",
      split: "path",
      splitDepth: 2,
      interface: iface,
      acceptanceCriteria: ["Given an event, hashEvent returns 64 hex characters"],
      criterionIds: ["AC-1"],
      estimate: 3,
    });
    expect(card.splitDepth).toBe(2);
    expect(card.interface).toEqual(iface);
    expect(card.criterionIds).toEqual(["AC-1"]);
    expect(cardCriteria(card)).toEqual([
      { id: "AC-1", text: "Given an event, hashEvent returns 64 hex characters" },
    ]);

    await store.updateCard("c", {
      acceptanceCriteria: ["first", "second"],
      criterionIds: ["AC-1", "AC-2"],
      splitDepth: 3,
    });
    await store.rebuildProjections();
    const after = await store.getCard("c");
    expect(after?.criterionIds).toEqual(["AC-1", "AC-2"]);
    // PM-N7-5 (B4.3 review A): a planned card's ids are never cleared, so its
    // criteria can never leave Planning without a person's approval.
    await expect(store.updateCard("c", { criterionIds: null })).rejects.toThrow(/cleared/);
    await expect(
      store.updateCard("c", { acceptanceCriteria: [], criterionIds: [] }),
    ).rejects.toThrow(/cleared/);
    expect(after?.splitDepth).toBe(3);
    expect(after?.interface).toEqual(iface);
    // A card without the fields reads none of them.
    const plain = await store.createCard({ id: "p", tier: "task", title: "Plain" });
    expect(plain.splitDepth).toBeUndefined();
    expect(plain.interface).toBeUndefined();
    expect(plain.criterionIds).toBeUndefined();
    expect(cardCriteria(plain)).toEqual([]);
  });

  it("refuses malformed values before anything is appended", async () => {
    await store.createCard({
      id: "c",
      tier: "task",
      title: "T",
      acceptanceCriteria: ["one"],
      criterionIds: ["AC-1"],
    });
    const count = async () =>
      (await store.cardEvents("c", ["card/created", "card/updated"])).length;
    const before = await count();
    const bad: [object, RegExp][] = [
      [{ splitDepth: 0 }, /splitDepth/],
      [{ splitDepth: 1.5 }, /splitDepth/],
      [{ interface: [{ symbol: "x", file: "" }] }, /interface/],
      [{ estimate: 4 }, /estimate/],
      [{ estimate: 13 }, /estimate/],
      // Criterion ids align one to one with the criteria, unique and tag-safe.
      [{ criterionIds: ["AC-1", "AC-2"] }, /criterionIds/],
      [{ acceptanceCriteria: ["one", "two"] }, /criterionIds/],
      [{ acceptanceCriteria: ["a", "b"], criterionIds: ["AC-1", "AC-1"] }, /criterionIds/],
      [{ criterionIds: ["has space"] }, /criterionIds/],
    ];
    for (const [patch, why] of bad) {
      await expect(store.updateCard("c", patch as never), JSON.stringify(patch)).rejects.toThrow(
        why,
      );
    }
    expect(await count()).toBe(before);
    await expect(
      store.createCard({ id: "d", tier: "task", title: "D", estimate: 6 }),
    ).rejects.toThrow(/estimate/);
    expect(await store.getCard("d")).toBeNull();
    // Clearing the estimate is allowed.
    await store.updateCard("c", { estimate: 5 });
    expect((await store.updateCard("c", { estimate: null })).estimate).toBeUndefined();
  });

  it("PM-N8-2: a dependency records why — declared, named or imported", async () => {
    for (const id of ["a", "b", "c", "d"]) await store.createCard({ id, tier: "task", title: id });
    await store.addDependency("d", "a", "declared", "human");
    await store.addDependency("d", "b", "named");
    await store.addDependency("d", "c", "imported");
    expect(store.getDependencyReasons("d")).toEqual([
      { dependsOnId: "a", source: "declared" },
      { dependsOnId: "b", source: "named" },
      { dependsOnId: "c", source: "imported" },
    ]);
    await expect(store.addDependency("a", "b", "guessed" as never)).rejects.toThrow(/source/);
    await store.rebuildProjections();
    expect(store.getDependencyReasons("d").map((r) => r.source)).toEqual([
      "declared",
      "named",
      "imported",
    ]);
  });

  it("a database from before the fields gains them by migrations 19-21", () => {
    for (const column of ["split_depth", "interface", "criterion_ids"]) {
      disk.db.exec(`ALTER TABLE cards DROP COLUMN ${column}`);
    }
    disk.db.exec("PRAGMA user_version = 18");
    initSchema(disk.db);
    const cols = (disk.db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(["split_depth", "interface", "criterion_ids"]));
    expect(
      (disk.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
  });

  it("PM_CONTRACT §2: nearestCardEstimate maps any import scale onto {1,2,3,5,8}, ties to the larger", async () => {
    expect(nearestCardEstimate(13)).toBe(8);
    expect(nearestCardEstimate(0)).toBe(1);
    expect(nearestCardEstimate(-4)).toBe(1);
    expect(nearestCardEstimate(100)).toBe(8);
    expect(nearestCardEstimate(6.5)).toBe(8);
    for (const v of CARD_ESTIMATES) expect(nearestCardEstimate(v)).toBe(v);
    await expect(
      store.createCard({
        id: "e",
        tier: "task",
        title: "E",
        estimate: nearestCardEstimate(13),
      }),
    ).resolves.toMatchObject({ estimate: 8 });
  });
});
