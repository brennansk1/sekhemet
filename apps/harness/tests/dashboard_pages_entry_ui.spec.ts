import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordQueueStarted } from "../src/execute.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// The dashboard's other pages through their door (C2d, FINDINGS_C1 TST-01,
// TST-02): the story map, Status at the widths that matter, Configuration ›
// Project's Definition of done, Integrations, Runs while a queue runs, and
// Machine's sparklines — a real server over a real ledger, in Chromium. No
// model is loaded; the memory figures come from the server's own probe seam.

type Server = { port: number; close: () => Promise<void> };

const BRIEF = {
  baseline: "Timesheets live in a shared spreadsheet",
  slices: [
    {
      title: "Walking skeleton",
      appetite: { cards: 12 },
      requirements: [
        {
          key: "enter",
          title: "Enter a day's hours",
          criteria: [{ id: "enter.1", text: "A day's hours are saved" }],
        },
        {
          key: "total",
          title: "Total a week",
          dependsOn: ["enter"],
          criteria: [{ id: "total.1", text: "The week's total is shown" }],
        },
      ],
    },
    {
      title: "Overtime",
      appetite: { cards: 12 },
      requirements: [
        {
          key: "flag",
          title: "Flag hours past 40",
          dependsOn: ["total"],
          criteria: [{ id: "flag.1", text: "Hours past 40 are flagged" }],
        },
      ],
    },
  ],
};

