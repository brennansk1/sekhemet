import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

// FINDINGS TEAM-07 and TEAM-08 in a real Chromium against a real Solo server
// (C2b): Members and Audit opened in Solo say they are Team pages and where
// to go, instead of opening another page in silence (DB-N9-12); My issues'
// empty state offers the next step — the board, the Inbox, New issue. At
// 1440 and 400 px. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("the Team pages in Solo, and My issues' next step (TEAM-07, TEAM-08)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-solo-pages-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    await store.createCard({ id: "c1", tier: "story", title: "Export a week as CSV" });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor();
    await page.waitForTimeout(500);
    return page;
  }

  for (const [hash, page, width] of [
    ["#/members", "Members", 1440],
    ["#/audit", "Audit", 400],
  ] as const) {
    it(`TEAM-07 at ${width} px: ${page} in Solo says it is a Team page and stays put`, async () => {
      const p = await open(hash, width);
      const notice = p.locator(".team-only");
      await notice.waitFor();
      expect(await p.evaluate(() => location.hash)).toBe(hash);
      const text = await notice.innerText();
      expect(text).toContain(`${page} is a Team page`);
      expect(text).toContain("This Sekhemet runs in Solo");
      expect(await notice.locator('a[href="#/status"]').innerText()).toBe("Back to Status");
      expect(await p.locator(".cfg").count()).toBe(0);
      expect(
        await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await p.context().close();
    });
  }

  it("TEAM-08 at 400 px: My issues with nothing yours offers the board, the Inbox and New issue", async () => {
    const p = await open("#/my-issues", 400);
    const empty = p.locator(".ib-empty");
    await empty.waitFor();
    expect(await empty.locator('a[href="#/board"]').innerText()).toBe("Open the board");
    expect(await empty.locator('a[href="#/inbox"]').innerText()).toBe("Open your Inbox");
    await empty.locator("[data-mi-create]").click();
    await p.locator("form.qc").waitFor();
    await p.context().close();
  });
});
