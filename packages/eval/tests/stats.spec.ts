import { describe, expect, it } from "vitest";
import {
  binomialTailAtLeast,
  clopperPearson,
  exactMcNemar,
  minDetectableDifference,
  passAtK,
  passHatK,
  wilcoxonSignedRankLess,
} from "../src/stats.js";

// measurement.md rules 4, 10-11 and 16b-16c (M12, T8): exact small-sample
// statistics, checked against published values.

describe("exact binomial tails", () => {
  it("gives the sign-test probabilities MS-T8-14 names", () => {
    // 9 harmful of 10 discordant pairs: P(X >= 9) = 11/1024.
    expect(binomialTailAtLeast(9, 10)).toBeCloseTo(11 / 1024, 12);
    expect(binomialTailAtLeast(9, 10)).toBeCloseTo(0.011, 3);
    // 8 of 10: 56/1024, about 0.055.
    expect(binomialTailAtLeast(8, 10)).toBeCloseTo(56 / 1024, 12);
    expect(binomialTailAtLeast(0, 10)).toBe(1);
    expect(binomialTailAtLeast(11, 10)).toBe(0);
    expect(binomialTailAtLeast(3, 5, 0.2)).toBeCloseTo(0.05792, 5);
  });
});

describe("Clopper-Pearson 95% intervals (MS-M12-1)", () => {
  it("matches published exact intervals", () => {
    const mid = clopperPearson(5, 10);
    expect(mid.low).toBeCloseTo(0.1871, 4);
    expect(mid.high).toBeCloseTo(0.8129, 4);
    expect(clopperPearson(0, 10)).toMatchObject({ low: 0 });
    expect(clopperPearson(0, 10).high).toBeCloseTo(0.3085, 4);
    expect(clopperPearson(10, 10).low).toBeCloseTo(0.6915, 4);
    expect(clopperPearson(10, 10).high).toBe(1);
    // Phase 0's 11/11 establishes at least 76% at 95% (rule 28).
    expect(clopperPearson(11, 11).low).toBeCloseTo(0.7151, 4);
  });

  it("has no interval without a measured card", () => {
    expect(clopperPearson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("the exact McNemar test (MS-M12-2)", () => {
  it("uses only the discordant pairs, two-sided", () => {
    expect(exactMcNemar(1, 0)).toBe(1);
    expect(exactMcNemar(0, 6)).toBeCloseTo(0.03125, 10);
    expect(exactMcNemar(2, 8)).toBeCloseTo(0.109375, 10);
    expect(exactMcNemar(0, 0)).toBe(1);
  });
});

describe("the smallest detectable difference (MS-M12-2, rule 11)", () => {
  it("needs about 155 paired cards to see 10 points at 20% disagreement", () => {
    const d155 = minDetectableDifference(155, 0.2);
    expect(d155).toBeGreaterThan(0.08);
    expect(d155).toBeLessThanOrEqual(0.13);
  });

  it("is far above 10 points on a 30-card suite", () => {
    expect(minDetectableDifference(30, 0.2)).toBeGreaterThanOrEqual(0.15);
  });

  it("says nothing is detectable when too few pairs disagree for the test to reject at all (review M1)", () => {
    // 2 discordant pairs of 60: no split of 2 reaches p <= 0.05, so no difference is detectable.
    expect(minDetectableDifference(60, 2 / 60)).toBeNull();
    expect(minDetectableDifference(10, 0.2)).toBeNull();
  });

  it("uses a one-sided critical value for a one-sided question", () => {
    const two = minDetectableDifference(155, 0.2) as number;
    const one = minDetectableDifference(155, 0.2, { sided: "one" }) as number;
    expect(one).toBeLessThan(two);
    // 5 of 5 discordant: one-sided p = 1/32 rejects; two-sided 1/16 does not.
    expect(minDetectableDifference(25, 0.2, { sided: "one" })).not.toBeNull();
    expect(minDetectableDifference(25, 0.2)).toBeNull();
  });
});

describe("the one-sided Wilcoxon signed-rank test (rule 16c)", () => {
  it("computes the exact lower tail of W+", () => {
    // Every difference negative: W+ = 0, p = 1/2^6.
    expect(wilcoxonSignedRankLess([-1, -2, -3, -4, -5, -6])).toBeCloseTo(1 / 64, 12);
    // Ranks 1, 2, 3 with W+ = 2: subsets of {1,2,3} summing to at most 2 are 3 of 8.
    expect(wilcoxonSignedRankLess([-1, 2, -3])).toBeCloseTo(3 / 8, 12);
    // Zero differences are dropped; nothing left means no evidence.
    expect(wilcoxonSignedRankLess([0, 0])).toBe(1);
  });

  it("averages tied ranks", () => {
    // |d| = 1, 1, 2: ranks 1.5, 1.5, 3; W+ = 1.5 (the positive 1).
    // Sums of subsets of {1.5, 1.5, 3} at most 1.5: {}, {1.5}, {1.5} = 3 of 8.
    expect(wilcoxonSignedRankLess([1, -1, -2])).toBeCloseTo(3 / 8, 12);
  });
});

describe("pass@k and pass^k (MS-M12-5)", () => {
  it("are the unbiased estimators over n runs with c passes", () => {
    expect(passAtK(2, 5, 1)).toBeCloseTo(0.4, 12);
    expect(passAtK(2, 5, 2)).toBeCloseTo(0.7, 12);
    expect(passHatK(2, 5, 2)).toBeCloseTo(0.1, 12);
    expect(passHatK(5, 5, 3)).toBe(1);
    expect(passAtK(0, 5, 3)).toBe(0);
  });
});
