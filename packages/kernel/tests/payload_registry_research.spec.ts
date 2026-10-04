import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.4 (models MD-N11-1..3; design-stage DS-N2-9): one research golden-set
// run is a registered event. Its payload is structural — the set's hash and
// version, the host, per contender its measures and grades, the pipeline
// verdicts and the adoption verdicts; the reasons, free text, only private.

const SHA = "d".repeat(64);
const run = () => ({
  setHash: SHA,
  setVersion: "1",
  host: "host-a",
  items: 25,
  contenders: [
    {
      model: "spark-x2.5-4b",
      pipeline: "tool-loop",
      correct: 24,
      n: 25,
      accuracy: 0.96,
      citationPrecision: 0.9,
      verifiedCitations: 30,
      unverifiedCitations: 3,
      secondsPerQuestion: 41.5,
      peakResidentBytes: 5 * 1024 ** 3,
      grades: [
        { id: "rg-1", grade: 1 },
        { id: "rg-2", grade: 0.5 },
      ],
      benchmarkEvent: "evt_1",
    },
    {
      model: "apodex-1.1-mini",
      pipeline: "native",
      correct: 15,
      n: 25,
      accuracy: 0.6,
      citationPrecision: null,
      verifiedCitations: 0,
      unverifiedCitations: 0,
      secondsPerQuestion: 60,
      grades: [],
    },
  ],
  pipelines: [
    {
      model: "spark-x2.5-4b",
      recommended: "tool-loop",
      notRecommended: ["native"],
      tests: [
        { a: "native", b: "tool-loop", aRight: 10, bRight: 24, better: 14, worse: 0, p: 0.0001 },
      ],
    },
  ],
  adoption: {
    incumbent: "apodex-1.1-mini",
    adopt: "spark-x2.5-4b",
    verdicts: [{ model: "spark-x2.5-4b", allowed: true, quality: "better", p: 0.01, pLoss: 0.99 }],
  },
});

describe("research/golden_run is registered (kernel rule 33)", () => {
  it("is in the registry", () => {
    expect(PAYLOAD_SCHEMAS["research/golden_run"]).toBeDefined();
  });

  it("accepts a run as recordResearchBakeoff writes it, reasons private", () => {
    expect(() =>
      checkEventPayload("research/golden_run", run(), {
        reasons: { "spark-x2.5-4b": "better on 14 paired items" },
      }),
    ).not.toThrow();
  });

  it("refuses a reason in the payload and an ungraded value", () => {
    const withReason = run();
    (withReason.adoption.verdicts[0] as Record<string, unknown>).reason = "free text";
    expect(() => checkEventPayload("research/golden_run", withReason, undefined)).toThrow();
    const badGrade = run();
    (badGrade.contenders[0]?.grades[0] as { grade: number }).grade = 0.7;
    expect(() => checkEventPayload("research/golden_run", badGrade, undefined)).toThrow();
    const badPipeline = run();
    (badPipeline.contenders[0] as { pipeline: string }).pipeline = "shell";
    expect(() => checkEventPayload("research/golden_run", badPipeline, undefined)).toThrow();
  });
});

// Design-stage DS-S8-3 (amended by the owner, 2026-09-28): the measurement
// that admits a Planning model's reuse queries is a registered event, all
// structural — the model, the prompt's and the set's hashes, both arms' rates.
describe("research/reuse_queries_measured is registered (kernel rule 33)", () => {
  const measured = () => ({
    model: "seshat-planner",
    promptHash: SHA,
    setHash: SHA,
    n: 44,
    keywords: { p1: 0.5, silence: 1, measured: 44 },
    modelQueries: { p1: null, silence: 0.9, measured: 40 },
    fromModel: 31,
    admitted: false,
  });

  it("is in the registry and accepts a measurement", () => {
    expect(PAYLOAD_SCHEMAS["research/reuse_queries_measured"]).toBeDefined();
    expect(() =>
      checkEventPayload("research/reuse_queries_measured", measured(), undefined),
    ).not.toThrow();
  });

  it("carries PROMPT_STANDARD 35.4's paired test and the rule it was judged by (C2c)", () => {
    const judged = {
      ...measured(),
      paired: { needs: 34, gained: 7, lost: 0, gainP: 1 / 128 },
      admissionRule: "prompt-standard-35.4",
    };
    expect(() =>
      checkEventPayload("research/reuse_queries_measured", judged, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "research/reuse_queries_measured",
        { ...judged, admissionRule: "higher-is-enough" },
        undefined,
      ),
    ).toThrow();
    expect(() =>
      checkEventPayload(
        "research/reuse_queries_measured",
        { ...judged, paired: { ...judged.paired, gainP: 2 } },
        undefined,
      ),
    ).toThrow();
  });

  it("refuses a query's words in the payload and a rate above one", () => {
    const withQueries = { ...measured(), queries: ["email sending"] };
    expect(() =>
      checkEventPayload("research/reuse_queries_measured", withQueries, undefined),
    ).toThrow();
    const badRate = { ...measured(), keywords: { p1: 1.5, silence: 1, measured: 44 } };
    expect(() =>
      checkEventPayload("research/reuse_queries_measured", badRate, undefined),
    ).toThrow();
  });
});
