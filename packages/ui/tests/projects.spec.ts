import { describe, expect, it } from "vitest";
import { UI_LIB_MODULES } from "../src/index.js";
import {
  PROJECTS_COLUMNS,
  PROJECTS_COPY,
  type ProjectFacts,
  type ProjectsOverview,
  projectsModel,
} from "../src/projects.js";

/**
 * dashboard DB-N9-9, DB-N9-21, DB-N9-3, DB-N9-7 (§2.11 Projects; teams item 5):
 * the workspace's home, replacing the Workspace rollup, as a pure model with
 * exact outputs. `web/projects.js` renders it.
 */
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const HOUR = 3_600_000;

const chronicle: ProjectFacts = {
  id: "proj_chronicle",
  name: "Chronicle",
  state: "active",
  lead: "Priya",
  health: { value: "at_risk", by: "Priya", at: "2026-09-24T09:00:00.000Z" },
  updateMissing: false,
  release: { name: "Release 1", done: 3, total: 5 },
  forecast: { remaining: 4, p50Days: 6, p85Days: 11, historyDays: 20, finished: 9, minimum: 5 },
  target: "2026-10-10",
  waitingOnYou: 2,
  agent: { working: ["Hasher", "Export"], queued: 1 },
};

const storefront: ProjectFacts = {
  id: "proj_shop",
  name: "Storefront",
  state: "idle",
  lead: null,
  health: null,
  updateMissing: true,
  release: null,
  forecast: { remaining: 2, historyDays: 2, finished: 1, minimum: 5 },
  target: null,
  waitingOnYou: 0,
  agent: { working: [], queued: 0 },
};

function overview(over: Partial<ProjectsOverview> = {}): ProjectsOverview {
  return {
    setup: "team",
    projects: [chronicle, storefront],
    waiting: [
      {
        projectId: "proj_chronicle",
        project: "Chronicle",
        cardId: "card_ledger",
        title: "Ledger (SPIDR: Rule)",
        kind: "review",
        since: new Date(NOW - 3 * HOUR).toISOString(),
      },
      {
        projectId: "proj_chronicle",
        project: "Chronicle",
        cardId: "card_search",
        title: "Search",
        kind: "decision",
        question: "Keep the old API?",
        since: new Date(NOW - 26 * HOUR).toISOString(),
      },
      {
        projectId: "proj_shop",
        project: "Storefront",
        cardId: "card_pay",
        title: "Payments",
        kind: "parked",
        since: new Date(NOW - 45 * 60_000).toISOString(),
      },
    ],
    shippedThisMonth: 12,
    agentSecondsToday: 4_800,
    models: {
      roles: [
        { role: "worker", model: "cyber-tiel-coder", state: "resident" },
        { role: "manager", model: "hermes-planner", state: "swapped" },
        { role: "reviewer", model: "qwen-review", state: "swapped" },
      ],
      slots: { inUse: 2, capacity: 2 },
      queue: 3,
      memory: { usedBytes: 14.2 * 1024 ** 3, totalBytes: 24 * 1024 ** 3 },
    },
    ...over,
  };
}

