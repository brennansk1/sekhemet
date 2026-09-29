import type { CardRecord, CardStatus } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  COLUMN_CHOICES_KEY,
  PIPELINE_KEY,
  boardColumnDefs,
  boardModel,
  focusAfterFrame,
  onColumns,
  readColumnChoices,
  readPipeline,
  reviewLimitText,
  writeColumnChoices,
  writePipeline,
} from "../src/columns.js";
import { tileModel } from "../src/tiles.js";
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_ORDER,
  type DisplayContext,
  boardColumnOf,
  describeCard,
} from "../src/vocabulary.js";

/**
 * dashboard P3 (DB-P3-1…11, 15, 16, 18): the board's columns, headers, chips
 * and tiles as pure models, with exact outputs. The page (`board.js`,
 * `tile.js`) renders these and nothing else.
 */
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

const typesFailed = {
  id: "ev_1",
  passed: false,
  stopReason: "oscillation_detected",
  turnsUsed: 8,
  filesTouched: ["src/hasher.ts"],
  rungResults: [
    { gate: "typecheck", rung: "typecheck", passed: false, durationMs: 658 },
    { gate: "unit", rung: "test", passed: true, durationMs: 900 },
  ],
  failures: [
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "a.ts:1 TS2353" },
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "a.ts:2 TS2353" },
    { gate: "typecheck", rung: "typecheck", errorExcerpt: "a.ts:3 TS2353" },
  ],
};

function boardCard(patch: Partial<CardRecord>, ctx: DisplayContext = {}) {
  const card: CardRecord = {
    id: "card_x",
    tier: "story",
    title: "A card",
    status: "backlog",
    scopeFiles: [],
    stepBudget: 40,
    stepsUsed: 0,
    createdAt: at(48),
    updatedAt: at(1),
    ...patch,
  };
  return { ...card, display: describeCard(card, { now: NOW, ...ctx }) };
}

const one = (status: CardStatus, id = `card_${status}`, extra: Partial<CardRecord> = {}) =>
  boardCard({ id, status, ...extra }, { enteredColumnAt: at(1) });

describe("DB-P3-1: five professional columns over the nine stored states", () => {
  it("maps every stored state to exactly one column, Rejected to the Won't do filter", () => {
    const all: CardStatus[] = [...BOARD_COLUMN_ORDER];
    expect(all.map((s) => [s, boardColumnOf(s)])).toEqual([
      ["backlog", "backlog"],
      ["ready", "todo"],
      ["planning", "todo"],
      ["in_progress", "in_progress"],
      ["verify", "in_progress"],
      ["review", "in_review"],
      ["done", "done"],
      ["parked", "on_hold"],
      ["rejected", "wont_do"],
    ]);
    // No state sits in two columns.
    for (const s of all) {
      expect(BOARD_COLUMNS.filter((c) => c.states.includes(s)).length).toBe(
        s === "rejected" ? 0 : 1,
      );
    }
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual([
      "Backlog",
      "To do",
      "In progress",
      "In review",
      "Done",
      "On hold",
    ]);
  });

  it("shows the five columns and On hold only when a card is parked (DB-P3-18)", () => {
    const cards = ["backlog", "ready", "in_progress", "review", "done"].map((s) =>
      one(s as CardStatus),
    );
    const m = boardModel({ cards, now: NOW });
    expect(m.columns.map((c) => c.label)).toEqual([
      "Backlog",
      "To do",
      "In progress",
      "In review",
      "Done",
    ]);
    expect(m.chips).toEqual([]);
    const parked = boardModel({ cards: [...cards, one("parked")], now: NOW });
    expect(parked.columns.map((c) => c.label).at(-1)).toBe("On hold");
    expect(parked.columns.at(-1)?.countTone).toBe("parked");
    expect(parked.columns.at(-1)?.count).toBe(1);
  });

  it("puts Ready and Planning in To do, In progress and Verify in In progress", () => {
    const m = boardModel({
      cards: [one("ready", "a"), one("planning", "b"), one("in_progress", "c"), one("verify", "d")],
      now: NOW,
    });
    const ids = Object.fromEntries(m.columns.map((c) => [c.id, c.cards.map((x) => x.id)]));
    expect(ids).toEqual({ todo: ["a", "b"], in_progress: ["c", "d"] });
    expect(m.chips.map((c) => c.label)).toEqual(["Backlog", "In review", "Done"]);
  });

  it("hides rejected cards unless the filter asks for Won't do", () => {
    const cards = [one("rejected", "r"), one("ready", "a")];
    expect(boardModel({ cards, now: NOW }).columns.map((c) => c.id)).toEqual(["todo"]);
    const asked = boardModel({ cards, now: NOW, wontDo: true });
    expect(asked.columns.map((c) => [c.label, c.cards.map((x) => x.id)])).toEqual([
      ["To do", ["a"]],
      ["Won't do", ["r"]],
    ]);
  });

  it("keeps On hold right-most when Won't do shows beside it (DB-P3-18)", () => {
    const cards = [one("rejected", "r"), one("parked", "p")];
    const m = boardModel({ cards, now: NOW, wontDo: true });
    expect(m.columns.map((c) => c.label)).toEqual(["Won't do", "On hold"]);
    expect(boardColumnDefs({ wontDo: true }).map((d) => d.id)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "wont_do",
      "on_hold",
    ]);
    expect(boardColumnDefs({}).map((d) => d.id)).not.toContain("wont_do");
    expect(boardColumnDefs({ pipeline: true, wontDo: true }).length).toBe(9);
  });

  it("swimlanes: the same columns, and a lane holds only the cards a column shows", () => {
    const cards = [one("rejected", "r"), one("ready", "a"), one("parked", "p")];
    // Without the filter asking, a rejected card is in no column, so in no lane.
    expect(onColumns(cards, boardColumnDefs({})).map((c) => c.id)).toEqual(["a", "p"]);
    // `state:rejected` adds Won't do, and the rejected card is in its cell.
    const defs = boardColumnDefs({ wontDo: true });
    expect(onColumns(cards, defs).map((c) => c.id)).toEqual(["r", "a", "p"]);
    expect(defs.find((d) => d.states.includes("rejected"))?.label).toBe("Won't do");
  });
});

