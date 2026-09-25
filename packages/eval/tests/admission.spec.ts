import { describe, expect, it } from "vitest";
import {
  type AttemptFinished,
  type ChangeFootprint,
  evaluateHarnessChange,
  interleaveArms,
  ruleCredit,
  sequentialLook,
  watchAdmittedChange,
  watchPooled,
} from "../src/admission.js";
import { resolveRunProfile, runProfileHash } from "../src/run_profile.js";
import type { SuiteRunResult } from "../src/suite.js";

/** The profile a run records (rule 9a): the same in both arms unless an arm is named. */
const profile = (argv: string[] = []) => {
  const p = resolveRunProfile({
    env: {},
    argv: ["--worker", "cyber-tiel", "--auto-accept", ...argv],
  });
  return { ...p, hash: runProfileHash(p) };
};

// measurement.md rules 16a-16c, DEC-28 (T8): admission by a significant
// paired gain; the inconclusive rule; rule credit at fixed looks.

const run = (
  n: number,
  pass: (i: number) => boolean,
  tokens: (i: number) => number = () => 1000,
  startedAt = "2026-09-25T10:00:00.000Z",
): SuiteRunResult => {
  const outcomes = Array.from({ length: n }, (_, i) => ({
    task: { suite: "alpha", cardId: `card_${i}`, title: `T${i}` },
    passed: pass(i),
    wallClockSeconds: 60,
    tokens: tokens(i),
    rungs: 0,
  }));
  return {
    suiteHash: "h",
    version: "1.0.0",
    passed: outcomes.filter((o) => o.passed).length,
    total: n,
    firstTry: 0,
    outcomes,
    cost: { wallClockSeconds: 60 * n, tokens: 1000 * n, rungs: 0 },
    startedAt,
    at: "2026-09-25T12:00:00.000Z",
    runProfile: profile(),
  };
};

/**
 * The arms interleaved in time (A, B, A, B; rule 10, MS-T7-4): run i of the
 * baseline starts at 10:00 + 2i minutes, run i of the candidate a minute later.
 */
const interleaved = (which: "baseline" | "candidate", runs: SuiteRunResult[]): SuiteRunResult[] =>
  runs.map((r, i) => ({
    ...r,
    startedAt: new Date(
      Date.parse("2026-09-25T10:00:00.000Z") + (2 * i + (which === "baseline" ? 0 : 1)) * 60_000,
    ).toISOString(),
  }));

const footprint = (over: Partial<ChangeFootprint> = {}): ChangeFootprint => ({
  stablePromptTokens: 900,
  tools: 12,
  switches: 3,
  linesOfCode: 50_000,
  ...over,
});

const entry = {
  costMeasure: "median tokens per card" as const,
  recordedAt: "2026-09-25T09:00:00.000Z",
};

