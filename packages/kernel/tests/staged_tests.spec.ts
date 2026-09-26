import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { criteriaSha256 } from "../src/staged_tests.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// planner-pm B4.3 step 0: staged test cases name the criterion they prove
// (PM-P1-17, PM-P1-18); approvals of criteria and of staged test files are
// bound to content hashes and voided by a change (PM-N7-3, -4, -5). Real SQLite.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("staged tests and their approvals", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-staged-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({
      id: "c",
      tier: "task",
      title: "Refund",
      status: "planning",
      acceptanceCriteria: ["Refunding 400 of 1000 leaves 600", "A second refund is refused"],
      criterionIds: ["AC-1", "AC-2"],
    });
  });
  afterEach(() => disk.dispose());

  it("PM-P1-17, PM-P1-18: each staged case names a criterion of its card; uncovered criteria are named", async () => {
    const t = store.stagedTests;
    expect(t.uncoveredCriteria("c")).toEqual(["AC-1", "AC-2"]);
    await t.stage({
      cardId: "c",
      path: "tests/refund.test.ts",
      sha256: SHA_A,
      author: "planner",
      cases: [{ name: "AC-1 refunding 400 leaves 600", criterionId: "AC-1" }],
    });
    const [event] = await log.getEventsByTypes(["test/staged"]);
    expect(event?.payload).toMatchObject({ cardId: "c", cases: [{ criterionId: "AC-1" }] });
    expect(t.uncoveredCriteria("c")).toEqual(["AC-2"]);
    expect(t.staged("c")).toEqual([
      {
        path: "tests/refund.test.ts",
        sha256: SHA_A,
        author: "planner",
        cases: [{ name: "AC-1 refunding 400 leaves 600", criterionId: "AC-1" }],
      },
    ]);

    // A test that proves no criterion of its card is refused, appending nothing.
    const before = (await log.getEventsByTypes(["test/staged"])).length;
    await expect(
      t.stage({
        cardId: "c",
        path: "tests/x.test.ts",
        sha256: SHA_A,
        author: "planner",
        cases: [],
      }),
    ).rejects.toThrow(/criterion/);
    await expect(
      t.stage({
        cardId: "c",
        path: "tests/x.test.ts",
        sha256: SHA_A,
        author: "planner",
        cases: [{ name: "other", criterionId: "AC-9" }],
      }),
    ).rejects.toThrow(/AC-9/);
    expect((await log.getEventsByTypes(["test/staged"])).length).toBe(before);

    // The latest staging of a path replaces its cases.
    await t.stage({
      cardId: "c",
      path: "tests/refund.test.ts",
      sha256: SHA_B,
      author: "test-author",
      cases: [
        { name: "AC-1 row 1", criterionId: "AC-1" },
        { name: "AC-2 refused", criterionId: "AC-2" },
      ],
    });
    expect(t.uncoveredCriteria("c")).toEqual([]);
  });

  it("PM-N7-5, PM-N7-3, PM-N7-4: approvals carry the principal and are void when the content changes", async () => {
    const t = store.stagedTests;
    const card = await store.getCard("c");
    const sha = criteriaSha256([
      { id: "AC-1", text: "Refunding 400 of 1000 leaves 600" },
      { id: "AC-2", text: "A second refund is refused" },
    ]);
    expect(t.criteriaApproval("c")).toEqual({ approved: false, currentSha256: sha });
    await expect(t.approveCriteria("c", "")).rejects.toThrow(/principal/);
    await t.approveCriteria("c", "p_owner");
    expect(t.criteriaApproval("c")).toEqual({
      approved: true,
      currentSha256: sha,
      approvedSha256: sha,
      principal: "p_owner",
    });
    const [approval] = await log.getEventsByTypes(["criteria/approved"]);
    expect(approval?.principal).toBe("p_owner");
    expect(approval?.actor).toBe("human");
    // Editing a criterion voids the approval.
    await store.updateCard("c", {
      acceptanceCriteria: [card?.acceptanceCriteria?.[0] ?? "", "A second refund returns 409"],
    });
    expect(t.criteriaApproval("c").approved).toBe(false);

    // A staged file's approval is tied to its SHA-256.
    await t.stage({
      cardId: "c",
      path: "tests/refund.test.ts",
      sha256: SHA_A,
      author: "planner",
      cases: [{ name: "AC-1", criterionId: "AC-1" }],
    });
    await expect(
      t.approveTest(
        { cardId: "c", path: "tests/refund.test.ts", sha256: SHA_B, what: "examples" },
        "p_owner",
      ),
    ).rejects.toThrow(/staged/);
    await t.approveTest(
      { cardId: "c", path: "tests/refund.test.ts", sha256: SHA_A, what: "examples" },
      "p_owner",
    );
    expect(t.testApprovals("c")).toEqual([
      {
        path: "tests/refund.test.ts",
        stagedSha256: SHA_A,
        approved: true,
        approvedSha256: SHA_A,
        principal: "p_owner",
        what: "examples",
      },
    ]);
    await t.stage({
      cardId: "c",
      path: "tests/refund.test.ts",
      sha256: SHA_B,
      author: "test-author",
      cases: [{ name: "AC-1", criterionId: "AC-1" }],
    });
    expect(t.testApprovals("c")[0]).toMatchObject({ approved: false, stagedSha256: SHA_B });
  });
});
