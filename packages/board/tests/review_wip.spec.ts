import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

/**
 * review-git S6: ReviewWIP from human decisions only (spine 4: the human is
 * the rate limiter). Automated sub-second exits made the live limit 7,708.
 * Real SQLite files (DoD §2A).
 */
describe("ReviewWIP from human decisions (review-git S6)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  const person = "p_reviewer";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-wip-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A card that went through Review, and the decision a person recorded on it. */
  const reviewed = async (id: string, minutes: number, projectId?: string, lines = 40) => {
    await store.createCard({
      id,
      tier: "task",
      title: id,
      ...(projectId ? { projectId } : {}),
    });
    await store.updateCardStatus(id, "review", "setup", "harness", { override: true });
    await store.recordEvent({
      type: "review/decided",
      cardId: id,
      actor: "human",
      principal: person,
      payload: {
        id,
        principal: person,
        decision: "send_back",
        linesReviewed: lines,
        minutes,
        acknowledgedFindings: [],
      },
    });
  };

  /** A harness exit from Review in well under a second (the auto-accept probe). */
  const automatedExit = async (id: string) => {
    await store.createCard({ id, tier: "task", title: id });
    await store.updateCardStatus(id, "review", "setup", "harness", { override: true });
    await store.updateCardStatus(id, "done", "auto", "harness", { override: true });
  };

  it("RG-S6-1: five sub-second harness exits and no human review give the 15-minute prior (60 min/day → 4)", async () => {
    for (const id of ["h1", "h2", "h3", "h4", "h5"]) await automatedExit(id);
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    expect(await board.measuredReviewMinutes()).toEqual([]);
    expect(await board.computeReviewWip()).toBe(4);
    expect((await board.getBoardState()).wipLimits.review).toBe(4);
  });

  it("RG-S6-2: with no review recorded and no review_minutes_per_day, 60 minutes a day and the prior give 4, not 3", async () => {
    const board = new BoardServiceImpl(store);
    expect(await board.computeReviewWip()).toBe(4);
    expect((await board.getBoardState()).wipLimits.review).toBe(4);
  });

  it("RG-S6-3: five human reviews of 20 minutes at 60 minutes a day give 3, whatever automated exits exist", async () => {
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) await reviewed(id, 20);
    for (const id of ["h1", "h2", "h3"]) await automatedExit(id);
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    expect((await board.measuredReviewMinutes()).sort()).toEqual([20, 20, 20, 20, 20]);
    expect(await board.computeReviewWip()).toBe(3);
  });

  it("RG-S6-4: a human decision is counted before the next card is released from Verify", async () => {
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    // Prior: 4. Four cards wait in Review, so Verify is closed.
    for (const id of ["q1", "q2", "q3", "q4"]) {
      await store.createCard({ id, tier: "task", title: id });
      await store.updateCardStatus(id, "review", "setup", "harness", { override: true });
    }
    await store.createCard({ id: "w", tier: "task", title: "W", status: "in_progress" });
    const toVerify = () =>
      board.transitionCard({
        cardId: "w",
        fromStatus: "in_progress",
        toStatus: "verify",
        actor: "executor",
      });
    await expect(toVerify()).rejects.toMatchObject({ code: "back_pressure" });
    // A person's quick decisions: 12-minute reviews give 5; the next move sees it.
    for (const id of ["d1", "d2", "d3"]) await reviewed(id, 12);
    for (const id of ["d1", "d2", "d3"]) {
      await store.updateCardStatus(id, "ready", "sent back", "human", { override: true });
    }
    await toVerify();
    expect((await store.getCard("w"))?.status).toBe("verify");
  });

  it("RG-S6-5: two projects on one server each get ReviewWIP from their own reviews and Review count", async () => {
    const pa = (await store.ensureProject({ name: "A", rootPath: join(dir, "a") })).id;
    const pb = (await store.ensureProject({ name: "B", rootPath: join(dir, "b") })).id;
    // Project A reviews slowly (60 min each: WIP 1); B has no reviews (prior: 4).
    for (const id of ["a1", "a2", "a3"]) await reviewed(id, 60, pa);
    for (const id of ["a1", "a2", "a3"]) {
      await store.updateCardStatus(id, "done", "accepted", "human", { override: true });
    }
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    expect(await board.computeReviewWip(undefined, pa)).toBe(1);
    expect(await board.computeReviewWip(undefined, pb)).toBe(4);
    // One card in A's Review closes A's Verify, not B's.
    await store.createCard({ id: "ar", tier: "task", title: "ar", projectId: pa });
    await store.updateCardStatus("ar", "review", "setup", "harness", { override: true });
    for (const [id, projectId] of [
      ["aw", pa],
      ["bw", pb],
    ] as const) {
      await store.createCard({ id, tier: "task", title: id, projectId, status: "in_progress" });
    }
    await expect(
      board.transitionCard({
        cardId: "aw",
        fromStatus: "in_progress",
        toStatus: "verify",
        actor: "executor",
      }),
    ).rejects.toMatchObject({ code: "back_pressure" });
    await board.transitionCard({
      cardId: "bw",
      fromStatus: "in_progress",
      toStatus: "verify",
      actor: "executor",
    });
    expect((await board.getBoardState({ projectId: pa })).backpressureActive).toBe(true);
    expect((await board.getBoardState({ projectId: pb })).backpressureActive).toBe(false);
  });

  it("RG-S6-7: Worker- and person-built cards count alike; decisions over 500 lines an hour are reported, not refused", async () => {
    await reviewed("fast", 6, undefined, 120); // 1,200 lines an hour
    await reviewed("slow", 30, undefined, 100); // 200 lines an hour
    await store.delegateCard("slow", { kind: "person", id: "p_builder" }, person);
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 60 });
    expect((await board.measuredReviewMinutes()).sort((a, b) => a - b)).toEqual([6, 30]);
    const rate = await board.reviewRate();
    expect(rate.decisions).toBe(2);
    expect(rate.fast).toEqual([{ cardId: "fast", linesPerHour: 1200 }]);
  });

  it("RG-S6-8: review minutes of 0 or less are refused naming the key, never falling back to 3", async () => {
    const pz = (await store.ensureProject({ name: "Z", rootPath: join(dir, "z") })).id;
    await expect(store.setProjectReviewMinutes(pz, 0)).rejects.toThrow(/review_minutes_per_day/);
    const board = new BoardServiceImpl(store, { reviewMinutesPerDay: 0 });
    await expect(board.computeReviewWip()).rejects.toThrow(/review_minutes_per_day/);
    await expect(board.computeReviewWip(-5)).rejects.toThrow(/review_minutes_per_day/);
  });

  it("keeps a limit a person fixed with [review] wip", async () => {
    for (const id of ["r1", "r2"]) await reviewed(id, 5);
    const board = new BoardServiceImpl(store, { customLimits: { review: 2 } });
    expect((await board.getBoardState()).wipLimits.review).toBe(2);
    expect(await board.computeReviewWip()).toBe(2);
  });
});
