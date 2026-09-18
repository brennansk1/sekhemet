import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";
import { TransitionRefusedError } from "../src/types.js";

describe("@sekhemet/board", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let board: BoardServiceImpl;

  beforeEach(() => {
    // A real WAL file on disk (DEFINITION_OF_DONE §2.A.1), not `:memory:`.
    dir = mkdtempSync(join(tmpdir(), "sekhemet-board-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    // Review WIP limit set to 2 for testing
    board = new BoardServiceImpl(cardStore, {
      review: 2,
      in_progress: 3,
      verify: 3,
      backlog: 100,
      ready: 50,
      done: 1000,
      rejected: 1000,
      parked: 1000,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("transitions cards along valid kanban lifecycle paths", async () => {
    const card = await cardStore.createCard({
      id: "c_flow",
      tier: "task",
      title: "Flow Test",
      status: "ready",
    });

    await board.transitionCard({
      cardId: "c_flow",
      fromStatus: "ready",
      toStatus: "in_progress",
      actor: "executor",
    });

    let current = await cardStore.getCard("c_flow");
    expect(current?.status).toBe("in_progress");

    await board.transitionCard({
      cardId: "c_flow",
      fromStatus: "in_progress",
      toStatus: "verify",
      actor: "executor",
    });

    current = await cardStore.getCard("c_flow");
    expect(current?.status).toBe("verify");
  });

  it("enforces Review WIP limits and applies backpressure", async () => {
    // Fill up review column to limit (2 cards)
    const c1 = await cardStore.createCard({
      id: "c1",
      tier: "task",
      title: "C1",
      status: "review",
    });
    const c2 = await cardStore.createCard({
      id: "c2",
      tier: "task",
      title: "C2",
      status: "review",
    });
    const c3 = await cardStore.createCard({
      id: "c3",
      tier: "task",
      title: "C3",
      status: "verify",
    });

    const state = await board.getBoardState();
    expect(state.wipLimits.review).toBe(2);

    const wipStatus = await board.checkWipLimits();
    const reviewWip = wipStatus.find((w) => w.column === "review");
    expect(reviewWip?.currentCount).toBe(2);
    expect(reviewWip?.isExceeded).toBe(false);
    // At the limit the column is full: the next transition in is refused, so
    // capacity must report true even though nothing has exceeded the limit.
    expect(reviewWip?.isAtCapacity).toBe(true);

    // Attempt to transition 3rd card into review should throw or activate backpressure!
    await expect(
      board.transitionCard({
        cardId: "c3",
        fromStatus: "verify",
        toStatus: "review",
        actor: "executor",
      }),
    ).rejects.toThrow(/WIP limit exceeded/);

    const updatedState = await board.getBoardState();
    expect(updatedState.backpressureActive).toBe(true);
  });

  it("records the transition's actor in the ledger, not a fixed executor", async () => {
    await cardStore.createCard({ id: "c_who", tier: "task", title: "Who", status: "ready" });
    await board.transitionCard({
      cardId: "c_who",
      fromStatus: "ready",
      toStatus: "parked",
      actor: "human",
      reason: "parked: not now",
    });
    const last = await log.getLastEvent();
    expect(last?.type).toBe("card/status_changed");
    expect(last?.actor).toBe("human");
  });

  it("refuses entry to Verify under back-pressure with a typed, recognisable error", async () => {
    await cardStore.createCard({ id: "r1", tier: "task", title: "R1", status: "review" });
    await cardStore.createCard({ id: "r2", tier: "task", title: "R2", status: "review" });
    await cardStore.createCard({ id: "w", tier: "task", title: "W", status: "in_progress" });

    const refusal = await board
      .transitionCard({
        cardId: "w",
        fromStatus: "in_progress",
        toStatus: "verify",
        actor: "executor",
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(refusal).toBeInstanceOf(TransitionRefusedError);
    expect(refusal).toMatchObject({ code: "back_pressure", cardId: "w", toStatus: "verify" });
    expect((refusal as Error).message).toMatch(/^Back-pressure: Review is at capacity \(2\/2\)/);
    expect((await cardStore.getCard("w"))?.status).toBe("in_progress");
  });

  it("types illegal edges and missing cards distinctly from back-pressure", async () => {
    await cardStore.createCard({ id: "b", tier: "task", title: "B", status: "backlog" });
    await expect(
      board.transitionCard({ cardId: "b", fromStatus: "backlog", toStatus: "done", actor: "x" }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(
      board.transitionCard({
        cardId: "nope",
        fromStatus: "ready",
        toStatus: "in_progress",
        actor: "x",
      }),
    ).rejects.toMatchObject({ code: "card_not_found", message: "Card not found: nope" });
  });

  it("holds a refused card with a reason, lists it, and releases it once Review drains", async () => {
    await cardStore.createCard({ id: "r1", tier: "task", title: "R1", status: "review" });
    await cardStore.createCard({ id: "r2", tier: "task", title: "R2", status: "review" });
    await cardStore.createCard({ id: "w", tier: "task", title: "W", status: "in_progress" });

    await board.holdCard("w", "Review is full; verify deferred");
    const held = await cardStore.getCard("w");
    expect(held?.status).toBe("in_progress");
    expect(held?.blockedReason).toBe("held: Review is full; verify deferred");
    expect((await board.listHeld()).map((c) => c.id)).toEqual(["w"]);

    // Still full: the release is refused and the hold stays.
    expect(await board.releaseHeld("w", "verify")).toBe(false);
    expect((await cardStore.getCard("w"))?.blockedReason).toBe(
      "held: Review is full; verify deferred",
    );

    await board.transitionCard({
      cardId: "r1",
      fromStatus: "review",
      toStatus: "done",
      actor: "human",
    });
    expect(await board.releaseHeld("w", "verify")).toBe(true);
    const released = await cardStore.getCard("w");
    expect(released?.status).toBe("verify");
    expect(released?.blockedReason).toBeUndefined();
    expect(await board.listHeld()).toEqual([]);
  });

  it("rejects an empty hold reason and a hold on a missing card; ignores unheld releases", async () => {
    await cardStore.createCard({ id: "w", tier: "task", title: "W", status: "in_progress" });
    await expect(board.holdCard("w", "  ")).rejects.toThrow("needs a reason");
    await expect(board.holdCard("ghost", "x")).rejects.toMatchObject({ code: "card_not_found" });
    expect(await board.releaseHeld("w", "verify")).toBe(false);
    expect((await cardStore.getCard("w"))?.status).toBe("in_progress");
  });

  it("keeps the board on disk: a second connection sees the same columns", async () => {
    await cardStore.createCard({ id: "p", tier: "task", title: "P", status: "ready" });
    await board.transitionCard({
      cardId: "p",
      fromStatus: "ready",
      toStatus: "in_progress",
      actor: "executor",
    });
    const other = new DatabaseSync(join(dir, "events.db"));
    try {
      const row = other.prepare("SELECT status FROM cards WHERE id = 'p'").get() as {
        status: string;
      };
      expect(row.status).toBe("in_progress");
    } finally {
      other.close();
    }
  });
});