describe("DB-P3-2: a verify card with a failing gate", () => {
  it("sits in In progress with a fail-tone badge naming the gate", () => {
    const c = boardCard({ id: "v", status: "verify", stepsUsed: 8 }, { evidence: typesFailed });
    const m = boardModel({ cards: [c], now: NOW });
    expect(m.columns.map((col) => col.id)).toEqual(["in_progress"]);
    const t = tileModel(c, { now: NOW });
    expect(t.status).toEqual({
      text: "Types failed · 3 errors",
      tone: "fail",
      mark: "pips",
      old: false,
      wraps: false,
    });
    expect(t.pips).toBe(true);
  });
});

describe("DB-P3-3: pipeline stages", () => {
  it("shows the nine stored states as columns, named as stored in sentence case", () => {
    const cards = BOARD_COLUMN_ORDER.map((s) => one(s));
    const m = boardModel({ cards, now: NOW, pipeline: true });
    expect(m.columns.map((c) => c.label)).toEqual([
      "Backlog",
      "Ready",
      "Planning",
      "In progress",
      "Verify",
      "Review",
      "Done",
      "Parked",
      "Rejected",
    ]);
    expect(m.columns.map((c) => c.id)).toEqual(BOARD_COLUMN_ORDER);
  });

  it("keeps the choice per browser, and a broken storage reads as off", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(readPipeline(storage)).toBe(false);
    writePipeline(storage, true);
    expect(mem.get(PIPELINE_KEY)).toBe("on");
    expect(readPipeline(storage)).toBe(true);
    writePipeline(storage, false);
    expect(readPipeline(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPipeline(broken)).toBe(false);
    expect(() => writePipeline(broken, true)).not.toThrow();
  });
});

