import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimatePromptTokens, tokensForChars } from "../src/allocator.js";
import { FALLBACK_CHARS_PER_TOKEN, estimateTokens } from "../src/tokens.js";

/**
 * CX-N1-2: without a tokenizer, one fallback ratio defined in one place, and
 * no other estimator in `packages/context`. Budgets, pressure tiers, masking
 * pointers and condensing reports then agree on every count.
 */
describe("CX-N1-2: one token estimator", () => {
  const samples = ["", "a", "export const x = 1;\n", "x".repeat(1000), "héllo wörld ".repeat(37)];

  it("the prompt estimate and the shared estimate are one function of the one ratio", () => {
    for (const s of samples) {
      expect(estimatePromptTokens(s)).toBe(estimateTokens(s));
      expect(tokensForChars(s.length)).toBe(estimateTokens(s));
      expect(estimateTokens(s)).toBe(Math.ceil(s.length / FALLBACK_CHARS_PER_TOKEN));
    }
  });

  it("errs on the side that does not overflow: at most the measured ~3.0 characters per token's undercount", () => {
    expect(FALLBACK_CHARS_PER_TOKEN).toBeLessThanOrEqual(3.2);
    expect(FALLBACK_CHARS_PER_TOKEN).toBeGreaterThanOrEqual(3);
  });

  it("no other character ratio exists in the package's source", () => {
    const dir = join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      if (f === "tokens.ts") continue;
      const text = readFileSync(join(dir, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/length\s*\/\s*\d|[*/]\s*3\.2\b|[*/]\s*4\s*\)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
