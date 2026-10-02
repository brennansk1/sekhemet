import { describe, expect, it } from "vitest";
import { accountHeader, accountMenu } from "../src/account.js";
import { FIRST_RUN, defaultRouteFor } from "../src/learn.js";
import { type CycleLike, cycleProgress } from "../src/pm.js";
import {
  type StatusCardLike,
  type StatusFacts,
  type StatusInput,
  type StatusSliceLike,
  currentRelease,
  forecastWords,
  requirementsWords,
  sprintDaysLeft,
  statusModel,
} from "../src/status.js";
import { loadFailedText, projectSwitcher, workspaceSwitcher } from "../src/switcher.js";

/**
 * C2a, the status-shell builder's pure halves, with exact values:
 * STA-01 (Status, the chat's /status and the board give one set of numbers:
 * requirements done, the forecast, the sprint's days left and the issue
 * count), STA-02 (Needs you follows the Accept rule), SHL-01 and DEC-57's
 * switchers (DB-N25-1..3), SHL-02 (a person's name, never a principal),
 * SHL-03 (the first run), and ERR-04 (one worded load failure).
 */
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const req = (
  id: string,
  mustHave: boolean,
  state: string,
  cards: StatusSliceLike["requirements"][number]["cards"] = [],
) => ({ id, title: `Requirement ${id}`, mustHave, state, cards });

const slices: StatusSliceLike[] = [
  {
    id: "SLICE-1",
    title: "Release 1: weekly timesheet",
    state: "unproven",
    requirements: [
      req("REQ-1", true, "proven", [{ id: "c1", status: "done", suspect: false }]),
      req("REQ-2", true, "unplanned"),
      req("REQ-3", true, "passing_strength_unmet", [
        { id: "c2", status: "review", suspect: false },
      ]),
      req("REQ-9", false, "unplanned"),
      req("REQ-10", false, "cut"),
    ],
  },
  {
    id: "SLICE-2",
    title: "Release 2: overtime",
    state: "unproven",
    requirements: [req("REQ-4", true, "unplanned"), req("REQ-5", false, "unplanned")],
  },
];

const solo: StatusFacts = {
  setup: "solo",
  project: { id: "proj_a", name: "Timesheets" },
  isLead: true,
  canSetHealth: true,
  healthWritable: true,
  health: null,
  update: null,
  updateMissing: false,
  canPostUpdate: true,
  canUnpark: true,
  mayAccept: true,
  forecast: { remaining: 10, historyDays: 2, finished: 2, minimum: 5 },
  acceptedThisWeek: [],
  flow: { days: 30, cycleHours: [], finished: 0, sentBack: 0, firstTime: { passed: 0, total: 0 } },
};

const cards: StatusCardLike[] = [
  { id: "c1", title: "Export", status: "done", tier: "story" },
  { id: "c2", title: "Weekly total", status: "review", tier: "story", owner: "p_lee" },
  { id: "c3", title: "Overtime", status: "review", tier: "story" },
  { id: "c4", title: "Approvals epic", status: "backlog", tier: "epic" },
  { id: "c5", title: "Old idea", status: "rejected", tier: "story" },
  { id: "c6", title: "Import", status: "ready", tier: "story" },
];

const cycles: CycleLike[] = [
  { id: "cyc_4", name: "Sprint 4", startsOn: "2026-09-25", endsOn: "2026-10-04", state: "active" },
];

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  now: NOW,
  me: "p_me",
  facts: solo,
  cards,
  cycles,
  storyMap: { slices },
  ...over,
});

