import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

/**
 * dashboard DB-P3-9: the In review limit is shown with its derivation, so the
 * board service says how it reached the limit — the review minutes a day, the
 * median minutes a person's review took (the prior before the first) and over
 * how many reviews — or that a person fixed it. Real SQLite files (DoD §2A).
 */
describe("the In review limit's derivation (DB-P3-9)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-limit-facts-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const reviewed = async (id: string, minutes: number) => {
    await store.createCard({ id, tier: "task", title: id });
    await store.updateCardStatus(id, "review", "setup", "harness", { override: true });
    await store.recordEvent({
      type: "review/decided",
      cardId: id,
      actor: "human",
      principal: "p_reviewer",
      payload: {
        id,
        principal: "p_reviewer",
        decision: "send_back",
        linesReviewed: 40,
        minutes,
        acknowledgedFindings: [],
      },
    });
  };

  it("names the prior before any review, then the median of the reviews recorded", async () => {
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    expect(await board.reviewLimitFacts()).toEqual({
      limit: 4,
      fixed: false,
      minutesPerDay: 60,
      minutesPerCard: 15,
      reviews: 0,
    });
    for (const [id, m] of [
      ["a", 10],
      ["b", 30],
      ["c", 20],
    ] as const)
      await reviewed(id, m);
    expect(await board.reviewLimitFacts()).toEqual({
      limit: 3,
      fixed: false,
      minutesPerDay: 60,
      minutesPerCard: 20,
      reviews: 3,
    });
    // The facts and the limit the board enforces are one computation.
    expect((await board.getBoardState()).wipLimits.review).toBe(3);
  });

  it("says a person fixed the limit with [review] wip", async () => {
    const board = new BoardServiceImpl(store, { customLimits: { review: 2 } });
    expect(await board.reviewLimitFacts()).toEqual({ limit: 2, fixed: true });
  });
});
