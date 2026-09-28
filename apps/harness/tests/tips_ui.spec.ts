import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { startDashboardServer } from "../src/server.js";

// Tips, the Learn layer (dashboard §2.9, P4), in a real Chromium: the
// first-run question sets them (DB-P4-7), with them off the page carries no
// `?` (DB-P4-1), and a beginner reaches the WIP limit's explanation from the
// board by keyboard alone, the popover saying the In review limit's numbers,
// and Esc returning focus to the `?` (DB-P4-3, -4, -8). No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("Tips in the page (DB-P4-1, -3, -7, -8)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: Server;
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-tips-ui-"));
    // A model in the folder: the first-run question follows once one is set up.
    writeGguf(join(dir, "models", "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama" });
    vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "models"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({
      id: "card_tips_1",
      tier: "feature",
      title: "A card waiting for review",
      scopeFiles: ["src/a.ts"],
    });
    // A card is never created in review (the transition law): move it there as setup.
    await cardStore.updateCardStatus("card_tips_1", "review", "setup", "harness", {
      override: true,
    });
    await cardStore.createCard({
      id: "card_tips_2",
      tier: "task",
      title: "A card ready to start",
      status: "ready",
      scopeFiles: ["src/b.ts"],
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function fresh(): Promise<Page> {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    await page.goto(`http://127.0.0.1:${server.port}/#/board`);
    await page.locator("#sk-firstrun").waitFor();
    await page.locator(".col-h").first().waitFor();
    return page;
  }

  it("I write code leaves Tips off: no ? anywhere", { timeout: 60_000 }, async () => {
    const page = await fresh();
    expect(await page.locator(".tip-q").count()).toBe(0);
    await page.getByRole("button", { name: /^I write code/ }).click();
    await page.locator("#sk-firstrun").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.documentElement.dataset.learn ?? "")).toBe("");
    expect(await page.locator(".tip-q").count()).toBe(0);
    await page.context().close();
  });

  it(
    "I'm learning turns Tips on, and the WIP limit's lesson is reached by keyboard alone",
    { timeout: 60_000 },
    async () => {
      const page = await fresh();
      await page.getByRole("button", { name: /^I'm learning/ }).click();
      await page.locator("#sk-firstrun").waitFor({ state: "detached" });
      await page.locator(".col-h .tip-q").first().waitFor();
      expect(await page.evaluate(() => document.documentElement.dataset.learn)).toBe("on");
      // From the top of the page, Tab until the In review WIP count's `?`.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let found = false;
      for (let i = 0; i < 200 && !found; i++) {
        await page.keyboard.press("Tab");
        found = await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") === "About WIP limit",
        );
      }
      expect(found).toBe(true);
      await page.keyboard.press("Enter");
      const pop = page.locator(".tip-pop[role=dialog]");
      await pop.waitFor();
      const text = (await pop.innerText()).replace(/\s+/g, " ");
      expect(text).toContain("WIP limit");
      expect(text).toMatch(/In review holds at most \d+/);
      expect(await pop.locator("a[href^='https://']").count()).toBe(1);
      await page.keyboard.press("Escape");
      await pop.waitFor({ state: "detached" });
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
      ).toBe("About WIP limit");
      await page.context().close();
    },
  );
});
