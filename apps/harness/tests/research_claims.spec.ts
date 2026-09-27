import { describe, expect, it } from "vitest";
import {
  type RiskVector,
  acceptRevision,
  adjudicate,
  extractClaims,
  renderDisagreements,
  reviewEligible,
  sentences,
} from "../src/research/claims.js";
import type { Source } from "../src/research/sources.js";

const source = (kind: string, ref: string): Source => ({ kind, ref });

describe("claim typing", () => {
  it("keeps code blocks out of the claim list", () => {
    const text =
      "The parser is strict [1].\n\n```ts\nconst a = 1; // this is not a claim at all\n```\n\nIt throws on bad input [2].";
    expect(sentences(text).some((s) => s.includes("const a = 1"))).toBe(false);
  });

  it("types a runnable statement about an API as executable, with its subject", () => {
    const [claim] = extractClaims(
      "The `csv-parse` package exports a `parse` function that returns a stream [1].",
    );
    expect(claim?.kind).toBe("executable");
    expect(claim?.subject).toBe("csv-parse");
    expect(claim?.citations).toEqual([1]);
  });

  it("carries the version when the sentence pins one", () => {
    const [claim] = extractClaims("In `zod` 3.22 the `parse` method throws a ZodError [2].");
    expect(claim?.kind).toBe("executable");
    expect(claim?.version).toBe("3.22");
  });

  it("types a dated statement as temporal", () => {
    const [claim] = extractClaims(
      "As of September 2026 the library is maintained by a single author [3].",
    );
    expect(claim?.kind).toBe("temporal");
  });

  it("types a hedged statement as contested rather than asserting it", () => {
    const [claim] = extractClaims(
      "Some sources report that the option is ignored, though this is unclear [4].",
    );
    expect(claim?.kind).toBe("contested");
  });

  it("falls back to citational, and numbers claims from one", () => {
    const claims = extractClaims(
      "The project moved to a monorepo in 2024 [1]. It has two maintainers listed [2].",
    );
    expect(claims.map((c) => c.kind)).toEqual(["citational", "citational"]);
    expect(claims.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("the disagreement ledger", () => {
  it("says nothing when the sources agree", () => {
    expect(
      adjudicate("maintained?", [
        { stance: "maintained", source: source("documentation", "https://docs.x/") },
        { stance: "Maintained", source: source("forum", "https://github.com/x/issues/1") },
      ]),
    ).toBeUndefined();
  });

  it("prefers the more authoritative source and says so", () => {
    const d = adjudicate("does it stream?", [
      { stance: "it streams", source: source("documentation", "https://docs.x/api") },
      { stance: "it buffers", source: source("forum", "https://stackoverflow.com/q/1") },
    ]);
    expect(d?.betterSupported).toBe("it streams");
    expect(d?.why).toContain("documentation");
  });

  it("breaks a tie between equals by recency", () => {
    const d = adjudicate("default timeout?", [
      { stance: "30 seconds", source: source("documentation", "https://a/1"), at: "2023-01-01" },
      { stance: "60 seconds", source: source("documentation", "https://b/2"), at: "2026-05-01" },
    ]);
    expect(d?.betterSupported).toBe("60 seconds");
    expect(d?.why).toContain("newer");
  });

  it("reports both positions rather than only the winner", () => {
    const d = adjudicate("does it stream?", [
      { stance: "it streams", source: source("documentation", "https://docs.x/api") },
      { stance: "it buffers", source: source("forum", "https://stackoverflow.com/q/1") },
    ]);
    const rendered = renderDisagreements(d ? [d] : []);
    expect(rendered).toContain("it streams");
    expect(rendered).toContain("it buffers");
    expect(rendered).toContain("Better supported");
  });
});

describe("the gate on revision", () => {
  const base: RiskVector = {
    badCitations: 2,
    uncovered: 1,
    failedClaims: 1,
    unreproduced: 1,
    confidence: 0.6,
  };

  it("accepts a revision that improves a component and worsens none", () => {
    const v = acceptRevision(base, { ...base, badCitations: 0 });
    expect(v.accept).toBe(true);
    expect(v.reason).toContain("fewer unverified citations");
  });

  it("refuses a revision that trades one component for another", () => {
    const v = acceptRevision(base, { ...base, badCitations: 0, uncovered: 2 });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain("fewer sub-questions answered");
  });

  it("refuses a rewrite that measures the same, so the loop terminates", () => {
    expect(acceptRevision(base, { ...base }).accept).toBe(false);
    expect(acceptRevision(base, { ...base }).reason).toContain("no measured improvement");
  });

  it("refuses a revision that only lowers confidence", () => {
    expect(acceptRevision(base, { ...base, confidence: 0.59 }).accept).toBe(false);
  });
});

describe("review eligibility", () => {
  const claims = extractClaims(
    "The `zod` package exports a `parse` method that throws on bad input [1]. The project has two maintainers [2].",
  );

  it("holds a report back while an executable claim has no verdict", () => {
    const r = reviewEligible(claims, new Map());
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("executable claim");
  });

  it("releases it once every executable claim has one, reproduced or not", () => {
    const verdicts = new Map(
      claims.filter((c) => c.kind === "executable").map((c) => [c.id, "unreproducible" as const]),
    );
    expect(reviewEligible(claims, verdicts).eligible).toBe(true);
  });
});
