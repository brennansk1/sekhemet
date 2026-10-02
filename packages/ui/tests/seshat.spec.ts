import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NAV_ITEMS,
  SESHAT_COPY,
  START_PROJECT_OPENING,
  STATUS_COPY,
  UI_LIB_MODULES,
  composerCostLine,
  composerHint,
  composerStarters,
  nonDeveloperWalk,
  paletteSeshat,
  seshatHeader,
  seshatOpensIn,
  visibleNav,
} from "../src/index.js";
import { reviewPlanButtonHtml } from "../web/review_plan_view.js";

/**
 * dashboard P5 (DB-P5-3..7): the path a non-developer takes to Seshat — the
 * panel header and its presence line, the composer's cost line and starters,
 * the palette's *Start a new project* and *Ask Seshat: <query>*, and the walk
 * at 400 px from Status to a started project and back, with no terminal.
 */

/** Words that would name a model, an id or an API path on screen. */
const OPERATOR = /\/api\/|\bGET\b|\bPOST\b|dirk|qwen|llama|gemma|gguf|cyber-tiel|\d+b\b|:latest/i;

describe("DB-P5-6: the panel header names Seshat and the role, never a model", () => {
  it("reads Seshat · Project manager with the presence line when idle", () => {
    expect(seshatHeader({ available: true, phase: "idle" })).toEqual({
      title: "Seshat · Project manager",
      line: "Replies in about a minute",
      busy: false,
    });
  });

  it("shows the current phase while Seshat works, and the server gap in words", () => {
    expect(seshatHeader({ available: true, phase: "thinking", current: "Thinking" })).toEqual({
      title: "Seshat · Project manager",
      line: "Thinking",
      busy: true,
    });
    expect(seshatHeader({ available: true, phase: "loading_pm" })).toEqual({
      title: "Seshat · Project manager",
      line: "Working",
      busy: true,
    });
    expect(seshatHeader({ available: false, phase: "idle" })).toEqual({
      title: "Seshat · Project manager",
      line: "Not on this server yet",
      busy: false,
    });
  });
});

describe("DB-P5-5: the cost line says what sending does, with no API path or model", () => {
  it("idle, with the Agent working, read-only, offline and unavailable", () => {
    const lines = [
      composerCostLine({}),
      composerCostLine({ agent: { step: 5, budget: 40 } }),
      composerCostLine({ agent: {} }),
      composerCostLine({ readOnly: true }),
      composerCostLine({ offline: true }),
      composerCostLine({ unavailable: true }),
    ];
    expect(lines).toEqual([
      "Seshat runs on this machine. Replies take about a minute.",
      "The Agent will pause after step 5 of 40 while Seshat answers (about 40s), then carry on.",
      "The Agent will pause at its first safe step while Seshat answers (about 40s), then carry on.",
      "This server is read-only, so Seshat can't be asked here. Whoever runs Sekhemet can restart it with sekhemet serve.",
      "Offline. Your message would not reach Seshat.",
      "Seshat needs a newer Sekhemet server.",
    ]);
    for (const l of lines) expect(l).not.toMatch(OPERATOR);
    expect(lines.join(" ")).not.toMatch(/\bworker\b|runs locally on/i);
  });
});

describe("the composer's starters include Start a new project", () => {
  it("lists the four starters in order, the start one ready to finish", () => {
    expect(composerStarters()).toEqual([
      { label: "Standup", text: "Standup" },
      { label: "What's at risk this week?", text: "What's at risk this week?" },
      { label: "Plan the next sprint", text: "Plan the next sprint" },
      { label: "Start a new project", text: "Start a new project: " },
    ]);
    expect(START_PROJECT_OPENING).toBe("Start a new project: ");
  });

  it("adds one contextual starter for the focused issue", () => {
    expect(composerStarters({ focused: { key: "CHR-7", failed: true } }).at(-1)).toEqual({
      label: "Why did @CHR-7 fail?",
      text: "Why did @CHR-7 fail?",
    });
    expect(composerStarters({ focused: { key: "CHR-8", estimate: 8 } }).at(-1)).toEqual({
      label: "Split @CHR-8",
      text: "Split @CHR-8",
    });
    expect(composerStarters({ focused: { key: "CHR-9", estimate: 3 } })).toHaveLength(4);
  });

  it("tells a person starting a project what to write and that nothing is created yet", () => {
    const hint =
      "Say in a sentence or two what you want built and who it is for. Seshat drafts a plan for you to review; nothing is created until you press Create project.";
    expect(composerHint("Start a new project: ")).toBe(hint);
    expect(composerHint("start a new project: a recipe site")).toBe(hint);
    expect(composerHint("Start a project: ")).toBe(hint);
    expect(composerHint("Standup")).toBe("");
    expect(composerHint("")).toBe("");
  });
});

