import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardStatus, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlannerLedger } from "../src/ledger.js";
import {
  BRIEF_ACCEPTED,
  type BriefInput,
  type MainTestResult,
  acceptBrief,
  acceptSlice,
  enforceAppetite,
  guardCompletionClaim,
  linkStagedTests,
  proposeSliceRelease,
  recordMainCheck,
  releaseReport,
  reviseRequirement,
  sliceStatus,
  storyMap,
} from "../src/requirement_graph.js";

// planner-pm P13 (§2.15): done is computed from requirements, never claimed.
// PM-P13-1, -3..-14 over the kernel's records, on a real SQLite file.

const OWNER = "p_owner";
const MAIN = "a".repeat(40);

let dir: string;
let db: DatabaseSync;
let ledger: PlannerLedger;
let store: CardStore;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sekhemet-req-graph-planner-"));
  db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  store = new CardStore(db, log);
  ledger = { store, log, board: new BoardServiceImpl(store) };
  projectId = (await store.ensureProject({ rootPath: dir, name: "Recipes" })).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function brief(): BriefInput {
  return {
    projectId,
    baseline: "Recipes live in a shared spreadsheet",
    slices: [
      {
        title: "Walking skeleton",
        appetite: { cards: 3, hours: 10 },
        requirements: [
          {
            key: "save",
            title: "Save a recipe",
            kano: "must-be",
            criteria: [{ id: "save.1", text: "A saved recipe is listed" }],
          },
          {
            key: "list",
            title: "List saved recipes",
            dependsOn: ["save"],
            criteria: [{ id: "list.1", text: "Lists in saved order" }],
          },
          { key: "tags", title: "Tag a recipe", mustHave: false, kano: "attractive" },
        ],
      },
      {
        title: "Favourites",
        appetite: { cards: 4 },
        requirements: [{ key: "fav", title: "Mark a favourite", dependsOn: ["list"] }],
      },
    ],
  };
}

async function card(id: string, requirementId: string, status: CardStatus = "ready") {
  const req = await store.requirements.get(requirementId);
  const criteria = req?.criteria.length ? req.criteria : [{ id: "x", text: "works" }];
  await store.createCard({
    id,
    tier: "task",
    title: id,
    status: "ready",
    projectId,
    acceptanceCriteria: criteria.map((c) => c.text),
    criterionIds: criteria.map((c) => c.id),
  });
  await store.requirements.link({ requirementId, from: "card", ref: id });
  const path: Record<CardStatus, CardStatus[]> = {
    ready: [],
    backlog: ["backlog"],
    planning: ["planning"],
    in_progress: ["in_progress"],
    verify: ["in_progress", "verify"],
    review: ["in_progress", "verify", "review"],
    done: ["in_progress", "verify", "review", "done"],
    parked: ["parked"],
    rejected: ["rejected"],
  };
  for (const to of path[status]) await store.updateCardStatus(id, to, "test", "human");
}

async function stage(cardId: string, path: string, cases: { name: string; criterionId: string }[]) {
  await store.stagedTests.stage({ cardId, path, sha256: "b".repeat(64), author: "planner", cases });
}

async function main(tests: Record<string, MainTestResult>, gatesPassed = true, sha = MAIN) {
  await recordMainCheck(ledger, {
    sha,
    branch: "main",
    gatesPassed,
    tests,
    profile: "internal tool",
  });
}

const pass: MainTestResult = { result: "passed", strength: "met" };

/** Slice 1 with its two must-haves planned, staged and passing on main. */
async function slice1Proven() {
  const { sliceIds, requirementIds } = await acceptBrief(ledger, brief(), OWNER);
  const [save, list] = requirementIds as [string, string];
  await card("c_save", save, "done");
  await card("c_list", list, "done");
  await stage("c_save", "tests/save.spec.ts", [
    { name: "lists a saved recipe", criterionId: "save.1" },
  ]);
  await stage("c_list", "tests/list.spec.ts", [{ name: "keeps order", criterionId: "list.1" }]);
  await linkStagedTests(ledger, "c_save");
  await linkStagedTests(ledger, "c_list");
  await main({
    "tests/save.spec.ts > lists a saved recipe": pass,
    "tests/list.spec.ts > keeps order": pass,
  });
  return { sliceIds, requirementIds };
}