describe("harness changes: a significant paired gain, else the inconclusive rule (MS-T8-1, -2, -13)", () => {
  it("MS-T8-1: the same number of passes is not a gain", () => {
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      candidate: interleaved("candidate", [run(30, (i) => i >= 15), run(30, (i) => i >= 15)]),
      entry,
      change: { before: footprint(), after: footprint({ switches: 4 }) },
      version: "ctx-2",
    });
    expect(v.verdict).not.toBe("admitted");
    expect(v.verdict).toBe("not adopted");
  });

  it("MS-T8-2: needs at least two paired runs per arm", () => {
    expect(() =>
      evaluateHarnessChange({
        baseline: interleaved("baseline", [run(30, () => false)]),
        candidate: interleaved("candidate", [run(30, () => true)]),
        entry,
        change: { before: footprint(), after: footprint() },
        version: "ctx-2",
      }),
    ).toThrow(/at least two paired runs per arm/);
  });

  it("MS-T8-2: admits a gain only when the one-sided exact test rejects no gain at 0.05 with at least 20 points", () => {
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 10), run(30, (i) => i < 10)]),
      candidate: interleaved("candidate", [run(30, (i) => i < 18), run(30, (i) => i < 18)]),
      entry,
      change: { before: footprint(), after: footprint({ switches: 4 }) },
      version: "ctx-2",
    });
    // 16 pairs gained, none lost, over 60 paired cards: 27 points.
    expect(v.verdict).toBe("admitted");
    expect(v.gainP).toBeLessThan(0.05);
  });

  it("MS-T8-13: an inconclusive but simpler change is 'not established — simpler', with the version and the smallest detectable loss", () => {
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      candidate: interleaved("candidate", [run(30, (i) => i < 16), run(30, (i) => i < 14)]),
      entry,
      change: { before: footprint(), after: footprint({ stablePromptTokens: 850 }) },
      version: "ctx-2",
    });
    expect(v.verdict).toBe("not established — simpler");
    expect(v.version).toBe("ctx-2");
    expect(v.minDetectableLoss).toBeGreaterThan(0);
    expect(v.reason).toMatch(/smallest paired loss detectable at 80% power/);
  });

  it("MS-T8-13: 'simpler' is computed from the footprint: removing one thing and adding another is not simpler", () => {
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      candidate: interleaved("candidate", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      entry,
      change: { before: footprint(), after: footprint({ tools: 11, switches: 4 }) },
      version: "ctx-2",
    });
    expect(v.verdict).toBe("not adopted");
  });

  it("MS-T8-13: 'cheaper' needs a one-sided paired Wilcoxon p below 0.05 on median tokens per card", () => {
    const cheaper = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      candidate: interleaved("candidate", [
        run(
          30,
          (i) => i < 15,
          () => 800,
        ),
        run(
          30,
          (i) => i < 15,
          () => 800,
        ),
      ]),
      entry,
      change: { before: footprint(), after: footprint({ switches: 4 }) },
      version: "ctx-2",
    });
    expect(cheaper.verdict).toBe("not established — cheaper");
    expect(cheaper.wilcoxonP).toBeLessThan(0.05);
  });

  it("MS-T8-13: a lower median with Wilcoxon p above 0.05, adding a switch, is not adopted", () => {
    // Cheaper on 16 cards, dearer on 14 by the same amount: the median falls, the test does not reject.
    const tokens = (i: number) => (i < 16 ? 900 : 1100);
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
      candidate: interleaved("candidate", [
        run(30, (i) => i < 15, tokens),
        run(30, (i) => i < 15, tokens),
      ]),
      entry,
      change: { before: footprint(), after: footprint({ switches: 4 }) },
      version: "ctx-2",
    });
    expect(v.candidateMedianTokens).toBeLessThan(v.baselineMedianTokens);
    expect(v.wilcoxonP).toBeGreaterThan(0.05);
    expect(v.verdict).toBe("not adopted");
  });

  it("MS-T8-13: refuses an entry whose cost measure was written after its first card ran", () => {
    expect(() =>
      evaluateHarnessChange({
        baseline: interleaved("baseline", [run(30, () => true), run(30, () => true)]),
        candidate: interleaved("candidate", [run(30, () => true), run(30, () => true)]),
        entry: { costMeasure: "median tokens per card", recordedAt: "2026-09-25T10:30:00.000Z" },
        change: { before: footprint(), after: footprint() },
        version: "ctx-2",
      }),
    ).toThrow(/cost measure was recorded after the first card ran/);
  });

  it("does not adopt a change the suite shows is a loss, however much simpler", () => {
    const v = evaluateHarnessChange({
      baseline: interleaved("baseline", [run(30, () => true), run(30, () => true)]),
      candidate: interleaved("candidate", [run(30, (i) => i >= 12), run(30, (i) => i >= 12)]),
      entry,
      change: { before: footprint(), after: footprint({ tools: 10 }) },
      version: "ctx-2",
    });
    expect(v.verdict).toBe("not adopted");
    expect(v.reason).toMatch(/a loss the suite resolves/);
  });
});

