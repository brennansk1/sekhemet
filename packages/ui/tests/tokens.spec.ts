import { describe, expect, it } from "vitest";
import {
  DERIVED,
  THEMES,
  contrastRatio,
  generateTokenCss,
  generateTokenJson,
} from "../src/tokens.js";

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
    expect(css).toContain("--rail-w: 52px;");
    expect(css).toContain("--topbar-h: 44px;");
    expect(css).toContain("--scrim: rgb(8 7 6 / 0.6);");
    expect(JSON.parse(generateTokenJson()).derived.sand.onAccent).toBe("#FFFFFF");
  });
});
