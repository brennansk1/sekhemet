import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssetManifest, verifyAsset } from "./eval_assets.js";
import { clopperPearson } from "./stats.js";

/**
 * The planning measure's figures (measurement rules 7 and 29; MS-T7-5,
 * MS-T7-7, MS-T7-8; NEW-measurement-4's test strength per card), computed
 * from recorded runs. Every share carries its Clopper–Pearson 95% interval.
 * The held-out acceptance share is reported next to the suite score and never
 * merged into it: the planner never saw those tests, so they measure whether
 * the plan covered what the brief needed, not whether the cards passed.
 */

type Interval = { low: number; high: number };

/** One generated card as the planning run recorded it. */
export interface PlannedCard {
  cardId: string;
  /** The SPIDR shape the planner gave it, when it gave one. */
  spidr?: string;
  scopeFiles: string[];
  /** Lines the card's scope files hold (or the reference diff changed). */
  scopeLines: number;
  /** Its acceptance test failed on the seed; null when not checked. */
  failsAtSeed: boolean | null;
  /** Its acceptance test passes on the reference solution; null when there is none. */
  passesOnReference: boolean | null;
  /** The acceptance tests' mutation campaign on the card's change; null when none ran. */
  mutants: { killed: number; total: number } | null;
}

const share = (yes: number, measured: number) => ({
  yes,
  measured,
  interval: clopperPearson(yes, measured),
});

/** Per generated card, and the shares over the cards measured (MS-T7-5). */
export function planningCardReport(cards: readonly PlannedCard[]): {
  rows: {
    cardId: string;
    spidr: string;
    files: number;
    lines: number;
    failsAtSeed: boolean | null;
    passesOnReference: boolean | null;
    /** Killed over total; null with no mutable lines or no campaign (rule 25). */
    mutationScore: number | null;
  }[];
  spidrShapes: Record<string, number>;
  failsAtSeed: { yes: number; measured: number; interval: Interval };
  passesOnReference: { yes: number; measured: number; interval: Interval };
} {
  const rows = cards.map((c) => ({
    cardId: c.cardId,
    spidr: c.spidr ?? "unshaped",
    files: c.scopeFiles.length,
    lines: c.scopeLines,
    failsAtSeed: c.failsAtSeed,
    passesOnReference: c.passesOnReference,
    mutationScore:
      c.mutants && c.mutants.total > 0
        ? Math.round((c.mutants.killed / c.mutants.total) * 1000) / 1000
        : null,
  }));
  const spidrShapes: Record<string, number> = {};
  for (const r of rows) spidrShapes[r.spidr] = (spidrShapes[r.spidr] ?? 0) + 1;
  const seed = cards.filter((c) => c.failsAtSeed !== null);
  const ref = cards.filter((c) => c.passesOnReference !== null);
  return {
    rows,
    spidrShapes,
    failsAtSeed: share(seed.filter((c) => c.failsAtSeed).length, seed.length),
    passesOnReference: share(ref.filter((c) => c.passesOnReference).length, ref.length),
  };
}

/** The share of held-out acceptance tests passing on the final `main` (MS-T7-5). */
export function heldOutShare(results: readonly { test: string; passed: boolean }[]): {
  passed: number;
  total: number;
  share: number | null;
  interval: Interval;
} {
  const passed = results.filter((r) => r.passed).length;
  return {
    passed,
    total: results.length,
    share: results.length ? passed / results.length : null,
    interval: clopperPearson(passed, results.length),
  };
}

/**
 * Implicit-requirement recall (MS-T7-7): the share of the golden briefs'
 * annotated unstated requirements that end up in the accepted requirement
 * graph, over every brief, with its exact interval.
 */
export function implicitRequirementRecall(
  briefs: readonly {
    briefId: string;
    annotated: readonly string[];
    inAcceptedGraph: readonly string[];
  }[],
): {
  covered: number;
  annotated: number;
  rate: number | null;
  interval: Interval;
  perBrief: { briefId: string; covered: number; annotated: number }[];
} {
  const perBrief = briefs.map((b) => {
    const graph = new Set(b.inAcceptedGraph);
    return {
      briefId: b.briefId,
      covered: b.annotated.filter((r) => graph.has(r)).length,
      annotated: b.annotated.length,
    };
  });
  const covered = perBrief.reduce((n, b) => n + b.covered, 0);
  const annotated = perBrief.reduce((n, b) => n + b.annotated, 0);
  return {
    covered,
    annotated,
    rate: annotated ? covered / annotated : null,
    interval: clopperPearson(covered, annotated),
    perBrief,
  };
}

