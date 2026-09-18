import type { CardRecord } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { reviewCard } from "../src/learning/review.js";

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const card = { id: "c", title: "Api (SPIDR: Path)" } as unknown as CardRecord;

describe("Merit's review against learned preferences", () => {
  it("returns concrete findings and normalises severities", async () => {
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: '{"findings":[{"severity":"likely_send_back","note":"src/api.ts uses a default export; the lead wants named exports"},{"severity":"odd","note":"consider naming the handler after the route"}]}',
        toolCalls: [],
        usage,
      },
    ]);
    const findings = await reviewCard(model, {
      card,
      diff: "+export default function handler() {}",
      preferences: ["Use named exports, never default exports"],
      rules: [],
    });
    expect(findings.map((f) => f.severity)).toEqual(["likely_send_back", "consider"]);
  });

  it("does not spend a model call when nothing has been learned yet", async () => {
    const model = new MockInferenceAdapter("dirk-27b", []);
    expect(await reviewCard(model, { card, diff: "+x", preferences: [], rules: [] })).toEqual([]);
  });
});
