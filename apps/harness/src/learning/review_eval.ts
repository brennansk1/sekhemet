import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clopperPearson, exactMcNemar, verifyAsset } from "@sekhemet/eval";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { recordedLiteralInventory, rolePromptVersion } from "../prompt_versions.js";
import { ReviewFailedError, type ReviewInput, type ReviewResult, reviewCard } from "./review.js";
import { type ReviewMethod, withReviewMethod } from "./review_copy.js";

/**
 * The Reviewer's seeded-defect measure (review-git RG-P8-13; measurement
 * rule 29, the asset `reviewer-seeded-defects`).
 *
 * Each item is a defect seeded into a frozen-suite card's reference solution
 * that still passes the card's checks — its frozen tests, the typecheck and
 * the lint — and fails a witness test that passes on the reference solution
 * (`scripts/verify_seeded_defects.mjs` executes both before the set is
 * registered, so every label is executed, never a model's). The set lives
 * beside the suite (`fixtures/seeded_defects/`), never in it: the suite's
 * hash does not change.
 *
 * The Reviewer is shown what it is shown in the product (`reviewerInput`):
 * the issue, its acceptance criteria, the staged test file, the checks (all
 * passed) and the change as a diff from the seed's empty file — never the
 * defect's description or its witness. A defect is **caught** when a finding
 * the model judged `unmet`, cited at a line the harness checked, lands within
 * {@link CATCH_TOLERANCE_LINES} lines of a line the defect changed. Every
 * other `unmet` finding the model made is a **false positive**. `unclear`
 * findings claim no defect and count as neither; findings the harness makes
 * itself (the fail-only test check) are not the model's and are left out.
 *
 * A review that failed — its reply cut off at its length cap, or holding no
 * readable JSON (live-test F25) — is counted apart: recall is over the
 * reviews that completed, never over truncated replies read as clean ones,
 * and a run with a failed review is never RG-P8-13's verdict.
 */

/** How far from a changed line a finding may cite and still catch the defect. */
export const CATCH_TOLERANCE_LINES = 3;
/** RG-P8-13's thresholds: recall of at least 0.3, and no card with more than 1 false positive. */
export const MIN_RECALL = 0.3;
export const MAX_FALSE_POSITIVES_PER_CARD = 1;
/** The registered asset this measure scores against (measurement rule 29). */
export const SEEDED_DEFECT_ASSET = "reviewer-seeded-defects";

export interface SeededDefect {
  id: string;
  fixture: string;
  card: string;
  /** The one file of the card's scope the defect is seeded into. */
  file: string;
  /** Applied in order to the reference solution; each `find` occurs exactly once. */
  edits: { find: string; replace: string }[];
  /** The words of the card's spec or criteria the defect breaks (verbatim). */
  violates: string;
  /** What is wrong, for the person reading the result; never shown to the Reviewer. */
  defect: string;
  witness: string;
}

/** The card as the frozen suite states it (`fixtures/<fixture>/cards.json`). */
export interface FixtureCard {
  id: string;
  title: string;
  spec?: string;
  acceptanceCriteria?: string[];
  acceptanceTests?: string[];
}

/** The seeded solution: the reference with the defect's edits applied. */
export function applyEdits(reference: string, edits: SeededDefect["edits"]): string {
  let text = reference;
  for (const e of edits) {
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0) {
      throw new Error(`a seeded edit's text must occur exactly once: ${e.find.slice(0, 60)}`);
    }
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return text;
}

/**
 * The lines of `after` the change touched, as 1-based inclusive ranges on
 * the new side: the lines a line diff marks as added, and for a pure
 * deletion the two lines either side of it.
 */
export function changedRanges(before: string, after: string): [number, number][] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence over lines; the files are a few hundred lines.
  const n = a.length;
  const m = b.length;
  const lcs = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => lcs[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ranges: [number, number][] = [];
  let i = 0;
  let j = 0;
  let open: [number, number] | undefined;
  let deletedHere = false;
  const close = () => {
    if (open) ranges.push(open);
    else if (deletedHere) ranges.push([Math.max(1, j), Math.min(m, j + 1)]);
    open = undefined;
    deletedHere = false;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) {
      open = open ? [open[0], j + 1] : [j + 1, j + 1];
      j++;
    } else {
      deletedHere = true;
      i++;
    }
  }
  close();
  return ranges;
}