/** Scripted `attempt/finished` records for one rule on comparable cards (rule 16b). */
function records(pairs: ("helpful" | "harmful" | "both" | "neither")[]): AttemptFinished[] {
  const out: AttemptFinished[] = [];
  pairs.forEach((kind, i) => {
    const withPassed = kind === "helpful" || kind === "both";
    const withoutPassed = kind === "harmful" || kind === "both";
    const base = { projectId: "p", cardClass: "implement:ts", attemptNumber: 1 };
    out.push(
      {
        ...base,
        cardId: `c${i}a`,
        rules: ["r1"],
        withheldRules: [],
        stopReason: withPassed ? "gate_passed" : "budget_exhausted",
      },
      {
        ...base,
        cardId: `c${i}b`,
        rules: [],
        withheldRules: ["r1"],
        stopReason: withoutPassed ? "gate_passed" : "budget_exhausted",
      },
    );
  });
  return out;
}
const repeat = <T>(x: T, n: number): T[] => Array.from({ length: n }, () => x);

describe("rule credit at fixed looks (MS-T8-14)", () => {
  it("retires a rule at 20 pairs with 1 helpful and 9 harmful (P about 0.011)", () => {
    const c = ruleCredit(
      records(["helpful", ...repeat("harmful" as const, 9), ...repeat("both" as const, 10)]),
      "r1",
    );
    expect(c).toMatchObject({ pairs: 20, helpful: 1, harmful: 9, credit: -8, status: "retired" });
    expect(c.retiredAt?.look).toBe(20);
    expect(c.retiredAt?.p).toBeCloseTo(0.0107, 3);
  });

  it("keeps a rule at 20 pairs with 2 helpful and 8 harmful (P about 0.055)", () => {
    const c = ruleCredit(
      records([
        ...repeat("helpful" as const, 2),
        ...repeat("harmful" as const, 8),
        ...repeat("neither" as const, 10),
      ]),
      "r1",
    );
    expect(c).toMatchObject({ pairs: 20, credit: -6, status: "kept" });
  });

  it("reports insufficient data below 20 pairs, whatever the harm", () => {
    const c = ruleCredit(
      records([...repeat("harmful" as const, 10), ...repeat("both" as const, 9)]),
      "r1",
    );
    expect(c).toMatchObject({ pairs: 19, helpful: 0, harmful: 10, status: "insufficient data" });
  });

  it("tests only at the looks: harm in pairs 21 to 39 retires nothing before pair 40", () => {
    const first20 = repeat("both" as const, 20);
    const c39 = ruleCredit(records([...first20, ...repeat("harmful" as const, 19)]), "r1");
    expect(c39).toMatchObject({ pairs: 39, harmful: 19, status: "kept" });
    const c40 = ruleCredit(records([...first20, ...repeat("harmful" as const, 20)]), "r1");
    expect(c40.status).toBe("retired");
    expect(c40.retiredAt?.look).toBe(40);
  });

  it("counts only first attempts on comparable cards, never a person's or a retry", () => {
    const rs = records(repeat("helpful" as const, 20));
    const noise: AttemptFinished[] = [
      {
        cardId: "x",
        projectId: "p",
        cardClass: "implement:ts",
        attemptNumber: 2,
        rules: [],
        withheldRules: ["r1"],
        stopReason: "gate_passed",
      },
      {
        cardId: "y",
        projectId: "p",
        cardClass: "implement:ts",
        attemptNumber: 1,
        builtBy: "person",
        rules: ["r1"],
        withheldRules: [],
        stopReason: "gate_passed",
      },
      {
        cardId: "z",
        projectId: "other",
        cardClass: "implement:ts",
        attemptNumber: 1,
        rules: [],
        withheldRules: ["r1"],
        stopReason: "gate_passed",
      },
    ];
    const c = ruleCredit([...rs.slice(0, 2), ...noise, ...rs.slice(2)], "r1");
    expect(c).toMatchObject({ pairs: 20, helpful: 20, harmful: 0, credit: 20 });
  });
});

