import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerAsset } from "../src/eval_assets.js";
import {
  heldOutShare,
  implicitRequirementRecall,
  planningCardReport,
  planningMeasureReport,
  prematureCompletionRate,
} from "../src/planning_measure.js";

// Measurement rules 7 and 29, MS-T7-5, MS-T7-7, MS-T7-8 (and NEW-measurement-4's
// test strength per card): the planning measure's figures, computed from
// recorded, scripted runs. Each share carries its exact interval; the held-out
// share sits next to the suite score, never merged into it.

describe("per generated card (MS-T7-5)", () => {
  it("reports SPIDR shape, scope, fail-at-seed, pass-on-reference, mutants killed and test strength", () => {
    const r = planningCardReport([
      {
        cardId: "c1",
        spidr: "Rule",
        scopeFiles: ["src/a.ts"],
        scopeLines: 40,
        failsAtSeed: true,
        passesOnReference: true,
        mutants: { killed: 7, total: 8 },
      },
      {
        cardId: "c2",
        spidr: "Data",
        scopeFiles: ["src/b.ts", "src/c.ts"],
        scopeLines: 120,
        failsAtSeed: false,
        passesOnReference: true,
        mutants: { killed: 0, total: 0 },
      },
      {
        cardId: "c3",
        scopeFiles: ["src/d.ts"],
        scopeLines: 10,
        failsAtSeed: true,
        passesOnReference: null,
        mutants: null,
      },
    ]);
    expect(r.rows[0]).toMatchObject({
      cardId: "c1",
      spidr: "Rule",
      files: 1,
      lines: 40,
      mutationScore: 0.875,
    });
    // No mutable lines is not a perfect score, and no campaign is not measured.
    expect(r.rows[1]?.mutationScore).toBeNull();
    expect(r.rows[2]).toMatchObject({
      spidr: "unshaped",
      mutationScore: null,
      passesOnReference: null,
    });
    expect(r.failsAtSeed).toMatchObject({ yes: 2, measured: 3 });
    expect(r.passesOnReference).toMatchObject({ yes: 2, measured: 2 });
    expect(r.failsAtSeed.interval.low).toBeGreaterThan(0);
    expect(r.spidrShapes).toEqual({ Rule: 1, Data: 1, unshaped: 1 });
  });
});

describe("end to end", () => {
  it("MS-T7-5: the share of held-out acceptance tests passing on the final main, with its interval", () => {
    const h = heldOutShare([
      { test: "a", passed: true },
      { test: "b", passed: true },
      { test: "c", passed: false },
      { test: "d", passed: true },
    ]);
    expect(h).toMatchObject({ passed: 3, total: 4, share: 0.75 });
    expect(h.interval.low).toBeCloseTo(0.194, 2);
  });

  it("MS-T7-7: implicit-requirement recall over the golden briefs, with an exact interval", () => {
    const r = implicitRequirementRecall([
      { briefId: "b1", annotated: ["r1", "r2", "r3"], inAcceptedGraph: ["r1", "r3", "extra"] },
      { briefId: "b2", annotated: ["r4"], inAcceptedGraph: [] },
    ]);
    expect(r).toMatchObject({ covered: 2, annotated: 4, rate: 0.5 });
    expect(r.perBrief).toEqual([
      { briefId: "b1", covered: 2, annotated: 3 },
      { briefId: "b2", covered: 0, annotated: 1 },
    ]);
    expect(r.interval.high).toBeGreaterThan(0.9);
  });

  it("MS-T7-8: the premature-completion rate — proven, but the held-out suite says not", () => {
    const r = prematureCompletionRate([
      { id: "slice1", markedProven: true, heldOutPassed: true },
      { id: "slice2", markedProven: true, heldOutPassed: false },
      { id: "slice3", markedProven: false, heldOutPassed: false },
    ]);
    expect(r).toMatchObject({ premature: 1, proven: 2, rate: 0.5, prematureIds: ["slice2"] });
    expect(prematureCompletionRate([]).rate).toBeNull();
  });
});

