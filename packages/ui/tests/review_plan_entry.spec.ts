import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The browser module as-is: the same code the page runs.
import { hasReviewPlan, reviewPlanButtonHtml } from "../web/review_plan_view.js";

/**
 * design-stage DS-P2-6 on the dashboard: a `start_project` proposal carrying
 * its group opens Review plan instead of applying at once, since applying is
 * where the person's choices go (PM_CONTRACT §3). Every other proposal keeps
 * its plain Apply.
 */

const WEB = join(import.meta.dirname, "..", "web");
const startProject = {
  id: "prop_1",
  kind: "start_project",
  state: "open",
  patch: { group: { version: 1 } },
};

describe("a project proposal opens Review plan", () => {
  it("only a start_project carrying a version-1 group has a Review plan", () => {
    expect(hasReviewPlan(startProject)).toBe(true);
    expect(hasReviewPlan({ ...startProject, patch: {} })).toBe(false);
    expect(hasReviewPlan({ ...startProject, kind: "update_card" })).toBe(false);
    expect(hasReviewPlan(undefined)).toBe(false);
  });

  it("its button says Review plan and is not the plain Apply", () => {
    const html = reviewPlanButtonHtml(false);
    expect(html).toContain("data-review-plan");
    expect(html).toContain("Review plan");
    expect(html).not.toContain("data-apply");
    expect(reviewPlanButtonHtml(true)).toContain("disabled");
  });

  it("the proposal list renders it and opens Review plan on click and on y, never applying", () => {
    const src = readFileSync(join(WEB, "proposals.js"), "utf8");
    expect(src).toMatch(
      /import \{[^}]*\bhasReviewPlan\b[^}]*\bopenReviewPlan\b[^}]*\} from "\.\/review_plan\.js"/,
    );
    expect(src).toContain("reviewPlanButtonHtml(");
    // Click and the `y` key each open it with the page's setup.
    expect(src.match(/openReviewPlan\(/g)?.length).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/\[data-review-plan\]/);
    expect(src).toMatch(/setup: getSession\(\)\.mode/);
    // Apply all never creates a project unreviewed.
    expect(src).toContain("applyAll(withoutReviewPlan(list))");
  });
});

describe("Review plan is styled (pm.css)", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "web", "pm.css"), "utf8");
  it("styles the dialog and every .rp-* class the view writes", () => {
    const view = readFileSync(
      join(import.meta.dirname, "..", "web", "review_plan_view.js"),
      "utf8",
    );
    const used = new Set(
      [...view.matchAll(/class="([^"]+)"/g)].flatMap(
        (m) => (m[1] ?? "").match(/\brp(?:-[a-z0-9]+)*/g) ?? [],
      ),
    );
    used.add("rp-dialog");
    expect(used.size).toBeGreaterThan(10);
    for (const c of used) expect(css, c).toMatch(new RegExp(`\\.${c}\\b`));
  });

  it("the dialog is fixed above the page and scrolls inside rather than clipping", () => {
    const rule = /\.rp-dialog\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*fixed/);
    const inner = /\.rp\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(inner).toMatch(/overflow(-y)?:\s*auto/);
    expect(inner).toMatch(/max-height/);
  });
});