describe("watching an admitted change: paired rollback (MS-T8-3, rule 18)", () => {
  it("rolls it back when later paired runs resolve a loss, and flags it", () => {
    // Without the change 20/30 pass; with it, 10 of those 20 fail and 1 other passes.
    const without = [run(30, (i) => i < 20), run(30, (i) => i < 20)];
    const withIt = [run(30, (i) => i < 10 || i === 25), run(30, (i) => i < 10 || i === 25)];
    const v = watchAdmittedChange({ changeId: "ctx-7", withChange: withIt, without });
    expect(v).toMatchObject({ status: "rolled back", pairedCards: 60, lost: 20, gained: 2 });
    expect(v.lossP).toBeLessThan(0.05);
    expect(v.reason).toMatch(/^rolled back: ctx-7 lost 20 and gained 2 over 60 paired cards/);
  });

  it("keeps it when no loss is resolved, naming the smallest loss the runs could have seen", () => {
    const without = [run(30, (i) => i < 20), run(30, (i) => i < 20)];
    const withIt = [run(30, (i) => i < 19 || i === 25), run(30, (i) => i < 20)];
    const v = watchAdmittedChange({ changeId: "ctx-7", withChange: withIt, without });
    expect(v.status).toBe("kept");
    expect(v.reason).toMatch(
      /no loss resolved.*smallest paired loss detectable at 80% power: \d+ points/,
    );
  });

  it("reports insufficient data with no paired runs, never an assumed baseline of 1.0", () => {
    const v = watchAdmittedChange({ changeId: "ctx-7", withChange: [], without: [] });
    expect(v).toMatchObject({ status: "insufficient data", pairedCards: 0 });
  });

  it("refuses runs on different suite hashes", () => {
    expect(() =>
      watchAdmittedChange({
        changeId: "x",
        withChange: [{ ...run(3, () => true), suiteHash: "other" }],
        without: [run(3, () => true)],
      }),
    ).toThrow(/different suite hashes/);
  });
});

describe("a card blocked in only one arm is that arm's failure (review B1)", () => {
  // 30 cards, 2 runs per arm: the candidate fails card 0, and cards 1-5 are
  // blocked only in its runs. Dropping them hid 10 of the 12 losses.
  const blocked = (r: SuiteRunResult, ids: number[]): SuiteRunResult => ({
    ...r,
    outcomes: r.outcomes.map((o, i) =>
      ids.includes(i) ? { ...o, passed: false, blocked: true } : o,
    ),
  });
  const baseline = interleaved("baseline", [run(30, () => true), run(30, () => true)]);
  const candidate = interleaved("candidate", [
    blocked(
      run(30, (i) => i !== 0),
      [1, 2, 3, 4, 5],
    ),
    blocked(
      run(30, (i) => i !== 0),
      [1, 2, 3, 4, 5],
    ),
  ]);

  it("admission sees 12 losses over 60 pairs and does not adopt the change", () => {
    const v = evaluateHarnessChange({
      baseline,
      candidate,
      entry,
      change: { before: footprint(), after: footprint({ stablePromptTokens: 850 }) },
      version: "ctx-3",
    });
    expect(v).toMatchObject({ pairedCards: 60, lost: 12, gained: 0, droppedBlocked: 0 });
    expect(v.lossP).toBeCloseTo(2 ** -12, 12);
    expect(v.verdict).toBe("not adopted");
  });

  it("the paired watch rolls it back, and a card blocked in both arms is dropped and counted", () => {
    const both = blocked(
      run(30, () => true),
      [7],
    );
    const v = watchAdmittedChange({
      changeId: "ctx-3",
      withChange: candidate.map((r) => blocked(r, [7])),
      without: [both, both],
    });
    expect(v).toMatchObject({
      status: "rolled back",
      lost: 12,
      pairedCards: 58,
      droppedBlocked: 2,
    });
  });
});