/** A unified diff creating `path` with `text`: the change from the seed's empty file. */
export function wholeFileDiff(path: string, text: string): string {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

/** What the Reviewer reads for one seeded item, as `reviewerInput` builds it in the product. */
export function seededReviewInput(card: FixtureCard, file: string, seeded: string): ReviewInput {
  return {
    card: {
      id: card.id,
      title: card.title,
      ...(card.spec ? { spec: card.spec } : {}),
      acceptanceCriteria: card.acceptanceCriteria ?? [],
      criterionIds: (card.acceptanceCriteria ?? []).map((_, i) => `${card.id}.c${i + 1}`),
    },
    diff: wholeFileDiff(file, seeded),
    stagedTests: (card.acceptanceTests ?? []).map((t) => ({ path: `tests/${t}` })),
    checks: [
      { gate: "typecheck", passed: true },
      { gate: "lint", passed: true },
      { gate: "test", passed: true },
    ],
    assumptions: [],
    preferences: [],
    rules: [],
  };
}

/** Whether a finding is the model's judgement (the harness's own fidelity check is not). */
function modelFinding(criterion: string): boolean {
  return !criterion.startsWith("no test:");
}

export interface DefectScore {
  id: string;
  caught: boolean;
  falsePositives: number;
  /** The model's `unmet` findings, each with where it cited and whether it caught the defect. */
  unmet: { criterion: string; at: string; catches: boolean }[];
  ranges: [number, number][];
  /** Why the review failed (F25); such an item is neither caught nor missed. */
  failed?: string;
}

/** A seeded item whose review failed (F25): no catch, no false positive, the reason kept. */
export function failedDefectReview(
  id: string,
  ranges: [number, number][],
  reason: string,
): DefectScore {
  return { id, caught: false, falsePositives: 0, unmet: [], ranges, failed: reason };
}

/** Score one review of one seeded item (RG-P8-13). */
export function scoreDefectReview(
  id: string,
  file: string,
  ranges: [number, number][],
  review: Pick<ReviewResult, "findings" | "cited">,
): DefectScore {
  const unmet: DefectScore["unmet"] = [];
  review.findings.forEach((f, i) => {
    if (f.verdict !== "unmet" || review.cited[i] !== true || !modelFinding(f.criterion)) return;
    const m = /^(.*):(\d+)$/.exec(f.evidence);
    const catches =
      !!m &&
      m[1] === file &&
      ranges.some(
        ([lo, hi]) =>
          Number(m[2]) >= lo - CATCH_TOLERANCE_LINES && Number(m[2]) <= hi + CATCH_TOLERANCE_LINES,
      );
    unmet.push({ criterion: f.criterion, at: f.evidence, catches });
  });
  return {
    id,
    caught: unmet.some((u) => u.catches),
    falsePositives: unmet.filter((u) => !u.catches).length,
    unmet,
    ranges,
  };
}

export interface SeededDefectReport {
  items: number;
  /** Items whose review completed: the recall's denominator. */
  reviewed: number;
  /** Items whose review failed (F25): cut off or unreadable, never counted as clean. */
  failed: number;
  caught: number;
  /** Caught over reviewed. */
  recall: number;
  /** Clopper–Pearson 95% interval on the recall. */
  interval: { low: number; high: number };
  /**
   * Items whose false positives exceed the per-card bound, counted on each
   * card: each seeded defect is its own review of its issue, so the bound
   * holds on each reviewed change, never averaged.
   */
  overFalsePositiveBound: string[];
  maxFalsePositives: number;
  /** RG-P8-13: recall ≥ 0.3, no card over 1 false positive, and no failed review. */
  passes: boolean;
  line: string;
}

/**
 * The measure over one run (RG-P8-13): recall over the reviews that
 * completed, false positives counted per card, failed reviews apart (F25).
 */
export function seededDefectReport(scores: readonly DefectScore[]): SeededDefectReport {
  const done = scores.filter((s) => s.failed === undefined);
  const failed = scores.length - done.length;
  const caught = done.filter((s) => s.caught).length;
  const n = done.length;
  const recall = n ? caught / n : 0;
  const over = done.filter((s) => s.falsePositives > MAX_FALSE_POSITIVES_PER_CARD).map((s) => s.id);
  const maxFalsePositives = Math.max(0, ...done.map((s) => s.falsePositives));
  const passes = n > 0 && failed === 0 && recall >= MIN_RECALL && over.length === 0;
  const interval = clopperPearson(caught, n);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const failedLine =
    failed === 0
      ? ""
      : ` ${failed} of ${scores.length} review${scores.length === 1 ? "" : "s"} failed (the reply was cut off or unreadable) and ${failed === 1 ? "is" : "are"} not counted.`;
  return {
    items: scores.length,
    reviewed: n,
    failed,
    caught,
    recall,
    interval,
    overFalsePositiveBound: over,
    maxFalsePositives,
    passes,
    line: `AI review caught ${caught} of ${n} seeded defects reviewed (recall ${pct(recall)}, 95% interval ${pct(interval.low)}–${pct(interval.high)}); ${over.length === 0 ? `no reviewed change had more than ${MAX_FALSE_POSITIVES_PER_CARD} false positive` : `${over.length} reviewed change${over.length === 1 ? "" : "s"} had more than ${MAX_FALSE_POSITIVES_PER_CARD} false positive`}.${failedLine} ${passes ? "Meets" : "Does not meet"} RG-P8-13 (recall at least ${MIN_RECALL}, at most ${MAX_FALSE_POSITIVES_PER_CARD} false positive per reviewed change, every review completed).`,
  };
}

export interface SeededDefectSet {
  hash: string;
  version: string;
  items: SeededDefect[];
  root: string;
}

/**
 * The registered set (MS-T11-2, -7): refused when it is not registered, its
 * hash does not match or it is short — never scored on a partial set.
 */
export function loadSeededDefects(root: string): SeededDefectSet {
  const asset = verifyAsset(root, SEEDED_DEFECT_ASSET);
  const items = JSON.parse(readFileSync(join(root, asset.path, "items.json"), "utf8")) as (
    | SeededDefect
    | undefined
  )[];
  return {
    hash: asset.hash,
    version: asset.version,
    items: items.filter((x): x is SeededDefect => x !== undefined),
    root,
  };
}

/** The card as the fixture states it. */
export function fixtureCard(root: string, fixture: string, cardId: string): FixtureCard {
  const cards = JSON.parse(
    readFileSync(join(root, "fixtures", fixture, "cards.json"), "utf8"),
  ) as FixtureCard[];
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`${fixture} has no card ${cardId}`);
  return card;
}

