import { describe, expect, it } from "vitest";
import { type CanvasCard, GATE_ORDER, THEME, cssVarName, tokensToCss } from "../src/tokens.js";

describe("basalt tokens: theme values", () => {
  it("defines the Basalt surface ladder exactly", () => {
    expect(THEME.bgBase).toBe("#14120F");
    expect(THEME.bgSurface).toBe("#1C1A16");
    expect(THEME.bgRaised).toBe("#24211C");
    expect(THEME.bgOverlay).toBe("#2C2822");
    expect(THEME.borderSubtle).toBe("#2E2A24");
  });

  it("defines the text colors and the four semantic accents exactly", () => {
    expect(THEME.textPrimary).toBe("#EDE6DA");
    expect(THEME.textMuted).toBe("#A39A8C");
    expect(THEME.gold).toBe("#C8952A");
    expect(THEME.nile).toBe("#4FA36B");
    expect(THEME.ochre).toBe("#C9503F");
    expect(THEME.lapis).toBe("#4C8ED9");
  });

  it("has exactly eleven tokens in ladder order, all 7-character hex colors", () => {
    expect(Object.keys(THEME)).toEqual([
      "bgBase",
      "bgSurface",
      "bgRaised",
      "bgOverlay",
      "borderSubtle",
      "textPrimary",
      "textMuted",
      "gold",
      "nile",
      "ochre",
      "lapis",
    ]);
    const invalid = Object.values(THEME).filter((v) => !/^#[0-9A-F]{6}$/.test(v));
    expect(invalid).toEqual([]);
  });

  it("orders the five gates for the gate strip", () => {
    expect(GATE_ORDER).toEqual(["typecheck", "lint", "test", "bounds", "visual"]);
  });
});

describe("basalt tokens: CSS output", () => {
  it("converts camelCase token names to CSS custom property names", () => {
    expect(cssVarName("bgBase")).toBe("--bg-base");
    expect(cssVarName("borderSubtle")).toBe("--border-subtle");
    expect(cssVarName("gold")).toBe("--gold");
  });

  it("renders every token as a custom property inside :root", () => {
    const css = tokensToCss(THEME);
    const lines = css.split("\n");
    expect(lines[0]).toBe(":root {");
    expect(lines[1]).toBe("  --bg-base: #14120F;");
    expect(lines[5]).toBe("  --border-subtle: #2E2A24;");
    expect(lines[11]).toBe("  --lapis: #4C8ED9;");
    expect(lines[12]).toBe("}");
    expect(lines[13]).toBe("");
    expect(lines.length).toBe(14);
  });

  it("uses the values of the theme it is given, not the default theme", () => {
    const css = tokensToCss({ ...THEME, bgBase: "#000000", lapis: "#FFFFFF" });
    expect(css.includes("  --bg-base: #000000;\n")).toBe(true);
    expect(css.includes("#14120F")).toBe(false);
    expect(css.endsWith("  --lapis: #FFFFFF;\n}\n")).toBe(true);
  });

  it("types a CanvasCard with a full gate record", () => {
    const card: CanvasCard = {
      id: "c1",
      title: "T",
      status: "ready",
      cardClass: "bug",
      difficulty: 3,
      stepsUsed: 0,
      stepBudget: 32,
      gates: { typecheck: "pass", lint: "pass", test: "fail", bounds: "pending", visual: "skipped" },
      dependsOn: [],
    };
    expect(Object.keys(card.gates)).toEqual(GATE_ORDER);
  });
});
