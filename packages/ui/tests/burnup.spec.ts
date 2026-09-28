import { describe, expect, it } from "vitest";
import { type BurnupSeries, burnupChart, burnupTarget, cycleHeaderShown } from "../src/burnup.js";
import { type CycleLike, parseQuery } from "../src/pm.js";

/**
 * dashboard DB-P3-14 (§2.4.13, §2.4.17): a burn-up draws done points and total
 * scope as two separate lines, so scope growth shows apart from progress; the
 * cycle header hides when the filter is `cycle:none`. Exact outputs; the page
 * (`web/burnup.js`, `web/viewbar.js`) renders these.
 */
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const cycles: CycleLike[] = [
  { id: "cyc_2", name: "Cycle 2", startsOn: "2026-09-07", endsOn: "2026-09-20", state: "closed" },
  { id: "cyc_3", name: "Cycle 3", startsOn: "2026-09-21", endsOn: "2026-09-27", state: "active" },
];

const series: BurnupSeries = {
  scope: "cycle",
  cycleId: "cyc_3",
  name: "Cycle 3",
  startsOn: "2026-09-21",
  endsOn: "2026-09-27",
  days: [
    { date: "2026-09-21", done: 0, scope: 8 },
    { date: "2026-09-22", done: 2, scope: 8 },
    { date: "2026-09-23", done: 3, scope: 11 },
    { date: "2026-09-24", done: 6, scope: 11 },
    { date: "2026-09-25", done: 8, scope: 13 },
  ],
  unestimated: 0,
};

describe("the burn-up (DB-P3-14)", () => {
  it("draws scope and done as two separate lines across the cycle's whole span", () => {
    const c = burnupChart(series, 560);
    if ("empty" in c) throw new Error("expected a chart");
    expect(c.title).toBe("Burn-up · Cycle 3");
    expect(c.yMax).toBe(15);
    expect(c.scopePath).toBe("M44 105.3L120.7 105.3L197.3 65.3L274 65.3L350.7 38.7");
    expect(c.donePath).toBe("M44 212L120.7 185.3L197.3 172L274 132L350.7 105.3");
    expect(c.scopePath).not.toBe(c.donePath);
    expect(c.ticks).toEqual([
      { value: 0, y: 212 },
      { value: 5, y: 145.3 },
      { value: 10, y: 78.7 },
      { value: 15, y: 12 },
    ]);
    expect(c.labels).toEqual({
      scope: { text: "Scope 13 pts", x: 356.7, y: 42.2 },
      done: { text: "Done 8 pts", x: 356.7, y: 108.8 },
    });
    expect([c.firstDate, c.lastDate]).toEqual(["Sep 21", "Sep 27"]);
  });

  it("says in words how far it got and how much the scope grew", () => {
    const c = burnupChart(series, 560);
    if ("empty" in c) throw new Error("expected a chart");
    expect(c.caption).toBe("8 of 13 pts done by Sep 25. Scope grew by 5 pts since Sep 21.");
    expect(c.rows).toEqual([
      ["Sep 21", "0", "8"],
      ["Sep 22", "2", "8"],
      ["Sep 23", "3", "11"],
      ["Sep 24", "6", "11"],
      ["Sep 25", "8", "13"],
    ]);
  });

  it("keeps the two labels apart when done reaches the scope, and counts unestimated cards", () => {
    const c = burnupChart(
      {
        scope: "project",
        days: [
          { date: "2026-09-24", done: 1, scope: 3 },
          { date: "2026-09-25", done: 3, scope: 3 },
        ],
        unestimated: 2,
      },
      560,
    );
    if ("empty" in c) throw new Error("expected a chart");
    expect(c.title).toBe("Burn-up · the project");
    expect(c.labels.done.y - c.labels.scope.y).toBe(12);
    expect(c.caption).toBe(
      "3 of 3 pts done by Sep 25. Scope has not changed since Sep 24. 2 issues unestimated, counted as 1 pt each.",
    );
  });

  it("DB-N9-1, DB-N9-3: Status's burn-up adds the forecast range as a band and the target as a line", () => {
    const c = burnupChart(series, 560, {
      band: { from: "2026-09-29", to: "2026-10-02" },
      target: "2026-09-30",
    });
    if ("empty" in c) throw new Error("expected a chart");
    // The span reaches the band's far edge (Sep 21 to Oct 2: 12 days).
    expect(c.scopePath).toBe("M44 105.3L85.8 105.3L127.6 65.3L169.5 65.3L211.3 38.7");
    expect(c.band).toEqual({ x1: 378.5, x2: 504, label: "50% Sep 29 to 85% Oct 2" });
    expect(c.target).toEqual({ x: 420.4, label: "Target Sep 30" });
    expect(c.lastDate).toBe("Oct 2");
    expect(c.caption).toBe(
      "8 of 13 pts done by Sep 25. Scope grew by 5 pts since Sep 21. Forecast: 50% by Sep 29, 85% by Oct 2. Target Sep 30.",
    );
    // Without extras the chart is the board's, unchanged.
    const plain = burnupChart(series, 560);
    if ("empty" in plain) throw new Error("expected a chart");
    expect(plain.band).toBeUndefined();
    expect(plain.target).toBeUndefined();
  });

  it("says when the cycle has not started, instead of drawing nothing", () => {
    expect(
      burnupChart({ ...series, startsOn: "2026-10-01", endsOn: "2026-10-14", days: [] }, 560),
    ).toEqual({ title: "Burn-up · Cycle 3", empty: "Cycle 3 starts on Oct 1." });
    expect(burnupChart({ scope: "project", days: [], unestimated: 0 }, 560)).toEqual({
      title: "Burn-up · the project",
      empty: "No issues yet.",
    });
  });
});

