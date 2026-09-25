import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl } from "../src/board_service.js";

// kernel.md rule 24, NEW-kernel-3: an accepted card whose pull request is
// open waits in Review with an `awaitingMerge` hold, outside Review's WIP
// count, and reaches Done only by the merge. Real SQLite files (DoD §2A).

describe("the awaiting-merge hold (K-N3-3, K-N3-4, K-N3-5)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let board: BoardServiceImpl;
  const person = "p_owner";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-merge-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
    board = new BoardServiceImpl(store, { customLimits: { review: 2 } });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const accepted = async (id: string, pr: number) => {
    await store.createCard({ id, tier: "task", title: id });
    await store.updateCardStatus(id, "review", "test setup", "harness", { override: true });
    await board.acceptWithPullRequest(id, { pr, url: `u/${pr}`, headSha: `sha${pr}` }, person);
  };

  it("RG-S5-2: card/pr_opened and the accepting card/accepted commit together, or neither does", async () => {
    await store.createCard({ id: "t1", tier: "task", title: "t1" });
    await store.updateCardStatus("t1", "review", "test setup", "harness", { override: true });
    const acceptedEvent = (gateStatus: string) => ({
      type: "card/accepted",
      actor: "human",
      principal: person,
      payload: { id: "t1", pr: "u/21", principal: person, independent: false, gateStatus },
    });
    await expect(
      board.acceptWithPullRequest(
        "t1",
        { pr: 21, url: "u/21", headSha: "sha21" },
        person,
        "harness",
        [acceptedEvent("bogus")],
      ),
    ).rejects.toThrow();
    expect(await store.cardEvents("t1", ["card/pr_opened", "card/accepted"])).toEqual([]);
    expect((await store.getCard("t1"))?.hold).toBeFalsy();
    await board.acceptWithPullRequest(
      "t1",
      { pr: 21, url: "u/21", headSha: "sha21" },
      person,
      "harness",
      [acceptedEvent("pass")],
    );
    const events = await store.cardEvents("t1", ["card/pr_opened", "card/accepted"]);
    expect(events.map((e) => e.type)).toEqual(["card/pr_opened", "card/accepted"]);
    expect((events[1]?.seq ?? 0) - (events[0]?.seq ?? 0)).toBe(1);
  });

  it("K-N3-3: records card/pr_opened, keeps the card in Review, and leaves it out of Review's WIP", async () => {
    await accepted("a1", 11);
    await accepted("a2", 12);
    const a1 = await store.getCard("a1");
    expect(a1?.status).toBe("review");
    expect(a1?.hold).toMatchObject({
      kind: "awaitingMerge",
      pr: 11,
      url: "u/11",
      headSha: "sha11",
    });
    expect(a1?.accepter).toBe(person);
    const [opened] = await store.cardEvents("a1", ["card/pr_opened"]);
    expect(opened?.payload).toMatchObject({ pr: 11, url: "u/11", headSha: "sha11" });

    // Review is at its limit of 2 with awaiting-merge cards only: a further
    // card still enters Verify, and then Review.
    await store.createCard({ id: "w", tier: "task", title: "W", status: "in_progress" });
    await board.transitionCard({
      cardId: "w",
      fromStatus: "in_progress",
      toStatus: "verify",
      actor: "executor",
    });
    await board.transitionCard({
      cardId: "w",
      fromStatus: "verify",
      toStatus: "review",
      actor: "executor",
    });
    expect((await store.getCard("w"))?.status).toBe("review");
    expect((await board.getBoardState()).backpressureActive).toBe(false);
  });

  it("K-N3-5: refuses Done by any path but the merge, even an override", async () => {
    await accepted("a1", 11);
    for (const move of [
      { actor: "human", principal: person },
      { actor: "harness" },
      { actor: "human", principal: person, reason: "override: merge it by hand" },
    ]) {
      await expect(
        board.transitionCard({ cardId: "a1", fromStatus: "review", toStatus: "done", ...move }),
      ).rejects.toMatchObject({ code: "entry_condition" });
    }
    expect((await store.getCard("a1"))?.status).toBe("review");
  });

  it("K-N3-4: a merge moves the card to Done; a close without merging clears the hold and the accepter", async () => {
    await accepted("m", 21);
    await board.closePullRequest("m", { pr: 21, merged: true }, "github");
    const merged = await store.getCard("m");
    expect(merged?.status).toBe("done");
    expect(merged?.hold).toBeUndefined();
    expect(merged?.accepter).toBe(person);

    await accepted("c", 22);
    await board.closePullRequest("c", { pr: 22, merged: false }, "github");
    const closed = await store.getCard("c");
    expect(closed?.status).toBe("review");
    expect(closed?.hold).toBeUndefined();
    expect(closed?.accepter).toBeUndefined();
    // Counted toward Review's WIP again, and a person's decision is needed anew.
    expect((await board.checkWipLimits()).find((w) => w.column === "review")?.currentCount).toBe(1);
    const withConditions = new BoardServiceImpl(store, { entryConditions: true });
    await expect(
      withConditions.transitionCard({
        cardId: "c",
        fromStatus: "review",
        toStatus: "done",
        actor: "github",
      }),
    ).rejects.toMatchObject({ code: "entry_condition" });
  });

  it("K-N3-6: a move out of Review clears the hold and the accepter, so the old pull request's merge cannot take the card to Done", async () => {
    await accepted("s", 31);
    // A person sends the accepted card back; later it returns to Review.
    await board.transitionCard({
      cardId: "s",
      fromStatus: "review",
      toStatus: "ready",
      actor: "human",
      principal: person,
    });
    let card = await store.getCard("s");
    expect(card?.hold).toBeUndefined();
    expect(card?.accepter).toBeUndefined();
    await store.updateCardStatus("s", "review", "test setup", "harness", { override: true });

    // The stale pull request merges: no acceptance stands, so Done is refused.
    await expect(board.closePullRequest("s", { pr: 31, merged: true }, "github")).rejects.toThrow(
      /does not await pull request #31/,
    );
    card = await store.getCard("s");
    expect(card?.status).toBe("review");
    expect(card?.accepter).toBeUndefined();

    // Replay reproduces it: the hold and the accepter stay cleared.
    expect((await store.verifyProjections()).identical).toBe(true);
    await store.rebuildProjections();
    card = await store.getCard("s");
    expect(card?.hold).toBeUndefined();
    expect(card?.accepter).toBeUndefined();
  });

  it("K-N3-5: projections rebuilt from the ledger reproduce every hold exactly", async () => {
    await accepted("a1", 11);
    await accepted("c", 22);
    await board.closePullRequest("c", { pr: 22, merged: false }, "github");
    await store.createCard({ id: "h", tier: "task", title: "H", status: "in_progress" });
    await board.holdCard("h", "verify refused (back-pressure)");
    expect((await store.verifyProjections()).identical).toBe(true);
    await store.rebuildProjections();
    expect((await store.getCard("a1"))?.hold).toMatchObject({ kind: "awaitingMerge", pr: 11 });
    expect((await store.getCard("h"))?.hold).toMatchObject({
      kind: "backpressure",
      awaiting: "verify",
    });
    expect((await store.getCard("c"))?.hold).toBeUndefined();
  });
});
