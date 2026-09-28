import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  type InferenceResponse,
  MockInferenceAdapter,
  resolveWorkerModelId,
} from "@sekhemet/models";
import { REVIEW_DESK_COPY, reviewerAbsence, reviewerFindings } from "@sekhemet/ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptFriction } from "../src/accept.js";
import { namesAnchor } from "../src/learning/reflect.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { dossierLines } from "../src/pm/service.js";
import { reviewDesk } from "../src/review_desk.js";
import {
  REVIEW_WAIT,
  ReviewFlow,
  type ReviewerRole,
  acceptAfterReview,
  familyOf,
  resolveReviewerRole,
  reviewerInput,
} from "../src/review_flow.js";
import { sendBack } from "../src/triage.js";

/**
 * review-git P8 through the product's paths, on a real SQLite ledger and
 * real evidence files (DoD §2A); the Review model is a scripted adapter and
 * Smart Swap's queue a deferred one, so a "tour" is released by the test.
 */

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const DIFF = [
  "diff --git a/src/ledger.ts b/src/ledger.ts",
  "--- a/src/ledger.ts",
  "+++ b/src/ledger.ts",
  "@@ -1,1 +1,3 @@",
  " export const rows: string[] = [];",
  "+export const append = (e: string) => rows.push(e);",
  "+export const list = () => [...rows].reverse();",
  "",
].join("\n");

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
const ctx = () => ({ repoPath: repo, cardStore: store, boardService: board });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sekhemet-review-flow-"));
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  board = new BoardServiceImpl(store);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

