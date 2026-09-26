import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AttemptOutcome,
  CardStore,
  EventLog,
  RUN_EVENTS,
  firstModelAttempts,
  initSchema,
  measuresModel,
  readAttemptOutcomes,
} from "../src/index.js";

/**
 * One attempt record (worker-loop rule 39, WL-N5-1, WL-N5-2, MD-N6-2): every
 * attempt ends with one self-contained `attempt/finished` event, and the one
 * reader of outcomes reads those events and nothing else.
 */
describe("WL-N5-1/2: one attempt record and one reader", () => {
  let dir: string;
  let path: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;

  beforeEach(async () => {
    // A real database file (DoD §2A).
    dir = mkdtempSync(join(tmpdir(), "kernel-outcomes-"));
    path = join(dir, "events.db");
    db = new DatabaseSync(path);
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "card_a", tier: "story", title: "A" });
    await store.createCard({ id: "card_b", tier: "story", title: "B" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("WL-N5-1: the finished event carries the attempt number, rung, arm, role, model, rules, exemplars, steps, tokens, builtBy and stop reason", async () => {
    const first = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: store.runs.nextAttemptNumber("card_a"),
      modelId: "worker-m",
      toolArm: "B",
    });
    await store.runs.finishAttempt({
      attemptId: first.id,
      status: "failed",
      stopReason: "budget_exhausted",
      tokensUsed: 900,
      secondsUsed: 12,
      rung: 3,
      role: "worker",
      ruleIds: ["r_1", "r_2"],
      withheldRuleIds: ["r_3"],
      exemplarIds: ["card_x"],
      steps: 7,
      cardClass: "feature:ts",
      projectId: "proj",
      linesAdded: 12,
      repairPlanId: "plan_1",
    });
    const second = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: store.runs.nextAttemptNumber("card_a"),
      modelId: "worker-m",
    });
    await store.runs.finishAttempt({
      attemptId: second.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 400,
      secondsUsed: 5,
      steps: 3,
    });

    const events = await log.getEventsByTypes([RUN_EVENTS.attemptFinished]);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({
      attemptId: first.id,
      cardId: "card_a",
      attemptNumber: 1,
      rung: 3,
      toolArm: "B",
      role: "worker",
      modelId: "worker-m",
      ruleIds: ["r_1", "r_2"],
      withheldRuleIds: ["r_3"],
      exemplarIds: ["card_x"],
      steps: 7,
      tokensUsed: 900,
      builtBy: { kind: "worker", id: "worker-m" },
      stopReason: "budget_exhausted",
      repairPlanId: "plan_1",
    });
    // The second run of a card carries attempt number 2, and defaults are explicit.
    expect(events[1]?.payload).toMatchObject({
      attemptNumber: 2,
      rung: 1,
      toolArm: "A",
      role: "worker",
      ruleIds: [],
      withheldRuleIds: [],
      exemplarIds: [],
    });
    // The rung it ended at is the attempt row's rung too.
    expect(store.runs.getAttempt(first.id)?.rung).toBe(3);
  });

  it("WL-N5-2: readAttemptOutcomes reads attempt/finished records only, in ledger order, running attempts excluded", async () => {
    const a = await store.runs.startAttempt({ cardId: "card_a", attemptNumber: 1, modelId: "m" });
    const b = await store.runs.startAttempt({
      cardId: "card_b",
      attemptNumber: 1,
      modelId: "m",
      builtBy: { kind: "person", id: "p_1" },
    });
    await store.runs.startAttempt({ cardId: "card_b", attemptNumber: 2, modelId: "m" });
    await store.runs.finishAttempt({
      attemptId: b.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 0,
      secondsUsed: 60,
    });
    await store.runs.finishAttempt({
      attemptId: a.id,
      status: "failed",
      stopReason: "no_progress",
      tokensUsed: 10,
      secondsUsed: 1,
      ruleIds: ["r_1"],
    });

    const outcomes = store.runs.readAttemptOutcomes();
    expect(outcomes.map((o) => o.attemptId)).toEqual([b.id, a.id]);
    expect(outcomes[0]).toMatchObject({
      cardId: "card_b",
      attemptNumber: 1,
      passed: true,
      builtBy: { kind: "person", id: "p_1" },
    });
    expect(outcomes[1]).toMatchObject({
      passed: false,
      stopReason: "no_progress",
      ruleIds: ["r_1"],
    });
    expect(store.runs.readAttemptOutcomes({ cardId: "card_a" }).map((o) => o.attemptId)).toEqual([
      a.id,
    ]);

    // A read-only handle on the ledger file reads the same (tune, capability).
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readAttemptOutcomes(ro)).toEqual(outcomes);
    } finally {
      ro.close();
    }
  });

  it("WL-N5-2: a finished event written before the record was extended is completed from its started event", async () => {
    const a = await store.runs.startAttempt({
      cardId: "card_a",
      attemptNumber: 1,
      modelId: "old-m",
      toolArm: "C",
    });
    // The pre-extension payload, as older ledgers hold it.
    await log.append({
      actor: "executor",
      type: RUN_EVENTS.attemptFinished,
      cardId: "card_a",
      attemptId: a.id,
      payload: {
        attemptId: a.id,
        status: "passed",
        stopReason: "gate_passed",
        tokensUsed: 5,
        secondsUsed: 2,
        completedAt: new Date().toISOString(),
      },
    });
    const [o] = store.runs.readAttemptOutcomes();
    expect(o).toMatchObject({
      attemptId: a.id,
      cardId: "card_a",
      attemptNumber: 1,
      modelId: "old-m",
      toolArm: "C",
      rung: 1,
      role: "worker",
      builtBy: { kind: "worker", id: "old-m" },
      ruleIds: [],
      exemplarIds: [],
      passed: true,
    });
  });

  it("refuses an unknown role or a rung outside the ladder on finish", async () => {
    const a = await store.runs.startAttempt({ cardId: "card_a", attemptNumber: 1, modelId: "m" });
    const base = {
      attemptId: a.id,
      status: "failed" as const,
      stopReason: "no_progress" as const,
      tokensUsed: 0,
      secondsUsed: 0,
    };
    await expect(store.runs.finishAttempt({ ...base, rung: 5 as never })).rejects.toThrow(/Rung/);
    await expect(store.runs.finishAttempt({ ...base, role: "boss" as never })).rejects.toThrow(
      /role/,
    );
  });

  it("K8: the extended record replays byte-identically", async () => {
    const a = await store.runs.startAttempt({ cardId: "card_a", attemptNumber: 1, modelId: "m" });
    await store.runs.finishAttempt({
      attemptId: a.id,
      status: "failed",
      stopReason: "no_progress",
      tokensUsed: 1,
      secondsUsed: 1,
      rung: 2,
      toolArm: "B",
    });
    const before = store.runs.getAttempt(a.id);
    db.exec("DELETE FROM attempts");
    for (const e of await log.getEventsByTypes([
      RUN_EVENTS.attemptStarted,
      RUN_EVENTS.attemptFinished,
    ])) {
      store.runs.applyEvent(e);
    }
    expect(store.runs.getAttempt(a.id)).toEqual(before);
    expect(before).toMatchObject({ rung: 2, toolArm: "B" });
  });
});

