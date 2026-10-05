import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../../src/ledger_evidence.js";
import { startDashboardServer } from "../../src/server.js";
import {
  BUDGETS,
  MEASURE_SCRIPT,
  type PageMeasure,
  p75WithUnreported,
  perfRuns,
  summarise,
} from "./perf_harness.js";

// W9 (FINISH_LINE_PLAN §A, Responsiveness): the dashboard's budgets on the
// policy board of 500 issues, measured in a real Chromium at 1440 px against
// the real server over a real SQLite ledger, with the browser's own
// PerformanceObserver: LCP ≤ 2.5 s, CLS ≤ 0.1, and an INP-like p75 of the
// interactions made on each page ≤ 200 ms, on the board, the issue page and
// Review (dashboard §A rows, DB-A-1 to DB-A-3). Timing is the machine's, so
// these run in `pnpm release-gate` (`SEKHEMET_PERF=1`), not in `pnpm gate`.
// No model is loaded.

const perf = process.env.SEKHEMET_PERF === "1";

const GATES = ["unit", "secrets", "lint", "format", "types", "size", "deps", "coverage"];
const DIFF = [
  "diff --git a/src/overtime.ts b/src/overtime.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/overtime.ts",
  "@@ -0,0 +1,3 @@",
  "+export function overtime(hours: number): number {",
  "+  return Math.max(0, hours - 40);",
  "+}",
  "",
].join("\n");

/** The policy board (§A): 500 issues across the columns a working team has. */
const SPREAD: [string, number][] = [
  ["backlog", 170],
  ["ready", 110],
  ["in_progress", 20],
  ["review", 50],
  ["done", 150],
];

