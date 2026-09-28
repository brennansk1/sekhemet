import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  CATCH_TOLERANCE_LINES,
  applyEdits,
  changedRanges,
  loadSeededDefects,
  runSeededDefects,
  scoreDefectReview,
  seededReviewInput,
  wholeFileDiff,
} from "../src/learning/review_eval.js";

// RG-P8-13: the seeded-defect set and its scorer, proved offline with a
// scripted Review model. The set is registered by execution
// (scripts/verify_seeded_defects.mjs): each defect passes its issue's checks
// and fails a witness test that passes on the reference solution.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A Review model that answers each request with the next scripted reply. */
function scripted(replies: string[]): LocalInferenceAdapter & { prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  return {
    modelId: "review-model",
    supportedArms: ["arm_b_json"],
    contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
    prompts,
    generate: async (req) => {
      prompts.push(req.prompt);
      return {
        text: replies[i++] ?? "{}",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
}

const set = loadSeededDefects(ROOT);
const rangesOf = (id: string) => {
  const d = set.items.find((x) => x.id === id);
  if (!d) throw new Error(id);
  const reference = readFileSync(
    join(ROOT, "fixtures", "reference_solutions", d.fixture, d.card, d.file),
    "utf8",
  );
  return { d, ranges: changedRanges(reference, applyEdits(reference, d.edits)) };
};

describe("the seeded-defect set (measurement rule 29, MS-T11-6)", () => {
  it("is registered with at least 20 defects, each executed against its checks and its witness", () => {
    expect(set.items.length).toBeGreaterThanOrEqual(20);
    const items = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "seeded_defects", "items.json"), "utf8"),
    ) as {
      id: string;
      verification: {
        frozenTests: { exitCode: number; passed: number; total: number };
        typecheck: { exitCode: number };
        lint: { exitCode: number };
        witnessOnDefect: { exitCode: number; passed: number; total: number };
        witnessOnReference: { exitCode: number; passed: number; total: number };
      };
      labelledBy: { kind: string };
    }[];
    for (const i of items) {
      const v = i.verification;
      expect(v.frozenTests.exitCode).toBe(0);
      expect(v.frozenTests.passed).toBe(v.frozenTests.total);
      expect([v.typecheck.exitCode, v.lint.exitCode]).toEqual([0, 0]);
      expect(v.witnessOnDefect.passed).toBeLessThan(v.witnessOnDefect.total);
      expect(v.witnessOnReference.passed).toBe(v.witnessOnReference.total);
      expect(i.labelledBy.kind).toBe("executed");
    }
  });

  it("sits beside the frozen suite, never in it", () => {
    const suite = readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8");
    expect(suite).not.toMatch(/seeded/);
    for (const d of set.items) expect(d.file.startsWith("src/")).toBe(true);
  });

  it("shows the Review model the issue and the diff, never the defect or its witness", () => {
    const { d } = rangesOf("vanguard-hmac-last-v1");
    const reference = readFileSync(
      join(ROOT, "fixtures", "reference_solutions", d.fixture, d.card, d.file),
      "utf8",
    );
    const cards = JSON.parse(
      readFileSync(join(ROOT, "fixtures", d.fixture, "cards.json"), "utf8"),
    ) as { id: string; title: string }[];
    const card = cards.find((c) => c.id === d.card) as { id: string; title: string };
    const input = seededReviewInput(card, d.file, applyEdits(reference, d.edits));
    const shown = JSON.stringify(input);
    expect(shown).not.toContain(d.defect);
    expect(shown).not.toContain(d.witness);
    expect(input.checks?.every((c) => c.passed)).toBe(true);
  });
});

describe("the change a defect makes, as new-side line ranges", () => {
  it("marks added lines, and both sides of a pure deletion", () => {
    expect(changedRanges("a\nb\nc\n", "a\nX\nc\n")).toEqual([[2, 2]]);
    expect(changedRanges("a\nb\nc\nd\n", "a\nd\n")).toEqual([[1, 2]]);
    expect(changedRanges("a\nb\nc\n", "a\nb\nc\nd\n")).toEqual([[4, 4]]);
  });

  it("gives every seeded item a changed range", () => {
    for (const d of set.items) expect(rangesOf(d.id).ranges.length).toBeGreaterThan(0);
  });

  it("diffs from the seed's empty file with the new side's numbers", () => {
    expect(wholeFileDiff("src/a.ts", "x\ny\n")).toBe(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+x\n+y",
    );
  });
});

