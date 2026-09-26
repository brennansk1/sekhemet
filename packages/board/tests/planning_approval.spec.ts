import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoardServiceImpl, planningExitFailure } from "../src/board_service.js";

/**
 * Leaving Planning needs a person's approvals (planner-pm §2.17, PM-N7-3,
 * PM-N7-4, PM-N7-5): the card's criteria as they are now, always; by the
 * depth profile, the example tables of must-have requirements (production)
 * or every staged acceptance-test file (regulated), each at its current
 * content — a changed file voids its approval.
 */
describe("PM-N7-3/4/5: the Planning exit condition for approvals", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "board-approval-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
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
    await store.requirements.link(
      { requirementId: requirement.id, from: "card", ref: "c1" },
      "planner",
    );
    await store.stagedTests.stage({
      cardId: "c1",
      path: "tests/c1.spec.ts",
      sha256: sha("v1"),
      author: "planner",
      cases: [{ name: "c1.c1: refund [example 1]", criterionId: "c1.c1" }],
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const toReady = (board: BoardServiceImpl) =>
    board.transitionCard({
      cardId: "c1",
      fromStatus: "planning",
      toStatus: "ready",
      actor: "planner",
    });

  it("PM-N7-5: every profile needs the criteria approved; the internal-tool default needs nothing more", async () => {
    const board = new BoardServiceImpl(store, { entryConditions: true });
    await expect(toReady(board)).rejects.toThrow(/approval of its criteria/);
    expect(
      await planningExitFailure(store, (await store.getCard("c1")) as never, "prototype"),
    ).toMatch(/criteria/);
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await toReady(board);
    expect((await store.getCard("c1"))?.status).toBe("ready");
  });

  it("PM-N7-5: a criterion changed after the approval voids it; the card cannot start from Backlog either", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await store.updateCard("c1", { acceptanceCriteria: ["Refunding 500 of 1000 leaves 500"] });
    const board = new BoardServiceImpl(store, { entryConditions: true });
    await board.transitionCard({
      cardId: "c1",
      fromStatus: "planning",
      toStatus: "backlog",
      actor: "planner",
    });
    await expect(
      board.transitionCard({
        cardId: "c1",
        fromStatus: "backlog",
        toStatus: "ready",
        actor: "planner",
      }),
    ).rejects.toThrow(/approval of its criteria/);
  });

  it("PM-N7-3: production needs the must-have example tables approved; regulated every staged file", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    const production = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
    });
    await expect(toReady(production)).rejects.toThrow(/example tables.*tests\/c1\.spec\.ts/);
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "examples" },
      "p_owner",
    );
    // Regulated asks for the whole file, not only its examples.
    const regulated = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "regulated",
    });
    expect(
      await regulated.entryConditionFailure((await store.getCard("c1")) as never, {
        cardId: "c1",
        fromStatus: "planning",
        toStatus: "ready",
        actor: "planner",
      }),
    ).toMatch(/every staged acceptance-test file/);
    await toReady(production);
    expect((await store.getCard("c1"))?.status).toBe("ready");
  });

  it("PM-N7-3: production asks nothing of a card that traces to no must-have requirement", async () => {
    await store.createCard({
      id: "c2",
      tier: "story",
      title: "Nice to have",
      status: "planning",
      acceptanceCriteria: ["Shows 3 rows"],
      criterionIds: ["c2.c1"],
    });
    const nice = await store.requirements.create(
      { id: "REQ-2", title: "Colours", mustHave: false },
      "p_owner",
    );
    await store.requirements.link({ requirementId: nice.id, from: "card", ref: "c2" }, "planner");
    await store.stagedTests.stage({
      cardId: "c2",
      path: "tests/c2.spec.ts",
      sha256: sha("x"),
      author: "planner",
      cases: [{ name: "c2.c1: rows", criterionId: "c2.c1" }],
    });
    await store.stagedTests.approveCriteria("c2", "p_owner");
    expect(
      await planningExitFailure(store, (await store.getCard("c2")) as never, "production"),
    ).toBeUndefined();
  });

  it("PM-N7-4: a staged file whose content changed after its approval needs approving again", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "file" },
      "p_owner",
    );
    await store.stagedTests.stage({
      cardId: "c1",
      path: "tests/c1.spec.ts",
      sha256: sha("v2"),
      author: "planner",
      cases: [{ name: "c1.c1: refund [example 1]", criterionId: "c1.c1" }],
    });
    const board = new BoardServiceImpl(store, { entryConditions: true, depthProfile: "regulated" });
    await expect(toReady(board)).rejects.toThrow(/void.*changed since it was approved/);
  });

  it("re-hashes a staged file from disk: a direct edit voids its approval even though nothing was re-staged", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "examples" },
      "p_owner",
    );
    // Nobody called `stage()` again: the kernel's own record still says "v1".
    const production = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
      readStagedFile: (path) => (path === "tests/c1.spec.ts" ? "v2 (edited on disk)" : undefined),
    });
    await expect(toReady(production)).rejects.toThrow(/void, the content changed/);
    // Without a reader, the same card (still recorded as "v1") is Ready.
    const noReader = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
    });
    await toReady(noReader);
    expect((await store.getCard("c1"))?.status).toBe("ready");
  });

  it("a staged file gone from disk voids its approval when the board reads the disk", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "examples" },
      "p_owner",
    );
    const production = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
      readStagedFile: () => undefined,
    });
    await expect(toReady(production)).rejects.toThrow(/void, the content changed/);
  });

  it("re-checks Ready to In Progress: a staged file edited on disk after the card was Ready is caught", async () => {
    await store.stagedTests.approveCriteria("c1", "p_owner");
    await store.stagedTests.approveTest(
      { cardId: "c1", path: "tests/c1.spec.ts", sha256: sha("v1"), what: "examples" },
      "p_owner",
    );
    const noReader = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
    });
    await toReady(noReader);
    await store.updateCard("c1", { scopeFiles: ["src/refund.ts"] });
    const production = new BoardServiceImpl(store, {
      entryConditions: true,
      depthProfile: "production",
      readStagedFile: (path) => (path === "tests/c1.spec.ts" ? "v2 (edited on disk)" : undefined),
    });
    await expect(
      production.transitionCard({
        cardId: "c1",
        fromStatus: "ready",
        toStatus: "in_progress",
        actor: "executor",
      }),
    ).rejects.toThrow(/void, the content changed/);
  });
});
