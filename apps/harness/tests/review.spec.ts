import { ALLOCATOR_WINDOW_MARGIN_TOKENS, estimatePromptTokens } from "@sekhemet/context";
import { MockInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  REVIEW_ANSWER_TOKENS,
  type ReviewInput,
  numberedDiff,
  parseDiff,
  reviewCard,
} from "../src/learning/review.js";

/**
 * review-git P8, the Reviewer rebuilt: the model's part through a scripted
 * adapter (no model is loaded). One finding per criterion with a verdict and
 * a `file:line` (RG-P8-1), a review with nothing learned (RG-P8-4), a diff
 * over budget read file by file with every file not read named (RG-P8-5),
 * the coverage line (RG-P8-6), the fail-only test check (RG-P8-7), the
 * Worker's assumptions (RG-P8-8) and no model-stated confidence (RG-P8-12).
 */

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const reply = (o: unknown) => ({ text: JSON.stringify(o), toolCalls: [], usage });

const DIFF = [
  "diff --git a/src/ledger.ts b/src/ledger.ts",
  "--- a/src/ledger.ts",
  "+++ b/src/ledger.ts",
  "@@ -1,2 +1,5 @@",
  " export const rows: string[] = [];",
  "-export function append() {}",
  "+export function append(entry: string) {",
  "+  rows.push(entry);",
  "+}",
  "+export const list = () => [...rows].reverse();",
  "diff --git a/src/extra.ts b/src/extra.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/extra.ts",
  "@@ -0,0 +1,2 @@",
  "+export const debug = true;",
  "+export const unused = 1;",
  "",
].join("\n");

const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  card: {
    id: "c1",
    title: "Ledger store",
    spec: "Store entries in order.",
    acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
    criterionIds: ["AC-1", "AC-2"],
  },
  diff: DIFF,
  stagedTests: [
    {
      path: "tests/ledger.spec.ts",
      cases: [
        { name: "appends", criterionId: "AC-1" },
        { name: "lists in order", criterionId: "AC-2" },
      ],
    },
  ],
  checks: [{ gate: "test", passed: true }],
  assumptions: [],
  preferences: [],
  rules: [],
  ...over,
});

describe("the diff as the Reviewer reads it", () => {
  it("parses files, the new side's line numbers and the added lines", () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.added])).toEqual([
      ["src/ledger.ts", [2, 3, 4, 5]],
      ["src/extra.ts", [1, 2]],
    ]);
    expect(numberedDiff(files[0] as (typeof files)[0])).toBe(
      [
        "file src/ledger.ts",
        "   1   export const rows: string[] = [];",
        "     - export function append() {}",
        "   2 + export function append(entry: string) {",
        "   3 +   rows.push(entry);",
        "   4 + }",
        "   5 + export const list = () => [...rows].reverse();",
      ].join("\n"),
    );
  });
});