/** A card whose checks passed, waiting in Verify for its review, with a transcript on disk. */
async function waiting(id: string): Promise<void> {
  await store.createCard({
    id,
    tier: "story",
    title: `Ledger ${id}`,
    spec: "Store entries in order.",
    scopeFiles: ["src/**"],
    acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
    criterionIds: ["AC-1", "AC-2"],
  });
  await store.stagedTests.stage({
    cardId: id,
    path: "tests/ledger.spec.ts",
    sha256: "a".repeat(64),
    author: "planner",
    cases: [{ name: "appends", criterionId: "AC-1" }],
  });
  await store.recordDossierEntry({
    cardId: id,
    kind: "note",
    text: "Assumed: list keeps insertion order",
  });
  await store.recordDossierEntry({
    cardId: id,
    kind: "lesson",
    text: "WORKER LESSON: tried a Map first",
  });
  const dir = join(repo, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `transcript-${id}.jsonl`), "WORKER TRANSCRIPT: my private reasoning\n");
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    diff: DIFF,
    rungResults: [{ gate: "test", passed: true }],
    filesTouched: ["src/ledger.ts"],
    transcriptPath: join(".sekhemet", "evidence", `transcript-${id}.jsonl`),
    steps: [{ turn: 1, reasoning: "WORKER STEP: reverse is fine" }],
  };
  const body = `${JSON.stringify(evidence)}\n`;
  writeFileSync(join(dir, `${evidence.id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "cyber-tiel",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: ["src/ledger.ts"],
  });
  await store.updateCardStatus(id, "verify", "checks passed", "executor", { override: true });
  await store.updateCard(id, { blockedReason: REVIEW_WAIT }, "executor");
}

const verdicts = (): InferenceResponse => ({
  text: JSON.stringify({
    criteria: [
      { n: 1, verdict: "met", at: "src/ledger.ts:2", note: "" },
      {
        n: 2,
        verdict: "unmet",
        at: "src/ledger.ts:3",
        note: "list reverses the entries: the letter, not the intent.",
      },
    ],
    assumptions: [
      { n: 1, contradicted: true, at: "src/ledger.ts:3", note: "list reverses the order." },
    ],
  }),
  toolCalls: [],
  usage,
});

/** Smart Swap's queue, deferred: work waits until the test runs the tour. */
function deferredAccess(model: MockInferenceAdapter) {
  const tour: (() => Promise<void>)[] = [];
  return {
    access: {
      submit: <T>(_q: string, work: (m: never) => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          tour.push(() => work(model as never).then(resolve, reject));
        }),
    } as never,
    runTour: async () => {
      for (const w of tour.splice(0)) await w();
    },
  };
}

const filled: ReviewerRole = { state: "filled", model: "gemma-4-26b", queue: "reviewer" };
const learned = async () => ({ preferences: [], rules: [] });

describe("the AI review before Review (RG-P8-1, -3, -9, -11, -12)", () => {
  it("holds passing cards in Verify until the tour brings the Review model, then records and moves each", async () => {
    await waiting("c1");
    await waiting("c2");
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts(), verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    expect(await flow.decide("c1")).toBe(REVIEW_WAIT);
    await flow.afterRun("c1");
    await flow.afterRun("c2");
    expect(flow.queued).toBe(2);
    // No tour yet: both wait in Verify, and neither is in Review.
    for (const id of ["c1", "c2"])
      expect(await store.getCard(id)).toMatchObject({
        status: "verify",
        blockedReason: REVIEW_WAIT,
      });
    await runTour();
    await flow.drain();
    for (const id of ["c1", "c2"]) {
      const card = await store.getCard(id);
      expect(card?.status).toBe("review");
      expect(card?.blockedReason ?? null).toBeNull();
      // The findings are on the ledger before the move to Review.
      const events = await store.cardEvents(id, ["card/review", "card/status_changed"]);
      const firstReview =
        events.find((e) => e.type === "card/review")?.seq ?? Number.POSITIVE_INFINITY;
      const intoReview = events.find(
        (e) =>
          e.type === "card/status_changed" &&
          (e.payload as { toStatus?: string }).toStatus === "review",
      )?.seq;
      expect(firstReview).toBeLessThan(intoReview as number);
    }
    // RG-P8-9: one dossier entry per finding, with verdict, citation, files read and model.
    const reviews = (await store.getDossier("c1")).reviews;
    expect(reviews.map((e) => [e.verdict, e.text])).toEqual([
      ["met", "append adds one entry (src/ledger.ts:2)"],
      [
        "unmet",
        "list returns the entries in order — list reverses the entries: the letter, not the intent. (src/ledger.ts:3)",
      ],
      [
        "unmet",
        "no test: list returns the entries in order — No staged test case names this criterion, so no check exercises it. (src/ledger.ts:3)",
      ],
      [
        "unmet",
        "assumption: Assumed: list keeps insertion order — list reverses the order. (src/ledger.ts:3)",
      ],
      ["coverage", "AI review read 1 of 1 file; 0 of 2 changed lines are cited by no finding."],
    ]);
    expect(reviews.every((e) => e.modelId === "gemma-4-26b" && e.actor === "reviewer")).toBe(true);
    expect(reviews[0]?.sources).toEqual(["src/ledger.ts"]);
    // ...and beside the evidence bundle, which stays sealed by its hash.
    const side = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "review-ev_c1.json"), "utf8"),
    );
    expect(side).toMatchObject({ cardId: "c1", modelId: "gemma-4-26b", notRead: [] });
    expect(side.findings).toHaveLength(4);
    // Seshat's snapshot of the card holds them, with verdict and model.
    const lines = await dossierLines(store, "c1");
    expect(lines).toContain(
      "- review met (reviewer, gemma-4-26b): append adds one entry (src/ledger.ts:2)",
    );
  });

  it("RG-P8-11: the Review model reads the assumptions and the diff, never the Worker's transcript", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    await runTour();
    const sent = `${model.callHistory[0]?.systemPrompt}\n${model.callHistory[0]?.prompt}`;
    expect(sent).toContain("1. Assumed: list keeps insertion order");
    expect(sent).toContain("export const append");
    expect(sent).toContain("Criterion 1: tests/ledger.spec.ts: appends");
    for (const leak of ["WORKER TRANSCRIPT", "WORKER STEP", "WORKER LESSON", "transcript-c1"])
      expect(sent).not.toContain(leak);
    const got = await reviewerInput(ctx(), (await store.getCard("c1")) as never, {
      preferences: [],
      rules: [],
    });
    expect(Object.keys(got?.input ?? {}).sort()).toEqual([
      "assumptions",
      "card",
      "checks",
      "diff",
      "preferences",
      "rules",
      "stagedTests",
    ]);
  });

  it("RG-P8-12: Review shows the findings as AI review with the model, the change's own only", async () => {
    await waiting("c1");
    // A finding on an earlier attempt, before the latest evidence: not this change's.
    const stale = await store.recordDossierEntry({
      cardId: "c1",
      kind: "review",
      verdict: "unmet",
      text: "old finding",
    });
    await recordLedgerRun(store, {
      cardId: "c1",
      modelId: "cyber-tiel",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_c1",
      path: join(".sekhemet", "evidence", "ev_c1.json"),
      body: readFileSync(join(repo, ".sekhemet", "evidence", "ev_c1.json"), "utf8"),
      filesTouched: ["src/ledger.ts"],
    });
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    await runTour();
    const desk = await reviewDesk(
      { ...ctx(), eventLog: log },
      (await store.getCard("c1")) as never,
      store.localPrincipal(),
      { nameOf: () => undefined },
    );
    expect(desk.findings.map((f) => f.id)).not.toContain(stale.entryId);
    expect(desk.findings.every((f) => f.modelId === "gemma-4-26b")).toBe(true);
    const shown = reviewerFindings(desk.findings, new Set());
    expect(shown.title).toBe("AI review · gemma-4-26b · 3 unmet");
    expect(JSON.stringify(desk)).not.toMatch(/confiden/i);
    // Accept asks only for this change's unmet findings to be acknowledged.
    const friction = await acceptFriction(store, "c1", {}, []);
    expect(friction.findings).toHaveLength(3);
    expect(friction.findings).not.toContain(stale.entryId);
  });

  it("a review that cannot run says so on the card, which goes on to Review", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", []);
    model.generate = async () => {
      throw new Error("the Review model's server did not answer");
    };
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    await runTour();
    expect((await store.getCard("c1"))?.status).toBe("review");
    const [note] = (await store.getDossier("c1")).reviews;
    expect(note).toMatchObject({
      verdict: "not_reviewed",
      text: REVIEW_DESK_COPY.reviewFailed("the Review model's server did not answer"),
    });
  });

  it("a change with no diff is not held for review (§2.3.2)", async () => {
    await store.createCard({ id: "c0", tier: "story", title: "No change", scopeFiles: [] });
    const body = `${JSON.stringify({ id: "ev_c0", cardId: "c0", passed: true, diff: "" })}\n`;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_c0.json"), body);
    await recordLedgerRun(store, {
      cardId: "c0",
      modelId: "cyber-tiel",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_c0",
      path: join(".sekhemet", "evidence", "ev_c0.json"),
      body,
    });
    const flow = new ReviewFlow({
      ctx: ctx(),
      role: filled,
      access: deferredAccess(new MockInferenceAdapter("m", [])).access,
      learned,
    });
    expect(await flow.decide("c0")).toBeUndefined();
    expect((await store.getDossier("c0")).reviews).toEqual([]);
  });

  it("a stopped run's waiting cards are reviewed by the next run", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    expect(await flow.resume()).toEqual(["c1"]);
    await runTour();
    expect((await store.getCard("c1"))?.status).toBe("review");
  });
});

describe("auto-accept waits for the AI review (RG-P8-2)", () => {
  it("merges only after the findings are recorded, and they stay on the card", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    const seenAtAccept: number[] = [];
    const accepting = acceptAfterReview(flow, ctx(), "c1", async (card) => {
      seenAtAccept.push((await store.getDossier(card.id)).reviews.length);
      return "abc1234567";
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seenAtAccept).toEqual([]);
    await runTour();
    expect(await accepting).toBe("abc1234567");
    expect(seenAtAccept).toEqual([5]);
  });
});

describe("auto-accept never merges an unreviewed change (RG-P8-2)", () => {
  it("does not merge a card whose AI review could not run", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", []);
    model.generate = async () => {
      throw new Error("the Review model's server did not answer");
    };
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    const merged: string[] = [];
    const accepting = acceptAfterReview(flow, ctx(), "c1", async (card) => {
      merged.push(card.id);
      return "abc1234567";
    });
    await runTour();
    expect(await accepting).toBeUndefined();
    expect(merged).toEqual([]);
    // It waits in Review for a person, saying the review did not run.
    expect((await store.getCard("c1"))?.status).toBe("review");
    expect((await store.getDossier("c1")).reviews.map((e) => e.verdict)).toEqual(["not_reviewed"]);
  });

  it("writes which findings cite a checked line beside the bundle", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
    const { access, runTour } = deferredAccess(model);
    const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
    await flow.afterRun("c1");
    await runTour();
    const side = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "review-ev_c1.json"), "utf8"),
    );
    expect(side.cited).toEqual([true, true, true, true]);
  });
});

describe("the Review role and its family (RG-P8-10)", () => {
  const registry = {
    get: (id: string) => ({ "cyber-tiel": { family: "qwen" }, "dirk-27b": { family: "qwen" } })[id],
  };
  const fam = (m: string) => familyOf(m, registry);

  it("leaves the role unfilled when the only other model shares the Coding model's family", () => {
    expect(
      resolveReviewerRole({ planner: "dirk-27b", worker: "cyber-tiel", familyOf: fam }),
    ).toEqual({ state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer });
    expect(
      resolveReviewerRole({ reviewer: "qwen3-14b", worker: "cyber-tiel", familyOf: fam }),
    ).toEqual({ state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer });
    expect(
      resolveReviewerRole({ reviewer: "gemma-4-26b", worker: "cyber-tiel", familyOf: fam }),
    ).toEqual({ state: "filled", model: "gemma-4-26b", queue: "reviewer" });
    expect(
      resolveReviewerRole({ planner: "gemma-4-26b", worker: "cyber-tiel", familyOf: fam }),
    ).toEqual({ state: "filled", model: "gemma-4-26b", queue: "manager" });
  });

  it("resolves a model's name as the roster keys it, and fails closed on an unknown family", () => {
    // The roster records a managed model's family under its resolved id, not its name.
    const byId = new Map([
      [resolveWorkerModelId("cyber-tiel"), { family: "qwen" }],
      [resolveWorkerModelId("qwen3.8-27b"), { family: "qwen" }],
    ]);
    const roster = { get: (id: string) => byId.get(id) };
    const f = (m: string) => familyOf(m, roster);
    expect(f("cyber-tiel")).toBe("qwen");
    expect(familyOf("cyber-tiel")).toBe("qwen");
    expect(f(resolveWorkerModelId("cyber-tiel"))).toBe("qwen");
    expect(f("some-coder-7b")).toBeUndefined();
    // The queue passes the Coding model's name: a Qwen never reviews a Qwen.
    for (const reviewer of ["qwen3.8-27b", "dirk", "some-coder-7b"])
      expect(
        resolveReviewerRole({ reviewer, worker: "cyber-tiel", familyOf: f }),
        reviewer,
      ).toEqual({ state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer });
    // A Coding model whose family is unknown cannot be shown to differ.
    expect(
      resolveReviewerRole({ reviewer: "gemma-4-26b", worker: "some-coder-7b", familyOf: f }),
    ).toEqual({ state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer });
    expect(
      resolveReviewerRole({ reviewer: "gemma-4-26b", worker: "cyber-tiel", familyOf: f }),
    ).toEqual({ state: "filled", model: "gemma-4-26b", queue: "reviewer" });
  });

  it("an unfilled role records the reason on the card, which Review shows", async () => {
    await waiting("c1");
    const model = new MockInferenceAdapter("dirk-27b", []);
    const { access } = deferredAccess(model);
    const role = resolveReviewerRole({ planner: "dirk-27b", worker: "cyber-tiel", familyOf: fam });
    const flow = new ReviewFlow({ ctx: ctx(), role, access, learned });
    expect(await flow.decide("c1")).toBeUndefined();
    const desk = await reviewDesk(
      { ...ctx(), eventLog: log },
      (await store.getCard("c1")) as never,
      store.localPrincipal(),
      { nameOf: () => undefined },
    );
    expect(reviewerAbsence(desk.findings)).toBe(
      "No AI review: no Review model outside the Coding model's family is configured.",
    );
    expect(model.callHistory).toHaveLength(0);
    // A card a stopped run left waiting goes on to Review with the reason.
    expect(await flow.resume()).toEqual(["c1"]);
    expect((await store.getCard("c1"))?.status).toBe("review");
  });
});

describe("a send-back note that names nothing stays a note (RG-P8-15)", () => {
  async function inReview(id: string) {
    await waiting(id);
    await store.updateCard(id, { blockedReason: null }, "executor");
    await store.updateCardStatus(id, "review", "reviewed", "executor", { override: true });
  }
  const tctx = () => ({ ...ctx(), log });

  it("keeps a vague note in the dossier and proposes no playbook rule", async () => {
    await inReview("c1");
    await sendBack(
      tctx() as never,
      (await store.getCard("c1")) as never,
      "Not quite what I wanted.",
    );
    expect((await store.getDossier("c1")).sendBacks.map((e) => e.text)).toEqual([
      "Not quite what I wanted.",
    ]);
    expect(await store.cardEvents("c1", ["playbook/candidate"])).toHaveLength(0);
    expect(await log.getEventsByTypes(["learn/rule"])).toHaveLength(0);
  });

  it("tells an anchored note from a vague one", () => {
    for (const vague of [
      "Not quite what I wanted.",
      "e.g. make it cleaner, i.e. simpler",
      "the tests don't really cover what I asked",
      "the types feel off and the format is messy",
      "the architecture is not what I had in mind",
      "keep secrets out of it and build it properly",
    ])
      expect(namesAnchor(vague), vague).toBe(false);
    for (const anchored of [
      "src/a.ts:12 is wrong",
      "call parseDate() first",
      "use snake_case keys",
      "lint fails",
      "throws TypeError",
      "the tests fail on an empty cart",
      "the coverage gate dropped",
      "semgrep flags the query",
    ])
      expect(namesAnchor(anchored), anchored).toBe(true);
  });

  it("a note naming a file, a symbol, a check or an error pattern is a playbook candidate", async () => {
    for (const [id, note] of [
      ["c1", "src/ledger.ts should keep insertion order"],
      ["c2", "Rename `append` to add"],
      ["c3", "The typecheck check fails on TS2322 here"],
    ] as const) {
      await inReview(id);
      await sendBack(tctx() as never, (await store.getCard(id)) as never, note);
      expect(await store.cardEvents(id, ["playbook/candidate"]), note).toHaveLength(1);
    }
  });
});

it("the evidence directory holds the review beside the bundle, never inside it", async () => {
  await waiting("c1");
  const before = readFileSync(join(repo, ".sekhemet", "evidence", "ev_c1.json"), "utf8");
  const model = new MockInferenceAdapter("gemma-4-26b", [verdicts()]);
  const { access, runTour } = deferredAccess(model);
  const flow = new ReviewFlow({ ctx: ctx(), role: filled, access, learned });
  await flow.afterRun("c1");
  await runTour();
  expect(readFileSync(join(repo, ".sekhemet", "evidence", "ev_c1.json"), "utf8")).toBe(before);
  expect(existsSync(join(repo, ".sekhemet", "evidence", "review-ev_c1.json"))).toBe(true);
});
