import { describe, expect, it } from "vitest";
import {
  AI_BADGE,
  APP_ICON,
  BRAND_LOCKUP_MIN_PX,
  BRAND_MARK_MIN_PX,
  ICONS,
  type IconName,
  aiBadge,
  appIconSvg,
  brandLockup,
  brandMark,
  icon,
  teammateName,
} from "../src/icons.js";

// §3.4: single weight, 1.5px stroke, 24 viewBox, currentColor, no fills but `dot`.
const REQUIRED: IconName[] = [
  "review",
  "board",
  "runs",
  "inbox",
  "ledger",
  "playbook",
  "machine",
  "settings",
  "search",
  "check",
  "x",
  "minus",
  "ring",
  "dot",
  "pause",
  "link",
  "lock",
  "alert",
  "merge",
  "send-back",
  "park",
  "clock",
  "file",
  "file-diff",
  "copy",
  "chevron-right",
  "chevron-down",
  "sun",
  "moon",
  "keyboard",
  "memory",
  "pencil",
  "undo",
  "external",
  // The topbar's Tips toggle: a book icon and the word (dashboard §2.9.1).
  "book",
];

describe("icon set", () => {
  it("contains every icon the design names", () => {
    for (const name of REQUIRED) expect(ICONS[name], name).toBeTruthy();
  });

  it("draws every icon at 24 viewBox, 1.5px stroke, currentColor", () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const svg = icon(name);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke-width="1.5"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('fill="none"');
      expect(svg).toContain('aria-hidden="true"');
    }
  });

  it("has no filled shapes except the dot, and no hard-coded colours", () => {
    for (const [name, body] of Object.entries(ICONS)) {
      if (name === "dot") {
        expect(body).toContain('fill="currentColor"');
        continue;
      }
      expect(body, name).not.toMatch(/fill=/);
      expect(body, name).not.toMatch(/#[0-9a-f]{3,6}\b/i);
      expect(body, name).not.toMatch(/stroke-width/);
    }
  });

  it("sizes by argument", () => {
    expect(icon("check", 12)).toContain('width="12" height="12"');
  });
});

/**
 * dashboard DB-N9-19 (§2.13.6): the brand mark is a temple gateway, two
 * tapered pylons in the theme's ink with a sun disc in the theme's gold. It
 * replaces the 1.5 px line glyph drawn in accent, so it is not a line icon.
 */
describe("the brand mark (DB-N9-19)", () => {
  it("draws the pylons in the theme's ink and the disc in the theme's gold, filled, never in accent line", () => {
    expect("glyph" in ICONS).toBe(false);
    const svg = brandMark(18);
    expect(svg).toContain('class="brand-mark"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('width="18" height="18"');
    // Colour comes from the theme's tokens only: ink and gold, nothing else.
    expect(svg).toContain('style="fill:var(--text-primary)"');
    expect(svg).toContain('style="fill:var(--accent)"');
    expect(svg).not.toMatch(/currentColor|stroke=|#[0-9a-f]{3,6}\b/i);
    // Two pylons and one disc.
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg.match(/<circle /g)).toHaveLength(1);
    expect(svg).toContain('aria-hidden="true"');
  });

  it("is never drawn below 16 px, and the lockup never below 80 px", () => {
    expect(BRAND_MARK_MIN_PX).toBe(16);
    expect(BRAND_LOCKUP_MIN_PX).toBe(80);
    expect(brandMark(12)).toContain('width="16" height="16"');
    const lockup = brandLockup(18);
    expect(lockup).toContain('class="lockup"');
    expect(lockup).toContain("min-width:80px");
    expect(lockup).toContain('width="18" height="18"');
    expect(lockup).toContain("<b");
    expect(lockup).toContain(">Sekhemet</b>");
  });

  it("the app icon and favicon: an ink tile, cream pylons and a gold disc", () => {
    expect(APP_ICON).toEqual({ tile: "#1D1B17", pylons: "#F3EEE3", disc: "#D9B45A" });
    const svg = appIconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('<rect width="32" height="32" rx="6" fill="#1D1B17"/>');
    expect(svg.match(/fill="#F3EEE3"/g)).toHaveLength(2);
    expect(svg.match(/fill="#D9B45A"/g)).toHaveLength(1);
    // Never on gold: the tile is ink.
    expect(svg).not.toContain('<rect width="32" height="32" rx="6" fill="#D9B45A"');
  });
});

/**
 * dashboard DB-N9-18 (§2.13.8): Seshat and the Agent carry the *AI* badge
 * beside their names; a person never does, and the Agent has no avatar.
 */
describe("the AI badge (DB-N9-18)", () => {
  it("is the letters AI with a spoken label, never a shape alone", () => {
    expect(AI_BADGE).toEqual({ text: "AI", label: "AI teammate" });
    expect(aiBadge()).toBe(
      '<span class="ai-badge"><span aria-hidden="true">AI</span><span class="sr-only">AI teammate</span></span>',
    );
  });

  it("sits after Seshat's and the Agent's names, and never beside a person", () => {
    expect(teammateName("Seshat", "seshat")).toBe(`<b class="tm-name">Seshat</b>${aiBadge()}`);
    expect(teammateName("Agent", "agent")).toBe(`<b class="tm-name">Agent</b>${aiBadge()}`);
    expect(teammateName("Priya", "person")).toBe('<b class="tm-name">Priya</b>');
    // A person who calls themselves Agent is still a person.
    expect(teammateName("Agent", "person")).toBe('<b class="tm-name">Agent</b>');
    expect(teammateName("<Sam>", "person")).toBe('<b class="tm-name">&lt;Sam&gt;</b>');
  });
});
