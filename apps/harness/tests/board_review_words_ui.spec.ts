import { BoardServiceImpl } from "@sekhemet/board";
import { BOARD_COLUMNS } from "@sekhemet/ui";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import {
  type SeededBoard,
  acceptableCard,
  openContext,
  seedBoard,
} from "./support/dashboard_seed.js";

// The test-and-refine loop's wave 8 B (sweep 4): the board header counted a
// Won't do card no column shows (B2); Review said *3 ready*, the stored
// state's word, for issues waiting in Review (B4); the review card's Run said
// *Steps  of 40* with the used count blank (B5); the Board and Review headers
// named the repository's folder where Status and the sidebar name the project
// (B6); and the check rows were 32 px tall at 400 px, under the phone's 44 px
// target (B7, dashboard §2.14.5). A real server over a real ledger; no model.

type Server = { port: number; close: () => Promise<void> };

describe("the board's count, Review's words and the review card (wave 8 B)", () => {
  let seed: SeededBoard;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    seed = await seedBoard("sek-w8b-");
    await acceptableCard(seed, "card_ac9", "Round a week's total");
    // Wave 8 review: once the planner has run a project has an epic; the
    // header's *issues* must not count it (sweep 4 #19, #20).
    await seed.store.createCard({
      id: "card_ep1",
      tier: "epic",
      title: "Overtime rules",
      status: "ready",
      projectId: seed.project,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function open(hash: string, width = 1440): Promise<Page> {
    const { page } = await openContext(browser, width, { project: seed.project });
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    return page;
  }

  const crumb = (page: Page) => page.locator("#top .crumb").first().innerText();

  it("B2: the board header counts the issues its columns show, as the ledger has them", async () => {
    const shown = new Set(BOARD_COLUMNS.flatMap((c) => c.states as string[]));
    const status = new Map((await seed.store.listCards()).map((c) => [c.id, c.status]));
    // Re-derived from the ledger: each card/created event's project and tier.
    const created = (
      seed.db.prepare("SELECT card_id, payload FROM events WHERE type = 'card/created'").all() as {
        card_id: string;
        payload: string;
      }[]
    ).map((r) => ({
      id: r.card_id,
      ...(JSON.parse(r.payload) as { tier?: string; projectId?: string }),
    }));
    const onBoard = created.filter(
      (c) => c.projectId === seed.project && shown.has(String(status.get(c.id))),
    );
    const issues = onBoard.filter((c) => !c.tier || c.tier === "story" || c.tier === "task");
    expect(onBoard.length - issues.length).toBe(1); // the epic
    const page = await open("#/board");
    await page.locator("#tile-card_bk1").waitFor();
    const tiles = await page.locator("#view li[data-id]").count();
    expect(tiles).toBe(onBoard.length);
    expect(await crumb(page)).toMatch(new RegExp(`· ${issues.length} issues$`));
    await page.context().close();
  }, 60_000);

  // Sweep 4 #21 (plan item B3), wave 8 review: this server has no Coding
  // model, so the bar says issues cannot run; the board's tile said
  // *Agent · queued* and the issue page *when a slot is free*.
  it("B3: with no Coding model, a Ready issue waits for one: no *queued* on its tile or its page", async () => {
    const page = await open("#/board");
    await page.locator("#sk-noworker").waitFor();
    const tile = page.locator("#tile-card_td1");
    await tile.waitFor();
    await page.waitForTimeout(500);
    expect(await tile.innerText()).not.toMatch(/queued/i);
    expect(await page.locator("#side").innerText()).toContain("No Coding model set up");
    await page.goto(`${base}/#/card/card_td1`);
    const sentence = page.locator(".agent-bar .ag-sentence").first();
    await sentence.waitFor();
    await expect
      .poll(() => sentence.innerText())
      .toBe(
        "Waiting for a Coding model: the Agent starts this issue once one is set up and verified on this machine.",
      );
    expect(await page.locator(".agent-bar").innerText()).not.toMatch(/queued|slot is free/i);
    await page.goto(`${base}/#/status`);
    await expect
      .poll(() => page.locator("#view").innerText(), { timeout: 10_000 })
      .toContain("No Coding model set up · issues wait until one fits this machine");
    expect(await page.locator("#view").innerText()).not.toMatch(/in queue, about/);
    await page.context().close();
  }, 60_000);

  for (const hash of ["#/board", "#/review", "#/review/card_ac9"]) {
    it(`B6: ${hash}'s header names the project, never the repository's folder`, async () => {
      const page = await open(hash);
      await page.waitForFunction(() =>
        /Timesheets/.test(document.querySelector("#top .crumb")?.textContent ?? ""),
      );
      const text = await crumb(page);
      expect(text).toMatch(/^Timesheets · /);
      expect(text).not.toContain("sek-w8b-");
      expect(await page.title()).not.toContain("sek-w8b-");
      await page.context().close();
    }, 60_000);
  }

  it("B4: Review's header says how many wait for review, never *ready* (a stored state's word)", async () => {
    const page = await open("#/review");
    await page.locator(".queue").first().waitFor();
    const text = await crumb(page);
    expect(text).toMatch(/· 3 to review · 1 needs you$/);
    expect(text).not.toMatch(/\bready\b/i);
    await page.context().close();
  }, 60_000);

  it("B5: the review card's Run names the steps used, as the Budget of a card with no run does", async () => {
    const card = await seed.store.getCard("card_ac9");
    const page = await open("#/review/card_ac9");
    const dd = page
      .locator("section:has(> h3.sh:text-is('Run')) > dl.kv > dt:text-is('Steps') + dd")
      .locator("visible=true");
    await dd.first().waitFor();
    const steps = await dd.first().innerText();
    expect(steps).toBe(`${card?.stepsUsed ?? 0} of ${card?.stepBudget}`);
    await page.context().close();
  }, 60_000);

  it("B7: at 400 px every check row is a 44 px phone target", async () => {
    const page = await open("#/review/card_ac9", 400);
    const segs = page.locator(".g-seg");
    await segs.first().waitFor();
    const heights = await segs.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await page.context().close();
  }, 60_000);
});