describe.runIf(perf)("§A budgets on the 500-issue board, Chromium at 1440 px (W9)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;
  const REVIEW = "card_0300";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-perf-"));
    mkdirSync(join(dir, ".sekhemet", "evidence"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    let n = 0;
    for (const [status, count] of SPREAD) {
      for (let i = 0; i < count; i++, n++) {
        const id = `card_${String(n).padStart(4, "0")}`;
        const start = status === "backlog" || status === "ready" ? status : "ready";
        await store.createCard({
          id,
          tier: "story",
          title: `Timesheet rule ${n}: pay the hours past 40 at time and a half`,
          status: start,
          spec: `Week ${n}: hours past 40 are overtime.`,
          acceptanceCriteria: [`Week ${n} with 41 hours has 1 hour of overtime.`],
          scopeFiles: [`src/rule_${n}.ts`],
          labels: [n % 3 === 0 ? "overtime-rules" : "timesheet"],
          priority: (n % 4) + 1,
        });
        if (status !== start)
          await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
      }
    }
    // The issue on Review has a run's evidence and its diff, as a real one does.
    const body = JSON.stringify({
      id: `ev_${REVIEW}`,
      cardId: REVIEW,
      attempt: 1,
      createdAt: new Date().toISOString(),
      passed: true,
      failures: [],
      skipped: [],
      unavailable: [],
      stopReason: "gate_passed",
      turnsUsed: 3,
      durationMs: 1000,
      filesTouched: ["src/overtime.ts"],
      linesAdded: 3,
      linesRemoved: 0,
      diff: DIFF,
      rungResults: GATES.map((gate) => ({
        gate,
        rung: "hygiene",
        layer: "functional",
        passed: true,
        exitCode: 0,
        durationMs: 90,
      })),
    });
    writeFileSync(join(dir, ".sekhemet", "evidence", `ev_${REVIEW}.json`), body);
    writeFileSync(join(dir, ".sekhemet", "evidence", `latest-${REVIEW}.json`), body);
    await recordLedgerRun(store, {
      cardId: REVIEW,
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: `ev_${REVIEW}`,
      path: `.sekhemet/evidence/ev_${REVIEW}.json`,
      body,
      filesTouched: ["src/overtime.ts"],
    });
    expect((await store.listCards()).length).toBe(500);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** What an interaction script may do: press a key, or click the nth match of a selector. */
  interface Act {
    press(key: string): Promise<void>;
    click(selector: string, nth?: number): Promise<void>;
  }

  /** One page load, measured, then `interact` run on it; a fresh context each time. */
  async function measure(
    hash: string,
    ready: string,
    interact: (act: Act) => Promise<number>,
  ): Promise<PageMeasure> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    await ctx.addInitScript({ content: MEASURE_SCRIPT });
    const page = await ctx.newPage();
    type Perf = {
      lcp: number;
      cls: number;
      firstInput: number | null;
      events: { id: number; d: number }[];
    };
    const read = () => page.evaluate(() => ({ ...(window as never as { __perf: Perf }).__perf }));
    try {
      await page.goto(`${base}/${hash}`);
      await page.locator(ready).first().waitFor({ state: "visible", timeout: 30_000 });
      // LCP is final at the first input; let the page settle as a person would see it.
      await page.waitForTimeout(500);
      const loaded = await read();
      const settle = () => page.waitForTimeout(150);
      const made = await interact({
        press: async (key) => {
          await page.keyboard.press(key);
          await settle();
        },
        click: async (selector, nth = 0) => {
          await page.locator(selector).nth(nth).click({ timeout: 5_000 });
          await settle();
        },
      });
      await page.waitForTimeout(300);
      const after = await read();
      // Event Timing works on this page: the first input is always reported,
      // whatever its duration, so an empty list of slow events means fast.
      expect(after.firstInput, "no first-input entry: Event Timing did not run").not.toBeNull();
      if (process.env.SEKHEMET_PERF_DEBUG)
        console.log("W9 debug", hash, after.firstInput, JSON.stringify(after.events));
      return { lcpMs: loaded.lcp, cls: after.cls, interactions: made, slowEvents: after.events };
    } finally {
      await ctx.close();
    }
  }

  async function budgetsHold(name: string, runs: PageMeasure[]): Promise<void> {
    const s = summarise(runs);
    console.log(
      `W9 ${name}: LCP median ${Math.round(s.lcpMedianMs)} ms (max ${Math.round(s.lcpMaxMs)}), CLS max ${s.clsMax.toFixed(3)}, INP-like p75 ${Math.round(s.inpP75Ms)} ms over ${s.interactions} interactions (max ${Math.round(s.inpMaxMs)})`,
    );
    expect(s.interactions).toBeGreaterThan(0);
    expect(s.lcpMedianMs).toBeGreaterThan(0);
    expect(s.lcpMedianMs).toBeLessThanOrEqual(BUDGETS.lcpMs);
    expect(s.clsMax).toBeLessThanOrEqual(BUDGETS.cls);
    expect(s.inpP75Ms).toBeLessThanOrEqual(BUDGETS.inpP75Ms);
  }

  it("the board: LCP, CLS and interaction latency within the §A budgets", async () => {
    const runs = await perfRuns(() =>
      measure("#/board", ".tile", async (act) => {
        // Open two issues' peeks and close them, then move the focus.
        await act.click(".tile", 3);
        await act.press("Escape");
        await act.click(".tile", 40);
        await act.press("Escape");
        for (const k of ["j", "j", "l", "k"]) await act.press(k);
        return 8;
      }),
    );
    await budgetsHold("board", runs);
  }, 240_000);

  // DB-9: scrolling the 500-issue board keeps every main-thread task under
  // 50 ms (a long task is one over 50 ms, so none may appear), and the page's
  // memory under 50 MB. Chromium gives a page its JS heap without
  // cross-origin isolation (`performance.memory`), which holds the DOM's
  // wrappers but not every DOM byte: that heap is the figure judged here.
  it("DB-9: the 500-issue board scrolls with no long task, its JS heap under 50 MB", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    await ctx.addInitScript({ content: MEASURE_SCRIPT });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/#/board`);
      await page.locator(".tile").first().waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        (window as never as { __perf: { longTasks: number[] } }).__perf.longTasks = [];
      });
      const scrolled: number[] = [];
      for (const col of await page.locator(".col[data-col]").all()) {
        const box = await col.boundingBox();
        if (!box) continue;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 900);
          await page.waitForTimeout(60);
        }
        scrolled.push(
          await col.evaluate((el) => {
            const own = [el, ...el.querySelectorAll<HTMLElement>("*")].find((x) => x.scrollTop > 0);
            return own?.scrollTop ?? 0;
          }),
        );
      }
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        longTasks: (window as never as { __perf: { longTasks: number[] } }).__perf.longTasks,
        heap: (performance as never as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize,
      }));
      console.log(
        `W9 DB-9: scrolled ${scrolled.filter((t) => t > 0).length} of ${scrolled.length} columns, long tasks ${JSON.stringify(after.longTasks)}, JS heap ${Math.round((after.heap ?? 0) / 1024 ** 2)} MB`,
      );
      // The scroll really happened: a column of 170 issues moved.
      expect(Math.max(0, ...scrolled)).toBeGreaterThan(0);
      expect(after.longTasks).toEqual([]);
      expect(after.heap).toBeGreaterThan(0);
      expect(after.heap as number).toBeLessThan(50 * 1024 ** 2);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("the issue page: LCP, CLS and interaction latency within the §A budgets", async () => {
    const runs = await perfRuns(() =>
      measure(`#/card/${REVIEW}`, "[data-rail] .iprop", async (act) => {
        // Its tabs, by click and by key.
        await act.click('[data-tab="changes"]');
        for (const k of ["1", "3", "2", "1"]) await act.press(k);
        return 5;
      }),
    );
    await budgetsHold("issue page", runs);
  }, 240_000);

  it("Review: LCP, CLS and interaction latency within the §A budgets", async () => {
    const runs = await perfRuns(() =>
      measure(`#/review/${REVIEW}`, "#view .view-host, #view > *", async (act) => {
        await act.click("#view h1, #view h2");
        for (const k of ["Tab", "Tab", "Tab", "Tab", "Tab"]) await act.press(k);
        return 6;
      }),
    );
    await budgetsHold("Review", runs);
  }, 240_000);
});

describe("the W9 harness's arithmetic", () => {
  it("counts an interaction the browser did not report (under 16 ms) at 16 ms, never as 0", () => {
    // Event Timing reports only events of 16 ms or more: 4 interactions made,
    // two reported (one interaction's keydown and keyup share an id).
    const slow = [
      { id: 5, d: 40 },
      { id: 5, d: 24 },
      { id: 9, d: 250 },
    ];
    expect(p75WithUnreported(slow, 4)).toBe(40);
    expect(p75WithUnreported(slow, 8)).toBe(16);
    expect(p75WithUnreported([], 4)).toBe(16);
    expect(p75WithUnreported([{ id: 1, d: 300 }], 1)).toBe(300);
  });

  it("summarises runs as the median LCP, the worst CLS and the pooled p75", () => {
    const s = summarise([
      { lcpMs: 900, cls: 0.01, interactions: 2, slowEvents: [{ id: 1, d: 30 }] },
      { lcpMs: 500, cls: 0.05, interactions: 2, slowEvents: [] },
      { lcpMs: 700, cls: 0.02, interactions: 2, slowEvents: [{ id: 3, d: 220 }] },
    ]);
    expect(s.lcpMedianMs).toBe(700);
    expect(s.lcpMaxMs).toBe(900);
    expect(s.clsMax).toBe(0.05);
    expect(s.interactions).toBe(6);
    expect(s.inpP75Ms).toBe(30);
    expect(s.inpMaxMs).toBe(220);
  });
});
