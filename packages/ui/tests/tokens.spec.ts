import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "../src/icons.js";
import {
  DERIVED,
  THEMES,
  contrastRatio,
  generateTokenCss,
  generateTokenJson,
  relativeLuminance,
} from "../src/tokens.js";
import { STATE_GLYPHS } from "../src/vocabulary.js";

// The §3.9 contrast rules, asserted on the shipped values rather than claimed.
describe("token contrast (FRONTEND_DESIGN §3.9)", () => {
  const surfaces = ["bgBase", "bgSurface", "bgRaised", "bgOverlay"] as const;
  // Blocked never colours text (§3.5: its words use secondary), so it is held
  // only to the 3:1 non-text bar below.
  const textStates = ["statePass", "stateFail", "stateRunning", "stateParked"] as const;
  const states = [...textStates, "stateBlocked"] as const;

  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: secondary text is readable on every surface`, () => {
      for (const s of surfaces) {
        const r = contrastRatio(t.textSecondary, t[s]);
        expect(r, `${name} textSecondary on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: state text only on base and surface; state marks on raised`, () => {
      for (const st of states) {
        for (const s of textStates.includes(st as (typeof textStates)[number])
          ? (["bgBase", "bgSurface"] as const)
          : []) {
          const r = contrastRatio(t[st], t[s]);
          expect(r, `${name} ${st} on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
        const raised = contrastRatio(t[st], t.bgRaised);
        expect(raised, `${name} ${st} on raised = ${raised.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${name}: the accent works as a focus ring everywhere and carries its label`, () => {
      for (const s of surfaces) {
        const r = contrastRatio(t.accent, t[s]);
        expect(r, `${name} accent on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
      const d = DERIVED[name as keyof typeof DERIVED];
      expect(contrastRatio(d.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("emits the derived roles and layout constants in both themes", () => {
    const css = generateTokenCss();
    for (const v of [
      "--on-accent",
      "--on-state",
      "--scrim",
      "--tint-pass",
      "--tint-fail",
      "--tint-running",
      "--tint-parked",
    ]) {
      expect(css.split(`${v}:`).length - 1, v).toBe(2);
    }
    expect(css).toContain("--sidebar-w: 216px;");
    // The icon-only rail is retired: 1024–1279 px keeps its labels (§2.2.2, P11).
    expect(css).not.toContain("--rail-w");
    expect(css).toContain("--sidebar-w-narrow: 176px;");
    expect(css.split("--border-control:").length - 1).toBe(2);
    expect(css).toContain("--topbar-h: 44px;");
    expect(css).toContain("--scrim: rgb(8 7 6 / 0.6);");
    expect(JSON.parse(generateTokenJson()).derived.sand.onAccent).toBe("#FFFFFF");
  });
});

// Dashboard P12 (§2.13.2, §2.14.1): the roles as used, measured in both themes.
describe("colour roles and contrast as used (dashboard P12)", () => {
  const surfaces = ["bgBase", "bgSurface", "bgRaised", "bgOverlay"] as const;

  /** HSL hue in degrees, 0–360. */
  function hue(hex: string): number {
    const v = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  for (const [name, t] of Object.entries(THEMES)) {
    it(`DB-P12-1 ${name}: body text is at least 7:1 on base and surface`, () => {
      for (const s of ["bgBase", "bgSurface"] as const) {
        const r = contrastRatio(t.textPrimary, t[s]);
        expect(r, `${name} textPrimary on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(7);
      }
      for (const s of surfaces) {
        const r = contrastRatio(t.textPrimary, t[s]);
        expect(r, `${name} textPrimary on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`DB-P12-1 ${name}: every control edge is at least 3:1 on every surface`, () => {
      for (const s of surfaces) {
        const r = contrastRatio(t.borderControl, t[s]);
        expect(r, `${name} borderControl on ${s} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`DB-P12-1 ${name}: glyphs on a state fill are at least 3:1, text on the accent at least 4.5:1`, () => {
      const d = DERIVED[name as keyof typeof DERIVED];
      for (const st of ["statePass", "stateFail", "stateRunning"] as const) {
        const r = contrastRatio(d.onState, t[st]);
        // Gate pips carry a glyph, not words: the non-text bar applies.
        expect(r, `${name} onState on ${st} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(d.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
    });

    it(`DB-P12-2 ${name}: the parked/warning hue is at least 20 degrees from the accent`, () => {
      const a = hue(t.accent);
      const p = hue(t.stateParked);
      const apart = Math.min(Math.abs(a - p), 360 - Math.abs(a - p));
      expect(
        apart,
        `${name} accent ${a.toFixed(1)} vs parked ${p.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(20);
    });

    // DEC-42: the copper "needs you" keeps its hue, 7–10° from the red ochre of
    // a failure, so hue never tells them apart alone: the glyph differs, and
    // parked sits at least 10 L* further from the ground than fail.
    it(`DEC-42 ${name}: parked and fail differ by glyph and by at least ${MIN_PARKED_FAIL_LSTAR} L*`, () => {
      expect(STATE_GLYPHS.parked).not.toBe(STATE_GLYPHS.fail);
      expect(ICONS[STATE_GLYPHS.parked]).not.toBe(ICONS[STATE_GLYPHS.fail]);
      const p = lstar(t.stateParked);
      const f = lstar(t.stateFail);
      expect(
        Math.abs(p - f),
        `${name} parked L* ${p.toFixed(1)} vs fail L* ${f.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(MIN_PARKED_FAIL_LSTAR);
      // Further from the ground: lighter on Basalt, darker on Sand.
      const ground = lstar(t.bgBase);
      expect(Math.abs(p - ground)).toBeGreaterThan(Math.abs(f - ground));
    });
  }

  it("DEC-42: the page's state marks take their glyphs from STATE_GLYPHS", () => {
    const marks = readFileSync(new URL("../web/marks.js", import.meta.url), "utf8");
    expect(marks).toMatch(/import \{[^}]*STATE_GLYPHS[^}]*\} from "\.\/lib\/vocabulary\.js"/);
    expect(marks).not.toMatch(/icon\("(pause|x)", 12, "ic s12 i-(park|fail)"\)/);
  });
});

/** The stated minimum lightness gap between parked and fail (DEC-42, dashboard §2.13.2). */
const MIN_PARKED_FAIL_LSTAR = 10;

/** CIE L* (0–100) from the WCAG relative luminance. */
function lstar(hex: string): number {
  const y = relativeLuminance(hex);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
}
