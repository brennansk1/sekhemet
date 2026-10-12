import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

// Wave 9 A1: a plan stores its epic in Planning (never In progress before
// its plan). A WIP limit counts work items — a parent never runs itself
// (B7) and takes no slot, as the terminal board's counts leave parents out
// (S1B-B16) — so epics waiting in Planning never fill Planning's limit, and
// a parent's rollup is never refused for a full In progress. Real SQLite
// files (DoD §2A).

describe("a parent takes no WIP slot", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let board: BoardServiceImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-parent-wip-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    board = new BoardServiceImpl(store, { customLimits: { planning: 3, in_progress: 2 } });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const epicWithIssue = async (id: string, issueStatus: "backlog" | "ready") => {
    await store.createCard({ id, tier: "epic", title: id, status: "planning" });
    await store.createCard({
      id: `${id}_s`,
      tier: "story",
      title: `${id} story`,
      parentId: id,
      status: issueStatus,
    });
  };

  it("epics in Planning do not fill Planning's limit for an issue", async () => {
    for (const id of ["e1", "e2", "e3"]) await epicWithIssue(id, "backlog");
    await store.createCard({ id: "t", tier: "task", title: "t", status: "ready" });
    await board.transitionCard({
      cardId: "t",
      fromStatus: "ready",
      toStatus: "planning",
      actor: "human",
    });
    expect((await store.getCard("t"))?.status).toBe("planning");
  });

  it("a parent moves into a full In progress (its rollup's route)", async () => {
    await epicWithIssue("e", "backlog");
    for (const id of ["w1", "w2"])
      await store.createCard({ id, tier: "task", title: id, status: "in_progress" });
    await board.transitionCard({
      cardId: "e",
      fromStatus: "planning",
      toStatus: "in_progress",
      actor: "harness",
    });
    expect((await store.getCard("e"))?.status).toBe("in_progress");
  });

  it("an issue is still refused by a full column", async () => {
    for (const id of ["w1", "w2"])
      await store.createCard({ id, tier: "task", title: id, status: "in_progress" });
    await store.createCard({ id: "x", tier: "task", title: "x", status: "ready" });
    await expect(
      board.transitionCard({
        cardId: "x",
        fromStatus: "ready",
        toStatus: "in_progress",
        actor: "human",
      }),
    ).rejects.toMatchObject({ code: "wip_limit" });
  });
});