describe("the Reviewer judges the card's criteria (RG-P8-1, -4)", () => {
  it("gives one finding per criterion, each with a verdict and a file:line, with nothing learned", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({
        criteria: [
          { n: 1, verdict: "met", at: "src/ledger.ts:3", note: "" },
          {
            n: 2,
            verdict: "unmet",
            at: "src/ledger.ts:5",
            note: "list reverses the entries: the letter of the criterion, not its intent.",
            confidence: 0.9,
          },
        ],
        assumptions: [],
        preferences: [],
        outside: [{ at: "src/extra.ts:1", note: "A debug flag the issue did not ask for." }],
      }),
    ]);
    const r = await reviewCard(model, base());
    // RG-P8-4: no preferences or rules, and the model is still asked.
    expect(model.callHistory).toHaveLength(1);
    expect(r.modelId).toBe("gemma-4-26b");
    expect(r.findings).toEqual([
      {
        criterion: "append adds one entry",
        verdict: "met",
        evidence: "src/ledger.ts:3",
        note: "",
      },
      {
        criterion: "list returns the entries in order",
        verdict: "unmet",
        evidence: "src/ledger.ts:5",
        note: "list reverses the entries: the letter of the criterion, not its intent.",
      },
      {
        criterion: "outside: src/extra.ts",
        verdict: "unclear",
        evidence: "src/extra.ts:1",
        note: "A debug flag the issue did not ask for.",
      },
    ]);
    // RG-P8-12: no model-stated confidence reaches a finding.
    expect(JSON.stringify(r)).not.toMatch(/confiden/i);
  });

  it("a criterion the model skips or cites outside the diff is unclear at a changed line, never met", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({ criteria: [{ n: 1, verdict: "met", at: "src/other.ts:40", note: "" }] }),
    ]);
    const r = await reviewCard(model, base());
    expect(r.findings.map((f) => [f.criterion, f.verdict, f.evidence])).toEqual([
      ["append adds one entry", "unclear", "src/ledger.ts:2"],
      ["list returns the entries in order", "unclear", "src/ledger.ts:2"],
    ]);
    expect(r.findings[0]?.note).toBe(
      "AI review cited no changed line that decides this criterion.",
    );
  });

  it("an unparseable reply still gives every criterion a finding", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      { text: "I think it is fine.", toolCalls: [], usage },
    ]);
    const r = await reviewCard(model, base());
    expect(r.findings.map((f) => f.verdict)).toEqual(["unclear", "unclear"]);
  });

  it("strips a confidence the model writes into a note", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({
        criteria: [
          {
            n: 1,
            verdict: "unclear",
            at: "src/ledger.ts:2",
            note: "No empty case (confidence: 0.7).",
          },
          { n: 2, verdict: "met", at: "src/ledger.ts:5", note: "" },
        ],
      }),
    ]);
    const r = await reviewCard(model, base());
    expect(r.findings[0]?.note).toBe("No empty case.");
  });
});

describe("the fail-only test check (RG-P8-7)", () => {
  it("reports a criterion no staged case names, and never marks it met on that check", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({
        criteria: [
          {
            n: 1,
            verdict: "unclear",
            at: "src/ledger.ts:3",
            note: "The empty entry is not handled.",
          },
          { n: 2, verdict: "met", at: "src/ledger.ts:5", note: "" },
        ],
      }),
    ]);
    const r = await reviewCard(
      model,
      base({
        stagedTests: [
          { path: "tests/ledger.spec.ts", cases: [{ name: "appends", criterionId: "AC-1" }] },
        ],
      }),
    );
    // AC-1 has a staged case: its verdict stays the model's (unclear), not met.
    expect(r.findings.map((f) => [f.criterion, f.verdict])).toEqual([
      ["append adds one entry", "unclear"],
      ["list returns the entries in order", "met"],
      ["no test: list returns the entries in order", "unmet"],
    ]);
    expect(r.findings[2]?.note).toBe(
      "No staged test case names this criterion, so no check exercises it.",
    );
    expect(r.findings[2]?.evidence).toBe("src/ledger.ts:5");
    // The prompt says which staged case names each criterion.
    expect(model.callHistory[0]?.prompt).toContain("Criterion 1: tests/ledger.spec.ts: appends");
    expect(model.callHistory[0]?.prompt).toContain("Criterion 2: no staged test case names it");
  });

  it("staged tests that record no criterion give one unclear finding, not one per criterion", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [reply({ criteria: [] })]);
    const r = await reviewCard(model, base({ stagedTests: [{ path: "tests/ledger.spec.ts" }] }));
    expect(
      r.findings.filter((f) => f.criterion.startsWith("no test")).map((f) => f.verdict),
    ).toEqual(["unclear"]);
  });
});