describe("the story map, Status, Configuration, Integrations, Runs and Machine in Chromium (C2d)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;
  /** The memory probe's next reading, in percent; it climbs by one each sample. */
  let pct = 50;
  const samples: number[] = [];

  beforeAll(async () => {
    seed = await seedBoard("sek-pages-entry-");
    // Three epics, created in one order and placed in another (the backbone's user order).
    const epic = (id: string, title: string, orderKey: string) =>
      seed.store.createCard({
        id,
        tier: "epic",
        title,
        status: "backlog",
        projectId: seed.project,
        orderKey,
      });
    await epic("ep_report", "Report the totals", "a3");
    await epic("ep_enter", "Enter the hours", "a1");
    await epic("ep_flag", "Flag the overtime", "a2");
    // gates.toml: two blocking checks and one advisory (the Definition of done reads it).
    writeFileSync(
      join(seed.dir, ".sekhemet", "gates.toml"),
      [
        "[[gate]]",
        'id = "unit"',
        'rung = "test"',
        'command = "node"',
        'args = ["-e", "process.exit(0)"]',
        "",
        "[[gate]]",
        'id = "lint"',
        'rung = "lint"',
        'command = "node"',
        'args = ["-e", "process.exit(0)"]',
        "",
        "[[gate]]",
        'id = "semgrep"',
        'rung = "security"',
        'command = "node"',
        'args = ["-e", "process.exit(0)"]',
        "blocking = false",
        "",
      ].join("\n"),
    );
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      // The defaults: a tick a second, Machine's memory every fifth tick (5 s).
      memoryProbe: () => {
        const p = pct++;
        samples.push(Date.now());
        return { usedBytes: p * 1e8, totalBytes: 100 * 1e8, swapUsedBytes: 0 };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    const accepted = await fetch(`${base}/api/brief/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ projectId: seed.project, ...BRIEF }),
    });
    expect(accepted.status).toBe(200);
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function open(hash: string, width = 1440, height = 900): Promise<Page> {
    const { page } = await openContext(browser, width, { project: seed.project, height });
    await page.goto(`${base}/${hash}`);
    return page;
  }

  it(
    "DB-P3-13: #/board/map lays the epics out in backbone order, with the first release marked",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/board/map");
      const head = page.locator(".smap thead .smap-epic");
      await head.first().waitFor();
      const epics = (await head.allInnerTexts())
        .map((t) => t.trim())
        .filter((t) => t !== "No epic");
      expect(epics).toEqual(["Enter the hours", "Flag the overtime", "Report the totals"]);
      const bands = await page.$$eval(".smap tbody.smap-band", (bs) =>
        bs.map((b) => ({
          heading: b.querySelector(".smap-band-t")?.textContent ?? "",
          first: b.classList.contains("skeleton"),
          mark: b.querySelector(".skel")?.textContent ?? "",
        })),
      );
      expect(bands.slice(0, 2)).toEqual([
        { heading: "Release 1 · Walking skeleton", first: true, mark: "First release" },
        { heading: "Release 2 · Overtime", first: false, mark: "" },
      ]);
      // Only the first is marked.
      expect(bands.filter((b) => b.first).length).toBe(1);
      await page.context().close();
    },
  );

  it(
    "DB-N18-1: at 1280 px Status is the mockup's grid, in §2.8's reading order",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/status", 1280);
      await page.locator(".stp-a-working").waitFor();
      const box = async (sel: string) => {
        const b = await page.locator(sel).boundingBox();
        if (!b) throw new Error(`${sel} has no box`);
        return b;
      };
      const numbers = await box(".stp-a-numbers");
      const burn = await box(".stp-a-burnup");
      const needs = await box(".stp-a-needs");
      // The key-number strip first, above everything.
      expect(numbers.y + numbers.height).toBeLessThanOrEqual(Math.min(burn.y, needs.y) + 1);
      // The burn-up (two thirds) beside Needs you (one third), on one row.
      expect(needs.x).toBeGreaterThanOrEqual(burn.x + burn.width - 1);
      expect(Math.abs(needs.y - burn.y)).toBeLessThan(4);
      expect(burn.width / (burn.width + needs.width)).toBeGreaterThan(0.6);
      expect(burn.width / (burn.width + needs.width)).toBeLessThan(0.72);
      // Solo: Waiting on others is the Team setup's (status.ts STATUS_SECTIONS); Needs you holds the third.
      expect(await page.locator(".stp-a-waiting").count()).toBe(0);
      // Requirements, Risks and Who's working: a three-column band, above Flow.
      const [req, risks, working, flow] = await Promise.all(
        [".stp-a-requirements", ".stp-a-risks", ".stp-a-working", ".stp-a-flow"].map(box),
      );
      expect(Math.round(risks?.y ?? 0)).toBe(Math.round(req?.y ?? 0));
      expect(Math.round(working?.y ?? 0)).toBe(Math.round(req?.y ?? 0));
      expect((req?.x ?? 0) < (risks?.x ?? 0) && (risks?.x ?? 0) < (working?.x ?? 0)).toBe(true);
      expect(flow?.y ?? 0).toBeGreaterThan((req?.y ?? 0) + (req?.height ?? 0) - 1);
      // The reading order is the DOM's, §2.8's.
      const order = await page.$$eval(".stp > section", (s) =>
        s.map((x) => (x.className.match(/stp-a-(\w+)/) ?? [])[1]),
      );
      const at = (id: string) => order.indexOf(id);
      expect(at("numbers")).toBe(0);
      expect(at("burnup")).toBeLessThan(at("needs"));
      expect(at("needs")).toBeLessThan(at("requirements"));
      expect(at("risks")).toBeLessThan(at("working"));
      expect(at("working")).toBeLessThan(at("flow"));
      await page.context().close();
    },
  );

  it("DB-N18-2: narrower than 768 px Status keeps one column", { timeout: 60_000 }, async () => {
    const page = await open("#/status", 767);
    await page.locator(".stp-a-working").waitFor();
    const boxes = await page.$$eval(".stp > section", (s) =>
      s
        .filter((x) => (x as HTMLElement).offsetParent !== null)
        .map((x) => {
          const r = x.getBoundingClientRect();
          return { left: Math.round(r.left), top: r.top, bottom: r.bottom };
        }),
    );
    expect(boxes.length).toBeGreaterThan(5);
    expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i]?.top ?? 0).toBeGreaterThanOrEqual((boxes[i - 1]?.bottom ?? 0) - 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.context().close();
  });

  it(
    "DB-N14-1: Configuration › Project shows a read-only Definition of done from gates.toml, the depth profile and the Accept rule",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/configuration/project");
      const dod = page.locator(".cfg-dod");
      await dod.waitFor();
      expect(await dod.locator("#cfg-h-dod").innerText()).toMatch(/^Definition of done/);
      expect(await dod.locator(".dod-sentence").innerText()).toBe(
        "An issue is done when its checks pass — Tests, Lint — its tests meet the strength rule, and you accept it.",
      );
      const rows = Object.fromEntries(
        await dod
          .locator("dt")
          .evaluateAll((dts) =>
            dts.map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
          ),
      );
      expect(rows["Checks that must pass"]).toBe(
        "Tests, Lint. Advisory, reported but not blocking: Semgrep.",
      );
      expect(rows["Test strength"]).toContain("(the project's Type: internal tool)");
      expect(rows["Who accepts"]).toBe("You.");
      // Read-only: nothing in it can be changed.
      expect(await dod.locator("input, select, textarea, button:not(.tip-q)").count()).toBe(0);
      await page.context().close();
    },
  );

  it(
    "DB-N2-7: Integrations shows only what /api/integrations returns, grouped Now, Next, Later; Next and Later have no button",
    { timeout: 60_000 },
    async () => {
      const entries = (await (await fetch(`${base}/api/integrations`)).json()) as {
        id: string;
        tier: string;
      }[];
      const count = (t: string) => entries.filter((e) => e.tier === t).length;
      expect(count("now")).toBeGreaterThan(0);
      expect(count("next")).toBeGreaterThan(0);
      expect(count("later")).toBeGreaterThan(0);
      const read = async (page: Page) => {
        await page.locator(".ints section h2").first().waitFor();
        return page.$$eval(".ints > section", (ss) =>
          ss.map((s) => ({
            heading: (s.querySelector("h2")?.firstChild?.textContent ?? "").trim(),
            items: s.querySelectorAll(".icard, .ilater li").length,
            buttons: s.querySelectorAll("button").length,
            text: s.textContent ?? "",
          })),
        );
      };
      const page = await open("#/integrations");
      const shown = await read(page);
      expect(shown.map((s) => [s.heading, s.items])).toEqual([
        ["Now", count("now")],
        ["Next", count("next")],
        ["Later", count("later")],
      ]);
      expect(shown[1]?.buttons).toBe(0);
      expect(shown[2]?.buttons).toBe(0);
      await page.context().close();
      // A server that omits an integration and moves another to Later: the page follows it.
      const { ctx, page: p } = await openContext(browser, 1440, { project: seed.project });
      await ctx.route("**/api/integrations", async (route) => {
        const r = await route.fetch();
        const body = (await r.json()) as { id: string; tier: string }[];
        await route.fulfill({
          response: r,
          json: body
            .filter((e) => e.id !== "slack")
            .map((e) => (e.id === "jira" ? { ...e, tier: "later" } : e)),
        });
      });
      await p.goto(`${base}/#/integrations`);
      const after = await read(p);
      const all = after.map((s) => s.text).join(" ");
      expect(all).not.toMatch(/Slack for Seshat|Slack notifications/);
      expect(after.find((s) => s.heading === "Later")?.text).toMatch(/Jira/);
      expect(after.find((s) => s.heading === "Now")?.text).not.toMatch(/Jira import/);
      await ctx.close();
    },
  );

  it(
    "DB-N2-11: a run in progress reads Running · n of m issues · elapsed on Runs, updated from the stream",
    { timeout: 60_000 },
    async () => {
      const cards = ["card_bk1", "card_td1", "card_ip1", "card_rv1"];
      const startedAt = new Date(Date.now() - 4 * 60_000 - 5000).toISOString();
      // A queue running in this very process: alive, and not yet reported.
      await recordQueueStarted(seed.log, { startedAt, cards, model: "stand-in", pid: process.pid });
      const finish = (cardId: string) =>
        seed.log.append({
          actor: "harness",
          type: "attempt/finished",
          cardId,
          payload: { cardId },
        });
      await finish("card_bk1");
      const page = await open("#/runs");
      const row = page.locator(".rn.running").first();
      await row.waitFor();
      expect(await row.locator(".a .tnum").innerText()).toBe("Running · 1 of 4 issues · 4m");
      // Another issue finishes and moves; the row follows the stream, no reload.
      await finish("card_td1");
      await seed.store.updateCardStatus("card_td1", "review", "setup", "harness", {
        override: true,
      });
      await expect
        .poll(() => row.locator(".a .tnum").innerText(), { timeout: 10_000 })
        .toBe("Running · 2 of 4 issues · 4m");
      await page.context().close();
    },
  );

  it(
    "DB-12: Machine draws the memory, decode-speed and prefix-cache sparklines, memory sampled every 5 s",
    { timeout: 60_000 },
    async () => {
      // Two steps' telemetry, as the runner records them.
      for (const [turn, decode, hit] of [
        [1, 21.5, 0.62],
        [2, 23.0, 0.98],
      ] as const)
        await seed.store.recordEvent({
          type: "card/step",
          cardId: "card_ip1",
          actor: "executor",
          payload: {
            id: "card_ip1",
            turn,
            calls: [],
            usage: {
              promptTokens: 1000,
              completionTokens: 50,
              durationMs: 2000,
              decodeTokensPerSecond: decode,
              cacheHitRate: hit,
            },
          },
        });
      const page = await open("#/machine");
      const row = (key: string) => page.locator(`canvas.sp[data-series="${key}"]`);
      await row("memory").waitFor();
      // Decode speed and the prefix-cache hit rate, from the steps.
      await expect.poll(() => row("decode").getAttribute("aria-label")).toMatch(/23\.0 tok\/s/);
      expect(await row("cacheHit").getAttribute("aria-label")).toMatch(/98%/);
      // Memory: the samples the stream carries, one every five seconds.
      const label = () => row("memory").getAttribute("aria-label");
      const seen: number[] = [];
      let last = await label();
      const until = Date.now() + 16_000;
      while (Date.now() < until && seen.length < 3) {
        await page.waitForTimeout(200);
        const now = await label();
        if (now !== last) {
          seen.push(Date.now());
          last = now;
        }
      }
      expect(seen.length).toBe(3);
      for (let i = 1; i < seen.length; i++) {
        const gap = (seen[i] ?? 0) - (seen[i - 1] ?? 0);
        expect(gap).toBeGreaterThan(4000);
        expect(gap).toBeLessThan(6000);
      }
      // Each sparkline is drawn: its canvas holds pixels.
      for (const key of ["memory", "decode", "cacheHit"]) {
        const inked = await row(key).evaluate((c) => {
          const cv = c as HTMLCanvasElement;
          const d = cv.getContext("2d")?.getImageData(0, 0, cv.width, cv.height).data ?? [];
          for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) return true;
          return false;
        });
        expect(inked, key).toBe(true);
      }
      await page.context().close();
    },
  );
});

