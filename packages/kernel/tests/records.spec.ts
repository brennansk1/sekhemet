import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CardStore,
  CardStructureError,
  EventLog,
  MAX_CARD_DEPTH,
  RUN_EVENTS,
  initSchema,
} from "../src/index.js";

describe("@sekhemet/kernel run records, structure and projections (K4-K21, B5, B13)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(async () => {
    // A real database file, as DoD §2.A.1 requires.
    dir = mkdtempSync(join(tmpdir(), "kernel-records-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "card_a", tier: "story", title: "A" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an attempt with its steps, gate results and evidence, ids on every event (K4, K16-K19)", async () => {
    const attempt = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 1,
      modelId: "m",
    });
    const step = await store.runs.recordStep({
      attemptId: attempt.id,
      cardId: "card_a",
      stepIndex: 1,
      calls: [{ name: "write_file", argumentHash: "h", target: "src/a.ts", ok: true }],
      contextPackId: "pack1",
      promptTokens: 10,
      completionTokens: 2,
      durationMs: 5,
    });
    await store.runs.recordGateResult({
      attemptId: attempt.id,
      cardId: "card_a",
      stepId: step.id,
      gate: "typecheck",
      layer: "static",
      passed: false,
      exitCode: 2,
      durationMs: 9,
      failures: [{ errorExcerpt: "TS2304" }],
    });
    await store.runs.markStepCheckpoint(step.id, "abc1234");
    await store.runs.recordEvidence({
      id: "ev_1",
      cardId: "card_a",
      attemptId: attempt.id,
      passed: false,
      stopReason: "budget_exhausted",
      path: ".sekhemet/evidence/ev_1.json",
      sha256: "f".repeat(64),
      filesTouched: ["src/a.ts"],
      linesAdded: 3,
      linesRemoved: 0,
    });
    await store.runs.finishAttempt({
      attemptId: attempt.id,
      status: "failed",
      stopReason: "budget_exhausted",
      tokensUsed: 12,
      secondsUsed: 1,
      evidenceId: "ev_1",
    });

    expect(store.runs.listAttempts("card_a")).toMatchObject([
      { attemptNumber: 1, status: "failed", stopReason: "budget_exhausted", evidenceId: "ev_1" },
    ]);
    expect(store.runs.nextAttemptNumber("card_a")).toBe(2);
    expect(store.runs.listSteps(attempt.id)).toMatchObject([
      { stepIndex: 1, contextPackId: "pack1", gitRef: "abc1234" },
    ]);
    expect(store.runs.listGateResults(attempt.id)[0]).toMatchObject({
      gate: "typecheck",
      passed: false,
      stepId: step.id,
    });
    expect(store.runs.listEvidence("card_a")[0]?.filesTouched).toEqual(["src/a.ts"]);

    // K4: the typed columns are written, not only the payload.
    const events = await log.getEventsByCard("card_a");
    const stepEvent = events.find((e) => e.type === RUN_EVENTS.stepRecorded);
    expect(stepEvent?.attemptId).toBe(attempt.id);
    expect(stepEvent?.stepId).toBe(step.id);
    const gateEvent = events.find((e) => e.type === RUN_EVENTS.gateResult);
    expect(gateEvent?.stepId).toBe(step.id);
    expect((await log.verifyHashChain()).valid).toBe(true);
  });

  it("asks a decision and returns the answer another writer gives, or times it out (K20)", async () => {
    const d = await store.runs.requestDecision({
      cardId: "card_a",
      kind: "permission",
      question: "Allow `git push --force`?",
      context: "run_cmd in card_a",
      options: ["deny", "allow"],
    });
    // A second connection (the dashboard) answers while the runner waits.
    const other = new CardStore(new DatabaseSync(join(dir, "events.db")), log);
    let polls = 0;
    const answer = await store.runs.awaitDecision(d.id, {
      timeoutMs: 5000,
      sleep: async () => {
        polls++;
        if (polls === 2) await other.runs.answerDecision(d.id, 1, "human");
      },
    });
    expect(answer).toBe(1);
    expect(store.runs.getDecision(d.id)?.status).toBe("answered");

    const late = await store.runs.requestDecision({
      kind: "permission",
      question: "Allow curl?",
      context: "",
      options: ["deny", "allow"],
    });
    expect(await store.runs.awaitDecision(late.id, { timeoutMs: 0 })).toBeUndefined();
    expect(store.runs.getDecision(late.id)?.status).toBe("timed_out");
    await expect(store.runs.answerDecision(late.id, 1)).rejects.toThrow(/timed_out/);
  });

  it("summarises competence by class and model (K21)", async () => {
    const base = {
      repoId: "r",
      cardClass: "Path",
      filesTouchedCount: 1,
      difficulty: "S",
      modelId: "m",
      toolArm: "arm_a_flat",
      stepBudget: 40,
      tokensUsed: 1000,
      wallClockSeconds: 30,
    };
    await store.runs.recordCompetence({
      ...base,
      stepsUsed: 5,
      stopReason: "gate_passed",
      passed: true,
    });
    await store.runs.recordCompetence({
      ...base,
      stepsUsed: 9,
      stopReason: "gate_passed",
      passed: true,
    });
    await store.runs.recordCompetence({
      ...base,
      stepsUsed: 40,
      stopReason: "budget_exhausted",
      passed: false,
    });
    const c = store.runs.competence("Path", "m");
    expect(c.attempts).toBe(3);
    expect(c.passed).toBe(2);
    expect(c.passRate).toBeCloseTo(2 / 3);
    expect(c.stepsP80).toBe(9);
  });

  it("caps card nesting at card and subtask (K13)", async () => {
    expect(MAX_CARD_DEPTH).toBe(2);
    await store.createCard({ id: "card_sub", tier: "task", title: "sub", parentId: "card_a" });
    await expect(
      store.createCard({ id: "card_deep", tier: "task", title: "deep", parentId: "card_sub" }),
    ).rejects.toThrow(CardStructureError);
    expect(await store.getCard("card_deep")).toBeNull();
    // Refused before the ledger: no card/created event for it.
    const events = await log.getEventsByTypes(["card/created"]);
    expect(events.some((e) => e.cardId === "card_deep")).toBe(false);
  });

  it("keeps dependencies as checked edges and refuses a cycle on every write (K15, B5)", async () => {
    await store.createCard({ id: "card_b", tier: "story", title: "B", dependsOn: ["card_a"] });
    await store.createCard({ id: "card_c", tier: "story", title: "C", dependsOn: ["card_b"] });
    expect(store.getDependencies("card_c")).toEqual(["card_b"]);
    expect(store.getDependents("card_a")).toEqual(["card_b"]);
    expect((await store.getCard("card_b"))?.dependsOn).toEqual(["card_a"]);
    await expect(store.addDependency("card_a", "card_c")).rejects.toMatchObject({
      code: "dependency_cycle",
      path: ["card_a", "card_c", "card_b", "card_a"],
    });
    await expect(store.updateCard("card_a", { dependsOn: ["card_c"] })).rejects.toThrow(/cycle/);
    expect(store.waitingOn("card_c")).toEqual(["card_b"]);
  });

  it("scopes cards to projects and caps active projects (K14, B13)", async () => {
    store.activeProjectCap = 2;
    const p1 = await store.ensureProject({ rootPath: "/r/one", name: "one" });
    const p2 = await store.ensureProject({ rootPath: "/r/two", name: "two" });
    const p3 = await store.ensureProject({ rootPath: "/r/three", name: "three" });
    expect([p1.status, p2.status, p3.status]).toEqual(["active", "active", "paused"]);
    expect((await store.ensureProject({ rootPath: "/r/one", name: "x" })).id).toBe(p1.id);
    await expect(store.setProjectStatus(p3.id, "active")).rejects.toMatchObject({
      code: "project_cap",
    });
    await store.setProjectStatus(p2.id, "paused");
    expect((await store.setProjectStatus(p3.id, "active")).status).toBe("active");
    // A card created without a project joins the oldest active one.
    const card = await store.createCard({ id: "card_p", tier: "story", title: "P" });
    expect(card.projectId).toBe(p1.id);
  });

  it("refuses an actor outside the documented enum, in code and in SQL (K5)", async () => {
    await expect(log.append({ actor: "robot", type: "x", payload: {} })).rejects.toThrow(
      /Unknown event actor/,
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (id, actor, type, payload, hash, prev_hash) VALUES ('i', 'robot', 't', '{}', 'h', 'p')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rebuilds every projection byte-identically from the log, and notices a drifted row (K8)", async () => {
    const p = await store.ensureProject({ rootPath: "/r", name: "r" });
    await store.createCard({ id: "card_b", tier: "story", title: "B", dependsOn: ["card_a"] });
    await store.updateCardStatus("card_b", "in_progress");
    await store.updateCard("card_b", { stepsUsed: 3, blockedReason: "held: verify refused" });
    const a = await store.runs.startAttempt({ cardId: "card_b", attemptNumber: 1, modelId: "m" });
    await store.runs.recordStep({
      attemptId: a.id,
      cardId: "card_b",
      stepIndex: 1,
      calls: [],
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
    await store.recordCheckpoint({
      cardId: "card_b",
      step: 1,
      gitRef: "abc1234",
      gateStatus: "partial",
      agentModel: "m",
      agentHarness: "sekhemet",
      agentRole: "implementer",
      createdAt: new Date().toISOString(),
    });
    await store.setProjectStatus(p.id, "paused");

    const verdict = await store.verifyProjections();
    expect(verdict).toMatchObject({ identical: true, mismatched: [] });
    expect(verdict.eventsApplied).toBeGreaterThan(5);

    // A projection written around the ledger is drift, and is reported.
    db.prepare("UPDATE cards SET title = 'edited behind the log' WHERE id = 'card_b'").run();
    const drift = await store.verifyProjections();
    expect(drift.identical).toBe(false);
    expect(drift.mismatched).toEqual(["cards"]);
    // verify never changes anything; rebuild does, from the log.
    expect((await store.getCard("card_b"))?.title).toBe("edited behind the log");
    await store.rebuildProjections();
    expect((await store.getCard("card_b"))?.title).toBe("B");
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("records the rung and tool arm an attempt ran at (K16)", async () => {
    const first = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 1,
      modelId: "m",
    });
    const repair = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 2,
      modelId: "m",
      rung: 3,
      toolArm: "C",
    });

    // An attempt that does not say is the ladder's first rung on the baseline arm.
    expect(store.runs.getAttempt(first.id)).toMatchObject({ rung: 1, toolArm: "A" });
    expect(store.runs.getAttempt(repair.id)).toMatchObject({ rung: 3, toolArm: "C" });
    // The ledger is the source of truth: a rebuild must not lose either.
    await store.rebuildProjections();
    expect(store.runs.getAttempt(repair.id)).toMatchObject({ rung: 3, toolArm: "C" });

    await expect(
      store.runs.startAttempt({ cardId: "card_a", attemptNumber: 3, modelId: "m", rung: 7 as 4 }),
    ).rejects.toThrow(/Rung must be 1\.\.4/);
    await expect(
      store.runs.startAttempt({
        cardId: "card_a",
        attemptNumber: 3,
        modelId: "m",
        toolArm: "D" as "C",
      }),
    ).rejects.toThrow(/Tool arm must be A, B or C/);
  });

  it("keeps the review surface and a trajectory hash on the evidence row (G11, K19)", async () => {
    const attempt = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 1,
      modelId: "m",
    });
    await store.runs.recordStep({
      attemptId: attempt.id,
      cardId: "card_a",
      stepIndex: 1,
      calls: [],
      repoStateHash: "tree-1",
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
    // The reference must name the trajectory that produced the bundle, so it
    // is the slice as it stood before the bundle's own event joined it.
    const trajectory = store.runs.trajectoryHash(attempt.id);
    const evidence = await store.runs.recordEvidence({
      id: "ev_2",
      cardId: "card_a",
      attemptId: attempt.id,
      passed: true,
      stopReason: "gate_passed",
      path: ".sekhemet/evidence/ev_2.json",
      sha256: "a".repeat(64),
      filesTouched: ["src/a.ts"],
      linesAdded: 4,
      linesRemoved: 1,
      structuralDiff: "src/a.ts: function add() changed",
      gateResultsSummary: { typecheck: "pass", unit: "pass" },
      summary: {
        passedChecks: ["typecheck", "unit"],
        failedChecks: [],
        abandonedHypotheses: ["caching the parse result — the cache key was not stable"],
      },
    });

    const stored = store.runs.getEvidence("ev_2");
    expect(stored).toMatchObject({
      structuralDiff: "src/a.ts: function add() changed",
      gateResultsSummary: { typecheck: "pass", unit: "pass" },
      summary: {
        passedChecks: ["typecheck", "unit"],
        failedChecks: [],
        abandonedHypotheses: ["caching the parse result — the cache key was not stable"],
      },
    });
    // The trajectory reference is a hash of this attempt's event slice, not a path.
    expect(evidence.trajectoryRef).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.trajectoryRef).toBe(trajectory);

    // A second attempt on the same card has a different slice, so a different hash.
    const other = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 2,
      modelId: "m",
    });
    expect(store.runs.trajectoryHash(other.id)).not.toBe(store.runs.trajectoryHash(attempt.id));
    expect((await store.verifyProjections()).identical).toBe(true);
  });

  it("adds the actor CHECK to a legacy events table without touching the chain (K5 migration)", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "kernel-legacy-"));
    const legacy = new DatabaseSync(join(legacyDir, "events.db"));
    legacy.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, type TEXT NOT NULL, payload JSON NOT NULL, hash TEXT NOT NULL, prev_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
    );
    initSchema(legacy);
    const legacyLog = new EventLog(legacy);
    await legacyLog.append({ actor: "human", type: "t", payload: { a: 1 } });
    legacy.close();
    // Reopen an unchecked copy: build one by hand, then migrate.
    const raw = new DatabaseSync(join(legacyDir, "old.db"));
    raw.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, type TEXT NOT NULL, card_id TEXT, attempt_id TEXT, step_id TEXT, payload JSON NOT NULL, payload_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, prev_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
    );
    const rawLog = new EventLog(raw);
    await rawLog.append({ actor: "planner", type: "a", payload: { n: 1 } });
    await rawLog.append({ actor: "executor", type: "b", payload: { n: 2 } });
    const report = initSchema(raw);
    expect(report.rebuiltEventsTable).toBe(true);
    const verified = await new EventLog(raw).verifyHashChain();
    expect(verified).toMatchObject({ valid: true, totalEvents: 2 });
    expect(initSchema(raw).rebuiltEventsTable).toBe(false);
    raw.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