describe("STA-01: one set of numbers on Status, the chat and the board", () => {
  it("requirements done are the current release's Must haves, the same words the chat says", () => {
    const words = requirementsWords(slices);
    expect(words).toEqual({
      value: "Release 1: weekly timesheet · 1 of 3 requirements done",
      detail:
        "Must have requirements. 1 with tests too weak, not counted as done. Should and Could have requirements are listed below and not counted.",
    });
    const v = statusModel(input());
    expect(v.numbers.find((n) => n.id === "requirements")).toEqual({
      id: "requirements",
      label: "Requirements",
      ...words,
    });
    // Projects reads the same counts (`currentRelease`).
    const cur = currentRelease(slices);
    expect([cur?.done, cur?.total]).toEqual([1, 3]);
  });

  it("lists requirements by release, each with the count its key number uses", () => {
    const v = statusModel(input());
    expect(
      v.requirements.releases.map((r) => [r.name, r.summary, r.current, r.groups.length]),
    ).toEqual([
      ["Release 1: weekly timesheet", "1 of 3 requirements done", true, 2],
      ["Release 2: overtime", "0 of 1 requirement done", false, 2],
    ]);
    expect(v.requirements.releases[0]?.groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["Must have", 3],
      ["Could have", 1],
    ]);
  });

  it("the forecast says the same words wherever it is shown", () => {
    expect(forecastWords(solo.forecast, NOW)).toEqual({
      value: "Not enough history yet",
      detail: "A range needs 5 days of history with finished issues: 2 days so far, 2 finished.",
    });
    expect(
      forecastWords(
        { remaining: 4, p50Days: 3, p85Days: 6, historyDays: 9, finished: 6, minimum: 5 },
        NOW,
        "2026-10-08",
      ),
    ).toEqual({
      value: "50% Sep 30 · 85% Oct 3 · target Oct 8",
      detail: "From 9 days of finished issues; 4 issues left.",
    });
    expect(statusModel(input()).numbers[0]).toEqual({
      id: "forecast",
      label: "Forecast",
      ...forecastWords(solo.forecast, NOW),
    });
  });

  it("the sprint's days left are the board's, counting today", () => {
    const cycle = cycles[0] as CycleLike;
    expect(sprintDaysLeft(cycle, NOW)).toBe(cycleProgress(cycle, [], NOW).daysLeft);
    expect(statusModel(input()).numbers.find((n) => n.id === "sprint")?.value).toBe(
      `Sprint 4 · ${cycleProgress(cycle, [], NOW).daysLeft} days left`,
    );
    const last = { ...cycle, endsOn: "2026-09-27" };
    expect(
      statusModel(input({ cycles: [last] })).numbers.find((n) => n.id === "sprint")?.value,
    ).toBe("Sprint 4 · ends today");
  });

  it("the issue count says what it leaves out, so it reads against the board's tiles", () => {
    expect(statusModel(input()).numbers.find((n) => n.id === "issues")).toEqual({
      id: "issues",
      label: "Issues done",
      value: "1 of 4",
      detail: "Not counted: 1 epic and 1 won't do issue.",
    });
  });
});

describe("STA-02: Needs you follows the project's Accept rule", () => {
  const team: StatusFacts = { ...solo, setup: "team", isLead: false, mayAccept: false };

  it("a person the Accept rule names is asked to review every issue in review", () => {
    const v = statusModel(input({ facts: { ...team, mayAccept: true } }));
    expect(v.needsYou.items.filter((i) => i.kind === "review").map((i) => i.text)).toEqual([
      "Weekly total is waiting for your review.",
      "Overtime is waiting for your review.",
    ]);
  });

  it("anyone else sees them waiting on the people who may accept, by name", () => {
    const v = statusModel(input({ facts: { ...team, accepters: ["Nora Okafor", "Lee Park"] } }));
    expect(v.needsYou.items.filter((i) => i.kind === "review")).toEqual([]);
    expect(v.waiting?.items).toEqual([
      "Weekly total · waiting for review by Nora Okafor or Lee Park",
      "Overtime · waiting for review by Nora Okafor or Lee Park",
    ]);
  });
});

describe("DEC-57's switchers (DB-N25-1..3; SHL-01, STA-07)", () => {
  const projects = [
    { id: "proj_a", name: "Timesheets", state: "active", rootPath: "/work/timesheets" },
    { id: "proj_b", name: "Timesheets", state: "idle", rootPath: "/work/timesheets-copy" },
    { id: "proj_c", name: "Storefront", state: "active", rootPath: "/work/shop" },
  ];

  it("shows the current project's badge and name; the path only in its tooltip", () => {
    const s = projectSwitcher(projects, "proj_c", { canCreate: true });
    expect([s.label, s.initials, s.title]).toEqual(["Storefront", "S", "Storefront · /work/shop"]);
    expect(s.rows.map((r) => [r.id, r.name, r.detail, r.current])).toEqual([
      ["proj_c", "Storefront", "Active", true],
      // Two projects of one name: each told apart by its folder (STA-07).
      ["proj_a", "Timesheets", "Active · timesheets", false],
      ["proj_b", "Timesheets", "Idle · timesheets-copy", false],
    ]);
    expect(s.newProject).toEqual({ label: "New project" });
  });

  it("filters as the person types, and offers New project only to who may create one", () => {
    const s = projectSwitcher(projects, "proj_a", { canCreate: false, filter: "store" });
    expect(s.rows.map((r) => r.id)).toEqual(["proj_c"]);
    expect(s.newProject).toBeNull();
    expect(projectSwitcher(projects, "proj_a", { canCreate: false, filter: "zzz" }).empty).toBe(
      "No project matches “zzz”.",
    );
    // No current project chosen yet: the first the person can see.
    expect(projectSwitcher(projects, null, { canCreate: true }).label).toBe("Timesheets");
    expect(projectSwitcher([], null, { canCreate: true }).label).toBe("No project yet");
  });

  it("lists this machine's workspaces in Solo, with Add and Remove", () => {
    const w = workspaceSwitcher(
      {
        current: "ws_aaaaaaaaaaaa",
        complete: true,
        workspaces: [
          {
            id: "ws_bbbbbbbbbbbb",
            name: "Northwind",
            address: "http://127.0.0.1:8742",
            setup: "team",
          },
          {
            id: "ws_aaaaaaaaaaaa",
            name: "timesheets",
            address: "http://127.0.0.1:8741",
            setup: "solo",
          },
        ],
      },
      { setup: "solo" },
    );
    expect(w.rows).toEqual([
      {
        id: "ws_aaaaaaaaaaaa",
        label: "timesheets",
        detail: "http://127.0.0.1:8741 · Solo",
        current: true,
        href: "http://127.0.0.1:8741/",
        removable: false,
      },
      {
        id: "ws_bbbbbbbbbbbb",
        label: "Northwind",
        detail: "http://127.0.0.1:8742 · Team",
        current: false,
        href: "http://127.0.0.1:8742/",
        removable: true,
      },
    ]);
    expect(w.add).toEqual({ kind: "add", label: "Add a workspace…" });
  });

  it("a Team server lists itself, and offers Open another workspace…", () => {
    const w = workspaceSwitcher(
      {
        current: "ws_bbbbbbbbbbbb",
        complete: false,
        workspaces: [
          {
            id: "ws_bbbbbbbbbbbb",
            name: "Northwind",
            address: "https://sek.northwind.test",
            setup: "team",
          },
        ],
      },
      { setup: "team" },
    );
    expect(w.rows.map((r) => [r.label, r.current, r.removable])).toEqual([
      ["Northwind", true, false],
    ]);
    expect(w.add).toEqual({ kind: "open", label: "Open another workspace…" });
  });
});