describe("the 500-issue board in Chromium (DB-9, its memory half)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-500-entry-");
    // The policy board (§A): 500 issues across the columns a working team has.
    const spread: [string, number][] = [
      ["backlog", 170],
      ["ready", 110],
      ["in_progress", 20],
      ["review", 50],
      ["done", 140],
    ];
    let n = 0;
    for (const [status, count] of spread)
      for (let i = 0; i < count; i++) {
        const id = `card_${String(n++).padStart(4, "0")}`;
        const start = status === "backlog" ? "backlog" : "ready";
        await seed.store.createCard({
          id,
          tier: "task",
          title: `Policy issue ${n}: pay rule for case ${i}`,
          status: start,
          projectId: seed.project,
        });
        if (status !== start)
          await seed.store.updateCardStatus(id, status as never, "setup", "harness", {
            override: true,
          });
      }
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  // The main-thread half of DB-9 (no task over 50 ms while scrolling) is timed
  // on the machine, so it runs in the release gate (perf/budgets_ui.spec.ts,
  // SEKHEMET_PERF=1); this half is the memory budget, which does not depend on load.
  it(
    "DB-9: with 500 issues loaded the board scrolls under 50 MB of page memory, its columns windowed",
    { timeout: 120_000 },
    async () => {
      const { page } = await openContext(browser, 1440, { project: seed.project });
      await page.goto(`${base}/#/board`);
      await page.locator(".tile").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      const loaded = await page.evaluate(
        `import("/app/store.js").then(({ store }) => store.state.cards.length)`,
      );
      expect(Number(loaded)).toBeGreaterThanOrEqual(500);
      const scrolled: number[] = [];
      for (const col of await page.locator(".board .col[data-col]").all()) {
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
      // The scroll happened: a column of 170 issues moved.
      expect(Math.max(0, ...scrolled)).toBeGreaterThan(0);
      // The page draws a window of tiles, never all 500.
      expect(await page.locator(".tile").count()).toBeLessThan(500);
      const heap = (await page.evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize,
      )) as number | undefined;
      expect(heap).toBeGreaterThan(0);
      expect(heap as number).toBeLessThan(50 * 1024 ** 2);
      await page.context().close();
    },
  );
});
