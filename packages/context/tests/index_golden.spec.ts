import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRankedRepoMap, outlineFile } from "../src/ranked_repo_map.js";
import { extractSymbolOutline } from "../src/symbol_outline.js";

/**
 * Characterization of the context package's own source readers, recorded
 * before they moved onto the source index (gates T2, context CX-IX-*): the
 * ranked map's outline and ranking, and the flat map's outline. Where the
 * index answers better, the test names the difference.
 */

const FILES: Record<string, string> = {
  "src/types.ts": [
    "/** The ledger's record types. */",
    "export interface Entry {",
    "  id: string;",
    "  amount: number;",
    "}",
    "export type EntryId = string;",
    "export enum Kind { Debit, Credit }",
  ].join("\n"),
  "src/ledger.ts": [
    'import type { Entry } from "./types.js";',
    'import { total } from "./math.js";',
    "export class Ledger {",
    "  private entries: Entry[] = [];",
    "  constructor(public readonly name: string) {}",
    "  add(entry: Entry): void {",
    "    this.entries.push(entry);",
    "  }",
    "  private secret(): void {}",
    "  balance(): number {",
    "    return total(this.entries.map((e) => e.amount));",
    "  }",
    "}",
    "export const openLedger = (name: string): Ledger => new Ledger(name);",
    "export function closeLedger(l: Ledger): void {",
    "  void l;",
    "}",
  ].join("\n"),
  "src/math.ts": [
    "export function total(xs: number[]): number {",
    "  return xs.reduce((a, b) => a + b, 0);",
    "}",
    "export const ZERO = 0, ONE = 1;",
    "function hidden(): void {}",
  ].join("\n"),
  "src/cli.ts": [
    'import { openLedger } from "./ledger.js";',
    'export { total } from "./math.js";',
    "export default function main(): void {",
    '  openLedger("x").balance();',
    "}",
  ].join("\n"),
};

describe("the context package's source readers keep their answers (CX-IX)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "ctx-golden-"));
    dirs.push(root);
    for (const [f, body] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    return root;
  };

  it("outlines each file: signatures, exports, imports and identifiers", () => {
    const out = Object.fromEntries(
      Object.entries(FILES).map(([f, body]) => {
        const o = outlineFile(f, body);
        return [f, { ...o, identifiers: [...o.identifiers].sort() }];
      }),
    );
    expect(out).toMatchSnapshot();
  });

  it("ranks and renders the map the same way", () => {
    const map = buildRankedRepoMap(repo(), {
      scopeFiles: ["src/ledger.ts"],
      budgetTokens: 1200,
      specText: "Add a closeLedger that zeroes the total",
    });
    expect({ text: map.text, files: map.files, considered: map.considered }).toMatchSnapshot();
  });

  it("outlines a file for the flat map", () => {
    // The one difference from the line reader: `export default function`
    // is outlined now (it matched none of the reader's line prefixes).
    expect(extractSymbolOutline("src/cli.ts", FILES["src/cli.ts"] ?? "")).toContain(
      "export default function main(): void",
    );
    expect(
      Object.fromEntries(Object.entries(FILES).map(([f, b]) => [f, extractSymbolOutline(f, b)])),
    ).toMatchSnapshot();
  });
});