/** An outcome with only the fields the first-attempt rule reads. */
const outcome = (o: Partial<AttemptOutcome> & Pick<AttemptOutcome, "cardId" | "attemptNumber">) =>
  ({
    seq: 0,
    attemptId: `${o.cardId}-${o.attemptNumber}`,
    rung: 0,
    toolArm: "full",
    role: "worker",
    modelId: "m",
    status: "failed",
    passed: false,
    stopReason: "no_progress",
    tokensUsed: 0,
    secondsUsed: 0,
    ruleIds: [],
    withheldRuleIds: [],
    exemplarIds: [],
    builtBy: { kind: "worker" },
    completedAt: "2026-09-25T00:00:00Z",
    ...o,
  }) as AttemptOutcome;

describe("MD-N6-2 (B4.0a review M2): a card's first attempt is its first that measures the Worker", () => {
  it("skips a halted attempt and a person's, so a resume after a halt is the card's first try", () => {
    const outcomes = [
      outcome({ cardId: "a", attemptNumber: 1, stopReason: "memory_pressure" }),
      outcome({
        cardId: "a",
        attemptNumber: 2,
        stopReason: "gate_passed",
        passed: true,
        status: "passed",
      }),
      outcome({
        cardId: "b",
        attemptNumber: 1,
        builtBy: { kind: "person", principal: "p_x" } as never,
      }),
      outcome({ cardId: "b", attemptNumber: 2, stopReason: "no_progress" }),
      outcome({ cardId: "c", attemptNumber: 1, stopReason: "crashed" }),
    ];
    expect(measuresModel(outcomes[0] as AttemptOutcome)).toBe(false);
    expect(firstModelAttempts(outcomes).map((o) => [o.cardId, o.attemptNumber, o.passed])).toEqual([
      ["a", 2, true],
      ["b", 2, false],
    ]);
  });
});
