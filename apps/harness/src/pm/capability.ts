import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AttemptOutcome,
  type CardRecord,
  firstModelAttempts,
  readAttemptOutcomes,
} from "@sekhemet/kernel";
import { capabilityModel } from "@sekhemet/planner";

/**
 * The Worker's measured competence, from this repo's own attempt records.
 *
 * Both research reports are blunt: there is no public benchmark for these
 * fine-tunes at this quantization, so capability must come from the ledger.
 * Rates carry 95% Wilson intervals because early samples are tiny, and the
 * PM is told when a number is too thin to trust.
 */
export interface CapabilityReport {
  sampleSize: number;
  types: {
    type: string;
    label: string;
    attempts: number;
    passes: number;
    rate: number;
    low: number;
    high: number;
    /** Fewer first attempts than the fit needs (PM-N3-3): only the static bounds apply. */
    rough: boolean;
    /** The planner's fitted 80% horizon for the kind, in changed lines (PM-N3-1). */
    horizon80Lines?: number;
  }[];
  sizeCurve: { maxLines: number; attempts: number; rate: number }[];
  /** Largest change size at which first attempts still pass 80% (>=3 samples). */
  horizon80Lines?: number;
  note?: string;
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

const KIND_LABEL: Record<string, string> = {
  interface: "Contract",
  data: "Storage",
  implement: "Flow",
  rule: "Rules",
  spike: "Spike",
  review: "Review",
  research: "Research",
};

/**
 * The card's kind, from its stored `kind` field (PM-P1-10, DEC-26), never
 * from its title; a card created before kinds were stored is "Other".
 */
export function cardKind(card?: Pick<CardRecord, "kind">): string {
  return card?.kind ?? "Other";
}

interface FirstAttempt {
  cardId: string;
  passed: boolean;
  linesAdded?: number;
}

/**
 * The repository's attempt outcomes, from its ledger's `attempt/finished`
 * records (WL-N5-2) — the one store every reader of outcomes uses.
 */
export function ledgerOutcomes(repoPath: string): AttemptOutcome[] {
  const path = join(repoPath, ".sekhemet", "events.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return readAttemptOutcomes(db);
  } catch (err) {
    // A ledger older than the events table has no outcomes to read; any other
    // failure (a busy database) is not "no attempts" and is not hidden.
    if (/no such table/i.test(String(err))) return [];
    throw err;
  } finally {
    db.close();
  }
}

const BUCKETS = [25, 50, 100, 200, Number.POSITIVE_INFINITY];

export function capabilityReport(
  repoPath: string,
  cards: CardRecord[],
  outcomes: readonly AttemptOutcome[] = ledgerOutcomes(repoPath),
): CapabilityReport {
  const byId = new Map(cards.map((c) => [c.id, c]));
  // First attempts only: that is what Pass@1 and the split decision need; a
  // person's attempt says nothing about the Worker (MD-N6-2).
  // A halted attempt says nothing about the Worker either: the first attempt
  // is the card's first that measures the model (B4.0a review M2).
  const first: FirstAttempt[] = firstModelAttempts(outcomes).map((o) => ({
    cardId: o.cardId,
    passed: o.passed,
    ...(o.linesAdded !== undefined ? { linesAdded: o.linesAdded } : {}),
  }));

  const groups = new Map<string, FirstAttempt[]>();
  for (const a of first) {
    const kind = cardKind(byId.get(a.cardId));
    groups.set(kind, [...(groups.get(kind) ?? []), a]);
  }
  // NEW-planner-pm-3: the planner's own fit, so Seshat and the split rule agree.
  const fitted = capabilityModel(outcomes, cards).kinds;
  const types = [...groups]
    .map(([type, list]) => {
      const passes = list.filter((a) => a.passed).length;
      const fit = fitted[type];
      return {
        type,
        label: KIND_LABEL[type] ?? type,
        attempts: list.length,
        passes,
        rate: round(passes / list.length),
        ...wilson(passes, list.length),
        rough: fit ? fit.rough : true,
        ...(fit?.horizon80Lines !== undefined ? { horizon80Lines: fit.horizon80Lines } : {}),
      };
    })
    .sort((a, b) => b.attempts - a.attempts);

  const sizeCurve = BUCKETS.map((max, i) => {
    const min = i === 0 ? -1 : (BUCKETS[i - 1] as number);
    // A record from before the attempt carried its size has no place on the
    // curve; it still counts in the rates above (B4.0a review M1).
    const inBucket = first.filter(
      (a) => a.linesAdded !== undefined && a.linesAdded > min && a.linesAdded <= max,
    );
    return {
      maxLines: Number.isFinite(max) ? max : 9999,
      attempts: inBucket.length,
      rate: inBucket.length ? round(inBucket.filter((a) => a.passed).length / inBucket.length) : 0,
    };
  }).filter((b) => b.attempts > 0);

  let horizon80Lines: number | undefined;
  for (const b of sizeCurve) {
    if (b.attempts >= 3 && b.rate >= 0.8) horizon80Lines = b.maxLines;
    else if (b.attempts >= 3) break;
  }

  return {
    sampleSize: first.length,
    types,
    sizeCurve,
    ...(horizon80Lines !== undefined ? { horizon80Lines } : {}),
    ...(first.length < 30
      ? {
          note: `${first.length} first attempts so far. Treat every rate as a range, not a number, until there are about 30.`,
        }
      : {}),
  };
}

/** One line per kind for the PM's brief: "Rules 3/5 (95% CI 23-88%)". */
export function capabilitySummary(report: CapabilityReport): string {
  if (report.sampleSize === 0) return "no measured attempts yet";
  const kinds = report.types
    .map((t) => {
      const ci = `95% CI ${Math.round(t.low * 100)}-${Math.round(t.high * 100)}%`;
      // PM-N3-3: under the minimum only the static bounds apply, and the rate is a rough range.
      const limit = t.rough
        ? ", rough"
        : t.horizon80Lines !== undefined
          ? `, 80% up to ~${t.horizon80Lines} lines`
          : "";
      return `${t.label} ${t.passes}/${t.attempts} (${ci}${limit})`;
    })
    .join("; ");
  const horizon =
    report.horizon80Lines !== undefined
      ? `; passes 80% of first attempts up to ~${report.horizon80Lines} changed lines`
      : "";
  return `first-attempt pass by kind: ${kinds}${horizon}`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