describe("DB-P3-16: a person's column choices survive a reload", () => {
  it("keeps each column's sort, and the folded and opened columns, per browser and per layout", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(readColumnChoices(storage, false)).toEqual({
      sort: {},
      collapsed: new Set(),
      expanded: new Set(),
    });
    writeColumnChoices(storage, false, {
      sort: { todo: "wait" },
      collapsed: new Set(["done"]),
      expanded: new Set(["in_review"]),
    });
    expect(JSON.parse(mem.get(COLUMN_CHOICES_KEY) ?? "{}")).toEqual({
      board: { sort: { todo: "wait" }, collapsed: ["done"], expanded: ["in_review"] },
    });
    const back = readColumnChoices(storage, false);
    expect(back).toEqual({
      sort: { todo: "wait" },
      collapsed: new Set(["done"]),
      expanded: new Set(["in_review"]),
    });
    // The same model a page that stayed open builds.
    const cards = [one("ready", "a"), one("done", "d")];
    expect(boardModel({ cards, now: NOW, ...back })).toEqual(
      boardModel({
        cards,
        now: NOW,
        sort: { todo: "wait" },
        collapsed: new Set(["done"]),
        expanded: new Set(["in_review"]),
      }),
    );
    // Pipeline stages keeps its own; a stored mode that is not one is dropped.
    expect(readColumnChoices(storage, true).collapsed.size).toBe(0);
    mem.set(COLUMN_CHOICES_KEY, JSON.stringify({ board: { sort: { todo: "sideways" } } }));
    expect(readColumnChoices(storage, false).sort).toEqual({});
    mem.set(COLUMN_CHOICES_KEY, "{not json");
    expect(readColumnChoices(storage, false).sort).toEqual({});
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readColumnChoices(broken, false).sort).toEqual({});
    expect(() =>
      writeColumnChoices(broken, true, { sort: {}, collapsed: new Set(), expanded: new Set() }),
    ).not.toThrow();
  });
});

describe("DB-P3-4, 5: the tile's anatomy", () => {
  const epics = [{ id: "card_epic", title: "Ledger (SPIDR: Rule)" }];
  const c = boardCard(
    {
      id: "card_a1",
      key: "CHR-12",
      tier: "story",
      title: "Implement canonical JSON (SPIDR: Rule)",
      status: "in_progress",
      stepsUsed: 8,
      estimate: 3,
      priority: 2,
      labels: ["api", "security", "perf"],
      epicId: "card_epic",
      owner: "p_jd",
      delegate: { kind: "worker" },
    } as Partial<CardRecord>,
    {
      enteredColumnAt: at(2),
      startedAt: at(22),
      ownerName: "Jane Doe",
    },
  );

  it("shows key, type, points, owner, the Agent chip, title, priority, epic, labels, status and age", () => {
    // Points show because the team turned on story points (DB-N7-2); the
    // status names no step count and there is no budget bar (DB-N7-3).
    expect(tileModel(c, { now: NOW, epics, estimation: "points" })).toEqual({
      id: "card_a1",
      column: "in_progress",
      key: "CHR-12",
      type: { icon: "type-story", label: "Story" },
      points: "3 pts",
      owner: { initials: "JD", name: "Jane Doe" },
      delegate: { text: "Agent", worker: true },
      title: "Implement canonical JSON",
      priority: 2,
      epic: { id: "card_epic", title: "Ledger" },
      labels: ["api", "security"],
      moreLabels: ["perf"],
      status: {
        text: "Working",
        tone: "running",
        mark: "running",
        old: false,
        wraps: false,
      },
      age: "22h",
      pips: false,
    });
    // With estimation off (the default) the same tile shows no points.
    expect(tileModel(c, { now: NOW, epics }).points).toBeUndefined();
  });

  it("leaves out what is not set: no points, owner, delegate, priority glyph or epic", () => {
    const bare = boardCard({ id: "card_b2", status: "backlog", tier: "task" });
    expect(tileModel(bare, { now: NOW })).toEqual({
      id: "card_b2",
      column: "backlog",
      key: "b2",
      type: { icon: "type-task", label: "Task" },
      title: "A card",
      priority: 0,
      labels: [],
      moreLabels: [],
      pips: false,
    });
  });

  it("DB-P3-5: a person delegate is named; the Agent is text, never an avatar", () => {
    const person = boardCard(
      {
        id: "card_p",
        status: "ready",
        delegate: { kind: "person", id: "p_sam" },
      } as Partial<CardRecord>,
      { delegateName: "Sam Ortiz" },
    );
    expect(tileModel(person, { now: NOW }).delegate).toEqual({ text: "Sam Ortiz", worker: false });
    const worker = tileModel(c, { now: NOW });
    expect(worker.delegate).toEqual({ text: "Agent", worker: true });
    expect(worker.owner?.initials).toBe("JD");
    // An owner with no recorded name still shows, with its words.
    const unnamed = boardCard({ id: "card_u", owner: "p_zz" } as Partial<CardRecord>);
    expect(tileModel(unnamed, { now: NOW }).owner).toEqual({
      initials: "?",
      name: "An unnamed person",
    });
  });

  it("types each tier by its standard issue type (DEC-31): containers by tier, work by what it changes", () => {
    const tiers = ["initiative", "epic", "feature", "story", "task"] as const;
    expect(tiers.map((tier) => tileModel(boardCard({ tier }), { now: NOW }).type)).toEqual([
      { icon: "layers", label: "Initiative" },
      { icon: "layers", label: "Epic" },
      { icon: "type-story", label: "Story" },
      { icon: "type-story", label: "Story" },
      { icon: "type-task", label: "Task" },
    ]);
  });

  it("shows the work item age on In progress and In review only", () => {
    const review = boardCard(
      { id: "card_r", status: "review" },
      { enteredColumnAt: at(3), startedAt: at(26) },
    );
    expect(tileModel(review, { now: NOW }).age).toBe("1d 2h");
    const done = boardCard({ id: "card_d", status: "done" }, { enteredColumnAt: at(3) });
    expect(tileModel(done, { now: NOW }).age).toBeUndefined();
    // Without a recorded start, the age counts from entering the column.
    const noStart = boardCard({ id: "card_n", status: "in_progress" }, { enteredColumnAt: at(5) });
    expect(tileModel(noStart, { now: NOW }).age).toBe("5h");
  });

  it("names an accepted card waiting on its pull request", () => {
    const held = boardCard(
      {
        id: "card_h",
        status: "review",
        hold: { kind: "awaitingMerge", pr: 14, since: at(1) },
      } as Partial<CardRecord>,
      { enteredColumnAt: at(1) },
    );
    expect(tileModel(held, { now: NOW }).status?.text).toBe("Accepted · PR #14 open");
    // Teams TEAM-24: new commits dismissed the accept; the pull request is still open.
    const dismissed = boardCard(
      {
        id: "card_d",
        status: "review",
        hold: { kind: "awaitingMerge", pr: 14, since: at(1), dismissed: true },
      } as Partial<CardRecord>,
      { enteredColumnAt: at(1) },
    );
    expect(tileModel(dismissed, { now: NOW }).status?.text).toBe(
      "Accept dismissed · PR #14 has new commits",
    );
  });

  it("says the agent is paused while Seshat replies, with no step count (DB-N7-3)", () => {
    expect(tileModel(c, { now: NOW, pmPaused: true }).status?.text).toBe("Paused for Seshat");
  });
});