describe("PM-P13-1: accepting the brief stores its requirements", () => {
  it("stores each slice with its appetite and each requirement with id, version, dependencies, Kano, must-have, criteria and slice", async () => {
    const { sliceIds, requirementIds } = await acceptBrief(ledger, brief(), OWNER);
    expect(sliceIds).toEqual(["SLICE-1", "SLICE-2"]);
    expect(requirementIds).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-4"]);
    const list = await store.requirements.get("REQ-2");
    expect(list).toMatchObject({
      version: 1,
      sliceId: "SLICE-1",
      dependsOn: ["REQ-1"],
      mustHave: true,
      criteria: [{ id: "list.1", text: "Lists in saved order" }],
    });
    expect(await store.requirements.get("REQ-3")).toMatchObject({
      mustHave: false,
      kano: "attractive",
    });
    expect(await store.requirements.get("REQ-4")).toMatchObject({
      sliceId: "SLICE-2",
      dependsOn: ["REQ-2"],
    });
    expect((await store.slices.get("SLICE-1"))?.appetite).toEqual({ cards: 3, hours: 10 });
    const [accepted] = await ledger.log.getEventsByTypes([BRIEF_ACCEPTED]);
    expect(accepted?.payload).toEqual({ projectId, sliceIds, requirementIds });
    expect(accepted?.principal).toBe(OWNER);
    expect(JSON.stringify(accepted?.payload)).not.toContain("spreadsheet");
    expect((await storyMap(ledger, { projectId })).baseline).toBe(
      "Recipes live in a shared spreadsheet",
    );
  });

  it("refuses a brief with an unknown dependency, a cycle or no principal, writing nothing", async () => {
    const bad = brief();
    (bad.slices[0]?.requirements[0] as { dependsOn?: string[] }).dependsOn = ["nowhere"];
    await expect(acceptBrief(ledger, bad, OWNER)).rejects.toThrow(/nowhere/);
    const cyc = brief();
    (cyc.slices[0]?.requirements[0] as { dependsOn?: string[] }).dependsOn = ["fav"];
    await expect(acceptBrief(ledger, cyc, OWNER)).rejects.toThrow(/cycle/);
    await expect(acceptBrief(ledger, brief(), "")).rejects.toThrow(/person/);
    expect(await store.requirements.list()).toEqual([]);
    expect(await store.slices.list()).toEqual([]);
  });
});

describe("PM-P13-3: an unplanned must-have is shown and keeps its slice unproven", () => {
  it("lists must-haves with no card on the story map and never counts the slice proven", async () => {
    await acceptBrief(ledger, brief(), OWNER);
    await card("c_save", "REQ-1", "done");
    await stage("c_save", "tests/save.spec.ts", [{ name: "lists", criterionId: "save.1" }]);
    await linkStagedTests(ledger, "c_save");
    await main({ "tests/save.spec.ts > lists": pass });
    const map = await storyMap(ledger, { projectId, mainSha: MAIN });
    expect(map.unplanned.map((r) => r.id)).toEqual(["REQ-2", "REQ-4"]);
    const s1 = map.slices[0];
    expect(s1?.unplanned).toEqual(["REQ-2"]);
    expect(s1?.state).toBe("unproven");
    // DEC-31: a proven must-have is a requirement done.
    expect(s1?.provenLine).toBe("1 of 2 requirements done");
    expect(map.provenLine).toBe("1 of 3 requirements done");
    // The nice-to-have with no card is not a must-have: not in the list.
    expect(map.unplanned.some((r) => r.id === "REQ-3")).toBe(false);
  });
});

