import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// The test-and-refine loop's wave 10 B (sweep 5, review-git): a Won't do
// reason the dialog promises "is kept on the issue" was on the ledger only
// (B1); the issue's Activity said *Rejected*, the stored state, where the
// board, the breadcrumb and the menu say *Won't do* (B2); and the Review
// desk's first-run welcome on a phone was three sentences and a model
// paragraph above the question, pushing the queue toward the fold (B4,
// dashboard §2.2.5: a bar under a one-line welcome). A real server over a
// real ledger, in Chromium; no model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("Won't do on the issue and the Review desk's first run (wave 10 B)", () => {
  let seed: SeededBoard;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    seed = await seedBoard("sek-w10b-");
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

  it(
    "B1, B2: a Won't do reason is shown on the issue, and its Activity says Won't do, never Rejected",
    { timeout: 60_000 },
    async () => {
      const reason = "Duplicate of the weekly total card";
      const page = await open("#/card/card_rv2");
      await page.locator(".cv-h [data-issue-more]").click();
      await page.locator('.ia-menu [data-ia="wontdo"]').click();
      const form = page.locator(".ia-pop");
      await form.waitFor();
      await form.locator("input").fill(reason);
      await form.locator("input").press("Enter");
      await page.locator(".toast", { hasText: "Marked Won't do" }).waitFor();
      await expect
        .poll(async () => (await seed.store.getCard("card_rv2"))?.status)
        .toBe("rejected");
      // The ledger holds it (the CLI and the dashboard alike).
      const moved = await seed.store.cardEvents("card_rv2", ["card/status_changed"]);
      expect((moved.at(-1)?.payload as { reason?: string }).reason).toBe(`rejected: ${reason}`);
      // A fresh read of the issue page, as the next person meets it.
      await page.reload();
      await page.locator("#view .view-host").first().waitFor({ state: "attached" });
      await page
        .getByRole("tab", { name: /Activity/ })
        .first()
        .click();
      await page.locator(".th-row").first().waitFor({ timeout: 10_000 });
      const rows = await page.locator(".th-row").allInnerTexts();
      const row = rows.find((r) => /moved from In review to/.test(r)) ?? rows.join("\n");
      expect(row).toContain("moved from In review to Won't do");
      expect(row).toContain(reason);
      expect(await page.locator("#view").innerText()).not.toMatch(/\bRejected\b/);
      await page.context().close();
    },
  );

  it(
    "B4: on a phone the Review desk's first run is a bar under a one-line welcome, and the queue is in the first screen",
    { timeout: 60_000 },
    async () => {
      // A fresh browser: the first-run question not answered yet.
      const ctx = await browser.newContext({ viewport: { width: 400, height: 667 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/#/review`);
      const bar = page.locator("#sk-firstrun");
      await bar.waitFor({ timeout: 10_000 });
      await page.locator('[aria-label="Ready for review"] [role=option]').first().waitFor();
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
        const welcome = document.querySelector(".fr-welcome") as HTMLElement;
        const lh = Number.parseFloat(getComputedStyle(welcome).lineHeight) || 20;
        return {
          bar: box("#sk-firstrun")?.height ?? 0,
          welcome: welcome.getBoundingClientRect().height,
          lh,
          queue: box('[aria-label="Ready for review"] [role=option]')?.bottom ?? 9999,
        };
      });
      // Every answer is still there and reachable.
      expect(await page.locator("#sk-firstrun [data-fr]").count()).toBe(5);
      expect(m.welcome, "the welcome is one line").toBeLessThanOrEqual(m.lh * 1.5);
      expect(
        m.queue,
        "the first issue Ready for review is in the first screen",
      ).toBeLessThanOrEqual(667);
      // The model step is the No Coding model bar's, above, with its link.
      expect(await page.locator('#sk-noworker a[href="#/configuration/models"]').isVisible()).toBe(
        true,
      );
      // The words a phone hides are still read by a screen reader.
      expect(await bar.locator(".fr-welcome").textContent()).toContain("plans your project");
      await ctx.close();
    },
  );
});
