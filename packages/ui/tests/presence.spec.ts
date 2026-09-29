import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESENCE_COPY, draggedBy, presenceFrameOf, viewersStrip } from "../src/live.js";

/**
 * B4.11, teams item 26 (TEAM-26) and dashboard DB-N9-20: the avatars of
 * the other people viewing an issue in its header, and a card someone is
 * dragging marked with their avatar on the board — what the `presence`
 * frame carries, as the page shows it. The reader is never shown to
 * themselves; words exact.
 */

const web = (name: string) => readFileSync(join(import.meta.dirname, "..", "web", name), "utf8");

const lee = { principal: "p_lee", name: "Lee Lead", initials: "LL" };
const mo = { principal: "p_mo", name: "Mo Member", initials: "MM" };
const vic = { principal: "p_vic", name: "Vic Viewer", initials: "VV" };
const ada = { principal: "p_ada", name: "Ada Admin", initials: "AA" };
const sam = { principal: "p_sam", name: "Sam Stakeholder", initials: "SS" };
const kim = { principal: "p_kim", name: "Kim Kay", initials: "KK" };

describe("the frame", () => {
  it("reads a presence frame, dropping what is not one", () => {
    expect(presenceFrameOf({ issues: { c1: [lee] }, dragging: {} })).toEqual({
      issues: { c1: [lee] },
      dragging: {},
    });
    expect(presenceFrameOf({ issues: { c1: [{ name: "x" }] }, dragging: 3 })).toEqual({
      issues: { c1: [] },
      dragging: {},
    });
    expect(presenceFrameOf(null)).toEqual({ issues: {}, dragging: {} });
  });
});

describe("DB-N9-20: the issue header's avatars", () => {
  it("shows the others viewing it, never the reader, at most four and a count", () => {
    const frame = { issues: { c1: [lee, mo, vic] }, dragging: {} };
    const strip = viewersStrip(frame, "c1", "p_mo");
    expect(strip.shown).toEqual([lee, vic]);
    expect(strip.more).toBe(0);
    expect(strip.label).toBe("Also viewing: Lee Lead and Vic Viewer");
    expect(strip.shown.map((f) => PRESENCE_COPY.viewer(f.name))).toEqual([
      "Lee Lead is viewing this issue",
      "Vic Viewer is viewing this issue",
    ]);
    const many = viewersStrip(
      { issues: { c1: [lee, mo, vic, ada, sam, kim] }, dragging: {} },
      "c1",
      "p_zed",
      4,
    );
    expect(many.shown).toHaveLength(4);
    expect(many.more).toBe(2);
    expect(many.label).toBe("Also viewing: Lee Lead, Mo Member, Vic Viewer, Ada Admin and 2 more");
    expect(viewersStrip(frame, "c2", "p_mo")).toEqual({ shown: [], more: 0, label: "" });
    expect(viewersStrip({ issues: { c1: [mo] }, dragging: {} }, "c1", "p_mo").label).toBe("");
  });

  it("the issue page announces what it shows and draws the strip from the store", () => {
    const card = web("card.js");
    expect(card).toContain("announceIssue(");
    expect(card).toContain("viewersStrip(");
    const presence = web("presence.js");
    expect(presence).toContain('postJSON("/api/presence"');
    expect(presence).toMatch(/HEARTBEAT_MS = 20_000/);
    expect(web("app.js")).toContain('addEventListener("presence"');
  });
});

describe("DB-N9-20: a card someone is dragging shows their avatar", () => {
  it("names the others dragging it, never the reader", () => {
    const frame = { issues: {}, dragging: { c1: [mo], c2: [lee] } };
    expect(draggedBy(frame, "c1", "p_lee")).toEqual([mo]);
    expect(draggedBy(frame, "c2", "p_lee")).toEqual([]);
    expect(PRESENCE_COPY.dragging("Mo Member")).toBe("Mo Member is moving this issue");
  });

  it("the board announces a drag and the tile draws the avatar", () => {
    expect(web("board.js")).toContain("announceDrag(");
    expect(web("tile.js")).toContain("PRESENCE_COPY.dragging(");
  });
});
