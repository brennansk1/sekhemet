import { estimatePromptTokens, tokensForChars } from "./allocator.js";
import type { PruneResult } from "./pruner.js";

/**
 * Null baselines (measurement rule 13, MS-T7-6): what a mechanism is
 * measured against when "better than nothing" is not the question.
 *
 * The context pruner keeps the lines a task names. Its null arm keeps the
 * same structure — line order, the pruner's elision markers, pinned lines,
 * and imports, exports and declarations before other lines — but chooses
 * which lines at random, from a seed, until the same token budget is spent. If the pruner cannot beat
 * this on the suite, its query awareness is not what helps (register R3).
 */

/** A small seeded generator (mulberry32): the same seed drops the same lines. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The declarations and module lines both arms always keep (the pruner's own pattern). */
const STRUCTURE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|def|fn|pub\s+fn|impl|struct)\b|^\s*(import|export)\b/;

function render(lines: readonly string[], keep: ReadonlySet<number>) {
  const out: string[] = [];
  const elided: [number, number][] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep.has(i)) {
      out.push(lines[i] ?? "");
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && !keep.has(i)) i++;
    elided.push([start + 1, i]);
    out.push(marker(start + 1, i));
  }
  return { text: out.join("\n"), elided };
}

/** The rendered length of the marker for 0-based lines `from`..`to`. */
function markerLength(from: number, to: number): number {
  return marker(from + 1, to + 1).length;
}

function marker(first: number, last: number): string {
  return `… (lines ${first}-${last} elided; read_file that range if needed) …`;
}

/** The kept lines' indices: counts by prefix and the k-th kept, both in O(log n). */
class Fenwick {
  private readonly tree: Int32Array;
  public size = 0;
  constructor(private readonly n: number) {
    this.tree = new Int32Array(n + 1);
  }
  public add(index: number): void {
    this.size++;
    for (let i = index + 1; i <= this.n; i += i & -i) this.tree[i] = (this.tree[i] ?? 0) + 1;
  }
  /** How many kept indices are below `index`. */
  public prefix(index: number): number {
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) sum += this.tree[i] ?? 0;
    return sum;
  }
  /** The k-th kept index, from 1. */
  public kth(k: number): number {
    let pos = 0;
    let rest = k;
    for (let step = 1 << Math.floor(Math.log2(this.n || 1)); step > 0; step >>= 1) {
      const nextPos = pos + step;
      if (nextPos <= this.n && (this.tree[nextPos] ?? 0) < rest) {
        pos = nextPos;
        rest -= this.tree[nextPos] ?? 0;
      }
    }
    return pos;
  }
}

/**
 * Drop lines at random, keeping structure, to fit `maxTokens` (the pruner's
 * budget, or the size of its output). Same result shape as `pruneLines`.
 */
export function randomLinePrune(
  text: string,
  options: { maxTokens: number; seed: number; pinnedLines?: number[] },
): PruneResult {
  const lines = text.split("\n");
  const total = lines.length;
  if (estimatePromptTokens(text) <= options.maxTokens) {
    return { text, keptLines: total, totalLines: total, elided: [], fits: true };
  }
  // Pinned lines are kept whatever they cost; then the structural lines, then
  // the rest, each group in a seeded random order, while the budget allows.
  const keep = new Set<number>();
  for (const n of options.pinnedLines ?? []) if (n >= 1 && n <= total) keep.add(n - 1);
  let best = render(lines, keep);
  if (estimatePromptTokens(best.text) > options.maxTokens) {
    return {
      text: best.text,
      keptLines: keep.size,
      totalLines: total,
      elided: best.elided,
      fits: false,
    };
  }
  const next = seeded(options.seed);
  const shuffled = (xs: number[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [xs[i], xs[j]] = [xs[j] as number, xs[i] as number];
    }
    return xs;
  };
  const free = lines.map((_, i) => i).filter((i) => !keep.has(i));
  const order = [
    ...shuffled(free.filter((i) => STRUCTURE.test(lines[i] ?? ""))),
    ...shuffled(free.filter((i) => !STRUCTURE.test(lines[i] ?? ""))),
  ];
  // Linear (the part 2 review): rather than render the file again for every
  // line tried, keep the rendered length and change it by what adding a line
  // does to its gap — the one elision marker becomes the line and at most two
  // markers. The kept lines sit in a Fenwick tree, so a line's gap is found in
  // O(log n). The result is the per-line re-render's, line for line.
  const kept = new Fenwick(total);
  for (const i of keep) kept.add(i);
  let length = best.text.length;
  for (const i of order) {
    const before = kept.prefix(i);
    const from = before > 0 ? kept.kth(before) + 1 : 0;
    const to = before < kept.size ? kept.kth(before + 1) - 1 : total - 1;
    const pieces = [
      ...(from <= i - 1 ? [markerLength(from, i - 1)] : []),
      (lines[i] ?? "").length,
      ...(i + 1 <= to ? [markerLength(i + 1, to)] : []),
    ];
    const grown =
      length - markerLength(from, to) + pieces.reduce((a, b) => a + b, 0) + (pieces.length - 1);
    if (tokensForChars(grown) <= options.maxTokens) {
      keep.add(i);
      kept.add(i);
      length = grown;
    }
  }
  best = render(lines, keep);
  return {
    text: best.text,
    keptLines: keep.size,
    totalLines: total,
    elided: best.elided,
    fits: true,
  };
}

export type PruneArm = "query" | "random";

/**
 * The prune arm the experiment switch `SEKHEMET_PRUNE` names (MS-T7-6):
 * `random` for the null baseline, anything else the pruner (the default).
 */
export function pruneArmFromEnv(env: Record<string, string | undefined> = process.env): PruneArm {
  return env.SEKHEMET_PRUNE === "random" ? "random" : "query";
}

/** A stable seed from a card and a file, so the null arm is reproducible. */
export function pruneSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
