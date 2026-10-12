import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// The honesty rule on every surface that names the Agent's work (the
// test-and-refine loop's wave 2, A1, and its review's findings 1 and 2): the
// seeded card_ip1 is stored In progress and card_vf1 Verify, with no runner
// lease, no slot lease and no attempt. No page may say either is being
// worked on or checked: not the issue page and its tabs, not the board's
// tiles, not Status's headline. A real server over a real ledger; no model.

type Server = { port: number; close: () => Promise<void> };

describe("no working without a run, in a browser (wave 2 A1)", () => {
  let seed: SeededBoard;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    seed = await seedBoard("sek-w2truth-");
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
    await page.waitForTimeout(600);
    return page;
  }

  for (const tab of ["", "/steps", "/activity"]) {
    it(`the issue page${tab || " (Overview)"} of a stored In progress card says no run, and offers no Pause`, async () => {
      const page = await open(`#/card/card_ip1${tab}`);
      const bar = page.locator(".agent-bar").first();
      await bar.waitFor();
      const text = await bar.innerText();
      expect(text).toContain("In progress with no run");
      expect(text).not.toMatch(/is working|Pausing/);
      expect(await page.locator('[data-agent="pause"]').count()).toBe(0);
      expect(await page.locator('[data-agent="take_over"]').count()).toBe(1);
      // No message box for an Agent that is not there to read it.
      expect(await page.locator("#agent-msg").count()).toBe(0);
      await page.context().close();
    }, 60_000);
  }

  it("a card delegated to the Agent and stored In progress with no run: the teammate line does not say working", async () => {
    await seed.store.updateCardStatus("card_td1", "in_progress", "setup", "harness", {
      override: true,
    });
    const page = await open("#/card/card_td1");
    const bar = page.locator(".agent-bar").first();
    await bar.waitFor();
    const text = await bar.innerText();
    expect(text).toContain("In progress with no run");
    expect(text).not.toMatch(/Working on/);
    expect(await page.locator('[data-agent="pause"]').count()).toBe(0);
    await page.context().close();
    await seed.store.updateCardStatus("card_td1", "ready", "setup", "harness", { override: true });
  }, 60_000);

  it("the issue page of a stored Verify card waits for checks, never says they are running", async () => {
    const page = await open("#/card/card_vf1");
    const bar = page.locator(".agent-bar").first();
    await bar.waitFor();
    const text = await bar.innerText();
    expect(text).toContain("Waiting for checks");
    expect(text).not.toMatch(/checks are running/);
    await page.context().close();
  }, 60_000);

  it("the board's tiles for both say the stored fact in a neutral tone, never the running mark", async () => {
    const page = await open("#/board");
    for (const [id, words] of [
      ["card_ip1", "In progress · no run"],
      ["card_vf1", "Waiting for checks"],
    ] as const) {
      const tile = page.locator(`.tile[data-id="${id}"]`);
      await tile.waitFor();
      expect(await tile.locator(".st").innerText()).toBe(words);
      expect(await tile.getAttribute("class")).not.toMatch(/t-running/);
    }
    await page.context().close();
  }, 60_000);

  it("Status's headline says In progress, never being built", async () => {
    const page = await open("#/status");
    const head = page.locator(".stp-headline");
    await head.waitFor();
    const text = await head.innerText();
    expect(text).toMatch(/2 in progress/);
    expect(text).not.toMatch(/being built/i);
    await page.context().close();
  }, 60_000);
});