describe("DB-P3-6: the blocker flag", () => {
  it("flags an unfinished dependency with its cause, instead of a second badge", () => {
    const t = tileModel(
      boardCard(
        { id: "card_w", status: "ready" },
        {
          waitsOn: [
            { id: "h", title: "hasher" },
            { id: "i", title: "index" },
          ],
        },
      ),
      { now: NOW },
    );
    expect(t.blocker).toEqual({ text: "Blocked · waits on hasher +1" });
    expect(t.status).toBeUndefined();
  });

  it("flags a blockedReason on a card in any column, beside its status", () => {
    const t = tileModel(
      boardCard(
        { id: "card_b", status: "in_progress", stepsUsed: 3, blockedReason: "Needs the API key" },
        { waitsOn: [{ id: "h", title: "hasher" }] },
      ),
      { now: NOW },
    );
    expect(t.blocker).toEqual({ text: "Blocked · Needs the API key · waits on hasher" });
    expect(t.status?.text).toBe("Working");
  });

  it("DB-P3-12: the criteria-approval hold points to the card's Approve, never to the CLI", () => {
    const t = tileModel(
      boardCard({
        id: "card_q",
        status: "planning",
        blockedReason:
          "Criterion c2 has no staged test case. Waiting on a person's approval of its criteria: sekhemet approve card_q.",
      }),
      { now: NOW },
    );
    expect(t.blocker).toEqual({
      text: "Blocked · Criterion c2 has no staged test case. Waiting on a person's approval of its criteria: open the issue to approve them.",
    });
  });
});

describe("DB-P3-7: a long status wraps and keeps its cause", () => {
  it("never truncates, and drops the labels to make room", () => {
    const text =
      "Its acceptance tests fail before any work, but on an error rather than an assertion";
    const c = boardCard(
      { id: "card_l", status: "parked", labels: ["api"] },
      { statusReason: `parked: ${text}` },
    );
    const t = tileModel(c, { now: NOW });
    expect(t.status?.text).toBe(text);
    expect(t.status?.wraps).toBe(true);
    expect(t.labels).toEqual([]);
    expect(t.moreLabels).toEqual([]);
  });
});

