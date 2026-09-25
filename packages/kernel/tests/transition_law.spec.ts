import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { CARD_STATUSES, LEGAL_TRANSITIONS, StatusTransitionError } from "../src/transitions.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 26, S4 and S7: the transition law is a compare-and-set in
// the kernel, checked against the stored status, and nothing reaches the
// ledger that the projection would refuse. Real SQLite files (DoD §2A).

describe("the transition law in the kernel (S4)", () => {
  let disk: DiskDb;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(() => {
    disk = openDiskDb("sekhemet-law-");
    db = disk.db;
    log = new EventLog(db);
    store = new CardStore(db, log);
  });
  afterEach(() => disk.dispose());

  const count = async () => (await log.getEvents(1, 1_000_000)).length;

  it("K-S4-1: refuses a stale `from`, naming it, and appends nothing", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", status: "backlog" });
    const before = await count();
    const err = await store
      .updateCardStatus("c", "done", "sneak", "human", { expectedFrom: "done" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatusTransitionError);
    expect(err).toMatchObject({ code: "stale_from", cardId: "c", toStatus: "done" });
    expect((err as Error).message).toMatch(/stored status is 'backlog', not 'done'/);
    expect(await count()).toBe(before);
    expect((await store.getCard("c"))?.status).toBe("backlog");
  });

  it("K-S4-1: refuses an illegal edge from the stored status, whatever the caller believes", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", status: "backlog" });
    const before = await count();
    await expect(store.updateCardStatus("c", "done", "skip ahead")).rejects.toMatchObject({
      code: "illegal_transition",
    });
    expect(await count()).toBe(before);
    // A legal edge from the stored status goes through.
    await store.updateCardStatus("c", "ready", "criteria written", "human", {
      expectedFrom: "backlog",
    });
    expect((await store.getCard("c"))?.status).toBe("ready");
  });

  it("K-S4-2: a move to the state the card is in appends nothing and returns it unchanged", async () => {
    const created = await store.createCard({ id: "c", tier: "task", title: "C" });
    const before = await count();
    const same = await store.updateCardStatus("c", "ready", "again", "human");
    expect(same).toEqual(created);
    expect(await count()).toBe(before);
  });

  it("K-S4-8: two concurrent moves from the same stored status — exactly one succeeds, the other is stale_from", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", acceptanceCriteria: ["x"] });
    const before = await count();
    const results = await Promise.allSettled([
      store.updateCardStatus("c", "in_progress", "start", "executor", { expectedFrom: "ready" }),
      store.updateCardStatus("c", "backlog", "later", "human", { expectedFrom: "ready" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "stale_from" });
    expect(await count()).toBe(before + 1);
    expect((await store.getCard("c"))?.status).toBe("in_progress");
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("K-N6-3: the accepter clears when a card leaves Done, live and on replay", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C", status: "backlog" });
    await store.updateCardStatus("c", "done", "override: by hand", "human", {
      override: true,
      principal: "p_owner",
    });
    expect((await store.getCard("c"))?.accepter).toBe("p_owner");
    await store.updateCardStatus("c", "ready", "reopened", "human", { principal: "p_owner" });
    expect((await store.getCard("c"))?.accepter).toBeUndefined();
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("K-S4-9: a card is created in backlog, ready, planning or in_progress, never past an entry condition", async () => {
    for (const status of ["backlog", "ready", "planning", "in_progress"] as const) {
      await store.createCard({ id: `ok_${status}`, tier: "task", title: status, status });
    }
    // Parked, only with its recorded reason.
    await store.createCard({
      id: "ok_parked",
      tier: "task",
      title: "parked",
      status: "parked",
      blockedReason: "Capability ceiling: split it",
    });
    const before = await count();
    for (const status of ["verify", "review", "done", "parked", "rejected"] as const) {
      await expect(
        store.createCard({ id: `no_${status}`, tier: "task", title: status, status }),
      ).rejects.toThrow(new RegExp(`cannot be created in '${status}'`));
    }
    expect(await count()).toBe(before);
  });

  it("carries the table the spec states, over the nine stored states", () => {
    expect([...CARD_STATUSES].sort()).toEqual([
      "backlog",
      "done",
      "in_progress",
      "parked",
      "planning",
      "ready",
      "rejected",
      "review",
      "verify",
    ]);
    expect(LEGAL_TRANSITIONS.done).toEqual(["ready"]);
    expect(LEGAL_TRANSITIONS.parked).toEqual(["ready", "planning", "backlog", "rejected"]);
    for (const s of CARD_STATUSES) expect(LEGAL_TRANSITIONS[s]).not.toContain(s);
  });
});

describe("one validated write per event (S7)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;

  beforeEach(() => {
    disk = openDiskDb("sekhemet-s7-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
  });
  afterEach(() => disk.dispose());

  const count = async () => (await log.getEvents(1, 1_000_000)).length;

  it("K-S7-1: refuses a card with difficulty 11 before appending; projections stay identical", async () => {
    await store.createCard({ id: "ok", tier: "task", title: "OK", difficulty: 5 });
    const before = await count();
    await expect(
      store.createCard({ id: "bad", tier: "task", title: "Bad", difficulty: 11 }),
    ).rejects.toThrow(/difficulty must be an integer from 1 to 10, got 11/);
    await expect(
      store.createCard({ id: "bad2", tier: "task", title: "Bad", difficulty: 0 }),
    ).rejects.toThrow(/difficulty/);
    await expect(store.updateCard("ok", { difficulty: 2.5 })).rejects.toThrow(/difficulty/);
    expect(await count()).toBe(before);
    expect(await store.getCard("bad")).toBeNull();
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("K-S7-2: refuses a status outside the nine, at creation or on a move, and replay still succeeds", async () => {
    await store.createCard({ id: "c", tier: "task", title: "C" });
    const before = await count();
    await expect(store.updateCardStatus("c", "shipped" as never)).rejects.toMatchObject({
      code: "invalid_status",
    });
    await expect(
      store.createCard({ id: "d", tier: "task", title: "D", status: "doing" as never }),
    ).rejects.toThrow(/'doing' is not one of the nine card states/);
    expect(await count()).toBe(before);
    await expect(store.rebuildProjections()).resolves.toMatchObject({ cardsCount: 1 });
    expect((await store.verifyProjections()).identical).toBe(true);
  });
});
