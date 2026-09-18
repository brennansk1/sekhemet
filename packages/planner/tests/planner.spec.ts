import { describe, expect, it } from "vitest";
import { ClarEvalAmbiguityClassifier, SpidrFeaturePlanner } from "../src/planner.js";

describe("@sekhemet/planner", () => {
  const classifier = new ClarEvalAmbiguityClassifier();
  const planner = new SpidrFeaturePlanner();

  it("classifies high-ambiguity task and provides DecisionRequest with preview sketches", async () => {
    const ambiguousSpec =
      "Support cloud or local backends. Let's maybe allow DynamoDB, PostgreSQL, or SQLite. Developer can configure it somehow.";

    const result = await classifier.classifyAmbiguity(ambiguousSpec);

    expect(result.askUser).toBe(true);
    expect(result.decision).toBeDefined();
    expect(result.decision?.question).toContain("Multiple architectural paths");
    expect(result.decision?.options.length).toBeGreaterThanOrEqual(2);
    expect(result.decision?.previewSketches.length).toBeGreaterThanOrEqual(2);
  });

  it("classifies concrete, low-ambiguity task and permits autonomous execution without asking", async () => {
    const concreteSpec =
      "Add column is_archived boolean default false to cards table in schema.ts and update types.ts.";

    const result = await classifier.classifyAmbiguity(concreteSpec);

    expect(result.askUser).toBe(false);
    expect(result.decision).toBeUndefined();
  });

  it("decomposes complex feature into SPIDR stories with strict card boundaries", async () => {
    const featureDesc =
      "Implement user authentication with JWT session cookies, password hashing, and rate limiting.";

    const decomp = await planner.decomposeFeature("epic_auth", featureDesc);

    expect(decomp.stories.length).toBeGreaterThanOrEqual(3);
    // Every story touches at most 3 files
    for (const story of decomp.stories) {
      expect(story.scopeFiles.length).toBeLessThanOrEqual(3);
      expect(story.tier).toBe("story");
    }
    expect(decomp.spikeNeeded).toBe(false);
  });
});
