import { type Source, isCovered as defaultIsCovered } from "./sources.js";

/**
 * Iterative research: the model decides what to look for, the code decides
 * when to stop.
 *
 * Ported from Helga's research_loop.py. A model is good at knowing what a
 * topic means, which is what writing queries needs. A model is bad at judging
 * "is that enough?": self-assessed sufficiency is the weakest stopping rule
 * there is, and it is not reproducible (the same question researched twice
 * gets different depth, invisibly). So:
 *
 *   the model PROPOSES: the checklist, and queries for items not yet covered
 *   the code DISPOSES: whether an item is covered, and whether to go on
 *
 * The loop stops when every item is covered, the round budget is spent, or
 * two rounds in a row add no new source. Two, not one: one empty round is
 * usually a bad query; two is the subject (or a silently failing service,
 * which must not burn the whole budget).
 */

export interface LoopFinding {
  /** The query that produced it. */
  query: string;
  /** Text the model will read: an answer, excerpts. Coverage is measured on it. */
  text: string;
  sources: Source[];
}

export interface LoopResult {
  ran: boolean;
  rounds: number;
  items: number;
  covered: string[];
  outstanding: string[];
  coveragePct: number;
  findings: LoopFinding[];
  sources: number;
  stoppedBecause: "covered" | "dry" | "budget" | "no queries" | "empty checklist";
  /** Said on the record so no one reads the exit as the model's opinion. */
  exitRule: "measured coverage of the checklist (no model judgement)";
}

export interface LoopOptions {
  /**
   * (outstanding items, findings so far) -> queries. The model's job; defaults
   * to the items. One query per outstanding item, in order, attributes each
   * query's sources to its item; any other shape attributes them to all.
   */
  proposeQueries?: (outstanding: string[], findings: LoopFinding[]) => Promise<string[]>;
  /** (item, all evidence text) -> covered. Deterministic by default. */
  isCovered?: (item: string, evidence: string) => boolean;
  /**
   * The closing rule (design-stage DS-N4-2): an item is covered only when
   * the sources its own queries found also close it, measured in code.
   */
  closes?: (item: string, sources: Source[]) => boolean;
  maxRounds?: number;
  /** Queries in flight at once. The network is the wait, not the model. */
  concurrency?: number;
  dryRounds?: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runResearchLoop(
  checklist: string[],
  search: (query: string, item: string | undefined) => Promise<LoopFinding | undefined>,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const items = [...new Set(checklist.map((c) => c.trim()).filter(Boolean))];
  const maxRounds = opts.maxRounds ?? 4;
  const dryLimit = opts.dryRounds ?? 2;
  const covers = opts.isCovered ?? defaultIsCovered;
  const base = {
    items: items.length,
    exitRule: "measured coverage of the checklist (no model judgement)" as const,
  };
  if (items.length === 0) {
    return {
      ...base,
      ran: false,
      rounds: 0,
      covered: [],
      outstanding: [],
      coveragePct: 0,
      findings: [],
      sources: 0,
      stoppedBecause: "empty checklist",
    };
  }
  const covered = new Set<string>();
  const findings: LoopFinding[] = [];
  const refs = new Set<string>();
  /** Each item's own sources, from the queries dispatched for it. */
  const itemSources = new Map<string, Source[]>();
  let rounds = 0;
  let dry = 0;
  let stopped: LoopResult["stoppedBecause"] = "budget";
  while (rounds < maxRounds) {
    const outstanding = items.filter((i) => !covered.has(i));
    if (outstanding.length === 0) {
      stopped = "covered";
      break;
    }
    rounds++;
    const proposed = opts.proposeQueries
      ? await opts.proposeQueries(outstanding, findings).catch(() => outstanding)
      : outstanding;
    const aligned = proposed.length === outstanding.length;
    const seenQueries = new Set<string>();
    const dispatches = proposed
      .map((q, i) => ({ query: q.trim(), item: aligned ? outstanding[i] : undefined }))
      .filter((d) => d.query && !seenQueries.has(d.query) && seenQueries.add(d.query))
      .slice(0, 8);
    if (dispatches.length === 0) {
      stopped = "no queries";
      break;
    }
    const before = refs.size;
    const got = await mapLimit(dispatches, opts.concurrency ?? 3, (d) =>
      search(d.query, d.item).catch(() => undefined),
    );
    got.forEach((f, i) => {
      if (!f) return;
      findings.push(f);
      for (const s of f.sources) refs.add(s.ref);
      const item = dispatches[i]?.item;
      for (const it of item ? [item] : outstanding) {
        itemSources.set(it, [...(itemSources.get(it) ?? []), ...f.sources]);
      }
    });
    // No new source is a stopping condition, not a reason to try harder.
    if (refs.size === before) {
      dry++;
      if (dry >= dryLimit) {
        stopped = "dry";
        break;
      }
      continue;
    }
    dry = 0;
    const evidence = findings
      .map(
        (f) =>
          `${f.text}\n${f.sources.map((s) => `${s.title ?? ""} ${s.excerpt ?? ""}`).join("\n")}`,
      )
      .join("\n");
    for (const item of outstanding) {
      if (!covers(item, evidence)) continue;
      if (opts.closes && !opts.closes(item, itemSources.get(item) ?? [])) continue;
      covered.add(item);
    }
  }
  const outstanding = items.filter((i) => !covered.has(i));
  if (outstanding.length === 0) stopped = "covered";
  return {
    ...base,
    ran: true,
    rounds,
    covered: items.filter((i) => covered.has(i)),
    outstanding,
    coveragePct: Math.round((covered.size / items.length) * 100),
    findings,
    sources: refs.size,
    stoppedBecause: stopped,
  };
}
