import { estimatePromptTokens, pruneLines } from "@sekhemet/context";
import { describe, expect, it } from "vitest";
import { randomLinePrune } from "../src/null_baselines.js";

// MS-T7-6 (measurement rule 13's null baselines): the context pruner is
// compared with structure-preserving random line dropping at the same token
// budget. This is the null arm: the same output shape, lines kept at random.

const FILE = [
  'import { Entry } from "./types.js";',
  "",
  "export class Ledger {",
  "  private rows: Entry[] = [];",
  ...Array.from({ length: 60 }, (_, i) => `  // bookkeeping note ${i} about nothing in particular`),
  "  append(entry: Entry): void {",
  "    this.rows.push(entry);",
  "  }",
  "}",
  "export function total(rows: Entry[]): number {",
  "  return rows.reduce((n, r) => n + r.amount, 0);",
  "}",
].join("\n");

describe("the pruner's null baseline: structure-preserving random line dropping (MS-T7-6)", () => {
  it("fits the same budget, keeps declarations, imports and pinned lines, and marks what it dropped", () => {
    const r = randomLinePrune(FILE, { maxTokens: 150, seed: 7, pinnedLines: [66] });
    expect(r.fits).toBe(true);
    expect(estimatePromptTokens(r.text)).toBeLessThanOrEqual(150);
    for (const line of [
      'import { Entry } from "./types.js";',
      "export class Ledger {",
      "export function total(rows: Entry[]): number {",
      "    this.rows.push(entry);",
    ]) {
      expect(r.text).toContain(line);
    }
    expect(r.elided.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/… \(lines \d+-\d+ elided; read_file that range if needed\) …/);
  });

  it("is reproducible from its seed, differs across seeds, and ignores the task", () => {
    const a = randomLinePrune(FILE, { maxTokens: 150, seed: 1 });
    expect(randomLinePrune(FILE, { maxTokens: 150, seed: 1 }).text).toBe(a.text);
    expect(randomLinePrune(FILE, { maxTokens: 150, seed: 2 }).text).not.toBe(a.text);
  });

  it("matches the pruner's own output size when given it, and returns a fitting text unchanged", () => {
    const pruned = pruneLines(FILE, "total amount", { maxTokens: 150 });
    const r = randomLinePrune(FILE, { maxTokens: estimatePromptTokens(pruned.text), seed: 3 });
    expect(estimatePromptTokens(r.text)).toBeLessThanOrEqual(estimatePromptTokens(pruned.text));
    const small = "export const a = 1;\n";
    expect(randomLinePrune(small, { maxTokens: 100, seed: 1 })).toMatchObject({
      text: small,
      fits: true,
    });
  });
});