describe("the Worker's assumptions and the preferences (RG-P8-8)", () => {
  it("gives the assumptions to the model and reports each one the diff contradicts", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({
        criteria: [
          { n: 1, verdict: "met", at: "src/ledger.ts:3", note: "" },
          { n: 2, verdict: "met", at: "src/ledger.ts:5", note: "" },
        ],
        assumptions: [
          {
            n: 1,
            contradicted: true,
            at: "src/ledger.ts:5",
            note: "list reverses, so it is not insertion order.",
          },
          { n: 2, contradicted: false, at: "", note: "" },
          { n: 9, contradicted: true, at: "src/ledger.ts:2", note: "no such assumption" },
        ],
        preferences: [{ n: 1, broken: true, at: "src/extra.ts:2", note: "An unused export." }],
      }),
    ]);
    const r = await reviewCard(
      model,
      base({
        assumptions: ["Assumed: list keeps insertion order", "Assumed: entries are strings"],
        preferences: ["No unused exports"],
      }),
    );
    expect(model.callHistory[0]?.prompt).toContain("1. Assumed: list keeps insertion order");
    expect(r.findings.slice(2)).toEqual([
      {
        criterion: "assumption: Assumed: list keeps insertion order",
        verdict: "unmet",
        evidence: "src/ledger.ts:5",
        note: "list reverses, so it is not insertion order.",
      },
      {
        criterion: "preference: No unused exports",
        verdict: "unmet",
        evidence: "src/extra.ts:2",
        note: "An unused export.",
      },
    ]);
  });
});

