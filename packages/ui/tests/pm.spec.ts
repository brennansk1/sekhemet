import { describe, expect, it } from "vitest";
import { ICONS } from "../src/icons.js";
import {
  type CycleLike,
  type LearnedRuleLike,
  type PmCardLike,
  type ProfileEntryLike,
  activeCycle,
  agingClass,
  applyAllLabel,
  capabilityRows,
  cycleProgress,
  cycleTimeStats,
  extractMentions,
  formatClock,
  formatHours,
  formatPoints,
  formatQuery,
  formatShortDate,
  groupCards,
  groupRules,
  horizonSentence,
  matchCard,
  movingAverage,
  parseQuery,
  percentile,
  pmSteps,
  priorityIcon,
  priorityOf,
  profileByCategory,
  proposalDiff,
  renderPmMarkdown,
  retireSuggested,
  rosterRows,
  scopeChips,
  setTerm,
  sortByPriority,
  sourceCites,
  stackCfd,
  strengthLabel,
  tuningSummary,
  valueBar,
} from "../src/pm.js";

const cycles: CycleLike[] = [
  { id: "cy12", name: "Cycle 12", startsOn: "2026-09-15", endsOn: "2026-09-28", state: "active" },
  { id: "cy13", name: "Cycle 13", startsOn: "2026-09-29", endsOn: "2026-10-10", state: "planned" },
];
const epics = [
  { id: "ep_ledger", title: "Ledger core" },
  { id: "ep_api", title: "HTTP API" },
];
const cards: PmCardLike[] = [
  {
    id: "card_hasher",
    status: "verify",
    priority: 3,
    estimate: 3,
    labels: ["api", "later"],
    epicId: "ep_ledger",
    cycleId: "cy12",
    assignee: "worker",
    display: { title: "Implement canonical JSON", kinds: ["rules"], mark: "pips" },
  },
  {
    id: "card_http",
    status: "ready",
    priority: 1,
    estimate: 8,
    labels: ["api"],
    epicId: "ep_api",
    cycleId: "cy12",
    assignee: "human",
    display: { title: "HTTP micro-API", kinds: ["flow"], needsYou: true },
  },
  {
    id: "card_docs",
    status: "done",
    display: { title: "Write the docs", kinds: [], mark: "done" },
    cycleId: "cy12",
  },
  {
    id: "card_tamper",
    status: "backlog",
    priority: 2,
    display: { title: "Tamper detection", kinds: ["rules"], mark: "blocked" },
  },
];

describe("priority and points (contract §2)", () => {
  it("accepts only the 0..4 scale and maps each to Linear's glyph", () => {
    expect(priorityOf(2)).toBe(2);
    expect(priorityOf(37.5)).toBe(0);
    expect(priorityOf(undefined)).toBe(0);
    expect(priorityOf("1")).toBe(0);
    expect(priorityIcon(1)).toBe("priority-urgent");
    expect(priorityIcon(0)).toBe("priority-none");
    for (const p of [0, 1, 2, 3, 4])
      expect(ICONS[priorityIcon(p) as keyof typeof ICONS]).toBeTruthy();
  });

  it("sorts urgent first and none last, stable within a priority", () => {
    const order = sortByPriority([
      { id: "a", priority: 0 },
      { id: "b", priority: 3 },
      { id: "c", priority: 1 },
      { id: "d", priority: 3 },
      { id: "e" },
      { id: "f", priority: 4 },
    ]).map((c) => c.id);
    expect(order).toEqual(["c", "b", "d", "f", "a", "e"]);
  });

  it("writes points and dates as words", () => {
    expect(formatPoints(1)).toBe("1 pt");
    expect(formatPoints(5)).toBe("5 pts");
    expect(formatPoints(undefined)).toBe("None");
    expect(formatShortDate("2026-09-29")).toBe("Sep 29");
    expect(formatShortDate("2026-01-03T23:59:00Z")).toBe("Jan 3");
  });
});

