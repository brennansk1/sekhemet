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
