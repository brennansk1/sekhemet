import { describe, expect, it } from "vitest";
import { agentStatusLine, agentWork } from "../src/nav.js";
import { type ProjectsOverview, projectsModel } from "../src/projects.js";
import { type StatusCardLike, statusModel } from "../src/status.js";

/**
 * Wave 2 A1, A2 (dashboard §2.1.6, §2.2.3, §2.8.8, DB-N9-7, DB-N9-9): what
 * the Agent is doing has one source. A card is the Agent's current work only
 * when a run backs it — the server marks it `liveRun` when a runner or slot
 * lease names it or its attempt is running on the ledger. A card merely
 * stored In progress is said to be so, with no run, and never "working";
 * Status, Projects and the sidebar name the same current item.
 */
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const ip1: StatusCardLike & { key: string; liveRun?: boolean } = {
  id: "card_ip1",
  key: "ip1",
  title: "Work out the pay period of a date",
  status: "in_progress",
  tier: "task",
  updatedAt: "2026-10-11T10:00:00.000Z",
};
const vf1: StatusCardLike & { key: string; liveRun?: boolean } = {
  id: "card_vf1",
  key: "vf1",
  title: "Round minutes to the quarter hour",
  status: "verify",
  tier: "task",
  updatedAt: "2026-10-11T11:00:00.000Z",
};

const status = (cards: StatusCardLike[]) =>
  statusModel({ now: NOW, facts: null, cards, standing: [] });

const overview = (working: string[], notRunning: string[]): ProjectsOverview => ({
  setup: "solo",
  projects: [
    {
      id: "proj_t",
      name: "Timesheets",
      state: "active",
      lead: "you",
      health: null,
      updateMissing: false,
      release: null,
      forecast: { remaining: 3, historyDays: 1, finished: 1, minimum: 5 },
      target: null,
      waitingOnYou: 0,
      agent: { working, notRunning, queued: 2 },
    },
  ],
  waiting: [],
  shippedThisMonth: 1,
  agentSecondsToday: 0,
  models: {
    roles: [{ role: "worker", model: "nail-mtp", state: "swapped" }],
    slots: { inUse: working.length, capacity: 1 },
    queue: 2,
    memory: null,
  },
});

describe("A1: the Agent is working only when a run backs it", () => {
  it("a card stored In progress with no run: the sidebar says the Agent is idle and names the card honestly", () => {
    const line = agentStatusLine(agentWork([ip1, vf1]));
    expect(line).toEqual({ text: "Agent idle · ip1 is in progress with no run", state: "idle" });
    expect(agentStatusLine(agentWork([ip1, { ...vf1, status: "in_progress" }])).text).toBe(
      "Agent idle · 2 issues are in progress with no run",
    );
  });

  it("a card with a run: the sidebar says the Agent is working on it", () => {
    expect(agentStatusLine(agentWork([{ ...ip1, liveRun: true }, vf1]))).toEqual({
      text: "Agent working on ip1",
      state: "working",
    });
  });

  it("Status names no Agent item and calls the Coding model idle when no run exists", () => {
    const v = status([ip1, vf1]);
    expect(v.working.rows).toEqual([]);
    expect(v.models).toBe("Coding model idle");
  });

  // Review finding 2: Status's headline and standup said "2 being built" and
  // "Being built: …" with no run behind either card; they say the stored fact.
  it("Status's headline and standup say In progress, never being built, with no run", () => {
    const v = statusModel({
      now: NOW,
      facts: null,
      cards: [ip1, vf1],
      standup: { byState: { in_progress: [{ id: ip1.id, title: ip1.title }] } },
    } as never);
    expect(v.headline).toBe("0 of 2 issues done. 2 in progress.");
    expect(v.standup.lines).toEqual(["In progress: Work out the pay period of a date"]);
    expect(JSON.stringify([v.headline, v.standup])).not.toMatch(/being built/i);
  });

  it("Projects says Idle, with the stored card named as not running", () => {
    const row = projectsModel({ now: NOW, overview: overview([], [ip1.title]) }).rows[0];
    expect(row?.agent).toBe("Idle · 1 in progress with no run · 2 queued");
  });
});

describe("A2: Status, Projects and the sidebar name the same Agent item", () => {
  it("the Agent's current item is the one its run is on, whatever column it is in", () => {
    const cards = [ip1, { ...vf1, liveRun: true }];
    const work = agentWork(cards);
    expect(work.running.map((c) => c.id)).toEqual(["card_vf1"]);
    expect(status(cards).working.rows).toEqual([
      { who: "Agent", ai: true, item: "Round minutes to the quarter hour" },
    ]);
    expect(agentStatusLine(work).text).toBe("Agent working on vf1");
    const row = projectsModel({
      now: NOW,
      overview: overview(
        work.running.map((c) => c.title),
        work.notRunning.map((c) => c.title),
      ),
    }).rows[0];
    expect(row?.agent).toBe(
      "Working on Round minutes to the quarter hour · 1 in progress with no run · 2 queued",
    );
    expect(status(cards).models).toBe("Coding model busy · nothing queued");
  });

  it("two runs: every view takes the most recently moved one first", () => {
    const cards = [
      { ...ip1, liveRun: true },
      { ...vf1, liveRun: true },
    ];
    expect(agentWork(cards).running.map((c) => c.id)).toEqual(["card_vf1", "card_ip1"]);
    expect(status(cards).working.rows[0]?.item).toBe("Round minutes to the quarter hour");
  });

  it("a person's own In progress card is theirs, never the Agent's", () => {
    const sams = { ...ip1, delegate: "p_sam", display: { delegateName: "Sam" } };
    expect(agentWork([sams]).notRunning).toEqual([]);
    expect(status([sams]).working.rows).toEqual([{ who: "Sam", ai: false, item: ip1.title }]);
  });
});
