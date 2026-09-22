import { MockInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { SpidrFeaturePlanner } from "../src/planner.js";

/**
 * A card must say what the code has to do. Planning a billing service on
 * 2026-09-22 gave every card the same acceptance sentence — "<title> is
 * observable through the exported surface of <file>" — which an empty export
 * satisfies; and "a retried charge must never charge a customer twice" became
 * the last card, a "happy path". The frozen suite never saw either: its cards
 * are written by hand.
 */
const SPEC =
  "a billing service that charges customers monthly, handles refunds, emails invoices; a retried or duplicated charge request must never charge a customer twice";

const assertions = (stories: { acceptanceTests: { assertion: string }[] }[]) =>
  stories.flatMap((s) => s.acceptanceTests.map((t) => t.assertion));

describe("cards say what the code must do", () => {
  it("never uses the tautology as a card's only criterion", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({ parentId: "epic_b", spec: SPEC });
    for (const story of plan.stories) {
      const own = story.acceptanceTests.map((t) => t.assertion);
      expect(own.some((a) => !/is observable through the exported surface/.test(a))).toBe(true);
    }
    expect(assertions(plan.stories).some((a) => /refunds/i.test(a))).toBe(true);
  });

  it("treats 'must never … twice' as a rule, and schedules it right after the contract", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({ parentId: "epic_b", spec: SPEC });
    const kinds = plan.stories.map((s) => s.slice);
    expect(kinds[0]).toBe("interface");
    const rule = plan.stories[1];
    expect(rule?.slice).toBe("rule");
    expect(rule?.card.title).toMatch(/never charge a customer twice/i);
  });

  it("puts the riskiest assumption first even when the spec never states it", async () => {
    // The design stage names it (money → "never charge twice"); the person
    // did not write it down, and it is still the first thing worth proving.
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_b",
      spec: "a billing service that charges customers monthly, handles refunds",
      riskiest:
        "A charge is correct and happens once: a retried or duplicated request must never charge a customer twice.",
    });
    const second = plan.stories[1];
    expect(second?.slice).toBe("rule");
    expect(second?.card.title).toMatch(/^Riskiest assumption/);
    expect(assertions([second as never]).join(" ")).toMatch(/never charge a customer twice/);
  });

  it("asks the model for a checkable behaviour per slice, and uses it", async () => {
    const adapter = new MockInferenceAdapter("planner", [
      {
        text: JSON.stringify({
          slices: [
            {
              kind: "interface",
              title: "Billing types",
              keywords: ["billing", "types"],
              rationale: "types first",
              behaviour: "An Invoice has an id, a customer id, an amount in cents and a due date.",
            },
            {
              kind: "path",
              title: "Refund an invoice",
              keywords: ["refund"],
              rationale: "happy path",
              behaviour:
                "Given a paid invoice of 1000 cents, refunding 400 leaves a balance of 600 and records one refund.",
            },
          ],
        }),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const plan = await new SpidrFeaturePlanner({ adapter }).decomposeSpec({
      parentId: "epic_b",
      spec: "billing with refunds",
    });
    expect(adapter.callHistory[0]?.systemPrompt).toMatch(/behaviour/);
    expect(assertions(plan.stories)).toContain(
      "Given a paid invoice of 1000 cents, refunding 400 leaves a balance of 600 and records one refund.",
    );
  });
});
