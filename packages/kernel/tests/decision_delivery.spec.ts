import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// planner-pm PM-P2-7: when a decision's answer reaches the card that asked,
// the decision records `deliveredAt`. Real SQLite files; a second connection
// reads what the first recorded.

describe("a decision's delivery (PM-P2-7)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-delivery-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "Asks" });
  });
  afterEach(() => disk.dispose());

  it("records deliveredAt once, only for an answered decision", async () => {
    const d = await store.runs.requestDecision({
      cardId: "c",
      kind: "planner",
      question: "Which store?",
      context: "{}",
      options: ["SQLite", "Postgres"],
    });
    expect(store.runs.getDecision(d.id)?.deliveredAt).toBeUndefined();
    await expect(store.runs.recordDecisionDelivered(d.id)).rejects.toThrow(/answered/);
    await store.runs.answerDecision(d.id, 0, "human", "p_owner");
    const delivered = await store.runs.recordDecisionDelivered(d.id);
    expect(delivered.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [event] = await log.getEventsByTypes(["decision/delivered"]);
    expect(event?.payload).toEqual({ id: d.id, deliveredAt: delivered.deliveredAt });
    expect(event?.cardId).toBe("c");
    // The first delivery stands.
    const again = await store.runs.recordDecisionDelivered(d.id);
    expect(again.deliveredAt).toBe(delivered.deliveredAt);
    expect(await log.getEventsByTypes(["decision/delivered"])).toHaveLength(1);
    expect(store.runs.listDecisions("answered")[0]?.deliveredAt).toBe(delivered.deliveredAt);
    await expect(store.runs.recordDecisionDelivered("dec_none")).rejects.toThrow(/not found/);
  });
});
