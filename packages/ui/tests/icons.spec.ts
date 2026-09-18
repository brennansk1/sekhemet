import { describe, expect, it } from "vitest";
import { ICONS, type IconName, icon } from "../src/icons.js";

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
  "glyph",
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
