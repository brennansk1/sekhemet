import { readFileSync } from "node:fs";
import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { type NavContext, cheatSheet, visibleNav } from "../src/nav.js";
import { NOTIFY_COPY } from "../src/notify.js";
import { capabilityWords, filterWords, parseQuery } from "../src/pm.js";
import { type ProjectFacts, type ProjectsOverview, projectsModel } from "../src/projects.js";
import { PROJECT_CONFIG_COPY, configRows, queueCapView } from "../src/settings.js";
import { tileModel } from "../src/tiles.js";
import { ACCEPTANCE_COPY, describeCard, pluralWord } from "../src/vocabulary.js";

/**
 * The test-and-refine loop's wave 4, words and copy (sweep2_dashboard.json;
 * dashboard §2.13 "Copy is terse", NAMING): each finding reduced to the pure
 * function its words come from.
 */

const PROJECT: ProjectFacts = {
  id: "p",
  name: "Timesheets",
  state: "active",
  lead: null,
  health: null,
  updateMissing: false,
  release: null,
  forecast: null,
  target: null,
  waitingOnYou: 1,
  agent: { working: [], queued: 0 },
};

describe("plurals come from one helper (sweep 2: '1 issues', '1 attempts', '1 kinds')", () => {
  it("pluralWord gives the word alone, singular for exactly one", () => {
    expect(pluralWord(1, "issue")).toBe("issue");
    expect(pluralWord(0, "issue")).toBe("issues");
    expect(pluralWord(2, "kind")).toBe("kinds");
    expect(pluralWord(1, "retry", "retries")).toBe("retry");
  });

  it("Projects' Shipped this month reads '1 issue finished'", () => {
    const overview = (shippedThisMonth: number): ProjectsOverview => ({
      setup: "solo",
      projects: [PROJECT],
      waiting: [],
      shippedThisMonth,
      agentSecondsToday: 0,
      models: { roles: [], slots: { inUse: 0, capacity: 1 }, queue: 0, memory: null },
    });
    const shipped = (n: number) =>
      projectsModel({ now: Date.parse("2026-10-11T12:00:00Z"), overview: overview(n) }).totals.find(
        (t) => t.id === "shipped",
      )?.detail;
    expect(shipped(1)).toBe("issue finished");
    expect(shipped(2)).toBe("issues finished");
  });

  it("Insights' Coding model capability agrees in number", () => {
    const one = capabilityWords({ sampleSize: 1, kinds: 1, few: 1 });
    expect(one.sub).toBe("1 attempt · bars show the pass rate and its 95% interval");
    expect(one.kinds).toBe("1 of 1 kind has fewer than 10 attempts; treat that rate as rough.");
    const many = capabilityWords({ sampleSize: 12, kinds: 3, few: 2 });
    expect(many.sub).toBe("12 attempts · bars show the pass rate and its 95% interval");
    expect(many.kinds).toBe(
      "2 of 3 kinds have fewer than 10 attempts; treat those rates as rough.",
    );
    expect(capabilityWords({ sampleSize: 30, kinds: 2, few: 0 }).kinds).toBe(
      "Every kind has at least 10 attempts.",
    );
  });
});

describe("board tiles show one time (sweep 2: 'Waiting 8m … 8m')", () => {
  const NOW = Date.parse("2026-09-27T12:00:00.000Z");
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
  const review = (display: Record<string, unknown> = {}) => {
    const c = {
      id: "card_rv1",
      tier: "story",
      title: "Show the weekly total",
      status: "review",
      scopeFiles: [],
      stepBudget: 40,
      stepsUsed: 3,
      createdAt: at(48),
      updatedAt: at(1),
    } as unknown as CardRecord;
    return {
      ...c,
      display: { ...describeCard(c, { now: NOW, enteredColumnAt: at(1) }), ...display },
    };
  };

  it("an In review tile whose wait equals its age says the time once, in the age", () => {
    const t = tileModel(review(), { now: NOW });
    expect(t.age).toBe("1h");
    expect(t.status?.text).toBe("Waiting for you");
    expect(t.status?.text).not.toMatch(/1h/);
  });

  it("keeps the wait when it is a different fact from the age, and turns amber past 2 h", () => {
    const t = tileModel(review({ startedAt: at(5) }), { now: NOW });
    expect(t.age).toBe("5h");
    expect(t.status?.text).toBe("Waiting 1h");
    const old = tileModel(review({ enteredColumnAt: at(3) }), { now: NOW });
    expect(old.status).toMatchObject({ text: "Waiting for you", old: true });
  });
});

