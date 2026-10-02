import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_BAR,
  KEY_GROUPS,
  NAV_ITEMS,
  type NavContext,
  agentQueueLine,
  bottomBar,
  cheatSheet,
  chordTarget,
  navNameOf,
  paletteGoTo,
  visibleNav,
} from "../src/nav.js";

// Every view the page mounts today (app.js VIEWS, with the P11 route names).
const BUILT = new Set([
  "review",
  "board",
  "pm",
  "insights",
  "runs",
  "ledger",
  "machine",
  "playbook",
  "integrations",
  "inbox",
  "graph",
  "projects",
  "configuration",
]);

const EMPTY: NavContext = {
  views: BUILT,
  team: false,
  completedRuns: 0,
  dependencyEdges: 0,
  playbookEntries: 0,
};

const names = (ctx: NavContext) => visibleNav(ctx).map((i) => i.name);

describe("the navigation model (dashboard P11)", () => {
  it("DB-P11-1: no runs, no dependency edges, one project: no Runs or Dependencies; Projects, Inbox and Configuration shown", () => {
    const shown = names(EMPTY);
    expect(shown).not.toContain("runs");
    expect(shown).not.toContain("graph");
    for (const n of ["projects", "inbox", "configuration"]) expect(shown).toContain(n);
  });

  it("groups top to bottom as §2.2.1 orders them", () => {
    const ctx = { ...EMPTY, completedRuns: 1, dependencyEdges: 1, playbookEntries: 1 };
    const order = visibleNav(ctx).map((i) => `${i.group}:${i.name}`);
    expect(order).toEqual([
      "workspace:projects",
      "workspace:inbox",
      "project:board",
      "project:review",
      "project:pm",
      "project:insights",
      "more:runs",
      "more:graph",
      "more:playbook",
      "more:integrations",
      "more:machine",
      "more:ledger",
      "bottom:configuration",
    ]);
    // The project manager reads as the role, with Seshat as secondary text.
    const pm = NAV_ITEMS.find((i) => i.name === "pm");
    expect(pm?.label).toBe("Project manager");
    expect(pm?.sub).toBe("Seshat");
  });

  it("shows a view only once it has something in it, and never a view the page does not have", () => {
    expect(names({ ...EMPTY, completedRuns: 1 })).toContain("runs");
    expect(names({ ...EMPTY, dependencyEdges: 2 })).toContain("graph");
    expect(names(EMPTY)).not.toContain("playbook");
    expect(names({ ...EMPTY, playbookEntries: 1 })).toContain("playbook");
    // Status and My issues are specified but not mounted yet: no dead link.
    expect(names(EMPTY)).not.toContain("status");
    expect(names({ ...EMPTY, team: true })).not.toContain("my-issues");
    const withStatus = { ...EMPTY, views: new Set([...BUILT, "status", "my-issues"]) };
    expect(names(withStatus)).toContain("status");
    // My issues is Team only.
    expect(names(withStatus)).not.toContain("my-issues");
    expect(names({ ...withStatus, team: true })).toContain("my-issues");
  });

  it("DB-P11-3: the phone bar is Status · Review · Board · Seshat, of the views that exist", () => {
    expect(BOTTOM_BAR).toEqual(["status", "review", "board", "pm"]);
    const withStatus = { ...EMPTY, views: new Set([...BUILT, "status"]) };
    expect(bottomBar(visibleNav(withStatus)).map((i) => i.short)).toEqual([
      "Status",
      "Review",
      "Board",
      "Seshat",
    ]);
    expect(bottomBar(visibleNav(EMPTY)).map((i) => i.name)).toEqual(["review", "board", "pm"]);
    for (const i of bottomBar(visibleNav(withStatus))) expect(i.route).toMatch(/^#\/[a-z-]+$/);
  });

  it("DB-P11-4: every visible view has exactly one chord, no two share one, and each chord goes there", () => {
    const all = { ...EMPTY, completedRuns: 1, dependencyEdges: 1, playbookEntries: 1, team: true };
    const everything = { ...all, views: new Set([...BUILT, "status", "my-issues"]) };
    for (const ctx of [EMPTY, all, everything]) {
      const shown = visibleNav(ctx);
      const chords = shown.map((i) => i.chord);
      expect(new Set(chords).size, chords.join(" ")).toBe(chords.length);
      for (const i of shown) {
        expect(i.chord, i.name).toMatch(/^[a-z]$/);
        expect(chordTarget(i.chord, shown)?.name, i.chord).toBe(i.name);
      }
    }
    // A chord for a hidden view does nothing.
    expect(chordTarget("u", visibleNav(EMPTY))).toBeUndefined();
    expect(chordTarget("s", visibleNav(EMPTY))).toBeUndefined();
    // The chords the design assigns (§2.2.1).
    const byName = Object.fromEntries(NAV_ITEMS.map((i) => [i.name, i.chord]));
    expect(byName).toEqual({
      projects: "w",
      inbox: "x",
      "my-issues": "y",
      status: "s",
      board: "b",
      review: "r",
      pm: "p",
      insights: "i",
      runs: "u",
      graph: "d",
      playbook: "k",
      integrations: "n",
      machine: "m",
      ledger: "l",
      configuration: "c",
    });
  });

  it("DB-P11-4: `t` is bound to nothing, alone or anywhere in the keymap", () => {
    for (const g of KEY_GROUPS)
      for (const row of g.rows) expect(row.keys, `${g.name}: ${row.label}`).not.toEqual(["t"]);
    expect(chordTarget("t", visibleNav(EMPTY))).toBeUndefined();
  });

  it("keeps the previous chords working silently for one release", () => {
    const shown = visibleNav({ ...EMPTY, completedRuns: 1 });
    expect(chordTarget("a", shown)?.name).toBe("pm");
    expect(chordTarget("f", shown)?.name).toBe("insights");
    expect(chordTarget("q", shown)?.name).toBe("runs");
    expect(chordTarget("e", shown)?.name).toBe("configuration");
    // Silent: no legacy chord is listed in the cheat sheet or the palette.
    const listed = cheatSheet(shown)
      .flatMap((g) => g.rows)
      .map((r) => r.keys.join(" "));
    for (const k of ["g a", "g f", "g q", "g e"]) expect(listed).not.toContain(k);
  });

  it("DB-P11-5: Playbook, Runs and Integrations are reached by g k, g u, g n and from the palette", () => {
    const shown = visibleNav({ ...EMPTY, completedRuns: 1, playbookEntries: 1 });
    const palette = paletteGoTo(shown);
    for (const [name, chord] of [
      ["playbook", "k"],
      ["runs", "u"],
      ["integrations", "n"],
    ] as const) {
      expect(chordTarget(chord, shown)?.name).toBe(name);
      const entry = palette.find((p) => p.name === name);
      expect(entry?.keys, name).toEqual(["g", chord]);
      expect(entry?.route).toBe(`#/${name}`);
    }
  });

  it("DB-P11-6: the cheat sheet and the palette come from one keymap", () => {
    const shown = visibleNav({
      ...EMPTY,
      completedRuns: 1,
      dependencyEdges: 1,
      playbookEntries: 1,
    });
    const sheet = cheatSheet(shown);
    const navigate = sheet.find((g) => g.name === "Navigate");
    const palette = paletteGoTo(shown);
    // Every view in the palette's Go to group is a Navigate row, with the same keys.
    expect(navigate?.rows.map((r) => [r.label, r.keys.join(" ")])).toEqual(
      palette.map((p) => [p.label, p.keys.join(" ")]),
    );
    // The static groups are the keymap's own, not a second copy.
    for (const g of KEY_GROUPS) expect(sheet.map((s) => s.name)).toContain(g.name);
    expect(sheet.map((s) => s.name).slice(0, 2)).toEqual(["Global", "Navigate"]);
  });

  it("announces g s as Status only once Status is shown, and says where it goes until then", () => {
    const note = (views: Set<string>) =>
      cheatSheet(visibleNav({ ...EMPTY, views })).find((g) => g.name === "Navigate")?.note ?? "";
    // Today Status is not built: g s (Integrations before P11) opens nothing.
    const today = note(BUILT);
    expect(today).not.toMatch(/g s is Status/);
    expect(today).toMatch(/g s opens nothing until Status is built/);
    expect(chordTarget("s", visibleNav(EMPTY))).toBeUndefined();
    expect(today).toMatch(/Integrations is g n/);
    // Once Status is mounted, the note names it.
    expect(note(new Set([...BUILT, "status"]))).toMatch(/g s is Status/);
  });

  it("maps the old route names onto the nav item that replaced them", () => {
    expect(navNameOf("workspace")).toBe("projects");
    expect(navNameOf("registry")).toBe("configuration");
    expect(navNameOf("board")).toBe("board");
    expect(navNameOf("card")).toBe("");
  });

  it("gives every nav item its own glyph", () => {
    const icons = NAV_ITEMS.map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("the board's keys (dashboard P3)", () => {
  it("DB-P3-3: lists Shift+V for pipeline stages among the Board keys", () => {
    const cards = KEY_GROUPS.find((g) => g.name === "Board");
    expect(cards?.rows.find((r) => r.label === "Pipeline stages")?.keys).toEqual(["⇧", "V"]);
  });
});

describe("teams item 31, dashboard §2.2.3: the Agent status line shows where you stand", () => {
  const key = (id: string) => (id === "card_mo" ? "CHR-14" : id);
  it("says your issue's place and estimate in the Team queue", () => {
    expect(
      agentQueueLine(
        { cardId: "card_mo", place: 2, message: "2nd in queue, about 6 minutes" },
        key,
      ),
    ).toBe("CHR-14 · 2nd in queue, about 6 minutes");
  });

  it("says yours starts next while another person's issue runs", () => {
    expect(
      agentQueueLine(
        {
          cardId: "card_mo",
          place: 1,
          message: "Next in queue, about 6 minutes",
          runningFor: "Priya",
        },
        key,
      ),
    ).toBe("Priya's issue is running; yours starts next");
  });

  it("says nothing when none of yours waits", () => {
    expect(agentQueueLine(null, key)).toBeUndefined();
    expect(agentQueueLine(undefined, key)).toBeUndefined();
  });
});

describe("the Agent status line is wired to the page's queue (shell.js, app.js)", () => {
  const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "web", f), "utf8");
  it("renders the queue line under the Agent's, and fetches it as the ledger moves", () => {
    expect(web("shell.js")).toContain("agentQueueLine(");
    expect(web("app.js")).toContain("/api/agent/states");
    expect(web("tile.js")).toContain("opts.ai");
    expect(web("board.js")).toContain("agentStates");
  });
});
