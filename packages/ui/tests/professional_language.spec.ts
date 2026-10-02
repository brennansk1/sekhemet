/**
 * NEW-dashboard-7 (DEC-31): professional language on every screen.
 *
 * DB-N7-1: every view's copy uses the words Jira, Linear, GitHub and
 * Scrum/Kanban use, and this test fails on any retired display label. It does
 * two things: it renders the views' pure models (`src/`) with fixtures and
 * reads every word they produce, and it reads every string literal of the
 * page modules (`web/`) and the models, comments left out, for a retired word.
 * Internal identifiers (API paths, query keys, CSS classes, `data-` names,
 * stored values in mono) are not copy and are stripped before the check.
 *
 * DB-N7-2: points show only when Preferences → Estimation is story points.
 * DB-N7-3: a card on the board shows no step counter or model name.
 *
 * DEC-31 also retires *card* from copy: a person reads *issue* everywhere but
 * the tile on a board, which the copy names *board card*.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CARD_STOP_REASONS, type CardRecord, STOP_REASONS } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { burnupChart } from "../src/burnup.js";
import { boardModel } from "../src/columns.js";
import {
  ESTIMATION_LABELS,
  PROPOSAL_KINDS,
  RULE_SOURCE_LABELS,
  cycleProgress,
  formatQuery,
  groupCards,
  horizonSentence,
  parseQuery,
  pmSteps,
  rosterRows,
  showsPoints,
  sprintHeaderText,
} from "../src/pm.js";
import { storyMapModel } from "../src/storymap.js";
import { tileModel } from "../src/tiles.js";
import {
  COLUMN_EMPTY,
  ISSUE_TYPE_LABELS,
  type IssueType,
  actorLabel,
  describeCard,
  issueTypeOf,
  stopReasonLabel,
  vocabularyTables,
} from "../src/vocabulary.js";
import { literals, rawRetiredIn, retiredIn } from "./copy_scan.js";

const HERE = new URL(".", import.meta.url).pathname;
const WEB = join(HERE, "../web");
const SRC = join(HERE, "../src");

/** Files whose remaining matches are not the retired sense, with why. */
const NOT_COPY: Record<string, RegExp> = {
  // A browser as a device ("This browser can't use passkeys"), not the Preferences section.
  "account.ts": /this browser/i,
  // Tips are the one place the product says *walking skeleton* (DEC-31, NAMING).
  "learn.ts": /^walking skeleton$/i,
  // The stored state's own label, read only in Pipeline stages (NAMING keeps
  // the stored names there); the board, its tiles and error text say On hold.
  "vocabulary.ts": /^Parked$/,
};

function scan(dir: string, ext: RegExp): string[] {
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((n) => ext.test(n))) {
    const skip = NOT_COPY[f];
    for (const { line, text } of literals(readFileSync(join(dir, f), "utf8"))) {
      for (const hit of [...retiredIn(text), ...rawRetiredIn(text)]) {
        if (skip?.test(hit.split(" → ")[0] ?? "")) continue;
        hits.push(`${f}:${line}: ${hit}`);
      }
    }
  }
  return hits;
}

function card(patch: Partial<CardRecord>): CardRecord {
  return {
    id: "card_x1",
    title: "Hash the ledger",
    status: "backlog",
    tier: "story",
    stepsUsed: 0,
    stepBudget: 40,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...patch,
  } as CardRecord;
}

