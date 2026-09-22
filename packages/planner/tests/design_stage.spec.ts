import { describe, expect, it } from "vitest";
import { designStage, renderBrief } from "../src/design_stage.js";

/**
 * The design stage is proportional (design: "Most work needs almost none of
 * this"). Before it existed, the planner treated these three specs the same
 * way, and turned the billing service's "fast", "secure" and "scale to many
 * users" into three "happy path" cards.
 */
const BILLING =
  "a billing service that charges customers monthly, handles refunds, and emails invoices; it should be fast and secure and scale to many users";

describe("the design stage", () => {
  it("says nothing for a small change to an existing project", () => {
    const d = designStage("add a --verbose flag to the CLI", { greenfield: false });
    expect(d.proportion).toBe("none");
    expect(d.say).toEqual([]);
  });

  it("says one sentence for a calculator, and records its default", () => {
    const d = designStage("build me a calculator", { greenfield: true });
    expect(d.proportion).toBe("sentence");
    expect(d.say).toHaveLength(1);
    expect(d.say[0]).toMatch(/^Building a calculator\./);
    expect(d.assumptions.some((a) => /TypeScript/.test(a))).toBe(true);
    expect(d.questions).toEqual([]);
  });

  it("asks one or two questions about things hard to change later, and proceeds anyway", () => {
    const d = designStage("a CLI that syncs my notes to S3", { greenfield: true });
    expect(d.proportion).toBe("questions");
    expect(d.questions.length).toBeGreaterThanOrEqual(1);
    expect(d.questions.length).toBeLessThanOrEqual(2);
    for (const q of d.questions) expect(q.default).not.toBe("");
    expect(d.say.join("\n")).toMatch(/Proceeding on the defaults/);
  });

  it("writes a brief for a service that moves money, and names its riskiest assumption", () => {
    const d = designStage(BILLING, { greenfield: true });
    expect(d.proportion).toBe("brief");
    expect(d.riskiest).toMatch(/twice/);
    const brief = renderBrief(d, { gates: ["typecheck", "lint", "test"] });
    for (const section of [
      "## Problem",
      "## Outcome",
      "## Non-goals",
      "## Constraints",
      "## Prior art",
      "## Riskiest assumption",
      "## The first slice",
      "## Definition of done",
      "## Invariants",
    ]) {
      expect(brief).toContain(section);
    }
  });

  it("turns quality words into constraints with defaults, not into cards", () => {
    const d = designStage(BILLING, { greenfield: true });
    expect(d.buildSpec).not.toMatch(/fast|secure|scale/i);
    expect(d.buildSpec).toMatch(/charges customers monthly/);
    expect(d.buildSpec).toMatch(/refunds/);
    expect(d.buildSpec).toMatch(/invoices/);
    const constraints = d.constraints.map((c) => c.quality);
    expect(constraints).toEqual(["fast", "secure", "scale to many users"]);
    for (const c of d.constraints) expect(c.default.length).toBeGreaterThan(10);
  });

  it("drops the request phrasing from what gets built", () => {
    expect(designStage("build me a calculator", { greenfield: true }).buildSpec).toBe(
      "a calculator",
    );
    expect(designStage("I want a todo app", { greenfield: true }).buildSpec).toBe("a todo app");
  });
});