describe("PM-P13-4, -5: proven is passing tests on main that meet the strength rule, no suspect link, gates passing", () => {
  it("marks the slice proven, then unproven when a test fails on main, and never counts passing-strength-unmet", async () => {
    await slice1Proven();
    let s1 = (await sliceStatus(ledger, "SLICE-1", MAIN))?.slice;
    expect(s1?.state).toBe("proven");
    expect(s1?.requirements.find((r) => r.id === "REQ-1")?.state).toBe("proven");

    await main({
      "tests/save.spec.ts > lists a saved recipe": { result: "failed", strength: "met" },
      "tests/list.spec.ts > keeps order": pass,
    });
    s1 = (await sliceStatus(ledger, "SLICE-1", MAIN))?.slice;
    expect(s1?.state).toBe("unproven");
    expect(s1?.requirements.find((r) => r.id === "REQ-1")?.state).toBe("failing");

    await main({
      "tests/save.spec.ts > lists a saved recipe": { result: "passed", strength: "unmet" },
      "tests/list.spec.ts > keeps order": pass,
    });
    s1 = (await sliceStatus(ledger, "SLICE-1", MAIN))?.slice;
    const save = s1?.requirements.find((r) => r.id === "REQ-1");
    expect(save?.state).toBe("passing_strength_unmet");
    expect(save?.why).toMatch(/strength unmet for the internal tool profile/);
    expect(s1?.mustHaves).toEqual({ proven: 1, total: 2 });
    expect(s1?.state).toBe("unproven");
  });

  it("is not proven when the project gates fail on main, or on a check of another head", async () => {
    await slice1Proven();
    await main(
      {
        "tests/save.spec.ts > lists a saved recipe": pass,
        "tests/list.spec.ts > keeps order": pass,
      },
      false,
    );
    expect((await sliceStatus(ledger, "SLICE-1", MAIN))?.slice.blockers).toContain(
      "The project's checks fail on main.",
    );
    await main({
      "tests/save.spec.ts > lists a saved recipe": pass,
      "tests/list.spec.ts > keeps order": pass,
    });
    const moved = (await sliceStatus(ledger, "SLICE-1", "c".repeat(40)))?.slice;
    expect(moved?.state).toBe("unproven");
    expect(moved?.requirements[0]?.why).toMatch(/Main moved/);
  });

  it("is not proven when the caller does not know main's head either: undefined never means proven", async () => {
    await slice1Proven();
    // With the caller naming main's head, it is proven.
    expect((await sliceStatus(ledger, "SLICE-1", MAIN))?.slice.state).toBe("proven");
    // Without it, a check recorded against some other head could be stale:
    // not knowing must not fail open into "proven".
    const unknown = (await sliceStatus(ledger, "SLICE-1"))?.slice;
    expect(unknown?.state).toBe("unproven");
    expect(unknown?.requirements[0]?.why).toMatch(/Main moved/);
    const map = await storyMap(ledger, { projectId });
    expect(map.main?.stale).toBe(true);
  });

  it("a slice with no must-have requirements at all is not proven", async () => {
    await store.slices.create({ projectId, title: "Empty", appetite: { cards: 1 } }, OWNER);
    // Only a nice-to-have, no must-have: the slice has nothing to prove,
    // and must not be trivially "done" for lacking anything to fail.
    await store.requirements.create({ title: "Nice", sliceId: "SLICE-1", mustHave: false }, OWNER);
    const status = (await sliceStatus(ledger, "SLICE-1", MAIN))?.slice;
    expect(status?.mustHaves).toEqual({ proven: 0, total: 0 });
    expect(status?.state).toBe("unproven");
    expect(status?.blockers.join(" ")).toMatch(/no Must have requirements/);
  });
});