describe("proposal field diffs", () => {
  const ctx = {
    cycles,
    epics,
    cards,
    statusLabel: (s: string) => ({ ready: "Ready", backlog: "Backlog" })[s] ?? s,
  };

  it("formats each field as people read it, with before from the proposal", () => {
    const rows = proposalDiff(
      {
        id: "p1",
        kind: "update_card",
        summary: "Raise hasher",
        cardId: "card_hasher",
        patch: {
          priority: 1,
          estimate: 5,
          cycleId: "cy13",
          epicId: "ep_api",
          assignee: "human",
          dueDate: "2026-10-02",
        },
        before: {
          priority: 3,
          estimate: 3,
          cycleId: "cy12",
          epicId: "ep_ledger",
          assignee: "worker",
        },
        state: "open",
      },
      ctx,
    );
    expect(rows.map((r) => [r.label, r.before, r.after])).toEqual([
      ["Priority", "Medium", "Urgent"],
      ["Points", "3 pts", "5 pts"],
      ["Sprint", "Cycle 12", "Cycle 13"],
      ["Epic", "Ledger core", "HTTP API"],
      ["Assignee", "Agent", "You"],
      ["Due", "None", "Oct 2"],
    ]);
  });

  it("falls back to the card's current value and drops unchanged fields", () => {
    const rows = proposalDiff(
      {
        id: "p2",
        kind: "update_card",
        summary: "",
        cardId: "card_hasher",
        patch: { priority: 3, estimate: 2 },
        state: "open",
      },
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field: "estimate", before: "3 pts", after: "2 pts" });
  });

  it("diffs labels as a set", () => {
    const [row] = proposalDiff(
      {
        id: "p3",
        kind: "update_card",
        summary: "",
        cardId: "card_hasher",
        patch: { labels: ["api", "security"] },
        state: "open",
      },
      ctx,
    );
    expect(row).toMatchObject({ type: "labels", added: ["security"], removed: ["later"] });
  });

  it("uses the status vocabulary and says None for empty values", () => {
    const rows = proposalDiff(
      {
        id: "p4",
        kind: "move_card",
        summary: "",
        cardId: "card_http",
        patch: { status: "backlog", labels: [] },
        before: { status: "ready", labels: [] },
        state: "open",
      },
      ctx,
    );
    expect(rows.map((r) => `${r.before}->${r.after}`)).toEqual(["Ready->Backlog"]);
    expect(
      proposalDiff({
        id: "p5",
        kind: "update_card",
        summary: "",
        patch: { priority: 0 },
        before: { priority: 2 },
        state: "open",
      })[0]?.after,
    ).toBe("No priority");
  });

  it("states what Apply all does", () => {
    expect(
      applyAllLabel([
        { id: "a", kind: "update_card", summary: "", cardId: "x", state: "open" },
        {
          id: "b",
          kind: "split_card",
          summary: "",
          cardId: "y",
          cards: [{}, {}, {}],
          state: "open",
        },
        { id: "c", kind: "update_card", summary: "", cardId: "z", state: "applied" },
      ]),
    ).toBe("Apply 2 changes to 5 cards");
    expect(
      applyAllLabel([{ id: "a", kind: "create_card", summary: "", cards: [{}], state: "open" }]),
    ).toBe("Apply 1 change to 1 card");
  });
});

