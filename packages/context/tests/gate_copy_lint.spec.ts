import { gateCopy } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { findCapitalEmphasis, findContradictions, findPlaceholders } from "../src/prompt_lint.js";

// PROMPT_STANDARD rules 5, 10, 12 and 14 over the gates copy module
// (packages/gates/src/copy.ts): every remedy a gate sends the model.

const SAMPLE_ARGS = ["src/ledger.ts", "Entry", "amount, id, note", "4", "TS2304", "./types.js"];

/** Each entry rendered: a string as it is, a builder with sample arguments. */
function rendered(): [string, string][] {
  return Object.entries(gateCopy).map(([key, value]) => [
    key,
    typeof value === "function"
      ? (value as (...a: string[]) => string)(...SAMPLE_ARGS.slice(0, value.length))
      : String(value),
  ]);
}

describe("the gates copy module passes the prompt lint", () => {
  it("renders every entry to text", () => {
    expect(rendered().length).toBeGreaterThan(20);
    for (const [key, text] of rendered()) expect(text.trim().length, key).toBeGreaterThan(10);
  });

  it("has no placeholder and no contradiction", () => {
    for (const [key, text] of rendered()) {
      expect(findPlaceholders(text), key).toEqual([]);
      expect(findContradictions(text), key).toEqual([]);
    }
  });

  it("uses capitals only for allowlisted acronyms", () => {
    const found = rendered().flatMap(([key, text]) =>
      findCapitalEmphasis(text).map((w) => `${key}: ${w}`),
    );
    // The B2.3 review's rule 14 rewrite removed the two grandfathered words
    // (SPIDR in the bounds remedy, an environment variable in the visual one).
    expect(found).toEqual([]);
  });

  it("gives the Worker only steps it can take (rule 14)", () => {
    for (const [key, text] of rendered()) {
      // What only a person can do reaches a person through note with a gate.
      expect(text, key).not.toMatch(/ask a person|a person must approve|SEKHEMET_/);
      expect(text, key).not.toMatch(/\bsplit this card\b/i);
      expect(text, key).not.toMatch(/by moving it to/);
    }
  });

  it("never sends the model to read a file to find exports or members (GT-M6-3)", () => {
    for (const [key, text] of rendered()) {
      if (/^(missingExport|unknownName|unknownMember|unknownProperty)/.test(key)) {
        expect(text, key).not.toMatch(/\bread\b/i);
      }
      expect(text, key).not.toMatch(/Read the module/);
    }
  });

  it("never asks the implementer to add a test (GT-M6-4, rule 17)", () => {
    for (const [key, text] of rendered()) {
      expect(text, key).not.toMatch(/\b(add|write) a test\b/i);
    }
  });
});
