import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import type { EventRecord } from "../src/types.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md S7, K-S7-3: the append and its projection are one transaction.
// A projection that throws after validation passed leaves neither the event
// nor the projection change, after the database is reopened. Real SQLite.

describe("the append and the projection in one transaction (K-S7-3)", () => {
  let disk: DiskDb;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-onetx-");
  });
  afterEach(() => disk.dispose());

  it("EventLog.appendNow runs the projection before COMMIT and rolls both back when it throws", () => {
    const log = new EventLog(disk.db);
    disk.db.exec("CREATE TABLE side (v TEXT)");
    const before = disk.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(() =>
      log.appendNow(
        { actor: "system", type: "test/projected", payload: { v: 1 } },
        {
          project: (event: EventRecord) => {
            disk.db.prepare("INSERT INTO side (v) VALUES (?)").run(event.id);
            throw new Error("injected projection fault");
          },
        },
      ),
    ).toThrow(/injected projection fault/);
    disk.close();
    const reopened = new DatabaseSync(disk.path);
    try {
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(
        before.n,
      );
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM side").get() as { n: number }).n).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("a card status write whose projection faults leaves neither the event nor the new status", async () => {
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "A card", acceptanceCriteria: ["x"] });
    const count = (): number =>
      (disk.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const before = count();
    const real = store.applyEvent.bind(store);
    store.applyEvent = (event: EventRecord): boolean => {
      real(event); // the projection writes, then fails
      throw new Error("injected projection fault");
    };
    await expect(store.updateCardStatus("c", "backlog")).rejects.toThrow(/injected/);
    expect(count()).toBe(before);
    disk.close();
    const db = new DatabaseSync(disk.path);
    try {
      const reopenedStore = new CardStore(db, new EventLog(db));
      expect((await reopenedStore.getCard("c"))?.status).toBe("ready");
      expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(
        before,
      );
      expect((await reopenedStore.verifyProjections()).identical).toBe(true);
    } finally {
      db.close();
    }
  });

  const events = (): number =>
    (disk.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

  it("a step checkpoint and a decision's expiry project inside their append's transaction", async () => {
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    await store.createCard({ id: "c", tier: "task", title: "C" });
    const attempt = await store.runs.startAttempt({ cardId: "c", attemptNumber: 1, modelId: "m" });
    const step = await store.runs.recordStep({
      attemptId: attempt.id,
      cardId: "c",
      stepIndex: 1,
      calls: [],
      contextPackId: "pack",
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
    const decision = await store.runs.requestDecision({
      cardId: "c",
      kind: "planner",
      question: "Which?",
      context: "{}",
      options: ["a", "b"],
    });
    const before = events();
    const real = store.runs.applyEvent.bind(store.runs);
    store.runs.applyEvent = (event: EventRecord): boolean => {
      real(event);
      throw new Error("injected projection fault");
    };
    await expect(store.runs.markStepCheckpoint(step.id, "abc123")).rejects.toThrow(/injected/);
    await expect(store.runs.expireDecision(decision.id)).rejects.toThrow(/injected/);
    expect(events()).toBe(before);
    expect(store.runs.getStep(step.id)?.gitRef).toBeUndefined();
    expect(store.runs.getDecision(decision.id)?.status).toBe("pending");
  });

  it("createCard's new person is appended in the card's transaction: a failed projection leaves neither", async () => {
    const log = new EventLog(disk.db);
    const store = new CardStore(disk.db, log);
    (store as unknown as { projectCardCreated: () => void }).projectCardCreated = () => {
      throw new Error("injected projection fault");
    };
    await expect(
      store.createCard({ id: "c", tier: "task", title: "C", assignee: "Carol" }),
    ).rejects.toThrow(/injected/);
    expect(await log.getEventsByTypes(["person/created", "card/created"])).toEqual([]);
  });
});
