import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

// DB-N16-4 (C4; FINDINGS REL-08, unhappy UH-4) in a real Chromium: two people
// edit one issue's priority from the same version. Ben's request is held in
// flight until Ana's edit is in, as a slow network would; his edit then
// reaches the server with a stale If-Match, is refused with 409, applies
// nothing, and his page shows the value Ana set and says his was not applied.
// A real server over real SQLite; no model is loaded.

describe("two people editing one issue in a browser (DB-N16-4)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-edit-conflict-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    await store.createCard({
      id: "card_x",
      tier: "story",
      title: "Overtime flag",
      priority: 3,
      status: "ready",
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 200,
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function board(): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/#/board`);
    await page.locator("#tile-card_x").waitFor();
    await page.waitForTimeout(300);
    return page;
  }

  const priority = () =>
    (db.prepare("SELECT priority FROM cards WHERE id = 'card_x'").get() as { priority: number })
      .priority;
  const updates = () =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE card_id = 'card_x' AND type = 'card/updated'",
        )
        .get() as { n: number }
    ).n;

  it(
    "the second edit from the same version is refused, and the page shows the current value",
    { timeout: 90_000 },
    async () => {
      const ana = await board();
      const ben = await board();
      // Ben's edit leaves his page at once and reaches the server only after Ana's.
      let release: () => void = () => {};
      const anaDone = new Promise<void>((r) => {
        release = r;
      });
      const sent: Record<string, string | undefined>[] = [];
      await ben.route("**/api/cards/card_x", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        sent.push(route.request().headers());
        await anaDone;
        return route.continue();
      });
      await ben.locator("#tile-card_x").focus();
      await ben.keyboard.press("Shift+P");
      await ben.locator(".picker-menu [role=option]", { hasText: "Low" }).click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]?.["if-match"]).toMatch(/^"[0-9a-f]{16}"$/);

      await ana.locator("#tile-card_x").focus();
      await ana.keyboard.press("Shift+P");
      await ana.locator(".picker-menu [role=option]", { hasText: "High" }).click();
      await ana.locator(".toast", { hasText: "Set priority to High" }).waitFor();
      await expect.poll(priority).toBe(2);
      release();

      const conflict = ben.locator(".toast", { hasText: "Couldn't set priority" });
      await conflict.waitFor();
      expect(await conflict.textContent()).toMatch(
        /changed since you opened it: it is now High.*Your change was not applied\./,
      );
      // Nothing of Ben's was applied: Ana's High stands, as her one edit.
      expect(priority()).toBe(2);
      expect(updates()).toBe(1);
      // His page shows the value now there, not the Low he chose.
      await expect
        .poll(() => ben.locator("#tile-card_x .prio").first().getAttribute("aria-label"))
        .toBe("High");
      await ana.context().close();
      await ben.context().close();
    },
  );
});