describe("PM markdown", () => {
  const chip = (id: string) =>
    id === "card_a_b" ? `<a class="chip" data-card="${id}">A</a>` : null;

  it("escapes model text before formatting", () => {
    const html = renderPmMarkdown('<img src=x onerror="alert(1)"> **bold** `<b>`');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>&lt;b&gt;</code>");
  });

  it("renders lists, headings, paragraphs and fenced code", () => {
    const html = renderPmMarkdown(
      "### Done\n- one\n- two\n\n1. first\n2. second\n\nline a\nline b\n```\nx < y\n```",
    );
    expect(html).toBe(
      "<h4>Done</h4><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol><p>line a<br>line b</p><pre><code>x &lt; y</code></pre>",
    );
  });

  it("turns known @card ids into chips and leaves unknown ones as text", () => {
    const html = renderPmMarkdown("See @card_a_b and @card_zz, *not* _this_.", { chip });
    expect(html).toContain('<a class="chip" data-card="card_a_b">A</a>');
    expect(html).toContain("@card_zz");
    expect(html).toContain("<em>not</em>");
    expect(html).toContain("<em>this</em>");
    // The chip's underscores are never read as emphasis.
    expect(html).not.toContain("<em>a</em>");
  });

  it("does not render links as links", () => {
    expect(renderPmMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
  });

  it("extracts mentions in order without duplicates or emails", () => {
    expect(extractMentions("@hasher then @http, again @hasher; mail a@b.com")).toEqual([
      "hasher",
      "http",
    ]);
  });
});

describe("filter language", () => {
  it("parses fields, aliases, negation, quotes and free text, and round-trips", () => {
    const f = parseQuery(
      'priority:urgent,high -label:later epic:"Ledger core" sprint:current canonical json',
    );
    expect(f.terms).toEqual([
      { field: "priority", values: ["urgent", "high"] },
      { field: "label", values: ["later"], negate: true },
      { field: "epic", values: ["ledger core"] },
      { field: "cycle", values: ["current"] },
    ]);
    expect(f.text).toBe("canonical json");
    // DEC-31: the query reads `sprint:`; `cycle:` is still understood.
    expect(formatQuery(f)).toBe(
      'priority:urgent,high -label:later epic:"ledger core" sprint:current canonical json',
    );
    expect(parseQuery("cycle:current").terms).toEqual([{ field: "cycle", values: ["current"] }]);
    expect(parseQuery(formatQuery(f))).toEqual(f);
  });

  it("ANDs terms and ORs values", () => {
    const ctx = { cycles, epics };
    const ids = (q: string) =>
      cards.filter((c) => matchCard(c, parseQuery(q), ctx)).map((c) => c.id);
    expect(ids("priority:urgent,medium")).toEqual(["card_hasher", "card_http"]);
    expect(ids("label:api -label:later")).toEqual(["card_http"]);
    expect(ids("epic:ledger")).toEqual(["card_hasher"]);
    expect(ids("epic:none")).toEqual(["card_docs", "card_tamper"]);
    expect(ids("cycle:current is:open")).toEqual(["card_hasher", "card_http"]);
    expect(ids("cycle:none")).toEqual(["card_tamper"]);
    expect(ids("assignee:me")).toEqual(["card_http"]);
    expect(ids("is:unestimated")).toEqual(["card_docs", "card_tamper"]);
    expect(ids("is:blocked")).toEqual(["card_tamper"]);
    expect(ids("is:needs-you")).toEqual(["card_http"]);
    // DEC-31: the issue type; `kind:` is the older spelling of `type:`.
    expect(ids("type:story canonical")).toEqual(["card_hasher"]);
    expect(ids("kind:story canonical")).toEqual(["card_hasher"]);
    expect(ids("type:bug")).toEqual([]);
    expect(ids("priority:none")).toEqual(["card_docs"]);
  });

  it("edits one field's term for the chips", () => {
    const f = setTerm(parseQuery("priority:low foo"), "priority", ["Urgent"]);
    expect(formatQuery(f)).toBe("priority:urgent foo");
    expect(formatQuery(setTerm(f, "priority", []))).toBe("foo");
  });
});

describe("grouping", () => {
  it("orders epic lanes as the board lists epics, with No epic last", () => {
    const g = groupCards(cards, "epic", { epics });
    expect(g.map((x) => [x.label, x.cards.length, x.points])).toEqual([
      ["Ledger core", 1, 3],
      ["HTTP API", 1, 8],
      ["No epic", 2, 0],
    ]);
  });

  it("orders priority lanes urgent first and assignee lanes Agent, You, then none", () => {
    expect(groupCards(cards, "priority").map((g) => g.label)).toEqual([
      "Urgent",
      "High",
      "Medium",
      "No priority",
    ]);
    expect(groupCards(cards, "assignee").map((g) => g.label)).toEqual([
      "Agent",
      "You",
      "No assignee",
    ]);
    expect(groupCards(cards, "cycle", { cycles }).map((g) => g.label)).toEqual([
      "Cycle 12",
      "No sprint",
    ]);
  });
});

describe("active cycle", () => {
  it("prefers the cycle marked active, else a non-closed cycle whose dates contain today", () => {
    expect(activeCycle(cycles)?.id).toBe("cy12");
    const planned = cycles.map((c) => ({
      ...c,
      state: c.state === "active" ? ("planned" as const) : c.state,
    }));
    expect(activeCycle(planned, Date.UTC(2026, 8, 20))?.id).toBe("cy12");
    expect(activeCycle(planned, Date.UTC(2026, 9, 1))?.id).toBe("cy13");
    expect(activeCycle(planned, Date.UTC(2026, 11, 1))).toBeUndefined();
    const closed = cycles.map((c) => ({ ...c, state: "closed" as const }));
    expect(activeCycle(closed, Date.UTC(2026, 8, 20))).toBeUndefined();
  });
});

describe("cycle progress", () => {
  it("splits points into done, started and not started, counting unestimated as 1", () => {
    const now = Date.UTC(2026, 8, 25, 12); // Sep 25 noon: day 11 of 14
    // With story points on (DB-N7-2); off, each issue counts 1 (professional_language.spec).
    const p = cycleProgress(cycles[0] as CycleLike, cards, now, "points");
    expect(p.totalDays).toBe(14);
    expect(p.daysLeft).toBe(4);
    expect(p.points).toEqual({ done: 1, started: 3, notStarted: 8, total: 12 });
    expect(p.unestimated).toBe(1);
    expect(p.cards).toEqual({ done: 1, total: 3 });
    expect(p.behindBy).toBe(Math.round(12 * p.elapsedRatio - 1));
    expect(p.atRisk).toBe(false);
    expect(
      cycleProgress(cycles[0] as CycleLike, cards, Date.UTC(2026, 8, 28, 12), "points").atRisk,
    ).toBe(true);
  });
});

describe("flow metrics", () => {
  it("interpolates percentiles and ignores non-finite values", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 1, Number.NaN, 5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4], 85)).toBeCloseTo(3.55);
    expect(percentile([], 50)).toBeNaN();
    const s = cycleTimeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((hours) => ({ hours })));
    expect(s).toMatchObject({ n: 10, p50: 5.5 });
    expect(s.p85).toBeCloseTo(8.65);
    expect(agingClass(9, s)).toBe("old");
    expect(agingClass(6, s)).toBe("watch");
    expect(agingClass(2, s)).toBe("ok");
  });

  it("averages a trailing window and stacks the CFD bottom-up", () => {
    expect(movingAverage([2, 4, 6, 8], 2)).toEqual([2, 3, 5, 7]);
    const { bands, max } = stackCfd([
      { backlog: 3, ready: 2, in_progress: 1, verify: 0, review: 1, done: 4 },
      { backlog: 2, done: 6 },
    ]);
    expect(bands.backlog[0]).toEqual([0, 3]);
    expect(bands.ready[0]).toEqual([3, 5]);
    expect(bands.done[0]).toEqual([7, 11]);
    expect(bands.done[1]).toEqual([2, 8]);
    expect(max).toBe(11);
  });

  it("formats hours and clocks", () => {
    expect(formatHours(0.5)).toBe("30m");
    expect(formatHours(6.24)).toBe("6.2h");
    expect(formatHours(22)).toBe("22h");
    expect(formatHours(74)).toBe("3.1d");
    expect(formatClock(64_900)).toBe("1:04");
  });
});