describe("linkStagedTests: a case links to the one requirement its own words match", () => {
  it("links each case to the requirement its criterion text overlaps, never to every traced requirement", async () => {
    const save = await store.requirements.create(
      { title: "Save a recipe", criteria: [{ id: "REQ-1.1", text: "A saved recipe is listed" }] },
      OWNER,
    );
    const fav = await store.requirements.create(
      {
        title: "Mark a favourite",
        criteria: [{ id: "REQ-2.1", text: "A favourited recipe shows a star" }],
      },
      OWNER,
    );
    // A planner card-scoped criterion id (`<card>.c<n>`) never equals a
    // brief's requirement-criterion id (`REQ-1.1`) — the bug this fixes.
    await store.createCard({
      id: "multi",
      tier: "task",
      title: "Save and favourite",
      status: "ready",
      acceptanceCriteria: ["A saved recipe is listed", "A favourited recipe shows a star"],
      criterionIds: ["multi.c1", "multi.c2"],
    });
    await store.requirements.link({ requirementId: save.id, from: "card", ref: "multi" });
    await store.requirements.link({ requirementId: fav.id, from: "card", ref: "multi" });
    await stage("multi", "tests/multi.spec.ts", [
      { name: "saves it", criterionId: "multi.c1" },
      { name: "favourites it", criterionId: "multi.c2" },
    ]);
    await linkStagedTests(ledger, "multi");
    expect(store.requirements.links(save.id).map((l) => l.ref)).toEqual([
      "multi",
      "tests/multi.spec.ts > saves it",
    ]);
    expect(store.requirements.links(fav.id).map((l) => l.ref)).toEqual([
      "multi",
      "tests/multi.spec.ts > favourites it",
    ]);
  });

  it("falls back to linking the whole file to every traced requirement when no case matches", async () => {
    const req = await store.requirements.create(
      { title: "Unrelated", criteria: [{ id: "REQ-9.1", text: "Something entirely different" }] },
      OWNER,
    );
    await store.createCard({
      id: "nomatch",
      tier: "task",
      title: "A card",
      status: "ready",
      acceptanceCriteria: ["Saves a value"],
      criterionIds: ["nomatch.c1"],
    });
    await store.requirements.link({ requirementId: req.id, from: "card", ref: "nomatch" });
    await stage("nomatch", "tests/nomatch.spec.ts", [{ name: "saves", criterionId: "nomatch.c1" }]);
    await linkStagedTests(ledger, "nomatch");
    expect(store.requirements.links(req.id).map((l) => l.ref)).toEqual([
      "nomatch",
      "tests/nomatch.spec.ts",
    ]);
  });
});

describe("PM-P13-6, -14: a model's claim of complete or ready changes nothing", () => {
  it("replaces the claim with the proven count and names what is unproven", async () => {
    await acceptBrief(ledger, brief(), OWNER);
    await card("c_save", "REQ-1", "done");
    const before = await ledger.log.getEventsByTypes(["slice/accepted", "release/proposed"]);
    const map = await storyMap(ledger, { projectId, mainSha: MAIN });
    const out = guardCompletionClaim(
      "Great progress today. The project is complete and the release is ready to ship!",
      map,
    );
    expect(out.guarded).toBe(true);
    expect(out.text).not.toMatch(/complete|ready to ship/);
    expect(out.text).toContain("Great progress today.");
    expect(out.text).toContain("Not done: 0 of 3 requirements done.");
    expect(out.text).toMatch(/REQ-1 \(planned\).*REQ-2 \(unplanned\)/);
    expect(await ledger.log.getEventsByTypes(["slice/accepted", "release/proposed"])).toEqual(
      before,
    );
    expect(guardCompletionClaim("The walking skeleton is complete.", map).guarded).toBe(true);
    expect(guardCompletionClaim("All must-haves are proven, so we're done.", map).guarded).toBe(
      true,
    );
    // No claim, no change.
    expect(guardCompletionClaim("Two cards are in review.", map)).toEqual({
      text: "Two cards are in review.",
      guarded: false,
    });
  });

  it("refuses to propose a release while a must-have is unproven, whatever was said", async () => {
    await acceptBrief(ledger, brief(), OWNER);
    await expect(
      proposeSliceRelease(ledger, {
        sliceId: "SLICE-1",
        version: "0.1.0",
        changelog: {},
        mainSha: MAIN,
      }),
    ).rejects.toThrow(/not been accepted/);
    expect(await ledger.log.getEventsByTypes(["release/proposed"])).toEqual([]);
  });
});