describe("terse copy: a label where a label will do (§2.13)", () => {
  it("names the protected files with a label, not a sentence", () => {
    expect(ACCEPTANCE_COPY.protectedLabel).toBe("Protected from the Agent");
    expect(ACCEPTANCE_COPY.protectedLabel).not.toMatch(/\./);
  });

  it("says a blocked browser in one short line, not browser steps", () => {
    expect(NOTIFY_COPY.blocked.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
    expect(NOTIFY_COPY.blocked.length).toBeLessThanOrEqual(100);
    expect(NOTIFY_COPY.blocked).not.toMatch(/address bar/);
  });
});

describe("the empty filter names the filter in words (§2.4 item 10)", () => {
  const label = (field: string, v: string) =>
    (
      ({
        priority: { urgent: "Urgent", high: "High" },
        is: { open: "Open", "needs-you": "Needs you" },
        cycle: { current: "Sprint 4" },
        label: { later: "later" },
      }) as Record<string, Record<string, string>>
    )[field]?.[v] ?? v;

  it("reads as the chips read, never as the query syntax", () => {
    expect(filterWords(parseQuery("priority:urgent,high is:open"), label)).toBe(
      "Priority: Urgent, High · Is: Open",
    );
    expect(filterWords(parseQuery("is:needs-you"), label)).toBe("Is: Needs you");
    expect(filterWords(parseQuery("sprint:current -label:later overtime"), label)).toBe(
      "Sprint: Sprint 4 · Label is not: later · overtime",
    );
    expect(filterWords(parseQuery(""), label)).toBe("");
  });
});

describe("the cheat sheet lists only shortcuts that work (sweep 2: 'Playbook g k')", () => {
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
    "status",
  ]);
  const ctx = (playbookEntries: number): NavContext => ({
    views: BUILT,
    team: false,
    completedRuns: 0,
    dependencyEdges: 0,
    playbookEntries,
  });
  const note = (c: NavContext) =>
    cheatSheet(visibleNav(c)).find((g) => g.name === "Navigate")?.note ?? "";

  it("does not announce g k while Playbook is hidden", () => {
    expect(visibleNav(ctx(0)).some((i) => i.name === "playbook")).toBe(false);
    expect(note(ctx(0))).not.toMatch(/Playbook/);
    expect(note(ctx(0))).toMatch(/Integrations is g n/);
  });

  it("announces g k once Playbook is shown", () => {
    expect(note(ctx(2))).toMatch(/Playbook g k/);
  });
});

describe("Projects names the action as Status does (DEC-52)", () => {
  it("an on-hold item's action is Take off hold, on the issue where that button is", () => {
    const v = projectsModel({
      now: Date.parse("2026-10-11T12:00:00Z"),
      overview: {
        setup: "solo",
        projects: [PROJECT],
        waiting: [
          {
            projectId: "p",
            project: "Timesheets",
            cardId: "card_pk1",
            title: "Let a manager approve a week",
            kind: "parked",
            since: "2026-10-11T11:00:00Z",
          },
        ],
        shippedThisMonth: 0,
        agentSecondsToday: 0,
        models: { roles: [], slots: { inUse: 0, capacity: 1 }, queue: 0, memory: null },
      },
    });
    expect(v.waiting?.items[0]).toMatchObject({
      action: "Take off hold",
      href: "#/card/card_pk1",
    });
  });
});

describe("Configuration › Project in a person's words", () => {
  // An internal setting key (`queue.agent_issues_per_person`), not a file name.
  const KEY = /\b(?:queue|machine|network|team|review)\.[a-z_]+\b/;
  it("shows no internal setting keys and does not tell a person to edit files", () => {
    expect(PROJECT_CONFIG_COPY.valuesHint).not.toMatch(/Edit the files/);
    expect(PROJECT_CONFIG_COPY.valuesHint).not.toMatch(KEY);
    const q = queueCapView({}, {}, "");
    expect(q.from).toBe("From: Default");
    expect(q.from).not.toMatch(/queue\.agent_issues_per_person/);
    for (const r of configRows({}, {})) {
      expect(r.label).not.toMatch(/\./);
      expect(r.source).not.toMatch(KEY);
    }
    // The page renders these words and no key beside them.
    const page = readFileSync(new URL("../web/configuration.js", import.meta.url), "utf8");
    expect(page).not.toMatch(/esc\(r\.key\)/);
    expect(page).not.toMatch(/>queue\.agent_issues_per_person</);
    expect(page).not.toMatch(/Edit the files/);
  });
});