describe("waiting steps (PmStatus.phase)", () => {
  it("shows the agent rows when the agent is paused, with step and ETA from detail", () => {
    const rows = pmSteps({
      phase: "loading_pm",
      workerPaused: true,
      detail: "Pausing the Worker after step 5 · ~40s to load the PM",
    });
    expect(rows.map((r) => `${r.state}:${r.label}`)).toEqual([
      "done:Paused the agent after step 5",
      "current:Loading the PM · about 40s",
      "todo:Thinking",
      "todo:Resuming the agent",
    ]);
  });

  it("omits the agent rows when nothing was running, and prefers structured fields", () => {
    const rows = pmSteps({ phase: "thinking", etaSeconds: 35 });
    expect(rows.map((r) => `${r.state}:${r.label}`)).toEqual([
      "done:Loaded the PM",
      "current:Thinking",
    ]);
    expect(pmSteps({ phase: "waiting_for_step", step: 7 })[0]?.label).toBe(
      "Pausing the agent after step 7",
    );
  });
});

describe("worker capability", () => {
  it("orders by evidence, writes the interval, and flags small samples", () => {
    const rows = capabilityRows([
      { type: "ui", label: "UI", attempts: 4, passes: 3, rate: 0.75, low: 0.3, high: 0.954 },
      {
        type: "rules",
        label: "Rules",
        attempts: 20,
        passes: 14,
        rate: 0.7,
        low: 0.481,
        high: 0.855,
      },
      { type: "none", label: "None", attempts: 0, passes: 0, rate: 0, low: 0, high: 0 },
    ]);
    expect(rows.map((r) => r.type)).toEqual(["rules", "ui"]);
    expect(rows[0]).toMatchObject({ trusted: true, text: "14 of 20 passed · 70% (48–86%)" });
    expect(rows[1]?.trusted).toBe(false);
    expect(horizonSentence(118.6)).toBe(
      "The agent passes 80% of issues that change up to about 119 lines.",
    );
    expect(horizonSentence(undefined)).toMatch(/^Not enough attempts/);
  });
});

