import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { initSchema } from "../src/schema.js";

describe("@sekhemet/kernel CardStore", () => {
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
  });

  it("creates a card, writes an event to the log, and projects into the cards table", async () => {
    const card = await store.createCard({
      id: "card_8f21",
      tier: "task",
      title: "Implement Seatbelt sandbox profile",
      scopeFiles: ["packages/sandbox/src/seatbelt.ts"],
      stepBudget: 25,
    });

    expect(card.id).toBe("card_8f21");
    expect(card.status).toBe("ready");
    expect(card.tier).toBe("task");
    expect(card.scopeFiles).toEqual(["packages/sandbox/src/seatbelt.ts"]);
    expect(card.stepBudget).toBe(25);

    // Verify card is retrievable
    const fetched = await store.getCard("card_8f21");
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe("Implement Seatbelt sandbox profile");

    // Verify an event was appended to the log
    const lastEvent = await log.getLastEvent();
    expect(lastEvent?.type).toBe("card/created");
    expect((lastEvent?.payload as Record<string, unknown>).id).toBe("card_8f21");
  });

  it("transitions card status and records state change event", async () => {
    await store.createCard({
      id: "card_1234",
      tier: "task",
      title: "Test Task",
      scopeFiles: ["index.ts"],
    });

    const updated = await store.updateCardStatus("card_1234", "in_progress", "Started turn 1");
    expect(updated.status).toBe("in_progress");

    const fetched = await store.getCard("card_1234");
    expect(fetched?.status).toBe("in_progress");

    const events = await log.getEvents();
    expect(events.length).toBe(2);
    expect(events[1]?.type).toBe("card/status_changed");
  });

  it("records checkpoints and retrieves them in order", async () => {
    await store.createCard({
      id: "card_check",
      tier: "task",
      title: "Checkpoint Test",
      scopeFiles: ["foo.ts"],
    });

    await store.recordCheckpoint({
      cardId: "card_check",
      step: 1,
      gitRef: "refs/sekhemet/checkpoints/card_check/step_1",
      gateStatus: "pass",
      agentModel: "gemini-2.5-pro",
      agentHarness: "antigravity-cli",
      agentRole: "implementer",
      createdAt: new Date().toISOString(),
    });

    await store.recordCheckpoint({
      cardId: "card_check",
      step: 2,
      gitRef: "refs/sekhemet/checkpoints/card_check/step_2",
      gateStatus: "suspended-quota",
      agentModel: "claude-3-7-sonnet-20250219",
      agentHarness: "claude-code",
      agentRole: "lead-driver",
      createdAt: new Date().toISOString(),
    });

    const checkpoints = await store.getCheckpoints("card_check");
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0]?.step).toBe(1);
    expect(checkpoints[0]?.agentModel).toBe("gemini-2.5-pro");
    expect(checkpoints[1]?.step).toBe(2);
    expect(checkpoints[1]?.gateStatus).toBe("suspended-quota");
  });

  it("rebuilds projections from scratch by replaying the hash-chained event log", async () => {
    // 1. Create cards and perform transitions
    await store.createCard({ id: "c1", tier: "epic", title: "Epic 1", scopeFiles: [] });
    await store.createCard({ id: "c2", tier: "task", title: "Task 1", scopeFiles: ["a.ts"] });
    await store.updateCardStatus("c2", "in_progress");
    await store.updateCardStatus("c2", "verify");
    await store.recordCheckpoint({
      cardId: "c2",
      step: 1,
      gitRef: "refs/checkpoints/c2/1",
      gateStatus: "pass",
      agentModel: "gemini-2.5-pro",
      agentHarness: "antigravity-cli",
      agentRole: "implementer",
      createdAt: new Date().toISOString(),
    });

    // 2. Wipe the projected tables
    db.exec("DELETE FROM checkpoints; DELETE FROM cards;");
    expect((await store.listCards()).length).toBe(0);
    expect((await store.getCheckpoints("c2")).length).toBe(0);

    // 3. Rebuild from immutable event log
    const stats = await store.rebuildProjections();
    expect(stats.cardsCount).toBe(2);
    expect(stats.checkpointsCount).toBe(1);

    // 4. Verify rebuilt state
    const c2 = await store.getCard("c2");
    expect(c2?.status).toBe("verify");
    const cp = await store.getCheckpoints("c2");
    expect(cp.length).toBe(1);
    expect(cp[0]?.gitRef).toBe("refs/checkpoints/c2/1");
  });
});