describe("Projects (DB-N9-9, DB-N9-21)", () => {
  it("DB-N9-9: shows the totals, one row per project, Waiting on you and the models on this server", () => {
    const v = projectsModel({ now: NOW, overview: overview() });
    expect(v.title).toBe("Projects");
    expect(v.crumb).toBe("2 projects you can see");
    expect(v.newProject).toBe("New project");
    expect(v.empty).toBeNull();
    expect(v.totals).toEqual([
      { id: "waiting", label: "Waiting on you", value: "3" },
      { id: "active", label: "Active projects", value: "1" },
      { id: "shipped", label: "Shipped this month", value: "12", detail: "issues finished" },
      { id: "agent", label: "Agent time today", value: "1h 20m", ai: true },
    ]);
    expect(PROJECTS_COLUMNS.map((c) => c.label)).toEqual([
      "Project",
      "Health",
      "Release",
      "Forecast",
      "Target",
      "Waiting on you",
      "Agent",
      "Lead",
    ]);
    expect(PROJECTS_COLUMNS.find((c) => c.label === "Agent")?.ai).toBe(true);
    expect(v.rows).toEqual([
      {
        id: "proj_chronicle",
        name: "Chronicle",
        state: "Active",
        health: { text: "At risk · set by Priya · Sep 24", tone: "parked" },
        updateMissing: null,
        release: "Release 1",
        progress: { done: 3, total: 5, text: "3 of 5 requirements done" },
        forecast: "50% Oct 3 · 85% Oct 8",
        target: "Oct 10",
        waiting: "2 items",
        agent: "Working on Hasher and 1 more · 1 queued",
        lead: "Priya",
      },
      {
        id: "proj_shop",
        name: "Storefront",
        state: "Idle",
        health: { text: "No health set", tone: "" },
        updateMissing: "Update missing",
        release: "No release planned",
        progress: null,
        forecast: "Not enough history yet",
        target: "No target set",
        waiting: "None",
        agent: "Idle",
        lead: "No lead",
      },
    ]);
    // Longest wait first, each with its project and where a person acts on it.
    expect(v.waiting).toEqual({
      heading: "Waiting on you",
      items: [
        {
          projectId: "proj_chronicle",
          project: "Chronicle",
          text: "Search needs your answer: Keep the old API?",
          wait: "Waiting 1d 2h",
          action: "Answer",
          href: "#/inbox",
        },
        {
          projectId: "proj_chronicle",
          project: "Chronicle",
          text: "Ledger is waiting for your review.",
          wait: "Waiting 3h",
          action: "Review it",
          href: "#/review/card_ledger",
        },
        {
          projectId: "proj_shop",
          project: "Storefront",
          text: "Payments is on hold.",
          wait: "Waiting 45m",
          action: "Open",
          href: "#/card/card_pay",
        },
      ],
      empty: "Nothing is waiting on you.",
    });
    expect(v.models).toEqual({
      heading: "Models on this server",
      rows: [
        {
          label: "Coding model",
          model: "cyber-tiel-coder",
          state: "Loaded",
          load: "2 of 2 slots in use · 3 in queue",
          seshat: false,
        },
        {
          label: "Planning model · Seshat",
          model: "hermes-planner",
          state: "Not loaded",
          load: "",
          seshat: true,
        },
        {
          label: "Review model",
          model: "qwen-review",
          state: "Not loaded",
          load: "",
          seshat: false,
        },
        { label: "Research model", model: "Not set", state: "Not set", load: "", seshat: false },
      ],
      memory: "Memory in use: 14.2 of 24 GB",
    });
  });

  it("DB-N17-1: Review it opens the criteria view for a person who manages the work", () => {
    const hrefs = (managesWork: boolean) =>
      projectsModel({ now: NOW, overview: overview(), managesWork })
        .waiting?.items.filter((i) => i.action === "Review it")
        .map((i) => i.href);
    expect(hrefs(true)).toEqual(["#/card/card_ledger/criteria"]);
    expect(hrefs(false)).toEqual(["#/review/card_ledger"]);
  });

  it("DB-N9-21: with no projects shows only Start your first project", () => {
    const v = projectsModel({
      now: NOW,
      overview: overview({ projects: [], waiting: [], shippedThisMonth: 0 }),
    });
    expect(v.empty).toEqual({
      heading: "Start your first project",
      detail: "Tell Seshat what you want to build; it plans the first issues with you.",
      button: "Start your first project",
    });
    // No totals, table, waiting list, models or second button.
    expect(v.newProject).toBeNull();
    expect(v.totals).toEqual([]);
    expect(v.rows).toEqual([]);
    expect(v.waiting).toBeNull();
    expect(v.models).toBeNull();
    expect(v.crumb).toBe("");
  });

  it("DB-N9-21: Solo shows neither No health set nor Update missing, and the lead is you", () => {
    const solo = overview({
      setup: "solo",
      projects: [{ ...storefront, lead: "you" }],
    });
    const v = projectsModel({ now: NOW, overview: solo });
    expect(v.crumb).toBe("1 project on this machine");
    expect(v.rows[0]?.health).toBeNull();
    expect(v.rows[0]?.updateMissing).toBeNull();
    expect(v.rows[0]?.lead).toBe("You");
    expect(JSON.stringify(v)).not.toMatch(/No health set|Update missing/);
    // Status shows no health in Solo, and neither does the table: no Health column.
    expect(v.columns.map((c) => c.id)).toEqual([
      "name",
      "release",
      "forecast",
      "target",
      "waiting",
      "agent",
      "lead",
    ]);
    expect(projectsModel({ now: NOW, overview: overview() }).columns).toEqual(PROJECTS_COLUMNS);
  });

  it("lists a plan waiting for the person's approval under Waiting on you, as Status does", () => {
    const v = projectsModel({
      now: NOW,
      overview: overview({
        waiting: [
          {
            projectId: "proj_chronicle",
            project: "Chronicle",
            cardId: "card_plan",
            title: "Plan me",
            kind: "plan",
            since: new Date(NOW - HOUR).toISOString(),
          },
        ],
      }),
    });
    expect(v.waiting?.items).toEqual([
      {
        projectId: "proj_chronicle",
        project: "Chronicle",
        text: "Plan me has a plan waiting for your approval.",
        wait: "Waiting 1h",
        action: "Review plan",
        href: "#/card/card_plan/plan",
      },
    ]);
  });

  it("DB-N9-3: a forecast is a range with its target, never one date", () => {
    const same = projectsModel({
      now: NOW,
      overview: overview({
        projects: [{ ...chronicle, forecast: { ...chronicle.forecast, p50Days: 4, p85Days: 4 } }],
      }),
    });
    expect(same.rows[0]?.forecast).toBe("50% Oct 1 · 85% Oct 1");
    expect(same.rows[0]?.target).toBe("Oct 10");
    // Nothing left: never one date for both percentiles.
    const done = projectsModel({
      now: NOW,
      overview: overview({
        projects: [
          {
            ...chronicle,
            forecast: { ...chronicle.forecast, remaining: 0, p50Days: 0, p85Days: 0 },
          },
        ],
      }),
    });
    expect(done.rows[0]?.forecast).toBe("All issues done");
  });

  it("DB-N9-7: shows no per-person count, rate or ranking", () => {
    const v = projectsModel({ now: NOW, overview: overview() });
    const words = JSON.stringify(v);
    expect(words).not.toMatch(/velocity|leaderboard|rank|per person|Priya's/i);
    // The lead is named once per row, never counted.
    expect(v.rows.map((r) => r.lead)).toEqual(["Priya", "No lead"]);
  });

  it("says when the server has no Projects page yet, and plain words when a figure is missing", () => {
    const v = projectsModel({ now: NOW, overview: null });
    expect(v.empty).toBeNull();
    expect(v.unavailable).toBe(PROJECTS_COPY.notOnServer);
    // No API path reaches the page (DB-P5-2).
    expect(PROJECTS_COPY.notOnServerDetail).toBe("Update Sekhemet and restart it.");
    const idle = projectsModel({
      now: NOW,
      overview: overview({
        agentSecondsToday: 0,
        waiting: [],
        models: { roles: [], slots: { inUse: 0, capacity: 1 }, queue: 0, memory: null },
      }),
    });
    expect(idle.totals.find((t) => t.id === "agent")?.value).toBe("None yet");
    expect(idle.waiting?.items).toEqual([]);
    expect(idle.models?.rows[0]?.load).toBe("0 of 1 slot in use · nothing queued");
    expect(idle.models?.memory).toBe("Memory in use: not measured");
  });

  it("is served to the browser as /app/lib/projects.js", () => {
    expect(UI_LIB_MODULES).toContain("projects.js");
  });
});

describe("B4.11 T6: health in Solo is optional (TEAM-45, teams item 28)", () => {
  it("shows the Health column once the one person has set a project's health, and nothing for the rest", () => {
    const solo = overview({
      setup: "solo",
      projects: [
        {
          ...storefront,
          lead: "you",
          health: { value: "on_track", by: "you", at: "2026-09-26T10:00:00.000Z" },
        },
        { ...storefront, id: "proj_b", name: "Billing", lead: "you", health: null },
      ],
    });
    const v = projectsModel({ now: NOW, overview: solo });
    expect(v.columns.map((c) => c.id)).toContain("health");
    expect(v.rows[0]?.health).toEqual({ text: "On track · set by you · Sep 26", tone: "pass" });
    expect(v.rows[1]?.health).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/No health set|Update missing/);
  });
});
