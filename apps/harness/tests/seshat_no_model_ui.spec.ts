import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";

// K3 item 12 in a real Chromium against a real Solo server with no model
// configured and model loads off (FINDINGS PM-01, PM-02; dashboard §2.7 item
// 8): Seshat's failed reply reads *Seshat couldn't reply.* with a plain
// cause, Retry (the same text again) and a link to Configuration › Models —
// never an environment variable, a loopback address or an API path — and
// "How is it going?" is answered from the Activity log. At 1440 and 400 px.

type Server = { port: number; close: () => Promise<void> };

describe("Seshat with no model (PM-01, PM-02)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-seshat-nomodel-ui-"));
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "c1", tier: "story", title: "Export a week as CSV" });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 1000,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  async function open(width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "manage");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/#/pm`);
    await page.locator(".pm-compose textarea").waitFor();
    return page;
  }

  async function send(page: Page, text: string): Promise<void> {
    const box = page.locator(".pm-compose textarea");
    await box.fill(text);
    await box.press("Enter");
  }

  for (const width of [1440, 400]) {
    it(
      `PM-01 at ${width} px: the failed reply is a plain sentence with Retry and Configuration › Models`,
      { timeout: 60_000 },
      async () => {
        const page = await open(width);
        // The widths share one thread: wait until every earlier message has its
        // failed reply, so the one picked below is this width's, not a late one
        // from the width before (all replies fail here: no model is configured).
        await expect
          .poll(
            async () =>
              (await page.locator(".msg.user").count()) ===
              (await page.locator(".msg.pm.failed").count()),
            { timeout: 15_000 },
          )
          .toBe(true);
        const failedBefore = await page.locator(".msg.pm.failed").count();
        await send(page, `Why is the CSV export slow (${width})?`);
        await expect
          .poll(() => page.locator(".msg.pm.failed").count(), { timeout: 15_000 })
          .toBe(failedBefore + 1);
        const failed = page.locator(".msg.pm.failed").last();
        const words = await failed.innerText();
        expect(words).toContain("Seshat couldn't reply.");
        expect(words).toContain("No model is answering for Seshat on this machine right now.");
        expect(words).not.toMatch(/SEKHEMET_|https?:\/\/|127\.0\.0\.1|\/api\/|Error:/);
        const link = failed.locator('a[href="#/configuration/models"]');
        expect(await link.innerText()).toContain("Configuration › Models");
        // Retry sends the same text again: a second message, a second failed reply.
        const before = await page.locator(".msg.pm.failed").count();
        await failed.locator("[data-retry-reply]").click();
        await expect
          .poll(() => page.locator(".msg.pm.failed").count(), { timeout: 15_000 })
          .toBe(before + 1);
        // The retried message comes back over the stream, and under load it can
        // land just after the failed reply: wait for it rather than read once.
        await expect
          .poll(
            async () =>
              (await page.locator(".msg.user").allInnerTexts()).filter((t) =>
                t.includes(`(${width})`),
              ).length,
            { timeout: 15_000 },
          )
          .toBe(2);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.context().close();
      },
    );
  }

  it(
    "PM-08, PM-09 at 400 px: / lists the commands, a pick fills the composer, and the placeholder fits",
    { timeout: 60_000 },
    async () => {
      const page = await open(400);
      const box = page.locator(".pm-compose textarea");
      // PM-09: the placeholder is never wider than the composer it sits in.
      const fits = await box.evaluate((ta: HTMLTextAreaElement) => {
        const c = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
        c.font = getComputedStyle(ta).font;
        return c.measureText(ta.placeholder).width <= ta.clientWidth;
      });
      expect(fits).toBe(true);
      expect(await box.getAttribute("placeholder")).toContain("(/ for commands)");
      // PM-08: the promise is kept.
      await box.fill("");
      await box.type("/fo");
      const picker = page.locator(".pm-compose .picker");
      await expect.poll(() => picker.isVisible()).toBe(true);
      expect(await picker.locator("[role=option]").allInnerTexts()).toEqual([
        expect.stringContaining("/forecast"),
      ]);
      await box.press("Enter");
      expect(await box.inputValue()).toBe("/forecast");
      expect(await picker.isVisible()).toBe(false);
      await box.fill("");
      await box.type("/");
      expect(await picker.locator("[role=option]").count()).toBeGreaterThan(5);
      await page.context().close();
    },
  );

  it(
    "PM-04 at 400 px on a touch screen: links read as links or file names, and no key hints show",
    { timeout: 60_000 },
    async () => {
      await new PmStore(new EventLog(db)).appendReply({
        replyTo: [],
        text: "The plan is in the [brief](docs/product/brief.md); triage works as [Linear's guide](https://linear.app/docs/triage) says.",
        proposals: [
          {
            kind: "update_card",
            cardId: "c1",
            patch: { priority: 1 },
            summary: "Make Export a week as CSV urgent. Why: the payroll run is Friday.",
          },
        ],
        model: "ledger",
      });
      const ctx = await browser.newContext({
        viewport: { width: 400, height: 860 },
        hasTouch: true,
        isMobile: true,
      });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("sekhemet-role", "manage");
        } catch {}
      });
      const page = await ctx.newPage();
      await page.goto(`${base}/#/pm`);
      const msg = page.locator(".msg.pm", { hasText: "The plan is in the" }).last();
      await msg.waitFor({ timeout: 15_000 });
      const text = await msg.innerText();
      expect(text).not.toContain("](");
      expect(
        await msg.locator('a[href="https://linear.app/docs/triage"]').getAttribute("rel"),
      ).toBe("noopener noreferrer nofollow");
      expect(await msg.locator("code").first().innerText()).toBe("docs/product/brief.md");
      // The proposal's Apply carries no ⇧Y or y on a touch screen.
      await msg.locator(".pgroup").waitFor();
      const shownKbd = await page.evaluate(
        () =>
          [...document.querySelectorAll(".pm-thread kbd, .pgroup kbd")].filter(
            (k) => (k as HTMLElement).offsetParent !== null,
          ).length,
      );
      expect(shownKbd).toBe(0);
      await ctx.close();
    },
  );

  it(
    "PM-06 at 1440 px: one change shows one Apply, and applying it says which issue changed and where it is",
    { timeout: 60_000 },
    async () => {
      await new PmStore(new EventLog(db)).appendReply({
        replyTo: [],
        text: "One change for the export.",
        proposals: [
          {
            kind: "update_card",
            cardId: "c1",
            patch: { priority: 2 },
            summary: "Raise the export to High. Why: two people asked for it this week.",
          },
        ],
        model: "ledger",
      });
      const page = await open(1440);
      const group = page.locator(".pgroup", { hasText: "Raise the export to High" });
      await group.waitFor({ timeout: 15_000 });
      expect(await group.locator("[data-apply-all]").count()).toBe(0);
      expect(await group.locator("[data-apply]").count()).toBe(1);
      await group.locator("[data-apply]").click();
      const toast = page.locator(".toast", { hasText: "Changed “Export a week as CSV”." });
      await toast.waitFor();
      expect(await toast.innerText()).toMatch(/It is in (Backlog|To do)\./);
      const applied = group.locator(".prop.applied");
      await applied.waitFor();
      expect(await applied.innerText()).toContain("Changed “Export a week as CSV”.");
      await page.context().close();
    },
  );

  it(
    "PM-02 at 400 px: 'How is it going?' is answered from the Activity log, not refused",
    { timeout: 60_000 },
    async () => {
      const page = await open(400);
      const failedBefore = await page.locator(".msg.pm.failed").count();
      await send(page, "How is it going?");
      const answer = page.locator(".msg.pm:not(.failed)", { hasText: "Activity log" }).last();
      await answer.waitFor({ timeout: 15_000 });
      expect(await answer.innerText()).toMatch(/standup from the Activity log/);
      expect(await page.locator(".msg.pm.failed").count()).toBe(failedBefore);
      await page.context().close();
    },
  );
});