describe("DB-P3-8: no step budget in Backlog or Ready", () => {
  it("shows no budget text, bar or badge on a plain Backlog or Ready card", () => {
    for (const status of ["backlog", "ready"] as const) {
      const t = tileModel(boardCard({ status, stepsUsed: 4 }), { now: NOW });
      expect(t.status, status).toBeUndefined();
      expect(t.budget, status).toBeUndefined();
      expect(JSON.stringify(t)).not.toMatch(/step/i);
    }
    // A Ready card sent back keeps its words; they are not a budget.
    const back = tileModel(boardCard({ status: "ready" }, { statusReason: "returned: fix" }), {
      now: NOW,
    });
    expect(back.status?.text).toBe("Sent back with your note");
  });
});

describe("DB-P3-9: headers carry count, limit with its derivation, and points", () => {
  const review = (id: string, estimate?: number, hold?: CardRecord["hold"]) =>
    boardCard(
      { id, status: "review", ...(estimate ? { estimate } : {}), ...(hold ? { hold } : {}) },
      { enteredColumnAt: at(1) },
    );

  it("derives the limit in words from measured reviews, whatever its size", () => {
    expect(
      reviewLimitText(
        { limit: 3, minutesPerDay: 60, minutesPerCard: 20, reviews: 4, fixed: false },
        { count: 1, held: 0 },
      ),
    ).toBe("Limit 3, from 60 review minutes a day at ~20 min per issue (the median of 4 reviews).");
    expect(
      reviewLimitText(
        { limit: 25, minutesPerDay: 375, minutesPerCard: 15, reviews: 0, fixed: false },
        { count: 25, held: 1 },
      ),
    ).toBe(
      "Limit 25, from 375 review minutes a day at ~15 min per issue (the starting estimate until you review an issue). Full. The agent holds finished issues until you clear one. An accepted issue waiting on its pull request does not count.",
    );
    expect(reviewLimitText({ limit: 2, fixed: true }, { count: 3, held: 0 })).toBe(
      "Limit 2, set by [review] wip in the project configuration. Over the limit.",
    );
  });

  it("shows In review as count / limit, a held card not counted, and every column's points", () => {
    const cards = [
      review("r1", 3),
      review("r2", 5),
      review("r3", undefined, { kind: "awaitingMerge", pr: 9, since: at(1) }),
      // An accept new commits dismissed waits for a decision: it counts (TEAM-24).
      review("r4", undefined, { kind: "awaitingMerge", pr: 10, since: at(1), dismissed: true }),
      one("backlog", "b1", { estimate: 1 }),
      one("done", "d1"),
    ];
    const m = boardModel({
      cards,
      now: NOW,
      wipLimits: { review: 2, backlog: 500 },
      reviewLimit: { limit: 2, minutesPerDay: 60, minutesPerCard: 30, reviews: 3, fixed: false },
      estimation: "points",
    });
    const byId = Object.fromEntries(m.columns.map((c) => [c.id, c]));
    expect(byId.in_review?.limit).toEqual({
      count: 3,
      limit: 2,
      state: "over",
      text: "3 / 2",
      derivation:
        "Limit 2, from 60 review minutes a day at ~30 min per issue (the median of 3 reviews). Over the limit. An accepted issue waiting on its pull request does not count.",
    });
    expect(byId.in_review?.pointsText).toBe("8 pts");
    expect(byId.backlog?.pointsText).toBe("1 pt");
    expect(byId.done?.pointsText).toBe("0 pts");
    // The professional board shows only the limit a person sets from review time.
    expect(byId.backlog?.limit).toBeUndefined();
  });

  it("shows each stored state's limit in pipeline stages, never hiding a large one", () => {
    const m = boardModel({
      cards: [one("backlog", "b"), one("ready", "r"), one("review", "v"), one("done", "d")],
      now: NOW,
      pipeline: true,
      wipLimits: { backlog: 500, ready: 50, review: 3, done: 10000 },
      reviewLimit: { limit: 3, fixed: true },
    });
    const limits = Object.fromEntries(m.columns.map((c) => [c.id, c.limit?.text]));
    expect(limits).toEqual({
      backlog: "1 / 500",
      ready: "1 / 50",
      review: "1 / 3",
      done: undefined,
    });
  });
});