/**
 * The premature-completion rate (MS-T7-8): of the projects or slices the
 * system marked proven, the share the held-out acceptance suite — never
 * shown to the planner — shows are not.
 */
export function prematureCompletionRate(
  items: readonly { id: string; markedProven: boolean; heldOutPassed: boolean }[],
): {
  premature: number;
  proven: number;
  rate: number | null;
  interval: Interval;
  prematureIds: string[];
} {
  const proven = items.filter((i) => i.markedProven);
  const prematureIds = proven.filter((i) => !i.heldOutPassed).map((i) => i.id);
  return {
    premature: prematureIds.length,
    proven: proven.length,
    rate: proven.length ? prematureIds.length / proven.length : null,
    interval: clopperPearson(prematureIds.length, proven.length),
    prematureIds,
  };
}

/**
 * The planning measure's report. The golden briefs and the held-out
 * acceptance suite are verified against the asset manifest before anything
 * is scored (rule 29, MS-T11-2): an unregistered or changed asset is refused,
 * and the result records each asset's hash so results on different versions
 * are never compared.
 */
export function planningMeasureReport(
  root: string,
  inputs: {
    cards: readonly PlannedCard[];
    heldOut: readonly { test: string; passed: boolean }[];
    briefs: Parameters<typeof implicitRequirementRecall>[0];
    slices: Parameters<typeof prematureCompletionRate>[0];
    suiteScore: { passed: number; measured: number };
  },
) {
  const assets = ["golden-briefs", "held-out-acceptance-suite"].map((name) => ({
    name,
    ...verifyAsset(root, name),
  }));
  // Review M5: the results cover exactly the registered items, none missing
  // and none added, so a result is never scored on part of an asset.
  sameItems(
    root,
    "golden-briefs",
    inputs.briefs.map((b) => b.briefId),
  );
  sameItems(
    root,
    "held-out-acceptance-suite",
    inputs.heldOut.map((h) => h.test),
  );
  const cards = planningCardReport(inputs.cards);
  const heldOut = heldOutShare(inputs.heldOut);
  const recall = implicitRequirementRecall(inputs.briefs);
  const premature = prematureCompletionRate(inputs.slices);
  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  return {
    assets,
    /** What the intervals mean (review minor 4). */
    intervals:
      "item-level Clopper-Pearson 95% intervals: requirements within one brief, tests within one project and cards within one plan are not independent, so the true intervals are wider",
    suiteScore: inputs.suiteScore,
    cards,
    heldOut,
    recall,
    premature,
    line: [
      `suite ${inputs.suiteScore.passed}/${inputs.suiteScore.measured}`,
      `held-out ${heldOut.passed}/${heldOut.total} (${pct(heldOut.share)}, 95% CI ${pct(heldOut.interval.low)}-${pct(heldOut.interval.high)}), reported apart`,
      `implicit-requirement recall ${recall.covered}/${recall.annotated} (${pct(recall.rate)}, 95% CI ${pct(recall.interval.low)}-${pct(recall.interval.high)})`,
      `premature completion ${premature.premature}/${premature.proven} (${pct(premature.rate)}, 95% CI ${pct(premature.interval.low)}-${pct(premature.interval.high)})`,
    ].join(" · "),
  };
}

/** The ids a registered asset's `items.json` lists. */
function itemIds(root: string, name: string): string[] {
  const entry = loadAssetManifest(root).assets.find((a) => a.name === name);
  if (!entry) throw new Error(`${name} is not registered`);
  const items = JSON.parse(readFileSync(join(root, entry.path, "items.json"), "utf8")) as {
    id?: string;
  }[];
  return items.map((i) => String(i.id));
}

function sameItems(root: string, name: string, given: readonly string[]): void {
  const twice = given.filter((g, i) => given.indexOf(g) !== i);
  if (twice.length)
    throw new Error(`${name}: ${[...new Set(twice)].join(", ")} is given more than once`);
  const ids = new Set(itemIds(root, name));
  const seen = new Set(given);
  const extra = given.filter((g) => !ids.has(g));
  if (extra.length) throw new Error(`${name}: ${extra.join(", ")} is not one of its items`);
  const missing = [...ids].filter((i) => !seen.has(i));
  if (missing.length) throw new Error(`${name}: ${missing.join(", ")} has no result`);
}