describe("a diff over the Reviewer's budget (RG-P8-5, -6)", () => {
  const big = [
    DIFF.trimEnd(),
    "diff --git a/src/huge.ts b/src/huge.ts",
    "--- /dev/null",
    "+++ b/src/huge.ts",
    "@@ -0,0 +1,300 @@",
    ...Array.from({ length: 300 }, (_, i) => `+export const v${i} = ${i};`),
    "",
  ].join("\n");

  it("reads whole files per request, a file over one request in parts, and cuts none", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({ criteria: [{ n: 1, verdict: "met", at: "src/ledger.ts:3", note: "" }] }),
      reply({
        criteria: [{ n: 2, verdict: "unmet", at: "src/extra.ts:1", note: "Not in order." }],
      }),
      ...Array.from({ length: 12 }, () => reply({ criteria: [] })),
    ]);
    // Room for the first file alone: each of the first two is read in its own request.
    const budgetChars =
      numberedDiff(parseDiff(big)[0] as ReturnType<typeof parseDiff>[0]).length + 5;
    const r = await reviewCard(model, base({ diff: big, budgetChars }));
    expect(r.filesChanged).toEqual(["src/ledger.ts", "src/extra.ts", "src/huge.ts"]);
    // RG-P8-5: the file larger than one request is read in parts, each whole lines.
    expect(r.filesRead).toEqual(["src/ledger.ts", "src/extra.ts", "src/huge.ts"]);
    expect(r.notRead).toEqual([]);
    const prompts = model.callHistory.map((c) => c.prompt);
    expect(prompts.length).toBeGreaterThan(3);
    expect(prompts[0]).toContain("part of the change: 1 of 3 files");
    expect(prompts[1]).toContain("part of the change: 1 of 3 files");
    expect(prompts[2]).toMatch(/part of the change: part 1 of \d+ of src\/huge\.ts/);
    expect(prompts[0]).toContain("   5 + export const list");
    // Every one of the file's 300 lines is shown once, in some part.
    const shown = prompts.slice(2).join("\n");
    for (const i of [0, 150, 299]) expect(shown).toContain(`+ export const v${i} = ${i};`);
    expect(shown.match(/\+ export const v\d+ = \d+;/g)).toHaveLength(300);
    // Merged: met in one file, unmet in the other.
    expect(r.findings.map((f) => [f.criterion, f.verdict, f.evidence])).toEqual([
      ["append adds one entry", "met", "src/ledger.ts:3"],
      ["list returns the entries in order", "unmet", "src/extra.ts:1"],
    ]);
    expect(r.coverage).toBe(
      "AI review read 3 of 3 files; 304 of 306 changed lines are cited by no finding.",
    );
  });

  it("names a file it cannot read, one line being over a request, and cuts none", async () => {
    const wide = [
      DIFF.trimEnd(),
      "diff --git a/src/wide.ts b/src/wide.ts",
      "--- /dev/null",
      "+++ b/src/wide.ts",
      "@@ -0,0 +1,1 @@",
      `+export const blob = "${"x".repeat(4_000)}";`,
      "",
    ].join("\n");
    const model = new MockInferenceAdapter("gemma-4-26b", [reply({ criteria: [] })]);
    const r = await reviewCard(model, base({ diff: wide, budgetChars: 2_000 }));
    expect(r.notRead).toEqual(["src/wide.ts"]);
    expect(r.filesRead).toEqual(["src/ledger.ts", "src/extra.ts"]);
    expect(model.callHistory.map((c) => c.prompt).join("\n")).not.toContain("xxxx");
  });

  it("counts the whole prompt against the Review model's window through the allocator", async () => {
    // A small window, a long issue and many preferences: every request, system
    // text included, fits the window less the answer cap and the margin.
    const window = 4_096;
    const model = new MockInferenceAdapter(
      "gemma-4-26b",
      Array.from({ length: 40 }, () => reply({ criteria: [] })),
    );
    Object.defineProperty(model, "contextWindow", {
      value: { contextTokens: window, maxTokens: 1_200 },
    });
    const r = await reviewCard(
      model,
      base({
        diff: big,
        card: { ...base().card, spec: "Keep every entry in the order it arrived. ".repeat(60) },
        preferences: Array.from(
          { length: 20 },
          (_, i) => `Preference ${i}: prefer small pure functions.`,
        ),
      }),
    );
    expect(r.notRead).toEqual([]);
    const budget = window - REVIEW_ANSWER_TOKENS - ALLOCATOR_WINDOW_MARGIN_TOKENS;
    for (const c of model.callHistory) {
      const used =
        estimatePromptTokens(c.systemPrompt ?? "") + estimatePromptTokens(c.prompt ?? "");
      expect(used).toBeLessThanOrEqual(budget);
    }
  });

  it("reads nothing, and names every file, when the issue alone fills the window", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", []);
    Object.defineProperty(model, "contextWindow", {
      value: { contextTokens: 2_048, maxTokens: 1_200 },
    });
    const r = await reviewCard(
      model,
      base({ card: { ...base().card, spec: "Keep entries in order. ".repeat(400) } }),
    );
    expect(model.callHistory).toHaveLength(0);
    expect(r.notRead).toEqual(["src/ledger.ts", "src/extra.ts"]);
    expect(r.findings.map((f) => f.verdict)).toEqual(["unclear", "unclear"]);
  });

  it("cites a file without an extension, such as a Makefile", async () => {
    const make = [
      "diff --git a/Makefile b/Makefile",
      "--- a/Makefile",
      "+++ b/Makefile",
      "@@ -1,1 +1,2 @@",
      " all:",
      "+\tnode build.js",
      "",
    ].join("\n");
    const model = new MockInferenceAdapter("gemma-4-26b", [
      reply({ criteria: [{ n: 1, verdict: "met", at: "Makefile:2", note: "" }] }),
    ]);
    const r = await reviewCard(
      model,
      base({ diff: make, card: { ...base().card, acceptanceCriteria: ["make builds"] } }),
    );
    expect(r.findings[0]).toMatchObject({ verdict: "met", evidence: "Makefile:2" });
    expect(r.cited[0]).toBe(true);
  });

  it("the whole change in one request when it fits", async () => {
    const model = new MockInferenceAdapter("gemma-4-26b", [reply({ criteria: [] })]);
    const r = await reviewCard(model, base());
    expect(model.callHistory).toHaveLength(1);
    expect(model.callHistory[0]?.prompt).toContain("the whole change: 2 files");
    expect(r.notRead).toEqual([]);
    expect(r.coverage).toBe(
      "AI review read 2 of 2 files; 6 of 6 changed lines are cited by no finding.",
    );
  });
});