describe("PM-P13-7, -8: a person accepts a proven slice; the project is done only on the last acceptance", () => {
  it("refuses an unproven slice, records the principal, and reports the project done only after the last slice", async () => {
    await slice1Proven();
    await expect(acceptSlice(ledger, "SLICE-2", OWNER, MAIN)).rejects.toThrow(/not proven/);
    await expect(acceptSlice(ledger, "SLICE-1", "", MAIN)).rejects.toThrow(/person/);
    const first = await acceptSlice(ledger, "SLICE-1", OWNER, MAIN);
    expect(first.completesProject).toBe(false);
    const [accepted] = await ledger.log.getEventsByTypes(["slice/accepted"]);
    expect(accepted?.principal).toBe(OWNER);
    expect(accepted?.actor).toBe("human");
    let map = await storyMap(ledger, { projectId, mainSha: MAIN });
    expect(map.slices[0]?.state).toBe("done");
    // Every card Done, but slice 2 is not accepted: not done.
    expect(map.projectDone).toBe(false);

    await card("c_fav", "REQ-4", "done");
    await stage("c_fav", "tests/fav.spec.ts", [{ name: "marks", criterionId: "x" }]);
    await linkStagedTests(ledger, "c_fav");
    await main({
      "tests/save.spec.ts > lists a saved recipe": pass,
      "tests/list.spec.ts > keeps order": pass,
      "tests/fav.spec.ts": pass,
    });
    map = await storyMap(ledger, { projectId, mainSha: MAIN });
    expect(map.slices[1]?.state).toBe("proven");
    expect(map.projectDone).toBe(false);
    const last = await acceptSlice(ledger, "SLICE-2", OWNER, MAIN);
    expect(last.completesProject).toBe(true);
    map = await storyMap(ledger, { projectId, mainSha: MAIN });
    expect(map.projectDone).toBe(true);
    expect(await store.projectRollup(projectId)).toBe("done");
  });
});

describe("PM-P13-9: appetite stops a slice's cards and asks the person", () => {
  it("holds the slice's cards once its cards reach the appetite, asks once, and offers extend only with red tests and nothing unplanned", async () => {
    await acceptBrief(ledger, brief(), OWNER);
    await card("c1", "REQ-1", "done");
    await card("c2", "REQ-1", "in_progress");
    await card("c3", "REQ-3", "review");
    await card("c4", "REQ-2", "ready");
    await card("f1", "REQ-4", "ready");
    const first = await enforceAppetite(ledger, { mainSha: MAIN });
    expect([...first.held].sort()).toEqual(["c2", "c3", "c4"]);
    expect(first.asks).toHaveLength(1);
    const ask = first.asks[0];
    expect(ask).toMatchObject({ sliceId: "SLICE-1", cards: 3, accept: false, extend: false });
    expect(ask?.cut.map((r) => r.id)).toEqual(["REQ-3"]);
    expect(ask?.noExtend).toMatch(/c3, c4 have no red test yet/);
    expect(ask?.text).toMatch(/reached its appetite: 3 of 3 cards/);
    expect(ask?.text).toMatch(/cut REQ-3/);
    expect((await store.slices.get("SLICE-1"))?.appetiteReached).toBe(true);

    // Asked once: the next pass still holds, but records and asks nothing.
    const again = await enforceAppetite(ledger, { mainSha: MAIN });
    expect(again.asks).toEqual([]);
    expect(again.held.has("c4")).toBe(true);
    expect(await ledger.log.getEventsByTypes(["slice/appetite_reached"])).toHaveLength(1);

    // Extended by a person: scheduled again.
    await store.slices.extend({ sliceId: "SLICE-1", appetite: { cards: 6 } }, OWNER);
    expect((await enforceAppetite(ledger)).held.size).toBe(0);
  });

  it("offers extend when every remaining card has red tests and nothing is unplanned", async () => {
    await acceptBrief(ledger, brief(), OWNER);
    await card("c1", "REQ-1", "done");
    await card("c2", "REQ-2", "done");
    await card("c3", "REQ-3", "done");
    await card("c4", "REQ-2", "ready");
    await stage("c4", "tests/list.spec.ts", [{ name: "keeps order", criterionId: "list.1" }]);
    const { asks } = await enforceAppetite(ledger);
    expect(asks[0]).toMatchObject({ extend: true });
    expect(asks[0]?.text).toMatch(/extend its appetite/);
  });
});

