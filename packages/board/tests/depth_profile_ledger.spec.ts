import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, checklistRowsFor, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl, planningExitFailure } from "../src/board_service.js";

/**
 * design-stage DS-P14-3: the Planning exit condition reads the depth profile
 * a person recorded on the ledger — not a value the caller passes — and the
 * internal-tool default only when none is recorded (planner-pm PM-N7-3).
 */
describe("DS-P14-3: the board reads the recorded depth profile", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "board-depth-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
    const requirement = await store.requirements.create(
      { id: "REQ-1", title: "Refund an invoice", mustHave: true },
      "p_owner",
    );
    await store.createCard({
      id: "c1",
      tier: "story",
      title: "Refund a paid invoice",
      status: "planning",
      scopeFiles: ["src/refund.ts"],
      acceptanceCriteria: ["Refunding 400 of 1000 leaves 600"],
      criterionIds: ["c1.c1"],
    });
    await store.requirements.link({ requirementId: requirement.id, from: "card", ref: "c1" });
    await store.stagedTests.stage({
      cardId: "c1",
      path: "tests/c1.spec.ts",
      sha256: sha("v1"),
      author: "planner",
      cases: [{ name: "c1.c1: refund [example 1]", criterionId: "c1.c1" }],
    });
    await store.stagedTests.approveCriteria("c1", "p_owner");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("with none recorded, the internal-tool default needs only the criteria", async () => {
    const card = (await store.getCard("c1")) as never;
    expect(await planningExitFailure(store, card)).toBeUndefined();
  });

  it("a recorded production profile needs the must-have example tables approved", async () => {
    await store.depthProfiles.choose(
      {
        profile: "production",
        checklist: Object.fromEntries(
          checklistRowsFor("production").map((row) => [
            row,
            { title: row, invariant: `${row}-gate` },
          ]),
        ),
      },
      "p_owner",
    );
    const board = new BoardServiceImpl(store, { entryConditions: true });
    await expect(
      board.transitionCard({
        cardId: "c1",
        fromStatus: "planning",
        toStatus: "ready",
        actor: "planner",
      }),
    ).rejects.toThrow(/example tables.*production profile/);
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "examples" },
      "p_owner",
    );
    await board.transitionCard({
      cardId: "c1",
      fromStatus: "planning",
      toStatus: "ready",
      actor: "planner",
    });
    expect((await store.getCard("c1"))?.status).toBe("ready");
  });
});