describe("the cycle header and the burn-up's scope follow the filter (DB-P3-14)", () => {
  const f = (q: string) => parseQuery(q);

  it("shows the cycle header while a cycle is in force, and hides it for cycle:none", () => {
    expect(cycleHeaderShown(cycles, f(""), NOW)).toBe(true);
    expect(cycleHeaderShown(cycles, f("cycle:current"), NOW)).toBe(true);
    expect(cycleHeaderShown(cycles, f("cycle:cycle-3 label:api"), NOW)).toBe(true);
    expect(cycleHeaderShown(cycles, f("cycle:none"), NOW)).toBe(false);
    expect(cycleHeaderShown(cycles, f("cycle:cyc_2"), NOW)).toBe(false);
    expect(cycleHeaderShown([cycles[0] as CycleLike], f(""), NOW)).toBe(false);
  });

  it("burns up the cycle in force, and the whole project under cycle:none", () => {
    // In story points when the team estimates; in issues otherwise (DB-N7-2).
    expect(burnupTarget(cycles, f(""), NOW, undefined, "points")).toEqual({
      kind: "cycle",
      id: "cyc_3",
      url: "/api/metrics/burnup?cycle=cyc_3",
    });
    expect(burnupTarget(cycles, f(""), NOW).url).toBe(
      "/api/metrics/burnup?cycle=cyc_3&unit=issues",
    );
    expect(burnupTarget(cycles, f("cycle:none"), NOW, undefined, "points")).toEqual({
      kind: "project",
      url: "/api/metrics/burnup?scope=project",
    });
  });

  it("burns up only the project the board is scoped to, when it is scoped to one", () => {
    expect(burnupTarget(cycles, f("cycle:none"), NOW, "proj_a b", "points")).toEqual({
      kind: "project",
      url: "/api/metrics/burnup?scope=project&project=proj_a%20b",
    });
    expect(burnupTarget(cycles, f("cycle:none"), NOW, null, "points").url).toBe(
      "/api/metrics/burnup?scope=project",
    );
    expect(burnupTarget(cycles, f("cycle:none"), NOW, "proj_a b").url).toBe(
      "/api/metrics/burnup?scope=project&project=proj_a%20b&unit=issues",
    );
  });
});