export interface SeededDefectRun {
  kind: "reviewer-seeded-defects";
  assetHash: string;
  assetVersion: string;
  model: string;
  at: string;
  scores: DefectScore[];
  report: SeededDefectReport;
  /** Set when only some items ran (`--only`): a smoke run, never RG-P8-13's verdict. */
  partial?: boolean;
}

/**
 * Review one seeded defect on one Review model as the product builds a
 * review's input, and score it (RG-P8-13): a cut-off or unreadable reply is
 * a failed review with its reason (F25). The quick benchmark's Reviewer
 * screen scores its items this way too (measurement MS-N8-5).
 */
export async function reviewSeededItem(
  root: string,
  d: Pick<SeededDefect, "id" | "fixture" | "card" | "file" | "edits">,
  model: LocalInferenceAdapter,
): Promise<DefectScore> {
  const reference = readFileSync(
    join(root, "fixtures", "reference_solutions", d.fixture, d.card, d.file),
    "utf8",
  );
  const seeded = applyEdits(reference, d.edits);
  const card = fixtureCard(root, d.fixture, d.card);
  const ranges = changedRanges(reference, seeded);
  const review = await reviewCard(model, seededReviewInput(card, d.file, seeded)).catch(
    (err: unknown) => {
      if (err instanceof ReviewFailedError) return err;
      throw err;
    },
  );
  if (review instanceof ReviewFailedError) return failedDefectReview(d.id, ranges, review.message);
  return scoreDefectReview(d.id, d.file, ranges, review);
}

/** Review every item of the set on one Review model and score it (RG-P8-13). */
export async function runSeededDefects(
  set: SeededDefectSet,
  model: LocalInferenceAdapter,
  opts: { only?: readonly string[]; say?: (line: string) => void; now?: () => Date } = {},
): Promise<SeededDefectRun> {
  const scores: DefectScore[] = [];
  const items = opts.only?.length ? set.items.filter((d) => opts.only?.includes(d.id)) : set.items;
  for (const d of items) {
    // F25: a cut-off or unreadable reply is a failed review, counted apart.
    const score = await reviewSeededItem(set.root, d, model);
    if (score.failed !== undefined) {
      scores.push(score);
      opts.say?.(`review failed ${d.id}: ${score.failed}`);
      continue;
    }
    scores.push(score);
    opts.say?.(
      `${score.caught ? "caught" : "missed"} ${d.id}${score.falsePositives ? ` · ${score.falsePositives} false positive${score.falsePositives === 1 ? "" : "s"}` : ""}`,
    );
  }
  const report = seededDefectReport(scores);
  const partial = items.length < set.items.length;
  return {
    kind: "reviewer-seeded-defects",
    assetHash: set.hash,
    assetVersion: set.version,
    model: model.modelId,
    at: (opts.now?.() ?? new Date()).toISOString(),
    scores,
    // MS-T11-7: a subset is never scored as the measure.
    report: partial
      ? {
          ...report,
          passes: false,
          line: `${report.line} Partial run (${items.length} of ${set.items.length} items): not RG-P8-13's verdict.`,
        }
      : report,
    ...(partial ? { partial: true } : {}),
  };
}

