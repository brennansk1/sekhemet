import { describe, expect, it } from "vitest";
import {
  type AttemptFinished,
  type ChangeFootprint,
  evaluateHarnessChange,
  ruleCredit,
  watchAdmittedChange,
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
      baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      candidate: [run(30, (i) => i >= 15), run(30, (i) => i >= 15)],
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
        baseline: [run(30, () => false)],
        candidate: [run(30, () => true)],
        entry,
        change: { before: footprint(), after: footprint() },
        version: "ctx-2",
      }),
    ).toThrow(/at least two paired runs per arm/);
  });

  it("MS-T8-2: admits a gain only when the one-sided exact test rejects no gain at 0.05 with at least 20 points", () => {
    const v = evaluateHarnessChange({
      baseline: [run(30, (i) => i < 10), run(30, (i) => i < 10)],
      candidate: [run(30, (i) => i < 18), run(30, (i) => i < 18)],
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
      baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      candidate: [run(30, (i) => i < 16), run(30, (i) => i < 14)],
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
      baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      candidate: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      entry,
      change: { before: footprint(), after: footprint({ tools: 11, switches: 4 }) },
      version: "ctx-2",
    });
    expect(v.verdict).toBe("not adopted");
  });

  it("MS-T8-13: 'cheaper' needs a one-sided paired Wilcoxon p below 0.05 on median tokens per card", () => {
    const cheaper = evaluateHarnessChange({
      baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      candidate: [
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
      ],
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
      baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
      candidate: [run(30, (i) => i < 15, tokens), run(30, (i) => i < 15, tokens)],
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
        baseline: [run(30, () => true), run(30, () => true)],
        candidate: [run(30, () => true), run(30, () => true)],
        entry: { costMeasure: "median tokens per card", recordedAt: "2026-09-25T10:30:00.000Z" },
        change: { before: footprint(), after: footprint() },
        version: "ctx-2",
      }),
    ).toThrow(/cost measure was recorded after the first card ran/);
  });

  it("does not adopt a change the suite shows is a loss, however much simpler", () => {
    const v = evaluateHarnessChange({
      baseline: [run(30, () => true), run(30, () => true)],
      candidate: [run(30, (i) => i >= 12), run(30, (i) => i >= 12)],
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
  const baseline = [run(30, () => true), run(30, () => true)];
  const candidate = [
    blocked(
      run(30, (i) => i !== 0),
      [1, 2, 3, 4, 5],
    ),
    blocked(
      run(30, (i) => i !== 0),
      [1, 2, 3, 4, 5],
    ),
  ];

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
    baseline: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
    candidate: [run(30, (i) => i < 15), run(30, (i) => i < 15)],
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
      baseline: [withEntry(run(30, (i) => i < 15)), withEntry(run(30, (i) => i < 15))],
      candidate: [withEntry(run(30, (i) => i < 15)), withEntry(run(30, (i) => i < 15))],
      entrySha256: "e".repeat(64),
    });
    expect(evaluateHarnessChange(ok).verdict).toBe("not established — simpler");
    expect(() =>
      evaluateHarnessChange({
        ...ok,
        candidate: [withEntry(run(30, (i) => i < 15)), run(30, (i) => i < 15)],
      }),
    ).toThrow(/does not carry the A\/B entry/);
  });

  it("refuses runs with no profile, mixed profiles within an arm, or arms that differ beyond the arm under test", () => {
    const noProfile = { ...run(30, (i) => i < 15), runProfile: undefined };
    expect(() =>
      evaluateHarnessChange(args({ candidate: [noProfile, run(30, (i) => i < 15)] })),
    ).toThrow(/records no RunProfile/);
    const other = { ...run(30, (i) => i < 15), runProfile: profile(["--max-turns", "20"]) };
    expect(() =>
      evaluateHarnessChange(args({ candidate: [other, run(30, (i) => i < 15)] })),
    ).toThrow(/more than one RunProfile within the candidate arm/);
    expect(() => evaluateHarnessChange(args({ candidate: [other, { ...other }] }))).toThrow(
      /differ in more than the arm under test/,
    );
    const arm = {
      ...run(30, (i) => i < 15),
      runProfile: profile(["--max-turns", "20", "--arm", "steps=20"]),
    };
    expect(evaluateHarnessChange(args({ candidate: [arm, { ...arm }] })).verdict).toBe(
      "not established — simpler",
    );
    const mixed = { ...run(30, (i) => i < 15), profileMismatch: ["alpha/card_3"] };
    expect(() =>
      evaluateHarnessChange(args({ candidate: [mixed, run(30, (i) => i < 15)] })),
    ).toThrow(/ran with a different profile.*alpha\/card_3/);
  });
});