describe("learning (contract §6)", () => {
  const rule = (o: Partial<LearnedRuleLike>): LearnedRuleLike => ({
    id: "r",
    role: "worker",
    text: "t",
    scope: {},
    status: "active",
    helpful: 0,
    harmful: 0,
    value: 0,
    source: "seed",
    evidence: [],
    createdAt: "2026-09-18T00:00:00Z",
    ...o,
  });

  it("groups rules, puts retirement proposals first, and reads scope as chips", () => {
    const g = groupRules([
      rule({ id: "a", value: 2 }),
      rule({ id: "b", value: 5 }),
      rule({ id: "c", value: 9, helpful: 1, harmful: 4 }),
      rule({ id: "d", status: "candidate", createdAt: "2026-09-17T00:00:00Z" }),
      rule({ id: "e", status: "candidate", createdAt: "2026-09-18T00:00:00Z" }),
      rule({ id: "f", status: "retired" }),
    ]);
    expect(g.active.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(g.candidate.map((r) => r.id)).toEqual(["e", "d"]);
    expect(g.retired.map((r) => r.id)).toEqual(["f"]);
    expect(retireSuggested(rule({ helpful: 1, harmful: 3 }))).toBe(false);
    expect(scopeChips({ kind: "rules", pathPattern: "src/**" }, (k) => k.toUpperCase())).toEqual([
      { label: "Kind", value: "RULES" },
      { label: "Files", value: "src/**" },
    ]);
    expect(scopeChips({})).toEqual([{ label: "Applies to", value: "every card" }]);
    expect(valueBar(-2, 4)).toEqual({ ratio: 0.5, negative: true });
    expect(valueBar(9, 4).ratio).toBe(1);
  });

  it("groups the profile by category, strongest first, without dismissed entries", () => {
    const e = (
      id: string,
      category: ProfileEntryLike["category"],
      strength: number,
      status: ProfileEntryLike["status"] = "active",
    ): ProfileEntryLike => ({
      id,
      statement: id,
      category,
      strength,
      evidence: [],
      status,
      source: "edits",
    });
    const g = profileByCategory([
      e("a", "planning", 0.3),
      e("b", "code_style", 0.9),
      e("c", "planning", 0.8),
      e("d", "planning", 1, "dismissed"),
    ]);
    expect(g.map((x) => [x.label, x.entries.map((y) => y.id)])).toEqual([
      ["Code style", ["b"]],
      ["Planning", ["c", "a"]],
    ]);
    expect([strengthLabel(0.75), strengthLabel(0.5), strengthLabel(0.1)]).toEqual([
      "Strong",
      "Moderate",
      "Weak",
    ]);
  });

  it("summarises a tuning report without overstating it", () => {
    const s = tuningSummary({
      current: {
        policy: { stepBudget: 32, maxFailedChecks: 99 },
        firstTry: 12,
        eventually: 18,
        cards: 24,
        minutes: 50.4,
      },
      best: {
        policy: { stepBudget: 12, maxFailedChecks: 4 },
        firstTry: 12,
        eventually: 18,
        cards: 24,
        minutes: 31,
      },
    });
    expect(s.headline).toBe(
      "A 12-step cap would have cut 50.4 to 31 minutes (38% less) and kept 18 of 18 passes.",
    );
    expect(s.command).toBe("sekhemet queue --max-turns 12");
    expect(s.savedMinutes).toBe(19.4);
    expect(s.savedText).toBe("19.4 minutes");
    expect(
      tuningSummary({
        current: {
          policy: { stepBudget: 40, maxFailedChecks: 4 },
          firstTry: 1,
          eventually: 2,
          cards: 3,
          minutes: 0.38,
        },
        best: {
          policy: { stepBudget: 12, maxFailedChecks: 2 },
          firstTry: 1,
          eventually: 2,
          cards: 3,
          minutes: 0.32,
        },
      }).savedText,
    ).toBe("4 seconds");
    expect(s.checksNote).toMatch(/4 failed checks \(now no limit\)/);
    const same = tuningSummary({
      current: {
        policy: { stepBudget: 20, maxFailedChecks: 3 },
        firstTry: 1,
        eventually: 2,
        cards: 2,
        minutes: 5,
      },
      best: {
        policy: { stepBudget: 20, maxFailedChecks: 3 },
        firstTry: 1,
        eventually: 2,
        cards: 2,
        minutes: 5,
      },
    });
    expect(same.same).toBe(true);
    expect(same.headline).toMatch(/already the fastest/);
  });
});

describe("model roster and research sources", () => {
  it("lists the four roles in order, filling unconfigured ones", () => {
    const rows = rosterRows([
      { role: "researcher", model: "apodex-1.1-mini", state: "swapped" },
      { role: "worker", model: "nail-35b", state: "resident", note: "Loaded 3m ago" },
      { role: "adversarial", state: "unconfigured" },
    ]);
    expect(rows.map((r) => [r.role, r.state, r.model ?? ""])).toEqual([
      ["worker", "resident", "nail-35b"],
      ["manager", "unconfigured", ""],
      ["reviewer", "unconfigured", ""],
      ["researcher", "swapped", "apodex-1.1-mini"],
    ]);
    expect(rows[0]?.note).toBe("Loaded 3m ago");
    expect(rows[2]?.does).toMatch(/different model family/);
  });

  it("keeps only http(s) sources as links and skips card cites", () => {
    expect(
      sourceCites([
        { url: "https://www.arxiv.org/abs/2609.14858", label: "Dream-RSI" },
        { url: "javascript:alert(1)", label: "bad" },
        { label: "Project ledger, run 14 Sep" },
        { cardId: "card_x" },
      ]),
    ).toEqual([
      { label: "Dream-RSI", href: "https://www.arxiv.org/abs/2609.14858", host: "arxiv.org" },
      { label: "bad" },
      { label: "Project ledger, run 14 Sep" },
    ]);
  });
});
