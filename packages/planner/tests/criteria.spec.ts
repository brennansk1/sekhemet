import { describe, expect, it } from "vitest";
import {
  SpidrFeaturePlanner,
  criterionIdsFor,
  exampleRows,
  lintCriterion,
  mechanismIn,
} from "../src/index.js";

/**
 * Acceptance criteria say what the code must do (planner-pm §2.3): the lint
 * refuses a criterion that repeats the title, has no concrete value, names no
 * domain noun or outcome, or is satisfied by an empty export named after the
 * title; hard invariants state the correct behaviour; titles are never clause
 * fragments; mechanisms are epics, not cards.
 */
const SPEC = "Refund a paid invoice: a refund leaves the invoice balance reduced.";
const codes = (criterion: string, title = "Refund a paid invoice") =>
  lintCriterion(criterion, { title, specText: SPEC }).problems.map((p) => p.code);

describe("PM-P1-5: the criterion lint", () => {
  it("refuses a criterion that repeats its card's title", () => {
    expect(codes("Refund a paid invoice")).toContain("repeats_title");
  });

  it("refuses a criterion with no concrete value", () => {
    expect(codes("Given a paid invoice, a refund leaves the balance reduced")).toContain(
      "no_value",
    );
  });

  it("refuses a criterion an empty export named after the title satisfies", () => {
    expect(codes("refundPaidInvoice is exported from src/refund.ts")).toContain("title_only");
    expect(codes("Refund a paid invoice is observable through the exported surface")).toContain(
      "title_only",
    );
  });

  it("refuses one that names no domain noun from the spec, or no outcome", () => {
    expect(codes("Given 3 widgets, then 2 gadgets remain")).toContain("no_domain_noun");
    expect(codes("A paid invoice of 1000 cents")).toContain("no_outcome");
  });

  it("accepts a behaviour with concrete values and an observable outcome", () => {
    const lint = lintCriterion(
      "Given a paid invoice of 1000 cents, refunding 400 leaves a balance of 600",
      { title: "Refund a paid invoice", specText: SPEC },
    );
    expect(lint.problems).toEqual([]);
    expect(lint.ok).toBe(true);
  });
});

describe("criterion ids: stable and tag-safe", () => {
  it("gives each criterion of a card its own id, carried in a test title", () => {
    const ids = criterionIdsFor("story_path_ab12cd34", 3);
    expect(ids).toEqual([
      "story_path_ab12cd34.c1",
      "story_path_ab12cd34.c2",
      "story_path_ab12cd34.c3",
    ]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

describe("PM-P1-6: a hard invariant's criterion states the correct behaviour", () => {
  it("'a retried charge must never charge a customer twice' returns the original result, one charge", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_c",
      spec: "A retried charge must never charge a customer twice.",
    });
    const criteria = plan.stories.flatMap((s) => s.acceptanceTests.map((t) => t.assertion));
    const invariant = criteria.find((c) => /original result/.test(c));
    expect(invariant, criteria.join(" | ")).toBeDefined();
    expect(invariant).toMatch(/retried/);
    expect(invariant).toMatch(/exactly one charge/);
    expect(invariant).not.toMatch(/reject/i);
  });
});

describe("PM-P1-9: no card is titled from a clause fragment", () => {
  it("'Let users log in with email and password' gives no 'Email' or 'Password' card", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_l",
      spec: "Let users log in with email and password",
    });
    const titles = plan.stories.map((s) => s.card.title);
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t).not.toMatch(/^(Email|Password)\b/i);
      expect(t).not.toMatch(/happy path/i);
    }
    expect(titles.some((t) => /log in with email and password/i.test(t))).toBe(true);
  });

  it("still splits a list of real capabilities", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_a",
      spec: "Implement user authentication with JWT session cookies, password hashing, and rate limiting.",
    });
    const titles = plan.stories.map((s) => s.card.title.toLowerCase());
    expect(titles.some((t) => t.includes("password hashing"))).toBe(true);
    expect(titles.some((t) => t.includes("rate limiting"))).toBe(true);
  });
});

describe("PM-P1-19 (extraction): concrete values become example rows", () => {
  it("reads one row per example: the given values in, the outcome out", () => {
    expect(
      exampleRows(
        "Given a paid invoice of 1000 cents, refunding 400 leaves 600; given a paid invoice of 500 cents, refunding 500 leaves 0",
      ),
    ).toEqual([
      { args: [1000, 400], expected: 600 },
      { args: [500, 500], expected: 0 },
    ]);
  });

  it("reads no row from a criterion about a refusal or with no value", () => {
    expect(exampleRows("Given 1200 of 1000 cents, the refund is rejected")).toEqual([]);
    expect(exampleRows("A refund leaves the invoice balance reduced")).toEqual([]);
  });
});

describe("PM-P1-20: a mechanism is an epic, never a single card", () => {
  it("recognises the mechanisms of §2.1.10", () => {
    expect(mechanismIn("Build a repo map of the source tree")).toBe("repo map");
    expect(mechanismIn("A tracker adapter for Jira")).toBe("tracker adapter");
    expect(mechanismIn("a deep research pipeline")).toBe("deep-research pipeline");
    expect(mechanismIn("Refund a paid invoice")).toBeUndefined();
  });

  it("refuses the single card and re-splits it as an epic", async () => {
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_m",
      spec: "Build a repo map of the source tree.",
    });
    expect(plan.stories.some((s) => /repo map/i.test(s.card.title))).toBe(false);
    expect(plan.epics.map((e) => e.mechanism)).toEqual(["repo map"]);
  });
});
