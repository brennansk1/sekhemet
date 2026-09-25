import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type SuiteRunResult,
  type SuiteTask,
  compareRuns,
  loadFrozenSuite,
  passKByCard,
  runFrozenSuite,
  summarise,
} from "../src/suite.js";

/** A repository with a two-fixture suite, so the hash has something to cover. */
function repo(opts: { body?: string; tasks?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "suite-"));
  mkdirSync(join(root, "fixtures", "alpha", "src"), { recursive: true });
  writeFileSync(
    join(root, "fixtures", "suite.json"),
    JSON.stringify({
      version: "1.0.0",
      fixtures: [{ name: "alpha", tasks: opts.tasks ?? 2 }],
    }),
  );
  writeFileSync(
    join(root, "fixtures", "alpha", "cards.json"),
    JSON.stringify([
      { id: "card_a", title: "A" },
      { id: "card_b", title: "B" },
    ]),
  );
  writeFileSync(
    join(root, "fixtures", "alpha", "src", "a.ts"),
    opts.body ?? "export const a = 1;\n",
  );
  return root;
}

const outcome = (passed: boolean, rungs = 0) => ({
  passed,
  wallClockSeconds: 60,
  tokens: 1000,
  rungs,
});

describe("the frozen suite", () => {
  it("loads its tasks from the fixtures the manifest names", () => {
    const suite = loadFrozenSuite(repo());
    expect(suite.version).toBe("1.0.0");
    expect(suite.tasks.map((t) => t.cardId)).toEqual(["card_a", "card_b"]);
    expect(suite.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes its hash when a fixture's contents change", () => {
    // This is what "frozen" means: editing a task to flatter a result makes
    // the two runs incomparable instead of making the result look better.
    const before = loadFrozenSuite(repo({ body: "export const a = 1;\n" }));
    const after = loadFrozenSuite(repo({ body: "export const a = 2;\n" }));
    expect(after.hash).not.toBe(before.hash);
  });

  it("gives the same hash for the same bytes", () => {
    expect(loadFrozenSuite(repo()).hash).toBe(loadFrozenSuite(repo()).hash);
  });

  it("refuses a fixture that has lost a task rather than scoring fewer", () => {
    // A vanished task would otherwise read as a clean run over a shorter list.
    expect(() => loadFrozenSuite(repo({ tasks: 3 }))).toThrow(/declares 3 tasks, found 2/);
  });

  it("names the fixture that is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "suite-"));
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "fixtures", "suite.json"),
      JSON.stringify({ version: "1.0.0", fixtures: [{ name: "ghost", tasks: 1 }] }),
    );
    expect(() => loadFrozenSuite(root)).toThrow(/no fixture ghost/);
  });
});

describe("running it", () => {
  it("reduces a run to one number and the cost that bought it", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async (t: SuiteTask) =>
      outcome(t.cardId === "card_a", t.cardId === "card_a" ? 0 : 2),
    );
    expect(r.passed).toBe(1);
    expect(r.total).toBe(2);
    expect(r.firstTry).toBe(1);
    expect(r.cost).toEqual({ wallClockSeconds: 120, tokens: 2000, rungs: 2 });
    expect(r.suiteHash).toBe(suite.hash);
  });

  it("counts a task that throws as a task that did not pass", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async (t) => {
      if (t.cardId === "card_b") throw new Error("model unreachable");
      return outcome(true);
    });
    expect(r.passed).toBe(1);
    expect(r.total).toBe(2);
    expect(r.outcomes[1]?.stopReason).toContain("model unreachable");
  });

  it("separates a pass that needed repair from one that did not", async () => {
    const suite = loadFrozenSuite(repo());
    const r = await runFrozenSuite(suite, async () => outcome(true, 3));
    expect(r.passed).toBe(2);
    expect(r.firstTry).toBe(0);
  });
});