describe("the planning measure's report (rule 29: assets verified before scoring)", () => {
  const root = () => {
    const r = mkdtempSync(join(tmpdir(), "planning-"));
    for (const [name, id] of [
      ["golden_briefs", "b1"],
      ["held_out", "a"],
    ] as const) {
      mkdirSync(join(r, "fixtures", name), { recursive: true });
      writeFileSync(
        join(r, "fixtures", name, "items.json"),
        JSON.stringify([{ id, labelledBy: { principal: "the owner", kind: "person" } }]),
      );
    }
    writeFileSync(
      join(r, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "", assets: [] }),
    );
    return r;
  };
  const inputs = {
    cards: [],
    heldOut: [{ test: "a", passed: true }],
    briefs: [{ briefId: "b1", annotated: ["r1"], inAcceptedGraph: ["r1"] }],
    slices: [{ id: "s", markedProven: true, heldOutPassed: true }],
    suiteScore: { passed: 10, measured: 14 },
  };

  it("refuses to score against assets that are not registered, naming the workstream that builds them", () => {
    expect(() => planningMeasureReport(root(), inputs)).toThrow(/golden-briefs.*B2\.4/);
  });

  it("refuses briefs or held-out tests that are missing from, or not in, the registered items (review M5)", () => {
    const r = root();
    registerAsset(r, {
      name: "golden-briefs",
      path: "fixtures/golden_briefs",
      labelledBy: "the owner",
    });
    registerAsset(r, {
      name: "held-out-acceptance-suite",
      path: "fixtures/held_out",
      labelledBy: "the owner",
    });
    expect(() =>
      planningMeasureReport(r, {
        ...inputs,
        briefs: [...inputs.briefs, { briefId: "b9", annotated: ["r"], inAcceptedGraph: [] }],
      }),
    ).toThrow(/golden-briefs: b9 is not one of its items/);
    expect(() => planningMeasureReport(r, { ...inputs, heldOut: [] })).toThrow(
      /held-out-acceptance-suite: a has no result/,
    );
    // Each item once (review M5).
    expect(() =>
      planningMeasureReport(r, { ...inputs, heldOut: [...inputs.heldOut, ...inputs.heldOut] }),
    ).toThrow(/held-out-acceptance-suite: a is given more than once/);
    expect(() =>
      planningMeasureReport(r, { ...inputs, briefs: [...inputs.briefs, ...inputs.briefs] }),
    ).toThrow(/golden-briefs: b1 is given more than once/);
  });

  it("records the assets' hashes, and keeps the held-out share next to the suite score, never merged", () => {
    const r = root();
    registerAsset(r, {
      name: "golden-briefs",
      path: "fixtures/golden_briefs",
      labelledBy: "the owner",
    });
    registerAsset(r, {
      name: "held-out-acceptance-suite",
      path: "fixtures/held_out",
      labelledBy: "the owner",
      heldOut: "from the Planner and Seshat",
    });
    const report = planningMeasureReport(r, inputs);
    expect(report.assets.map((a) => a.name)).toEqual([
      "golden-briefs",
      "held-out-acceptance-suite",
    ]);
    expect(report.suiteScore).toEqual({ passed: 10, measured: 14 });
    expect(report.heldOut).toMatchObject({ passed: 1, total: 1 });
    expect(report.line).toMatch(/suite 10\/14 .* held-out 1\/1 .* reported apart/);
    // Every share with its interval, labelled item-level (review minor 4).
    expect(report.line).toMatch(/recall 1\/1 \(100%, 95% CI 2%-100%\)/);
    expect(report.line).toMatch(/premature completion 0\/1 \(0%, 95% CI 0%-98%\)/);
    expect(report.intervals).toMatch(/item-level/);
  });
});