describe("scoring one review (RG-P8-13)", () => {
  const f = (
    verdict: "met" | "unmet" | "unclear",
    evidence: string,
    criterion = "1. it works",
  ) => ({
    criterion,
    verdict,
    evidence,
    note: "",
  });

  it("catches within the tolerance, counts other unmet findings as false positives", () => {
    const s = scoreDefectReview("x", "src/a.ts", [[10, 10]], {
      findings: [
        f("unmet", `src/a.ts:${10 + CATCH_TOLERANCE_LINES}`),
        f("unmet", "src/a.ts:30"),
        f("unmet", "src/b.ts:10"),
      ],
      cited: [true, true, true],
    });
    expect([s.caught, s.falsePositives]).toEqual([true, 2]);
  });

  it("never counts an unclear, uncited or harness-made finding", () => {
    const s = scoreDefectReview("x", "src/a.ts", [[10, 10]], {
      findings: [
        f("unclear", "src/a.ts:10"),
        f("unmet", "src/a.ts:10"),
        f("unmet", "src/a.ts:40", "no test: 1. it works"),
        f("met", "src/a.ts:50"),
      ],
      cited: [true, false, true, true],
    });
    expect([s.caught, s.falsePositives]).toEqual([false, 0]);
  });
});

describe("the measure, proved with a scripted Review model", () => {
  it("scores a reviewer that cites every defect: recall 1, no false positive, RG-P8-13 met", async () => {
    const replies = set.items.map((d) => {
      const { ranges } = rangesOf(d.id);
      return JSON.stringify({
        criteria: [
          {
            n: 1,
            verdict: "unmet",
            at: `${d.file}:${ranges[0]?.[0]}`,
            note: "This line breaks it.",
          },
        ],
      });
    });
    const model = scripted(replies);
    const run = await runSeededDefects(set, model);
    expect(model.prompts).toHaveLength(set.items.length);
    expect(run.report.recall).toBe(1);
    expect(run.report.maxFalsePositives).toBe(0);
    expect(run.report.passes).toBe(true);
    // Each seeded defect is its own review of its issue: the bound is per reviewed change.
    expect(run.report.line).toMatch(/no reviewed change had more than 1 false positive/);
    expect(run.report.line).toMatch(/at most 1 false positive per reviewed change/);
    expect(run.assetHash).toBe(set.hash);
    expect(run.model).toBe("review-model");
    // Never shown the defect's description.
    for (const [i, d] of set.items.entries()) expect(model.prompts[i]).not.toContain(d.defect);
  });

  it("fails a reviewer that flags the first line twice: misses and false positives, per issue", async () => {
    const replies = set.items.map((d) =>
      JSON.stringify({
        criteria: [
          { n: 1, verdict: "unmet", at: `${d.file}:1`, note: "Wrong." },
          { n: 2, verdict: "unmet", at: `${d.file}:1`, note: "Wrong." },
        ],
      }),
    );
    const run = await runSeededDefects(set, scripted(replies));
    const nearTop = set.items.filter((d) =>
      rangesOf(d.id).ranges.some(([lo]) => lo - CATCH_TOLERANCE_LINES <= 1),
    );
    expect(run.report.caught).toBe(nearTop.length);
    expect(run.report.recall).toBeLessThan(0.3);
    for (const s of run.scores) expect(s.falsePositives).toBe(s.caught ? 0 : 2);
    expect(run.report.overFalsePositiveBound.length).toBe(set.items.length - nearTop.length);
    expect(run.report.passes).toBe(false);
  });

  it("never gives a partial run the verdict", async () => {
    const first = set.items[0];
    const { ranges } = rangesOf(first?.id ?? "");
    const run = await runSeededDefects(
      set,
      scripted([
        JSON.stringify({
          criteria: [{ n: 1, verdict: "unmet", at: `${first?.file}:${ranges[0]?.[0]}`, note: "x" }],
        }),
      ]),
      { only: [first?.id ?? ""] },
    );
    expect(run.report.recall).toBe(1);
    expect(run.partial).toBe(true);
    expect(run.report.passes).toBe(false);
  });

  it("refuses a set that is not registered (MS-T11-7)", () => {
    const root = mkdtempSync(join(tmpdir(), "seeded-"));
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "", assets: [] }),
    );
    expect(() => loadSeededDefects(root)).toThrow(
      /reviewer-seeded-defects is not registered.*B4\.8/,
    );
  });
});