describe("admission refuses what cannot show the A/B was set up before it ran (review M2, M3)", () => {
  const args = (over: Partial<Parameters<typeof evaluateHarnessChange>[0]> = {}) => ({
    baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
    candidate: interleaved("candidate", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
    entry,
    change: { before: footprint(), after: footprint({ stablePromptTokens: 850 }) },
    version: "ctx-4",
    ...over,
  });

  it("refuses an entry whose cost measure is not the one rule 16c names, or whose date does not parse", () => {
    expect(() =>
      evaluateHarnessChange(
        args({ entry: { costMeasure: "mean tokens" as never, recordedAt: entry.recordedAt } }),
      ),
    ).toThrow(/cost measure must be "median tokens per card"/);
    expect(() =>
      evaluateHarnessChange(
        args({ entry: { costMeasure: entry.costMeasure, recordedAt: "yesterday" } }),
      ),
    ).toThrow(/not an ISO date/);
    expect(() =>
      evaluateHarnessChange(args({ entry: { costMeasure: entry.costMeasure } as never })),
    ).toThrow(/not an ISO date/);
  });

  it("with the entry's hash, refuses a run that does not carry it", () => {
    const withEntry = (r: SuiteRunResult) => ({
      ...r,
      abEntry: {
        sha256: "e".repeat(64),
        costMeasure: entry.costMeasure,
        recordedAt: entry.recordedAt,
      },
    });
    const ok = args({
      baseline: interleaved("baseline", [
        withEntry(run(30, (i) => i < 15)),
        withEntry(run(30, (i) => i < 15)),
      ]),
      candidate: interleaved("candidate", [
        withEntry(run(30, (i) => i < 15)),
        withEntry(run(30, (i) => i < 15)),
      ]),
      entrySha256: "e".repeat(64),
    });
    expect(evaluateHarnessChange(ok).verdict).toBe("not established — simpler");
    expect(() =>
      evaluateHarnessChange({
        ...ok,
        candidate: interleaved("candidate", [
          withEntry(run(30, (i) => i < 15)),
          run(30, (i) => i < 15),
        ]),
      }),
    ).toThrow(/does not carry the A\/B entry/);
  });

  it("refuses runs with no profile, mixed profiles within an arm, or arms that differ beyond the arm under test", () => {
    const noProfile = { ...run(30, (i) => i < 15), runProfile: undefined };
    expect(() =>
      evaluateHarnessChange(
        args({ candidate: interleaved("candidate", [noProfile, run(30, (i) => i < 15)]) }),
      ),
    ).toThrow(/records no RunProfile/);
    const other = { ...run(30, (i) => i < 15), runProfile: profile(["--max-turns", "20"]) };
    expect(() =>
      evaluateHarnessChange(
        args({ candidate: interleaved("candidate", [other, run(30, (i) => i < 15)]) }),
      ),
    ).toThrow(/more than one RunProfile within the candidate arm/);
    expect(() =>
      evaluateHarnessChange(args({ candidate: interleaved("candidate", [other, { ...other }]) })),
    ).toThrow(/differ in more than the arm under test/);
    const arm = {
      ...run(30, (i) => i < 15),
      runProfile: profile(["--max-turns", "20", "--arm", "steps=20"]),
    };
    expect(
      evaluateHarnessChange(args({ candidate: interleaved("candidate", [arm, { ...arm }]) }))
        .verdict,
    ).toBe("not established — simpler");
    const mixed = { ...run(30, (i) => i < 15), profileMismatch: ["alpha/card_3"] };
    expect(() =>
      evaluateHarnessChange(
        args({ candidate: interleaved("candidate", [mixed, run(30, (i) => i < 15)]) }),
      ),
    ).toThrow(/ran with a different profile.*alpha\/card_3/);
  });
});

describe("the arms are interleaved, and a sequential test may stop early at a stated error rate (MS-T7-4)", () => {
  const twoRuns = (pass: (i: number) => boolean) => [run(30, pass), run(30, pass)];
  const at = (runs: SuiteRunResult[], minutes: number[]) =>
    runs.map((r, i) => ({
      ...r,
      startedAt: new Date(
        Date.parse("2026-09-25T10:00:00.000Z") + (minutes[i] as number) * 60_000,
      ).toISOString(),
    }));

  it("refuses arms run one after the other, or runs whose order cannot be told", () => {
    const common = {
      entry,
      change: { before: footprint(), after: footprint({ stablePromptTokens: 850 }) },
      version: "ctx-5",
    };
    // A, A, B, B: the arm is confounded with time.
    expect(() =>
      evaluateHarnessChange({
        ...common,
        baseline: at(
          twoRuns((i) => i < 15),
          [0, 1],
        ),
        candidate: at(
          twoRuns((i) => i < 15),
          [2, 3],
        ),
      }),
    ).toThrow(/not interleaved/);
    // Two runs starting at the same moment cannot be ordered.
    expect(() =>
      evaluateHarnessChange({
        ...common,
        baseline: at(
          twoRuns((i) => i < 15),
          [0, 2],
        ),
        candidate: at(
          twoRuns((i) => i < 15),
          [0, 3],
        ),
      }),
    ).toThrow(/not interleaved/);
    // B, A, A, B is interleaved: each pair's order may be either way.
    expect(
      evaluateHarnessChange({
        ...common,
        baseline: at(
          twoRuns((i) => i < 15),
          [1, 2],
        ),
        candidate: at(
          twoRuns((i) => i < 15),
          [0, 3],
        ),
      }).verdict,
    ).toBe("not established — simpler");
  });

  it("orders each card's arms from a fixed seed, reproducibly", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      suite: "a",
      cardId: `c${i}`,
      title: "",
    }));
    const s1 = interleaveArms(tasks, 42);
    expect(interleaveArms(tasks, 42)).toEqual(s1);
    expect(interleaveArms(tasks, 43)).not.toEqual(s1);
    expect(s1).toHaveLength(40);
    // Each card appears once per arm, adjacent.
    for (let i = 0; i < 20; i++) {
      const pair = s1.slice(2 * i, 2 * i + 2);
      expect(pair.map((x) => x.task.cardId)).toEqual([`c${i}`, `c${i}`]);
      expect(new Set(pair.map((x) => x.arm))).toEqual(new Set(["baseline", "candidate"]));
    }
  });

  it("stops early only at a fixed look, each direction at alpha / (2 x looks) (review M4)", () => {
    // Planned 60 pairs, looks at 20, 40 and 60; both directions: 0.05 / 6 each.
    const plan = { plannedPairs: 60, looks: [20, 40, 60], alpha: 0.05 };
    expect(sequentialLook({ ...plan, pairs: 15, gained: 10, lost: 0 })).toMatchObject({
      stop: false,
      reason: expect.stringMatching(/no look yet/),
    });
    const early = sequentialLook({ ...plan, pairs: 20, gained: 9, lost: 0 });
    expect(early).toMatchObject({ stop: true, verdict: "gain", look: 20, alphaPerLook: 0.05 / 6 });
    expect(early.reason).toMatch(/each direction at most 0\.025 over 3 looks/);
    expect(sequentialLook({ ...plan, pairs: 20, gained: 5, lost: 0 })).toMatchObject({
      stop: false,
      look: 20,
    });
    // It fires at the first count at or past a look, once per look.
    expect(sequentialLook({ ...plan, pairs: 44, gained: 0, lost: 8 })).toMatchObject({
      stop: true,
      verdict: "loss",
      look: 40,
    });
    expect(
      sequentialLook({ ...plan, pairs: 25, gained: 9, lost: 0, testedLooks: [20] }),
    ).toMatchObject({ stop: false, reason: expect.stringMatching(/no look yet/) });
    // A loss-only watch spends the whole alpha on one direction.
    expect(
      sequentialLook({ ...plan, pairs: 20, gained: 0, lost: 6, directions: "loss" }).alphaPerLook,
    ).toBeCloseTo(0.05 / 3, 12);
  });

  it("refuses looks that are unsorted, repeated, beyond the plan or not ending at it", () => {
    const at = (looks: number[]) => () =>
      sequentialLook({ plannedPairs: 60, looks, alpha: 0.05, pairs: 20, gained: 1, lost: 0 });
    expect(at([40, 20, 60])).toThrow(/looks must rise/);
    expect(at([20, 20, 60])).toThrow(/looks must rise/);
    expect(at([20, 80])).toThrow(/end at the planned 60 pairs/);
    expect(at([20, 40])).toThrow(/end at the planned 60 pairs/);
  });
});