describe("DB-P3-10: empty columns are chips; Done is a column whenever it has cards", () => {
  it("chips every empty column with its purpose, in column order", () => {
    const m = boardModel({ cards: [one("done", "d1")], now: NOW });
    expect(m.columns.map((c) => c.id)).toEqual(["done"]);
    expect(m.chips.map((c) => [c.label, c.count, c.empty])).toEqual([
      ["Backlog", 0, "Ideas and split-off work."],
      ["To do", 0, "Issues whose dependencies are done, and issues being planned."],
      ["In progress", 0, "No agent running."],
      ["In review", 0, "Nothing waiting for you."],
    ]);
  });

  it("opens a chip into a column on request, and folds a column into a chip", () => {
    const cards = [one("done", "d1"), one("ready", "a")];
    const m = boardModel({
      cards,
      now: NOW,
      expanded: new Set(["in_review"]),
      collapsed: new Set(["done"]),
    });
    expect(m.columns.map((c) => c.id)).toEqual(["todo", "in_review"]);
    expect(m.chips.map((c) => [c.id, c.count])).toEqual([
      ["backlog", 0],
      ["in_progress", 0],
      ["done", 1],
    ]);
  });

  it("keeps a column whose cards the filter hides, saying none match", () => {
    const m = boardModel({ cards: [one("ready", "a")], visible: new Set(), now: NOW });
    expect(m.columns.map((c) => [c.id, c.count, c.cards.length])).toEqual([["todo", 1, 0]]);
  });
});

describe("DB-P3-11: In review and On hold order by wait, longest first", () => {
  it("sorts the queue columns by wait and the rest by priority, stably", () => {
    const wait = (id: string, status: CardStatus, hours: number, priority?: number) =>
      boardCard({ id, status, ...(priority ? { priority } : {}) }, { enteredColumnAt: at(hours) });
    const m = boardModel({
      cards: [
        wait("r1", "review", 1),
        wait("r2", "review", 5),
        wait("r3", "review", 3),
        wait("p1", "parked", 2),
        wait("p2", "parked", 9),
        wait("t1", "ready", 9, 4),
        wait("t2", "ready", 1, 1),
        wait("t3", "ready", 5),
      ],
      now: NOW,
    });
    const ids = Object.fromEntries(m.columns.map((c) => [c.id, c.cards.map((x) => x.id)]));
    expect(ids.in_review).toEqual(["r2", "r3", "r1"]);
    expect(ids.on_hold).toEqual(["p2", "p1"]);
    expect(ids.todo).toEqual(["t2", "t1", "t3"]);
    // A person's choice from the column menu wins.
    const byWait = boardModel({
      cards: [wait("t1", "ready", 9, 4), wait("t2", "ready", 1, 1)],
      now: NOW,
      sort: { todo: "wait" },
    });
    expect(byWait.columns[0]?.cards.map((x) => x.id)).toEqual(["t1", "t2"]);
  });
});

describe("DB-P3-15: focus on a stream frame", () => {
  it("keeps focus on the card and scrolls only when its column changed", () => {
    const before = new Map([
      ["a", "todo"],
      ["b", "in_progress"],
    ]);
    const moved = new Map([
      ["a", "in_progress"],
      ["b", "in_progress"],
    ]);
    expect(focusAfterFrame("a", before, moved)).toEqual({ id: "a", scroll: true });
    expect(focusAfterFrame("b", before, moved)).toEqual({ id: "b", scroll: false });
    expect(focusAfterFrame(null, before, moved)).toBeNull();
    // A card that left the board (rejected, filtered away) takes no focus.
    expect(focusAfterFrame("a", before, new Map([["b", "done"]]))).toBeNull();
  });
});

describe("DB-P3-16: the board is a function of the board payload", () => {
  it("builds the same columns and tiles from the same payload, however it arrived", () => {
    const payload = {
      cards: [
        one("ready", "a"),
        boardCard({ id: "v", status: "verify", stepsUsed: 8 }, { evidence: typesFailed }),
        one("review", "r", { estimate: 2 }),
        one("parked", "p"),
      ],
      wipLimits: { review: 3 },
      reviewLimit: { limit: 3, minutesPerDay: 60, minutesPerCard: 20, reviews: 2, fixed: false },
    };
    const view = (p: typeof payload) => {
      const m = boardModel({ ...p, now: NOW });
      return {
        columns: m.columns.map((c) => ({
          id: c.id,
          header: [c.label, c.count, c.pointsText, c.limit?.text ?? ""],
          tiles: c.cards.map((x) => tileModel(x, { now: NOW })),
        })),
        chips: m.chips.map((c) => c.id),
      };
    };
    // A page that stayed open applied this payload from a stream frame; a
    // reloaded page from GET /api/board. Both carry the same JSON.
    const fromFrame = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(view(fromFrame)).toEqual(view(payload));
    expect(view(payload).columns.map((c) => c.id)).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "on_hold",
    ]);
  });
});
