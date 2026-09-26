import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// planner-pm PM-N9-1 and teams TEAM-18, TEAM-19: Seshat's suggestions on an
// issue — proposed with a private reason, applied or dismissed by a person,
// and a dismissed change never proposed again on that issue. Real SQLite.

describe("suggestions (PM-N9-1, TEAM-18, TEAM-19)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-suggestions-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "Issue" });
  });
  afterEach(() => disk.dispose());

  it("proposes with a private reason, applies and dismisses with the principal", async () => {
    const s = store.suggestions;
    const id = await s.propose({
      cardId: "c",
      kind: "priority",
      value: 2,
      why: "Blocks two issues",
    });
    expect(id).toMatch(/^sug_/);
    const [proposed] = await log.getEventsByTypes(["suggestion/proposed"]);
    expect(proposed?.payload).toEqual({ id, cardId: "c", kind: "priority", value: 2 });
    expect(proposed?.private).toEqual({ why: "Blocks two issues" });
    expect(await s.open("c")).toEqual([
      { id, cardId: "c", kind: "priority", value: 2, why: "Blocks two issues" },
    ]);

    await expect(s.apply(id as string, "")).rejects.toThrow(/principal/);
    await s.apply(id as string, "p_admin", { auto: true });
    const [applied] = await log.getEventsByTypes(["suggestion/applied"]);
    expect(applied?.payload).toEqual({ id, auto: true });
    expect(applied?.principal).toBe("p_admin");
    expect(await s.open("c")).toEqual([]);
    await expect(s.dismiss(id as string, "p_admin")).rejects.toThrow(/applied/);

    // TEAM-18: the assignee is never auto-applied.
    const assign = await s.propose({
      cardId: "c",
      kind: "assignee",
      value: "p_bob",
      why: "Knows it",
    });
    await expect(s.apply(assign as string, "p_admin", { auto: true })).rejects.toThrow(/assignee/);
    await expect(
      s.propose({ cardId: "c", kind: "health" as never, value: "red", why: "x" }),
    ).rejects.toThrow(/kind/);
  });

  it("TEAM-19: a dismissed change is not proposed again on that issue", async () => {
    const s = store.suggestions;
    const id = await s.propose({ cardId: "c", kind: "label", value: "bug", why: "A crash" });
    await s.dismiss(id as string, "p_owner");
    expect(await s.propose({ cardId: "c", kind: "label", value: "bug", why: "Again" })).toBeNull();
    // A different value is still proposed.
    expect(await s.propose({ cardId: "c", kind: "label", value: "ui", why: "A screen" })).toMatch(
      /^sug_/,
    );
    expect(s.wasDismissed("c", "label", "bug")).toBe(true);
    expect(s.wasDismissed("c", "label", "ui")).toBe(false);
  });

  it("a planner's hold and a re-plan's removal are kinds of their own, never auto-applied", async () => {
    const s = store.suggestions;
    const hold = await s.propose({
      cardId: "c",
      kind: "hold",
      value: "held until decision dec_1 is answered",
      why: "Scope drift",
    });
    const remove = await s.propose({
      cardId: "c",
      kind: "remove",
      value: "Removed by the re-plan of epic_1: the Worker failed at rung 3",
      why: "Plan v2 no longer includes it",
    });
    expect(await s.get(hold as string)).toMatchObject({ kind: "hold", state: "open" });
    // TEAM-18: auto-apply covers labels, the duplicate link, priority and a split only.
    await expect(s.apply(hold as string, "p_admin", { auto: true })).rejects.toThrow(/hold/);
    await expect(s.apply(remove as string, "p_admin", { auto: true })).rejects.toThrow(/remove/);
    await s.apply(remove as string, "p_owner");
    expect(await s.get(remove as string)).toMatchObject({ state: "applied" });
    expect(await s.get("sug_none")).toBeUndefined();
  });
});
