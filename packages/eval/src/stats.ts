/**
 * Exact small-sample statistics for a 14–30 card suite (measurement.md
 * rules 4, 10–11, 16b–16c; M12, T8). Everything here is exact — binomial
 * tails, Clopper–Pearson intervals, the exact McNemar and sign tests, the
 * exact Wilcoxon signed-rank distribution — because normal approximations
 * mislead at these sample sizes. No model and no randomness.
 */

/** ln C(n, k), by summing logs (n here is at most a few hundred). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X = k) for X ~ Binomial(n, p). */
export function binomialPmf(k: number, n: number, p = 0.5): number {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** P(X >= k) for X ~ Binomial(n, p): the one-sided exact (sign) test's p-value. */
export function binomialTailAtLeast(k: number, n: number, p = 0.5): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let i = k; i <= n; i++) s += binomialPmf(i, n, p);
  return Math.min(1, s);
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialTailAtMost(k: number, n: number, p = 0.5): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i++) s += binomialPmf(i, n, p);
  return Math.min(1, s);
}

/** Bisection for the p in [0, 1] where a monotone `f` crosses `target`. */
function solve(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if (increasing ? v < target : v > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The exact (Clopper–Pearson) interval for k successes in n trials, at
 * 1 − alpha (default 95%). With no trials, nothing is known: [0, 1].
 */
export function clopperPearson(k: number, n: number, alpha = 0.05): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const low = k === 0 ? 0 : solve((p) => binomialTailAtLeast(k, n, p), alpha / 2, true);
  const high = k === n ? 1 : solve((p) => binomialTailAtMost(k, n, p), alpha / 2, false);
  return { low, high };
}

/**
 * The exact McNemar test on the discordant pairs: `b` pairs where only the
 * first arm passed, `c` where only the second did. Two-sided p-value.
 */
export function exactMcNemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  return Math.min(1, 2 * binomialTailAtMost(Math.min(b, c), n));
}

/**
 * The smallest paired difference in pass rate (a share of the cards) that an
 * exact test on the discordant pairs detects at `alpha` with `power`, on `n`
 * paired cards of which a share `discordance` disagree (rule 11: at 20%
 * disagreement about 155 paired cards see 10 points). Two-sided (McNemar)
 * by default; `sided: "one"` for a one-sided question such as "a loss".
 * Returns null when nothing is detectable: too few pairs disagree for any
 * split of them to reach `alpha`.
 */
export function minDetectableDifference(
  n: number,
  discordance = 0.2,
  options: { alpha?: number; power?: number; sided?: "one" | "two" } = {},
): number | null {
  const alpha = options.alpha ?? 0.05;
  const power = options.power ?? 0.8;
  const sides = options.sided === "one" ? 1 : 2;
  if (n <= 0) return null;
  const q = Math.max(1 / n, discordance);
  const m = Math.max(1, Math.round(q * n));
  // The fewest wins among m discordant pairs that the test rejects on.
  let critical = m + 1;
  for (let k = Math.ceil(m / 2); k <= m; k++) {
    if (sides * binomialTailAtLeast(k, m) <= alpha) {
      critical = k;
      break;
    }
  }
  if (critical > m) return null;
  for (let step = 0; step <= 1000; step++) {
    const d = (q * step) / 1000;
    const favour = Math.min(1, (q + d) / (2 * q));
    if (binomialTailAtLeast(critical, m, favour) >= power) return Math.round(d * 1000) / 1000;
  }
  return null;
}

/** The planning disagreement between arms that rule 11's resolution assumes. */
export const PLANNING_DISCORDANCE = 0.2;

/** "N points" for a detectable difference, or why none is detectable. */
export function describeDetectable(d: number | null, pairedCards: number, what: string): string {
  return d === null
    ? `no ${what} is detectable on ${pairedCards} paired card(s) at 80% power`
    : `smallest ${what} detectable at 80% power: ${Math.round(d * 100)} points (at ${PLANNING_DISCORDANCE * 100}% disagreement)`;
}

/**
 * The one-sided exact Wilcoxon signed-rank test that the differences are
 * shifted below zero (the candidate costs less): P(W+ <= observed) under
 * the null, where W+ is the sum of the ranks of the positive differences.
 * Zeros are dropped; tied magnitudes get their average rank; the null
 * distribution is enumerated exactly.
 */
export function wilcoxonSignedRankLess(differences: readonly number[]): number {
  const d = differences.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return 1;
  const order = d.map((x, i) => ({ abs: Math.abs(x), i })).sort((a, b) => a.abs - b.abs);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && (order[j + 1] as { abs: number }).abs === (order[i] as { abs: number }).abs)
      j++;
    const avg = (i + j + 2) / 2;
    for (let t = i; t <= j; t++) ranks[(order[t] as { i: number }).i] = avg;
    i = j + 1;
  }
  // Ranks are multiples of 0.5: count subset sums of the doubled ranks.
  const doubled = ranks.map((r) => Math.round(r * 2));
  const total = doubled.reduce((a, b) => a + b, 0);
  let counts = new Array<number>(total + 1).fill(0);
  counts[0] = 1;
  for (const r of doubled) {
    const next = counts.slice();
    for (let s = total - r; s >= 0; s--) {
      if (counts[s]) next[s + r] = (next[s + r] as number) + (counts[s] as number);
    }
    counts = next;
  }
  const observed = d.reduce((acc, x, i) => (x > 0 ? acc + (doubled[i] as number) : acc), 0);
  let below = 0;
  for (let s = 0; s <= observed; s++) below += counts[s] as number;
  return Math.min(1, below / 2 ** n);
}

/** The median of a list (the mean of the middle two when even). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** pass@k: the chance at least one of k runs drawn from n (c passing) passes. */
export function passAtK(c: number, n: number, k: number): number {
  if (k > n) throw new Error(`pass@${k} needs at least ${k} runs, got ${n}`);
  if (n - c < k) return 1;
  return 1 - Math.exp(logChoose(n - c, k) - logChoose(n, k));
}

/** pass^k: the chance all of k runs drawn from n (c passing) pass. */
export function passHatK(c: number, n: number, k: number): number {
  if (k > n) throw new Error(`pass^${k} needs at least ${k} runs, got ${n}`);
  if (c < k) return 0;
  return Math.exp(logChoose(c, k) - logChoose(n, k));
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
