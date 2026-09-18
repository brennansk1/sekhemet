import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { initSchema } from "../src/schema.js";

describe("@sekhemet/kernel team practice fields", () => {
  let db: DatabaseSync;
  let store: CardStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });

  it("stores priority, estimate, labels, epic, cycle, assignee and due date", async () => {
    const card = await store.createCard({
      tier: "task",
      title: "Ledger",
      priority: 2,
      estimate: 3,
      labels: ["storage", "p-risk"],
      epicId: "card_epic",
      cycleId: "cycle_1",
      assignee: "worker",
      dueDate: "2026-09-25",
    });
    expect(card).toMatchObject({
      priority: 2,
      estimate: 3,
      labels: ["storage", "p-risk"],
      epicId: "card_epic",
      cycleId: "cycle_1",
      assignee: "worker",
      dueDate: "2026-09-25",
    });
  });

  it("updates and clears them, and a replay of the ledger reproduces the board", async () => {
    const card = await store.createCard({ tier: "task", title: "Api", estimate: 5 });
    expect(card.labels).toEqual([]);
    await store.updateCard(card.id, { estimate: null, cycleId: "cycle_2", labels: ["api"] });
    const updated = await store.getCard(card.id);
    expect(updated?.estimate).toBeUndefined();
    expect(updated?.cycleId).toBe("cycle_2");
    expect(updated?.labels).toEqual(["api"]);

    await store.rebuildProjections();
    expect(await store.getCard(card.id)).toEqual(updated);
  });
});