describe("PM-P13-10, -13: the release report and the release per slice", () => {
  it("proposes the accepted slice's release with notes in the brief's words and lists proven, cut and remaining against the baseline", async () => {
    await slice1Proven();
    await store.slices.cut({ requirementId: "REQ-3", reason: "later" }, OWNER);
    await acceptSlice(ledger, "SLICE-1", OWNER, MAIN);
    const r = await proposeSliceRelease(ledger, {
      sliceId: "SLICE-1",
      version: "v0.1.0",
      changelog: { Added: ["save a recipe (abc1234)"] },
      mainSha: MAIN,
    });
    expect(r.version).toBe("0.1.0");
    expect(r.requirementIds).toEqual(["REQ-1", "REQ-2"]);
    expect(r.notes).toContain("- Save a recipe");
    expect(r.notes).toContain("- List saved recipes");
    const [release] = await store.slices.releases("SLICE-1");
    expect(release).toMatchObject({
      version: "0.1.0",
      changelog: { Added: ["save a recipe (abc1234)"] },
    });
    const report = releaseReport(await storyMap(ledger, { projectId, mainSha: MAIN }), "SLICE-1");
    expect(report.proven.map((x) => x.id)).toEqual(["REQ-1", "REQ-2"]);
    expect(report.cut.map((x) => x.id)).toEqual(["REQ-3"]);
    expect(report.text).toContain(
      "Compared with what you had before: Recipes live in a shared spreadsheet",
    );
    const remaining = releaseReport(
      await storyMap(ledger, { projectId, mainSha: MAIN }),
      "SLICE-2",
    );
    expect(remaining.remaining).toEqual([
      { id: "REQ-4", title: "Mark a favourite", state: "unplanned" },
    ]);
  });
});

describe("PM-P13-11, -12: a revision holds traced cards and stays suspect until resolved", () => {
  it("holds open cards in Planning, leaves a running one, drafts a change card for a done one, and unproves the slice", async () => {
    await slice1Proven();
    await card("c_more", "REQ-1", "ready");
    await card("c_run", "REQ-1", "in_progress");
    const out = await reviseRequirement(
      ledger,
      "REQ-1",
      { criteria: [{ id: "save.1", text: "A saved recipe is listed with its photo" }] },
      OWNER,
    );
    expect(out.version).toBe(2);
    expect(out.held).toEqual(["c_more"]);
    expect((await store.getCard("c_more"))?.status).toBe("planning");
    expect(out.running).toEqual(["c_run"]);
    expect(out.changeCards.map((c) => c.cardId)).toEqual(["c_save"]);
    expect(out.changeCards[0]?.spec).toMatch(/version 2/);
    const s1 = (await sliceStatus(ledger, "SLICE-1", MAIN))?.slice;
    expect(s1?.state).toBe("unproven");
    expect(s1?.requirements[0]?.state).toBe("suspect");

    // The running card finishes into Review: the next sweep holds it too.
    await store.updateCardStatus("c_run", "verify", "t", "human");
    await store.updateCardStatus("c_run", "review", "t", "human");
    const { holdSuspectCards } = await import("../src/requirement_graph.js");
    expect(await holdSuspectCards(ledger)).toEqual(["c_run"]);

    // Still suspect after another machine link; cleared by a person's re-confirmation.
    await store.requirements.link({ requirementId: "REQ-1", from: "card", ref: "c_save" });
    expect(store.requirements.links("REQ-1").find((l) => l.ref === "c_save")?.suspect).toBe(true);
    for (const l of store.requirements.links("REQ-1").filter((x) => x.suspect)) {
      await store.requirements.confirm({ requirementId: "REQ-1", from: l.from, ref: l.ref }, OWNER);
    }
    expect((await sliceStatus(ledger, "SLICE-1", MAIN))?.slice.state).toBe("proven");
  });

  it("PM-N9-9: in the Team setup a card someone else owns gets the hold as a suggestion, and is not moved", async () => {
    await slice1Proven();
    await card("c_theirs", "REQ-1", "ready");
    await card("c_mine", "REQ-1", "ready");
    const out = await reviseRequirement(
      ledger,
      "REQ-1",
      { criteria: [{ id: "save.1", text: "A saved recipe is listed with its photo" }] },
      OWNER,
      { route: (c) => (c.id === "c_theirs" ? "suggest" : "apply") },
    );
    expect(out.held).toEqual(["c_mine"]);
    expect((await store.getCard("c_theirs"))?.status).toBe("ready");
    expect(await store.suggestions.open("c_theirs")).toEqual([
      expect.objectContaining({
        kind: "hold",
        value: expect.stringMatching(/^REQ-1 was revised to version 2/),
      }),
    ]);
  });
});
