import { describe, expect, it } from "vitest";
import { estimatePromptTokens } from "../src/allocator.js";
import { randomLinePrune } from "../src/random_prune.js";

// MS-T7-6's null arm (part 2 review): the same result as re-rendering the
// file after every line, in linear time.

/** The earlier algorithm, kept here as the reference: re-render per line. */
function reference(text: string, maxTokens: number, seed: number, pinned: number[] = []) {
  const STRUCTURE =
    /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|def|fn|pub\s+fn|impl|struct)\b|^\s*(import|export)\b/;
  const lines = text.split("\n");
  const render = (keep: Set<number>) => {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (keep.has(i)) {
        out.push(lines[i] ?? "");
        i++;
        continue;
      }
      const start = i;
      while (i < lines.length && !keep.has(i)) i++;
      out.push(`… (lines ${start + 1}-${i} elided; read_file that range if needed) …`);
    }
    return out.join("\n");
  };
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = (xs: number[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [xs[i], xs[j]] = [xs[j] as number, xs[i] as number];
    }
    return xs;
  };
  const keep = new Set<number>();
  for (const n of pinned) if (n >= 1 && n <= lines.length) keep.add(n - 1);
  let best = render(keep);
  const free = lines.map((_, i) => i).filter((i) => !keep.has(i));
  const order = [
    ...shuffled(free.filter((i) => STRUCTURE.test(lines[i] ?? ""))),
    ...shuffled(free.filter((i) => !STRUCTURE.test(lines[i] ?? ""))),
  ];
  for (const i of order) {
    keep.add(i);
    const tried = render(keep);
    if (estimatePromptTokens(tried) <= maxTokens) best = tried;
    else keep.delete(i);
  }
  return best;
}

const source = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 7 === 0
      ? `export function f${i}(x: number) {`
      : `  const v${i} = x * ${i}; // ${"w".repeat(i % 23)}`,
  ).join("\n");

describe("randomLinePrune", () => {
  it("gives exactly the reference result for several files, budgets, seeds and pins", () => {
    for (const [n, budget, seed, pinned] of [
      [120, 400, 1, []],
      [300, 900, 42, [5, 77]],
      [80, 150, 7, [1, 80]],
      [500, 2_000, 12345, [250]],
    ] as [number, number, number, number[]][]) {
      const text = source(n);
      const r = randomLinePrune(text, { maxTokens: budget, seed, pinnedLines: pinned });
      expect(r.text, `${n} ${budget} ${seed}`).toBe(reference(text, budget, seed, pinned));
      expect(estimatePromptTokens(r.text)).toBeLessThanOrEqual(budget);
    }
  });

  it("prunes a 20,000-line file in linear time", () => {
    const text = source(20_000);
    const started = performance.now();
    const r = randomLinePrune(text, { maxTokens: 30_000, seed: 3 });
    expect(r.fits).toBe(true);
    // The per-line re-render took minutes here; linear takes well under a second.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