describe("DB-P5-4: the palette offers Start a new project and Ask Seshat", () => {
  it("offers Start a new project for 'new project' and for its words", () => {
    const start = { kind: "start", label: "Start a new project", text: "Start a new project: " };
    expect(paletteSeshat("new project", 0)).toEqual([start]);
    expect(paletteSeshat("new project", 4)).toEqual([start]);
    expect(paletteSeshat("start", 2)).toEqual([start]);
    expect(paletteSeshat("New Proj", 0)).toEqual([start]);
  });

  it("offers Ask Seshat: <query> only when nothing else matches", () => {
    expect(paletteSeshat("why is login slow", 0)).toEqual([
      { kind: "ask", label: "Ask Seshat: why is login slow", text: "why is login slow" },
    ]);
    expect(paletteSeshat("why is login slow", 1)).toEqual([]);
    expect(paletteSeshat("", 0)).toEqual([]);
    expect(paletteSeshat("   ", 0)).toEqual([]);
  });
});

describe("DB-P5-7: a non-developer at 400 px starts a project and asks how it is going", () => {
  const solo = visibleNav({
    views: new Set(NAV_ITEMS.map((i) => i.name)),
    team: false,
    completedRuns: 0,
    dependencyEdges: 0,
    playbookEntries: 0,
  });

  it("opens Seshat as the full view on a phone and as the panel from 768 px", () => {
    expect(seshatOpensIn(400)).toBe("full");
    expect(seshatOpensIn(767)).toBe("full");
    expect(seshatOpensIn(768)).toBe("panel");
    expect(seshatOpensIn(1440)).toBe("panel");
  });

  it("walks from the Status tab to a created project and a plain answer, all on screen", () => {
    const walk = nonDeveloperWalk(400, solo);
    expect(walk).toEqual({
      reachable: true,
      steps: [
        { where: "Bottom bar", press: "Status", route: "#/status" },
        // design-stage §2.11: a project starts on its own page with a live draft.
        { where: "Status", press: STATUS_COPY.startProject, route: "#/projects/new" },
        { where: "Seshat", press: "Send", route: "#/projects/new" },
        { where: "Seshat", press: "Review plan", route: "#/projects/new" },
        { where: "Review plan", press: "Create project", route: "#/projects/new" },
        { where: "Bottom bar", press: "Status", route: "#/status" },
        { where: "Status", press: STATUS_COPY.ask, route: "#/pm" },
      ],
    });
    for (const s of walk.steps) expect(`${s.where} ${s.press}`).not.toMatch(/terminal|sekhemet /i);
  });

  it("keeps Seshat beside the page on a wide window, reached from the sidebar", () => {
    const walk = nonDeveloperWalk(1440, solo);
    expect(walk.reachable).toBe(true);
    expect(walk.steps[0]).toEqual({ where: "Sidebar", press: "Status", route: "#/status" });
    expect(walk.steps[1]).toEqual({
      where: "Status",
      press: "Start a new project",
      route: "#/projects/new",
    });
  });

  it("is not reachable when the Status view is not shown", () => {
    const noStatus = solo.filter((i) => i.name !== "status");
    expect(nonDeveloperWalk(400, noStatus)).toEqual({ reachable: false, steps: [] });
  });

  it("matches the served page: the panel hidden below 768 px, the buttons' own words", () => {
    const css = readFileSync(new URL("../web/pm.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.pm-dock \{\s*display: none;/);
    expect(reviewPlanButtonHtml(false)).toContain(`>${SESHAT_COPY.reviewPlan}<`);
    const view = readFileSync(new URL("../web/review_plan_view.js", import.meta.url), "utf8");
    expect(view).toContain(`: "${SESHAT_COPY.createProject}"`);
    const status = readFileSync(new URL("../web/status.js", import.meta.url), "utf8");
    expect(status).toContain("C.startProject");
    expect(status).toContain("C.ask)");
  });

  it("is served to the browser as /app/lib/seshat.js", () => {
    expect(UI_LIB_MODULES).toContain("seshat.js");
    expect(SESHAT_COPY.title).toBe("Seshat · Project manager");
  });
});
