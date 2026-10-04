import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { seedEgress } from "./egress_fixture.js";

/**
 * Configuration › Project › *Network activity* in a real Chromium against a
 * real server and ledger (dashboard §2.16 item 5, NEW-dashboard-24;
 * security item 33a; FINDINGS INS-08), at 1440 and 400 px: the last card of
 * Project configuration lists what left the machine newest first, its
 * filters narrow it, and it records nothing and offers no action.
 */
describe("Network activity in Project configuration (DB-N24-1..3)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-net-ui-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-net-ui-cfg-"));
    await seedEgress(dir);
    const opened = openLocalLedger(dir);
    db = opened.db;
    const cardStore = new CardStore(db, opened.log);
    server = await startDashboardServer({
      db,
      log: opened.log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 500,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/#/configuration/project`);
    await page.locator("[data-net-list] li").first().waitFor();
    return page;
  }

  const lastSeq = () => (db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;

  for (const width of [1440, 400]) {
    it(`DB-N24-1: the last card of Project configuration, newest first, each with its cause (${width} px)`, async () => {
      const page = await open(width);
      const before = lastSeq();
      // The last card of the Project section.
      const last = await page.evaluate(() => {
        const sec = document.querySelector(".cfg-body section.cfg-sec");
        return sec?.lastElementChild?.getAttribute("aria-labelledby") ?? null;
      });
      expect(last).toBe("cfg-h-net");
      expect(await page.locator("#cfg-h-net").innerText()).toBe("Network activity");
      const rows = page.locator("[data-net-list] li");
      expect(await rows.count()).toBe(3);
      const text = await rows.allInnerTexts();
      expect(text[0]).toMatch(/huggingface\.co/);
      expect(text[0]).toMatch(/Allowed/);
      expect(text[0]).toMatch(/Model download/);
      expect(text[0]).toMatch(/5 GB/);
      expect(text[1]).toMatch(/paste\.example\.net/);
      expect(text[1]).toMatch(/Refused/);
      expect(text[1]).toMatch(/not on the allowlist/);
      expect(text[2]).toMatch(/api\.github\.com/);
      expect(text[2]).toMatch(/GitHub integration/);
      // The issue that caused it, as its key and title, linked.
      const link = rows.nth(1).locator("a[href='#/card/c1']");
      expect(await link.innerText()).toBe("c1 Fetch exchange rates");
      // Read-only: no button in the card, and rendering it recorded nothing.
      expect(await page.locator("section[aria-labelledby='cfg-h-net'] button").count()).toBe(0);
      expect(lastSeq()).toBe(before);
      // No sideways scroll at a phone's width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.locator("section[aria-labelledby='cfg-h-net']").screenshot({
        path: join(process.env.SEKHEMET_SHOTS ?? dir, `network-activity-${width}.png`),
      });
      await page.context().close();
    }, 60_000);
  }

  it("DB-N24-2: Refused only and Since narrow the list; none left says so", async () => {
    const page = await open(1440);
    const rows = page.locator("[data-net-list] li");
    await page.locator("[data-net-refused]").check();
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().innerText()).toMatch(/paste\.example\.net/);
    await page.locator("[data-net-refused]").uncheck();
    await expect.poll(() => rows.count()).toBe(3);
    await page.locator("[data-net-since]").fill("2999-01-01");
    await page.locator("[data-net-since]").dispatchEvent("change");
    await page.locator("[data-net-empty]", { hasText: "Nothing has left this machine." }).waitFor();
    expect(await rows.count()).toBe(0);
    await page.context().close();
  }, 60_000);
});
