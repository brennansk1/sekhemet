import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

describe("@sekhemet/board", () => {
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let board: BoardServiceImpl;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
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
});