describe("DB-N7-1: the page's copy uses DEC-31's words", () => {
  it("no page module says a retired word", () => {
    expect(scan(WEB, /\.js$/)).toEqual([]);
  });

  it("no view model says a retired word", () => {
    expect(scan(SRC, /\.ts$/)).toEqual([]);
  });

  it("the scan catches what it is for, and leaves identifiers alone", () => {
    expect(retiredIn("All gates passed.")).toEqual(["gates → checks"]);
    expect(retiredIn("Plan the next cycle")).toEqual(["cycle → sprint"]);
    expect(retiredIn("No Worker running.")).toEqual([
      "Worker → Agent (assignee) or Coding model (role)",
    ]);
    expect(retiredIn("1 of 3 must-haves proven")).toEqual([
      "must-haves → Must have / requirements done",
    ]);
    expect(retiredIn("Cycle time, 85th percentile")).toEqual([]);
    expect(retiredIn('<tr class="c-cycle" data-gate="x">Sprint</tr>')).toEqual([]);
    expect(retiredIn("Edit gates.toml, or GET /api/gates to read them")).toEqual([]);
    expect(retiredIn("delegate:worker")).toEqual([]);
    expect(retiredIn("worker")).toEqual([]);
    expect(retiredIn("Worker")).toEqual(["Worker → a DEC-31 word"]);
    expect(retiredIn('<section aria-label="Gates">')).toEqual(["Gates → a DEC-31 word"]);
    expect(retiredIn('<b title="All gates passed">x</b>')).toEqual(["gates → checks"]);
    // A retired label alone in an element is copy too (the story map's tag).
    expect(retiredIn('<span class="sec">Nice-to-have</span>')).toEqual([
      "Nice-to-have → Could have",
    ]);
    expect(retiredIn("Must-have")).toEqual(["Must-have → Must have / requirements done"]);
    expect(retiredIn("Kano")).toEqual(["Kano → Must have / Should have / Could have"]);
    expect(retiredIn("Slice")).toEqual(["Slice → release"]);
    expect(retiredIn("nice-to-have")).toEqual([]);
  });

  it("says issue, never card, outside the tile on a board", () => {
    const card = "issue (card only for the tile on a board: board card)";
    expect(retiredIn("No cards yet.")).toEqual([`cards → ${card}`]);
    expect(retiredIn("This card has no attempt to respond to.")).toEqual([`card → ${card}`]);
    expect(retiredIn("<th>Card</th><th>Column</th>")).toEqual([`Card → ${card}`]);
    expect(retiredIn("Card")).toEqual([`Card → ${card}`]);
    expect(retiredIn('<table aria-label="Cards">')).toEqual([`Cards → ${card}`]);
    // The tile, and identifiers: event names, routes, labels, CSS names, keys.
    expect(retiredIn("Off, no points show on board cards, columns or reports.")).toEqual([]);
    expect(retiredIn("The board's card shows its key.")).toEqual([]);
    expect(retiredIn("&type=card/review&limit=1")).toEqual([]);
    expect(retiredIn('<a href="#/card/x/plan">Plan</a>')).toEqual([]);
    expect(retiredIn("card-zero")).toEqual([]);
    expect(retiredIn(":root { --shadow-card: 0 1px 2px; }")).toEqual([]);
    expect(retiredIn("card")).toEqual([]);
  });

  it("counts issues, never cards, in a pluralised count", () => {
    // `n === 1 ? "card" : "cards"` is two bare tokens the literal scan leaves
    // alone, so the source is read for the pattern itself.
    const hits: string[] = [];
    for (const [dir, ext] of [
      [WEB, /\.js$/],
      [SRC, /\.ts$/],
    ] as const) {
      for (const f of readdirSync(dir).filter((n) => ext.test(n))) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(
          /["'`]cards?["'`]\s*:\s*["'`]cards?["'`]|\bcard\$\{[^}]*\?\s*""\s*:\s*"s"/g,
        )) {
          hits.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("NEW-dashboard-23 (DEC-52): the professional words, one pass", () => {
  it("catches each word the rename table retires, and leaves identifiers alone", () => {
    const first = (t: string) => retiredIn(t).map((h) => h.split(" → ")[1]);
    expect(first("Send back")).toEqual(["Request changes"]);
    expect(first("Sent back. The issue is back in To do.")).toEqual(["Request changes"]);
    expect(first("Suggested rules from your send-back notes")).toEqual(["Request changes"]);
    expect(first("Park")).toEqual(["Put on hold / On hold / Take off hold"]);
    expect(first("Nothing runs until you unpark it.")).toEqual([
      "Put on hold / On hold / Take off hold",
    ]);
    expect(first("Ledger")).toEqual(["Activity log"]);
    expect(first("Read from the event log.")).toEqual(["Activity log"]);
    expect(first("Suspect")).toEqual(["Needs re-checking"]);
    expect(first("Passing, strength unmet")).toEqual(["Tests too weak"]);
    expect(first("Done when")).toEqual(["Acceptance criteria"]);
    expect(first("May edit")).toEqual(["Files in scope"]);
    expect(first("New appetite, in issues")).toEqual(["Size limit"]);
    expect(first("Need you")).toEqual(["Needs you"]);
    expect(first("Harness overhead")).toEqual(["Sekhemet"]);
    expect(first("Loading the PM")).toEqual(["Seshat"]);
    expect(first("past the day's notice budget")).toEqual(["notification limit"]);
    expect(first("Facts rail")).toEqual(["Details / status / enablers"]);
    expect(first("no other Accept-holder yet")).toEqual(["a person on the Accept rule"]);
    expect(first("lead is a principal")).toEqual(["person"]);
    expect(first("A loop runs through 3 issue(s)")).toEqual(["plural()"]);
    expect(first("Unchanged by the agent")).toEqual(["the Agent"]);
    expect(first("The agent stops at the end of this step.")).toEqual(["the Agent"]);
    expect(first("Not a registry model")).toEqual(["Sekhemet's model list / Published hash"]);
    expect(first("No bake-off yet.")).toEqual(["benchmark"]);
    expect(first("Seshat's review")).toEqual(["Seshat's notes"]);
    expect(first("a team of sub-researchers")).toEqual(["a plain description"]);
    expect(first("Local inference socket")).toEqual([
      "Model server / Sandbox / first-run benchmark / Research quality",
    ]);
    expect(first("Ledger TRUNCATED at entry 4")).toEqual(["Activity log", "sentence case"]);
    // Identifiers, and the sentences that only look like the old words.
    expect(retiredIn("ic s14 i-park")).toEqual([]);
    expect(retiredIn("the issue reaches Done when it merges")).toEqual([]);
    expect(retiredIn("Ready for review Needs you")).toEqual([]);
    expect(retiredIn("Pipeline stages")).toEqual([]);
    expect(retiredIn("parked")).toEqual([]);
    expect(retiredIn("erased by ledger/erased seq 4, see the Ledger-Head trailer")).toEqual([]);
    expect(rawRetiredIn("<code>GET /api/capability</code> returned 404.")).toEqual([
      "GET /api/ → what failed, in plain words",
      "returned 404 → what failed, in plain words",
    ]);
    expect(rawRetiredIn("because SEKHEMET_ALLOW_UNCONFINED=1 was set")).toEqual([
      "SEKHEMET_ALLOW_UNCONFINED= → the setting's name in Configuration",
    ]);
    expect(rawRetiredIn("Refused (DEC-39): no sandbox")).toEqual([
      "DEC-39 → the plain sentence alone",
    ]);
    expect(rawRetiredIn("CHR-7 is In review")).toEqual([]);
  });
});

describe("DB-N7-1: the issue types are Story, Task, Bug, Spike and Epic", () => {
  it("names each stored kind and change by its standard issue type", () => {
    const cases: [Partial<CardRecord>, IssueType][] = [
      [{ kind: "implement", change: "feature" }, "story"],
      [{ kind: "interface" }, "story"],
      [{ kind: "data", change: "feature" }, "story"],
      [{ kind: "rule", change: "fix" }, "bug"],
      [{ kind: "implement", change: "refactor" }, "task"],
      [{ kind: "implement", change: "upgrade" }, "task"],
      [{ kind: "implement", change: "characterize" }, "task"],
      [{ kind: "review" }, "task"],
      [{ kind: "spike" }, "spike"],
      [{ kind: "research" }, "spike"],
      [{ tier: "epic" }, "epic"],
      [{}, "story"],
    ];
    expect(cases.map(([p]) => issueTypeOf(card(p)))).toEqual(cases.map(([, t]) => t));
    expect(Object.values(ISSUE_TYPE_LABELS).map((l) => l.label)).toEqual([
      "Story",
      "Task",
      "Bug",
      "Spike",
      "Epic",
    ]);
  });

  it("describes a card by its issue type, never Contract, Storage, Flow or Rules", () => {
    const d = describeCard(card({ kind: "rule", change: "fix" }));
    expect(d.type).toBe("bug");
    const all = JSON.stringify(vocabularyTables(STOP_REASONS));
    for (const retired of ["Contract", "Storage", '"Flow"', '"Rules"']) {
      expect(all).not.toContain(retired);
    }
  });

  it("types the tile by its issue type, keeping Epic and Initiative for containers", () => {
    const types = (
      [
        { tier: "story", kind: "implement" },
        { tier: "story", kind: "rule", change: "fix" },
        { tier: "task", kind: "implement", change: "refactor" },
        { tier: "story", kind: "spike" },
        { tier: "epic" },
        { tier: "initiative" },
      ] as Partial<CardRecord>[]
    ).map((p) => {
      const c = card(p);
      return tileModel({ ...c, display: describeCard(c) }, { now: Date.now() }).type;
    });
    expect(types).toEqual([
      { icon: "type-story", label: "Story" },
      { icon: "type-bug", label: "Bug" },
      { icon: "type-task", label: "Task" },
      { icon: "type-spike", label: "Spike" },
      { icon: "layers", label: "Epic" },
      { icon: "layers", label: "Initiative" },
    ]);
  });
});

describe("DB-N7-1: roles, checks and sprints in the models' words", () => {
  it("names the machine's roles as DEC-31 does", () => {
    expect(
      ["worker", "planner", "reviewer", "researcher", "human"].map((a) => actorLabel(a)),
    ).toEqual(["Agent", "Planning model", "AI review", "Research model", "You"]);
    // The checks record their own evidence in the Activity log (C2a rename).
    expect(actorLabel("gate")).toBe("Checks");
    expect(rosterRows([]).map((r) => r.label)).toEqual([
      "Coding model",
      "Planning model · Seshat",
      "Review model",
      "Research model",
    ]);
  });

  it("says checks, never gates, in every stop reason", () => {
    const codes = [...CARD_STOP_REASONS];
    const texts = codes.flatMap((c) => {
      const l = stopReasonLabel(c, { step: 3, repairs: 2 });
      return [l.short, l.sentence];
    });
    expect(texts.filter((t) => retiredIn(t).length > 0)).toEqual([]);
    // And the next actions the stop table publishes (`/vocab.json`).
    const tables = vocabularyTables(STOP_REASONS) as {
      stopReasons: Record<string, { short: string; sentence: string; nextAction: string }>;
      actors: Record<string, string>;
    };
    const published = [
      ...Object.values(tables.stopReasons).flatMap((r) => [r.short, r.sentence, r.nextAction]),
      ...Object.values(tables.actors),
    ];
    expect(published.filter((t) => retiredIn(t).length > 0)).toEqual([]);
    expect(stopReasonLabel("gate_passed", { step: 3 }).sentence).toBe(
      "All checks passed on step 3.",
    );
    expect(Object.values(COLUMN_EMPTY).filter((t) => retiredIn(t).length > 0)).toEqual([]);
  });

  it("says sprint where the models said cycle", () => {
    expect(PROPOSAL_KINDS.create_cycle?.label).toBe("Create sprint");
    expect(PROPOSAL_KINDS.assign_cycle?.label).toBe("Add to sprint");
    expect(formatQuery(parseQuery("cycle:current kind:bug"))).toBe("sprint:current type:bug");
    const groups = groupCards([{ id: "a", status: "ready" }], "cycle");
    expect(groups.map((g) => g.label)).toEqual(["No sprint"]);
    expect(pmSteps({ phase: "waiting_for_step" }, { step: 4 }).map((s) => s.label)).toEqual([
      "Pausing the Agent after step 4",
      "Starting Seshat",
      "Thinking",
      "Resuming the Agent",
    ]);
    expect(horizonSentence(undefined)).toBe(
      "Not enough attempts yet to say how large a change the Agent handles reliably.",
    );
    expect(RULE_SOURCE_LABELS.struggle).toBe("From a fix that took the Agent several tries");
  });

  it("titles the burn-up by sprint, and the story map by release", () => {
    const c = burnupChart(
      {
        scope: "cycle",
        name: "Sprint 4",
        startsOn: "2026-10-01",
        endsOn: "2026-10-14",
        days: [],
        unestimated: 0,
      },
      560,
    );
    expect(c).toEqual({ title: "Burn-up · Sprint 4", empty: "Sprint 4 starts on Oct 1." });
    const unnamed = burnupChart({ scope: "cycle", days: [], unestimated: 0 }, 560);
    expect(unnamed.title).toBe("Burn-up · the sprint");
    const map = storyMapModel({
      map: {
        projectId: "p",
        slices: [
          {
            id: "s1",
            title: "Import one statement",
            state: "unproven",
            provenLine: "0 of 1 requirement done",
            requirements: [],
          },
          { id: "s2", state: "proven", provenLine: "1 of 1 requirement done", requirements: [] },
        ],
        unplanned: [],
        provenLine: "1 of 2 requirements done",
        projectDone: false,
      },
      cards: [],
      epics: [{ id: "e", title: "Import" }],
    });
    expect(map.bands.map((b) => [b.heading, b.stateText])).toEqual([
      ["Release 1 · Import one statement", "Not done yet · 0 of 1 requirement done"],
      [
        "Release 2",
        "Requirements done, waiting for a person to accept it · 1 of 1 requirement done",
      ],
      ["Not traced to a requirement", ""],
    ]);
  });
});

describe("DB-N7-2: points only when the team turns on estimation", () => {
  const cards = [
    { id: "a", status: "in_progress", estimate: 3, cycleId: "cy" },
    { id: "b", status: "done", estimate: 5, cycleId: "cy" },
    { id: "c", status: "ready", cycleId: "cy" },
  ];

  it("defaults to off: Preferences → Estimation offers off and story points", () => {
    expect(ESTIMATION_LABELS).toEqual({ off: "Off", points: "Story points" });
    expect(showsPoints(undefined)).toBe(false);
    expect(showsPoints("off")).toBe(false);
    expect(showsPoints("points")).toBe(true);
  });

  it("leaves points off the tile and the columns unless estimation is story points", () => {
    const c = card({ id: "card_p", status: "in_progress", estimate: 3 } as Partial<CardRecord>);
    const shown = { ...c, display: describeCard(c) };
    expect(tileModel(shown, { now: Date.now() }).points).toBeUndefined();
    expect(tileModel(shown, { now: Date.now(), estimation: "points" }).points).toBe("3 pts");
    const off = boardModel({ cards: [shown], now: Date.now() });
    const col = off.columns.find((x) => x.id === "in_progress");
    expect(col?.pointsText).toBe("");
    const on = boardModel({ cards: [shown], now: Date.now(), estimation: "points" });
    expect(on.columns.find((x) => x.id === "in_progress")?.pointsText).toBe("3 pts");
  });

  it("counts a sprint in issues when estimation is off, in points when it is on", () => {
    const cycle = {
      id: "cy",
      name: "Sprint 4",
      state: "active" as const,
      startsOn: "2026-10-01",
      endsOn: "2026-10-10",
    };
    const now = Date.parse("2026-10-06T00:00:00Z");
    expect(cycleProgress(cycle, cards, now).points).toEqual({
      done: 1,
      started: 1,
      notStarted: 1,
      total: 3,
    });
    expect(cycleProgress(cycle, cards, now, "points").points).toEqual({
      done: 5,
      started: 3,
      notStarted: 1,
      total: 9,
    });
    // The sprint header says the same in the team's unit.
    expect(sprintHeaderText(cycleProgress(cycle, cards, now))).toEqual({
      done: "1 of 3 issues done",
      aria: "1 of 3 issues done, 1 in progress, 1 not started",
      pace: "Behind the linear pace by 1 issue.",
      unestimated: "",
    });
    expect(sprintHeaderText(cycleProgress(cycle, cards, now, "points"), "points")).toEqual({
      done: "5 of 9 pts done",
      aria: "5 of 9 pts done, 3 in progress, 1 not started",
      pace: "On the linear pace.",
      unestimated: " · 1 unestimated, counted as 1 pt",
    });
  });

  it("draws the burn-up in issues when the series is counted in issues", () => {
    const c = burnupChart(
      {
        scope: "project",
        unit: "issues",
        days: [
          { date: "2026-09-21", done: 0, scope: 2 },
          { date: "2026-09-22", done: 1, scope: 3 },
        ],
        unestimated: 3,
      },
      560,
    );
    if ("empty" in c) throw new Error("expected a chart");
    expect(c.labels.scope.text).toBe("Scope 3 issues");
    expect(c.labels.done.text).toBe("Done 1 issue");
    expect(c.caption).toBe("1 of 3 issues done by Sep 22. Scope grew by 1 issue since Sep 21.");
  });
});

describe("DB-N7-3: the tile has no step counter and no model name", () => {
  it("says what the Agent is doing without its step count, and draws no budget bar", () => {
    const c = card({
      id: "card_r",
      status: "in_progress",
      stepsUsed: 8,
      delegate: { kind: "worker" },
    } as Partial<CardRecord>);
    const display = describeCard(c, {
      lastStep: { turn: 9, calls: [{ name: "edit_file", target: "src/hasher.ts" }] },
    });
    const t = tileModel({ ...c, display }, { now: Date.now() });
    expect(t.status?.text).toBe("Editing src/hasher.ts");
    expect(t.delegate).toEqual({ text: "Agent", worker: true });
    expect(t).not.toHaveProperty("budget");
    expect(JSON.stringify(t)).not.toMatch(/\bstep\b|of 40/i);
    // The issue keeps the count: "step 9 of 40" in the Agent's progress.
    expect(display.budgetText).toBe("9 of 40 steps");
    const paused = tileModel({ ...c, display }, { now: Date.now(), pmPaused: true });
    expect(paused.status?.text).toBe("Paused for Seshat");
  });
});
