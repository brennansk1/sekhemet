import { describe, expect, it } from "vitest";
import { budgetPercent, escapeHtml, renderCardTile, renderGateStrip } from "../src/card_tile.js";
import type { CanvasCard } from "../src/tokens.js";

function card(overrides: Partial<CanvasCard> = {}): CanvasCard {
  return {
    id: "card_1",
    title: "Parse gate output",
    status: "doing",
    cardClass: "feature",
    difficulty: 3,
    stepsUsed: 8,
    stepBudget: 32,
    gates: { typecheck: "pass", lint: "pass", test: "fail", bounds: "pending", visual: "skipped" },
    dependsOn: [],
    ...overrides,
  };
}

const STRIP =
  '<div class="gate-strip">' +
  '<span class="gate gate-pass" data-gate="typecheck" title="typecheck: pass"></span>' +
  '<span class="gate gate-pass" data-gate="lint" title="lint: pass"></span>' +
  '<span class="gate gate-fail" data-gate="test" title="test: fail"></span>' +
  '<span class="gate gate-pending" data-gate="bounds" title="bounds: pending"></span>' +
  '<span class="gate gate-skipped" data-gate="visual" title="visual: skipped"></span>' +
  "</div>";

describe("basalt card tile: helpers", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("leaves plain text unchanged and escapes & only once", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("computes a rounded budget percentage", () => {
    expect(budgetPercent(8, 32)).toBe(25);
    expect(budgetPercent(1, 3)).toBe(33);
    expect(budgetPercent(2, 3)).toBe(67);
  });

  it("clamps the budget percentage to 0..100 and treats a zero budget as full", () => {
    expect(budgetPercent(50, 32)).toBe(100);
    expect(budgetPercent(-4, 32)).toBe(0);
    expect(budgetPercent(0, 0)).toBe(100);
  });
});

describe("basalt card tile: gate strip", () => {
  it("renders five boxes in gate order with state classes", () => {
    expect(
      renderGateStrip({
        visual: "skipped",
        bounds: "pending",
        test: "fail",
        lint: "pass",
        typecheck: "pass",
      }),
    ).toBe(STRIP);
  });

  it("always renders exactly five boxes", () => {
    const html = renderGateStrip({
      typecheck: "pending",
      lint: "pending",
      test: "pending",
      bounds: "pending",
      visual: "pending",
    });
    expect(html.match(/class="gate /g)?.length).toBe(5);
    expect(html.includes("gate-pass")).toBe(false);
  });
});

describe("basalt card tile: tile", () => {
  it("renders the complete tile markup", () => {
    const head =
      '<article class="card-tile" data-id="card_1" data-status="doing">' +
      '<span class="chip chip-feature">feature</span>' +
      '<span class="difficulty">D3</span>' +
      '<h3 class="title">Parse gate output</h3>' +
      '<div class="budget"><div class="budget-bar" style="width: 25%"></div>' +
      '<span class="budget-label">8/32</span></div>';
    expect(renderCardTile(card())).toBe(`${head}${STRIP}</article>`);
  });

  it("marks a selected tile", () => {
    const html = renderCardTile(card(), { selected: true });
    expect(html.startsWith('<article class="card-tile is-selected" data-id="card_1"')).toBe(true);
    expect(
      renderCardTile(card(), { selected: false }).startsWith('<article class="card-tile" '),
    ).toBe(true);
  });

  it("marks an over-budget bar but shows the real step counts", () => {
    const html = renderCardTile(card({ stepsUsed: 40, stepBudget: 32 }));
    expect(html.includes('<div class="budget-bar is-over" style="width: 100%"></div>')).toBe(true);
    expect(html.includes('<span class="budget-label">40/32</span>')).toBe(true);
  });

  it("does not mark a bar that is exactly at budget", () => {
    const html = renderCardTile(card({ stepsUsed: 32, stepBudget: 32 }));
    expect(html.includes('<div class="budget-bar" style="width: 100%"></div>')).toBe(true);
  });

  it("escapes a hostile title and id so no markup is injected", () => {
    const html = renderCardTile(card({ id: 'x"><b', title: '<script>alert("x")</script>' }));
    expect(html.includes("<script>")).toBe(false);
    expect(html.includes('data-id="x&quot;&gt;&lt;b"')).toBe(true);
    expect(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")).toBe(true);
  });

  it("renders the class chip for each card class", () => {
    expect(
      renderCardTile(card({ cardClass: "bug" })).includes('<span class="chip chip-bug">bug</span>'),
    ).toBe(true);
    expect(
      renderCardTile(card({ cardClass: "spike", difficulty: 5 })).includes(
        '<span class="difficulty">D5</span>',
      ),
    ).toBe(true);
  });
});