describe("comparing two runs (M12: paired and exact)", () => {
  /** A run of n cards; `pass(i)` says whether card i passed, `blocked(i)` whether it was blocked. */
  const run = (
    n: number,
    pass: (i: number) => boolean,
    over: { blocked?: (i: number) => boolean; rungs?: number; suiteHash?: string } = {},
  ): SuiteRunResult => {
    const outcomes = Array.from({ length: n }, (_, i) => ({
      task: { suite: "alpha", cardId: `card_${i}`, title: `T${i}` },
      passed: pass(i),
      ...(over.blocked?.(i) ? { blocked: true } : {}),
      wallClockSeconds: 60,
      tokens: 1000,
      rungs: 0,
    }));
    return {
      suiteHash: over.suiteHash ?? "h",
      version: "1.0.0",
      passed: outcomes.filter((o) => o.passed).length,
      total: n,
      firstTry: outcomes.filter((o) => o.passed).length,
      outcomes,
      cost: { wallClockSeconds: 60 * n, tokens: 1000 * n, rungs: over.rungs ?? 0 },
      at: "2026-09-20T00:00:00.000Z",
    };
  };

  it("MS-M12-3: one more task, not significant, is not an improvement (the old expectation reversed)", () => {
    const base = run(30, (i) => i < 15);
    const v = compareRuns(
      base,
      run(30, (i) => i < 16),
    );
    expect(v).toMatchObject({
      comparable: true,
      improved: false,
      delta: 1,
      candidateOnly: 1,
      baselineOnly: 0,
      verdict: "not established",
    });
    expect(v.p).toBe(1);
    expect(v.reason).toMatch(/not established/);
  });

  it("MS-M12-2: pairs only the cards run in both, and reports the discordant counts, the exact p and the smallest detectable difference", () => {
    // 30 cards: the candidate passes 22 the baseline failed, and loses none.
    const base = run(30, (i) => i < 4);
    const cand = run(32, (i) => i < 26 || i >= 30);
    const v = compareRuns(base, cand);
    expect(v.paired).toBe(30);
    expect([v.baselineOnly, v.candidateOnly]).toEqual([0, 22]);
    expect(v.p).toBeCloseTo(2 / 2 ** 22, 12);
    expect(v.improved).toBe(true);
    expect(v.verdict).toBe("improved");
    expect(v.minDetectable).toBeGreaterThan(0);
    expect(v.reason).toMatch(/smallest difference detectable at 80% power/);
  });

  it("counts a card blocked in only one run as that run's failure, and drops it only when blocked in both (review B1)", () => {
    // The candidate fails card 0 and has cards 1-5 blocked; card 6 is blocked in both.
    const blockedIn = (r: SuiteRunResult, ids: number[]) => ({
      ...r,
      outcomes: r.outcomes.map((o, i) =>
        ids.includes(i) ? { ...o, passed: false, blocked: true } : o,
      ),
    });
    const base = blockedIn(
      run(30, () => true),
      [6],
    );
    const cand = blockedIn(
      run(30, (i) => i !== 0),
      [1, 2, 3, 4, 5, 6],
    );
    const v = compareRuns(base, cand);
    expect(v.paired).toBe(29);
    expect(v.droppedBlocked).toBe(1);
    expect(v.baselineOnly).toBe(6);
    expect(v.verdict).toBe("worse");
    expect(v.reason).toMatch(/1 card blocked in both runs left out/);
  });

  it("MS-M12-4: a significant effect under 20 points is marked not established", () => {
    // 100 cards, 10 more passes and none lost: p = 0.002, but only 10 points.
    const v = compareRuns(
      run(100, (i) => i < 50),
      run(100, (i) => i < 60),
    );
    expect(v.p).toBeLessThan(0.05);
    expect(v.improved).toBe(false);
    expect(v.verdict).toBe("not established");
  });

  it("pairs a card blocked in one run as that run's failure, and leaves out one blocked in both (review B1)", () => {
    const base = run(10, () => false, { blocked: (i) => i === 0 });
    expect(
      compareRuns(
        base,
        run(10, () => false),
      ).paired,
    ).toBe(10);
    const both = compareRuns(
      base,
      run(10, () => false, { blocked: (i) => i === 0 }),
    );
    expect([both.paired, both.droppedBlocked]).toEqual([9, 1]);
  });

  it("reports a resolvable loss as worse", () => {
    const v = compareRuns(
      run(30, () => true),
      run(30, (i) => i >= 22),
    );
    expect(v).toMatchObject({ improved: false, verdict: "worse", baselineOnly: 22 });
  });

  it("refuses to compare runs of different suites", () => {
    const v = compareRuns(
      run(10, () => true),
      run(10, () => true, { suiteHash: "other" }),
    );
    expect(v.comparable).toBe(false);
    expect(v.improved).toBe(false);
    expect(v.reason).toContain("different suites");
  });

  it("does not call an equal score with fewer repair rungs an improvement (rule 4)", () => {
    const v = compareRuns(
      run(10, (i) => i < 5, { rungs: 8 }),
      run(10, (i) => i < 5, { rungs: 5 }),
    );
    expect(v.improved).toBe(false);
    expect(v.verdict).toBe("no difference");
    expect(v.reason).toContain("fewer");
  });

  it("MS-M12-1: summarises passed over measured with a Clopper-Pearson interval, and blocked apart", () => {
    const r = run(10, (i) => i < 5, { blocked: (i) => i >= 8 });
    const line = summarise(r);
    expect(line).toContain("5/8 passed");
    expect(line).toContain("95% CI 24%-91%");
    expect(line).toContain("2 blocked");
    expect(line).toContain("repair rung");
  });

  it("MS-M12-5: reports pass@k and pass^k per card over repeated runs", () => {
    const runs = [run(2, () => true), run(2, (i) => i === 0), run(2, (i) => i === 0)];
    const byCard = passKByCard(runs, 2);
    expect(byCard).toEqual([
      { suite: "alpha", cardId: "card_0", runs: 3, passes: 3, passAtK: 1, passHatK: 1 },
      {
        suite: "alpha",
        cardId: "card_1",
        runs: 3,
        passes: 1,
        passAtK: expect.closeTo(2 / 3, 12),
        passHatK: 0,
      },
    ]);
  });
});
