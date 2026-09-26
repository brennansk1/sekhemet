import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  type Attempt,
  describeTuning,
  loadAttempts,
  replay,
  scorePolicy,
  tune,
  tuneForRepo,
} from "../src/tune.js";

const steps = (n: number, passAt?: number, failAt: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    durationMs: 10_000,
    ...(passAt === i + 1
      ? { gate: { passed: true } }
      : failAt.includes(i + 1)
        ? { gate: { passed: false } }
        : {}),
  }));

describe("replay policy tuner", () => {
  const attempts: Attempt[] = [
    { run: "r", cardId: "a", attempt: 1, steps: steps(3, 3) },
    { run: "r", cardId: "b", attempt: 1, steps: steps(40, undefined, [5, 10, 20, 30]) },
    { run: "r", cardId: "b", attempt: 2, steps: steps(2, 2) },
  ];

  it("never invents a pass: a tighter budget can only stop a trajectory earlier", () => {
    expect(replay(attempts[0] as Attempt, { stepBudget: 2, maxFailedChecks: 9 }).passed).toBe(
      false,
    );
    expect(replay(attempts[0] as Attempt, { stepBudget: 3, maxFailedChecks: 9 }).passed).toBe(true);
  });

  it("stops a hopeless attempt early and keeps the retry's pass", () => {
    const loose = scorePolicy(attempts, { stepBudget: 40, maxFailedChecks: 4 });
    const tight = scorePolicy(attempts, { stepBudget: 12, maxFailedChecks: 2 });
    expect([loose.firstTry, loose.eventually]).toEqual([1, 2]);
    expect([tight.firstTry, tight.eventually]).toEqual([1, 2]);
    expect(tight.minutes).toBeLessThan(loose.minutes);
  });

  it("recommends the fastest policy that loses no pass", () => {
    const r = tune(attempts, { stepBudget: 40, maxFailedChecks: 4 });
    expect(r.best.eventually).toBe(r.current.eventually);
    expect(r.best.minutes).toBeLessThan(r.current.minutes);
  });
});

describe("a repository with little history inherits the machine's tuning (MS-T8-11)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sek-tune-"));
  const many = (cls: string, n: number): Attempt[] =>
    Array.from({ length: n }, (_, i) => ({
      run: "r",
      cardId: `${cls}_${i}`,
      attempt: 1,
      cardClass: cls,
      steps: steps(30, 3),
    }));

  it("tunes locally on the classes with enough attempts, and records the machine's report", () => {
    const d = dir();
    const globalPath = join(d, "global.json");
    const r = tuneForRepo([...many("implement:ts", 5), ...many("fix:ts", 2)], {
      current: { stepBudget: 40, maxFailedChecks: 4 },
      globalPath,
      repo: "/repo/a",
    });
    expect(r.kind).toBe("local");
    expect(r.kind === "local" && r.report.current.cards).toBe(5);
    // It is the machine's *last tuned* report, whether or not it was applied (review minor 7).
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toMatchObject({
      from: "/repo/a",
      meaning: expect.stringMatching(/last repository tuned/),
    });
  });

  it("with fewer than MIN_ARM_TRIALS attempts in every class, proposes the machine's policy, labelled inherited", () => {
    const d = dir();
    const globalPath = join(d, "global.json");
    tuneForRepo(many("implement:ts", 6), {
      current: { stepBudget: 40, maxFailedChecks: 4 },
      globalPath,
      repo: "/repo/a",
    });
    const r = tuneForRepo(many("implement:ts", 4), {
      current: { stepBudget: 40, maxFailedChecks: 4 },
      globalPath,
      repo: "/repo/b",
    });
    expect(r).toMatchObject({ kind: "inherited", from: "/repo/a" });
    expect(r.kind === "inherited" && r.policy.stepBudget).toBeLessThan(40);
    expect(describeTuning(r)).toMatch(
      /^Inherited from \/repo\/a, the last repository tuned on this machine/,
    );
  });

  it("with no machine report either, reports insufficient data and proposes nothing", () => {
    const r = tuneForRepo(many("fix:ts", 2), {
      current: { stepBudget: 40, maxFailedChecks: 4 },
      globalPath: join(dir(), "none.json"),
      repo: "/repo/c",
    });
    expect(r.kind).toBe("insufficient data");
    expect(describeTuning(r)).toMatch(/insufficient data: no class has 5 recorded attempts/);
  });
});

describe("WL-N5-2: tune reads attempts from the attempt records", () => {
  it("groups each finished attempt's steps by attempt id, numbered by its record, skipping a running attempt and a person's", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tune-ledger-"));
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    await store.createCard({ id: "a", tier: "story", title: "Add a parser" });
    const step = (attemptId: string, turn: number, gate?: boolean) =>
      store.recordEvent({
        type: "card/step",
        cardId: "a",
        actor: "executor",
        attemptId,
        payload: {
          turn,
          usage: { durationMs: 1000 },
          ...(gate !== undefined ? { gate: { passed: gate } } : {}),
        },
      });
    const start = (builtBy?: { kind: "person"; id: string }) =>
      store.runs.startAttempt({
        cardId: "a",
        attemptNumber: store.runs.nextAttemptNumber("a"),
        modelId: "m",
        ...(builtBy ? { builtBy } : {}),
      });
    const one = await start();
    await step(one.id, 1);
    await step(one.id, 2, false);
    await store.runs.finishAttempt({
      attemptId: one.id,
      status: "failed",
      stopReason: "no_progress",
      tokensUsed: 1,
      secondsUsed: 2,
    });
    const two = await start();
    await step(two.id, 1);
    await step(two.id, 2, true);
    await store.runs.finishAttempt({
      attemptId: two.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 1,
      secondsUsed: 2,
    });
    const person = await start({ kind: "person", id: "p_1" });
    await step(person.id, 1, true);
    await store.runs.finishAttempt({
      attemptId: person.id,
      status: "passed",
      stopReason: "gate_passed",
      tokensUsed: 0,
      secondsUsed: 1,
    });
    const running = await start();
    await step(running.id, 1);
    db.close();

    const attempts = loadAttempts([repo]);
    expect(attempts.map((a) => [a.cardId, a.attempt, a.steps.length])).toEqual([
      ["a", 1, 2],
      ["a", 2, 2],
    ]);
    expect(attempts[1]?.steps.at(-1)?.gate).toEqual({ passed: true });
    expect(attempts[0]?.cardClass).toBeDefined();
  });
});