describe("SHL-02: a person's name, never a principal; Switch workspace in both setups", () => {
  it("names the person, or says You", () => {
    expect(accountHeader({ mode: "solo", signedIn: true, principal: "p_9a757e74" })).toEqual({
      name: "You",
      detail: "This computer",
    });
    expect(
      accountHeader({ mode: "solo", signedIn: true, principal: "p_9a757e74", name: "Ada" }),
    ).toEqual({ name: "Ada", detail: "This computer" });
    expect(
      accountHeader({ mode: "team", signedIn: true, principal: "p_ada", level: "member" }).name,
    ).toBe("You");
  });

  it("offers Switch workspace in Solo too (DEC-57, DB-N25-3)", () => {
    const ids = accountMenu({ mode: "solo", signedIn: true }, new Set(["switch"])).map((i) => i.id);
    expect(ids).toEqual(["profile", "shortcuts", "theme", "switch"]);
  });
});

describe("SHL-03: the first run", () => {
  it("offers to just talk to Seshat, which opens Seshat", () => {
    expect(FIRST_RUN.choices.map((c) => c.label)).toEqual([
      "I write code",
      "I manage the work",
      "I'm learning",
      "I'll just talk to Seshat",
    ]);
    expect(defaultRouteFor({ role: "seshat", reviewWaiting: false, everAccepted: false })).toBe(
      "#/pm",
    );
  });

  it("sends only who can set up models to Configuration › Models; anyone else to their own page", () => {
    const base = { reviewWaiting: false, everAccepted: false, noModel: true };
    expect(defaultRouteFor(base)).toBe("#/configuration/models");
    expect(defaultRouteFor({ ...base, team: true, level: "admin" })).toBe("#/configuration/models");
    expect(defaultRouteFor({ ...base, team: true, level: "member" })).toBe("#/board");
    expect(
      defaultRouteFor({ ...base, team: true, level: "stakeholder", profileLabel: "Stakeholder" }),
    ).toBe("#/status");
    expect(defaultRouteFor({ ...base, team: true, level: "viewer" })).toBe("#/status");
  });
});

describe("ERR-04: a failed load in words, never a status code", () => {
  it("names what could not load and what to do", () => {
    expect(loadFailedText("the projects", 500)).toEqual({
      title: "Couldn't load the projects.",
      detail: "Sekhemet had a problem answering. Try again; if it keeps happening, restart it.",
    });
    expect(loadFailedText("the projects", 0)).toEqual({
      title: "Couldn't load the projects.",
      detail: "Sekhemet can't be reached. Check that it is running, then try again.",
    });
    expect(loadFailedText("the projects", 404).detail).toBe(
      "This Sekhemet server doesn't have them. Update Sekhemet and restart it.",
    );
    expect(loadFailedText("the projects", 403).detail).toBe(
      "You don't have access to them. An Admin can grant it.",
    );
  });
});

describe("STA-06: one day of history draws no empty axes", () => {
  it("says the burn-up needs a second day, instead of axes from Oct 1 to Oct 1", async () => {
    const { burnupChart } = await import("../src/burnup.js");
    expect(
      burnupChart(
        {
          scope: "project",
          unit: "issues",
          unestimated: 0,
          days: [{ date: "2026-10-01", scope: 13, done: 2 }],
        },
        560,
      ),
    ).toEqual({
      title: "Burn-up · the project",
      empty:
        "Not enough history yet: 2 of 13 issues done today. The lines start once there are two days.",
    });
  });
});