describe("watching an adopted change over later runs, pooled, at planned looks (review B1)", () => {
  const without = [run(30, (i) => i < 20), run(30, (i) => i < 20)];
  const lossy = () => run(30, (i) => i < 17);

  it("tests only after the 1st, 2nd and 4th later run, pooling them, and rolls back on a resolved loss", () => {
    // One later run: 3 losses at look 1 is not resolved at 0.05 / 3.
    const first = watchPooled({ changeId: "ctx-9", without, withRuns: [lossy()], testedLooks: [] });
    expect(first).toMatchObject({
      status: "watching",
      look: 1,
      pairedCards: 30,
      lost: 3,
      looks: [1, 2, 4],
    });
    // The second run reaches look 2: 6 losses, p = 1/64 < 0.0167.
    const second = watchPooled({
      changeId: "ctx-9",
      without,
      withRuns: [lossy(), lossy()],
      testedLooks: first.testedLooks,
    });
    expect(second).toMatchObject({ status: "rolled back", look: 2, lost: 6 });
    expect(second.reason).toMatch(/each direction at most 0\.05 over 3 looks/);
  });

  it("keeps the looks fixed by run count however many pairs each run brings (the 28/56/90 case)", () => {
    // Runs of 28, 28 and 34 paired cards: the looks stay at runs 1, 2 and 4.
    const w = (n: number) => [run(n, () => true), run(n, () => true)];
    const r = (n: number) => run(n, () => true);
    const tested: number[][] = [];
    let looks: number[] = [];
    const later = [r(28), r(28), r(34), r(34)];
    for (let k = 1; k <= 4; k++) {
      const v = watchPooled({
        changeId: "c",
        without: w(34),
        withRuns: later.slice(0, k),
        testedLooks: looks,
      });
      looks = v.testedLooks;
      tested.push([...looks]);
    }
    // No look at the third run, and three tests in all.
    expect(tested).toEqual([[1], [1, 2], [1, 2], [1, 2, 4]]);
  });

  it("does not retest a look it already tested, and ends kept at the last look", () => {
    const same = () => run(30, (i) => i < 20);
    const once = watchPooled({ changeId: "c", without, withRuns: [same()], testedLooks: [1] });
    expect(once.status).toBe("watching");
    expect(once.look).toBeUndefined();
    const end = watchPooled({
      changeId: "c",
      without,
      withRuns: [same(), same(), same(), same()],
      testedLooks: [1, 2],
    });
    expect(end).toMatchObject({ status: "kept", look: 4 });
  });

  it("reports insufficient data with no later run", () => {
    expect(watchPooled({ changeId: "c", without, withRuns: [], testedLooks: [] }).status).toBe(
      "insufficient data",
    );
  });
});

describe("runs of different modes are not compared (review M1)", () => {
  it("refuses sequential against independent in admission", () => {
    const indep = (r: SuiteRunResult) => ({ ...r, mode: "independent" as const });
    expect(() =>
      evaluateHarnessChange({
        baseline: interleaved("baseline", [run(30, (i) => i < 15), run(30, (i) => i < 15)]),
        candidate: interleaved("candidate", [
          indep(run(30, (i) => i < 15)),
          indep(run(30, (i) => i < 15)),
        ]),
        entry,
        change: { before: footprint(), after: footprint({ stablePromptTokens: 850 }) },
        version: "ctx-6",
      }),
    ).toThrow(/sequential and independent runs are not comparable/);
  });
});
