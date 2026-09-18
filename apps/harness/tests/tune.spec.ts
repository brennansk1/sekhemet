import { describe, expect, it } from "vitest";
import { type Attempt, replay, scorePolicy, tune } from "../src/tune.js";

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