// ── the paired A/B of a Review model's method or settings (R3b, R3c) ────

/** One arm of the A/B: the method it reviews with and the adapter (its settings applied). */
export interface ReviewerArm {
  method: ReviewMethod;
  adapter: LocalInferenceAdapter;
}

/** One item reviewed under both arms. */
export interface ReviewerPair {
  id: string;
  current: boolean;
  candidate: boolean;
}

/** The paired seeded-set A/B (review-git RG-P8-17; PROMPT_STANDARD rule 35.4). */
export interface ReviewerAbRecord {
  kind: "reviewer-paired-ab";
  assetHash: string;
  assetVersion: string;
  model: string;
  at: string;
  arms: {
    current: {
      method: ReviewMethod;
      contextVersion: string;
      scores: DefectScore[];
      report: SeededDefectReport;
    };
    candidate: {
      method: ReviewMethod;
      contextVersion: string;
      scores: DefectScore[];
      report: SeededDefectReport;
    };
  };
  pairs: ReviewerPair[];
  /** Items the candidate caught and the current arm missed, and the reverse. */
  gained: number;
  lost: number;
  /** The exact two-sided sign (McNemar) test on the discordant items. */
  p: number;
  /** `best`: the candidate resolves better at 0.05; `worse`: it resolves lower; else no clear difference. */
  verdict: "best" | "worse" | "no_clear_difference";
  /** Set when only some items ran (`--only`): never the admission's verdict. */
  partial?: boolean;
}

/**
 * Review the registered set under the current arm and the candidate arm,
 * item by item and interleaved (measurement rule 10), score each by
 * RG-P8-13, and compare the pairs by the exact two-sided test. A failed
 * review in either arm leaves the pair out of the test, and the arm's
 * report says so. It adopts nothing: admission is rule 35.4's, on each
 * candidate Review model.
 */
export async function reviewerAB(
  set: SeededDefectSet,
  o: {
    current: ReviewerArm;
    candidate: ReviewerArm;
    only?: readonly string[];
    say?: (line: string) => void;
    now?: () => Date;
  },
): Promise<ReviewerAbRecord> {
  const items = o.only?.length ? set.items.filter((d) => o.only?.includes(d.id)) : set.items;
  const current: DefectScore[] = [];
  const candidate: DefectScore[] = [];
  const pairs: ReviewerPair[] = [];
  for (const d of items) {
    const a = await withReviewMethod(o.current.method, () =>
      reviewSeededItem(set.root, d, o.current.adapter),
    );
    const b = await withReviewMethod(o.candidate.method, () =>
      reviewSeededItem(set.root, d, o.candidate.adapter),
    );
    current.push(a);
    candidate.push(b);
    if (a.failed === undefined && b.failed === undefined)
      pairs.push({ id: d.id, current: a.caught, candidate: b.caught });
    o.say?.(
      `${d.id}: current ${a.failed !== undefined ? "failed" : a.caught ? "caught" : "missed"}, candidate ${b.failed !== undefined ? "failed" : b.caught ? "caught" : "missed"}`,
    );
  }
  const gained = pairs.filter((x) => x.candidate && !x.current).length;
  const lost = pairs.filter((x) => x.current && !x.candidate).length;
  const p = exactMcNemar(gained, lost);
  const partial = items.length < set.items.length;
  const inventory = recordedLiteralInventory();
  const version = (m: ReviewMethod) =>
    withReviewMethod(m, async () => rolePromptVersion("reviewer", { inventory }));
  return {
    kind: "reviewer-paired-ab",
    assetHash: set.hash,
    assetVersion: set.version,
    model: o.candidate.adapter.modelId,
    at: (o.now?.() ?? new Date()).toISOString(),
    arms: {
      current: {
        method: o.current.method,
        contextVersion: await version(o.current.method),
        scores: current,
        report: seededDefectReport(current),
      },
      candidate: {
        method: o.candidate.method,
        contextVersion: await version(o.candidate.method),
        scores: candidate,
        report: seededDefectReport(candidate),
      },
    },
    pairs,
    gained,
    lost,
    p,
    verdict: p < 0.05 ? (gained > lost ? "best" : "worse") : "no_clear_difference",
    ...(partial ? { partial: true } : {}),
  };
}
