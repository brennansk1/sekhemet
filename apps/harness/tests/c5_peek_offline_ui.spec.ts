import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import {
  type SeededBoard,
  acceptableCard,
  openContext,
  seedBoard,
} from "./support/dashboard_seed.js";

/**
 * The peek's `r` while offline (dashboard DB-4; the C2d fixer's finding
 * routed to C5): a real server over a real ledger in a real repository,
 * driven in Chromium; the stream dropped and /api/meta failing at the browser's network boundary. No
 * model is loaded.
 */

type Server = { port: number; close: () => Promise<void> };

describe("offline, the peek's keys act on nothing (DB-4)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;
  const connection = (page: Page) =>
    page.evaluate(`import("/app/store.js").then(({ store }) => store.state.connection)`);

  beforeAll(async () => {
    seed = await seedBoard("sek-c5-peek-");
    await acceptableCard(seed, "card_ac9", "Round a week's total");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 250,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  it(
    "DB-4: offline, `r` in the peek opens no Request changes form and says Offline.",
    { timeout: 90_000 },
    async () => {
      const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
      // The stream never connects and, once the test says so, /api/meta fails:
      // the page goes offline (DB-4's own faults, at the network boundary).
      let metaFails = false;
      await ctx.route("**/api/stream**", (r) => r.abort("connectionreset"));
      await ctx.route("**/api/meta", (r) =>
        metaFails ? r.fulfill({ status: 500, body: "{}" }) : r.continue(),
      );
      await page.goto(`${base}/#/board`);
      await page.locator("#tile-card_ac9 .title").waitFor();
      await page.locator("#tile-card_ac9 .title").click();
      await page.locator(".peek").waitFor();
      // The evidence has loaded: the key would act at once.
      await page.locator(".peek [data-accept], .peek [data-back]").first().waitFor();
      metaFails = true;
      await expect.poll(() => connection(page), { timeout: 40_000 }).toBe("offline");
      await page.keyboard.press("r");
      await page.waitForTimeout(500);
      expect(await page.locator(".peek form[data-composer]").count()).toBe(0);
      expect(await page.locator(".toast", { hasText: "Offline." }).count()).toBeGreaterThan(0);
      await ctx.close();
    },
  );
});
