import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import {
  type SeededBoard,
  acceptableCard,
  openContext,
  seedBoard,
} from "./support/dashboard_seed.js";

// The review and issue flow on a fully seeded board, in a real Chromium (the
// test-and-refine loop's wave 2, list B; sweep 2 of the dashboard): the Review
// queue's ARIA, the queue at phone width and at 200% zoom, the diff header's
// line counts, Take off hold on the issue page, the Request changes composer
// above the triage bar, a Save the server never answered, and the story map
// with no accepted brief. A real server over a real ledger; no model is loaded.

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

type Server = { port: number; close: () => Promise<void> };

describe("the review and issue flow in a browser (wave 2, B1–B8)", () => {
  let seed: SeededBoard;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    seed = await seedBoard("sek-w2b-");
    await acceptableCard(seed, "card_ac9", "Round a week's total");
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

  async function open(hash: string, width: number, height = 900): Promise<Page> {
    const { page } = await openContext(browser, width, { project: seed.project, height });
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor({ state: "attached" });
    await page.waitForTimeout(600);
    return page;
  }

  async function axe(page: Page, rules: string[]): Promise<string[]> {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
    if (!(await page.evaluate(() => Boolean((window as any).axe))))
      await page.evaluate(`${AXE_SOURCE}\n;undefined`);
    const r = (await page.evaluate(
      (only) =>
        // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
        (window as any).axe.run(document, { runOnly: { type: "rule", values: only } }),
      rules,
    )) as { violations: { id: string; nodes: { target: string[] }[] }[] };
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`));
  }

  it("B1: the Review queue holds only options in its listboxes, and the diff only its lines", async () => {
    const page = await open("#/review/card_ac9", 1440);
    await page.locator(".group[data-file]").first().waitFor();
    expect(await axe(page, ["aria-required-children", "aria-required-parent"])).toEqual([]);
    // Each group of the queue is named by its heading.
    const boxes = page.getByRole("listbox");
    expect(await boxes.count()).toBeGreaterThan(0);
    await expect
      .poll(() => page.getByRole("listbox", { name: /Ready for review/ }).count())
      .toBe(1);
    expect(await page.getByRole("option").count()).toBeGreaterThanOrEqual(3);
    // The issue page's Changes tab draws the same diff.
    const card = await open("#/card/card_ac9/changes", 1440);
    await card.locator(".group[data-file]").first().waitFor();
    expect(await axe(card, ["aria-required-children", "aria-required-parent"])).toEqual([]);
    await page.context().close();
    await card.context().close();
  });

  for (const width of [400, 720]) {
    it(`B2: at ${width} px the Review desk opens on its queue, a row opens the evidence, and Back returns`, async () => {
      const page = await open("#/review", width);
      const rows = page.locator(".q-row");
      await rows.first().waitFor();
      expect(await rows.first().isVisible()).toBe(true);
      expect(await rows.count()).toBeGreaterThanOrEqual(3);
      // The queue is the screen: the evidence waits for a choice.
      expect(await page.locator(".ev").isVisible()).toBe(false);
      await page.locator('.q-row[data-id="card_ac9"]').click();
      await page.locator(".ev .group[data-file]").first().waitFor();
      expect(await page.locator(".queue").isVisible()).toBe(false);
      // A visible way back to the queue, by keyboard or touch.
      const back = page.getByRole("link", { name: "Review queue" });
      expect(await back.isVisible()).toBe(true);
      await back.click();
      await rows.first().waitFor();
      expect(await rows.first().isVisible()).toBe(true);
      expect(await page.locator(".ev").isVisible()).toBe(false);
      // Another issue is one tap away.
      await page.locator('.q-row[data-id="card_rv2"]').click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/review/card_rv2");
      expect(await page.locator(".ev").isVisible()).toBe(true);
      await page.context().close();
    });
  }

  // Review finding 5 (§2.14.3, §2.14.4): with nothing chosen below 768 px every
  // row had tabindex -1, so Tab never reached the queue; a listbox with a
  // roving tabindex always keeps one tab stop, whichever group holds the choice.
  it("B2: at 400 px Tab from the top reaches a queue row, and Enter opens its evidence", async () => {
    const page = await open("#/review", 400);
    await page.locator(".q-row").first().waitFor();
    for (const box of await page.locator('.queue [role="listbox"]').all()) {
      expect(await box.locator('[role="option"][tabindex="0"]').count()).toBe(1);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.classList.contains("q-row") ?? false,
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".ev").isVisible(), { timeout: 5000 }).toBe(true);
    expect(await page.locator(".queue").isVisible()).toBe(false);
    await page.context().close();
  });

  it("B2: at 1440 px each listbox keeps one tab stop, the chosen row's group and the other", async () => {
    const page = await open("#/review", 1440);
    await page.locator('.q-row[aria-selected="true"]').first().waitFor();
    const boxes = await page.locator('.queue [role="listbox"]').all();
    expect(boxes.length).toBe(2);
    for (const box of boxes) {
      expect(await box.locator('[role="option"][tabindex="0"]').count()).toBe(1);
    }
    await page.context().close();
  });

  it("B2: at 1440 px the queue and the evidence stay side by side, the first issue selected", async () => {
    const page = await open("#/review", 1440);
    await page.locator(".q-row").first().waitFor();
    expect(await page.locator(".queue").isVisible()).toBe(true);
    expect(await page.locator(".ev").isVisible()).toBe(true);
    expect(await page.locator('.q-row[aria-selected="true"]').count()).toBe(1);
    expect(await page.getByRole("link", { name: "Review queue" }).isVisible()).toBe(false);
    await page.context().close();
  });

  for (const theme of ["sand", "basalt"]) {
    it(`B3: the diff header's line counts pass the colour-contrast check (${theme})`, async () => {
      const page = await open("#/review/card_ac9", 1440);
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.locator(".g-h .add-n").first().waitFor();
      await page.waitForTimeout(250);
      expect(await axe(page, ["color-contrast"])).toEqual([]);
      await page.context().close();
    });
  }

  it("B5: the Request changes composer shows its playbook option whole, above the triage bar", async () => {
    const page = await open("#/review/card_ac9", 1440, 900);
    await page.locator("[data-back]").first().waitFor();
    await page.locator("[data-back]").first().click();
    const box = page.locator("[data-composer]");
    await box.waitFor();
    const cbx = page.locator("[data-composer] label", { hasText: "Suggest as a playbook rule" });
    const input = cbx.locator("input[type=checkbox]");
    const triage = page.locator(".ev .triage");
    const [c, i, t, b] = await Promise.all([
      cbx.boundingBox(),
      input.boundingBox(),
      triage.boundingBox(),
      box.boundingBox(),
    ]);
    expect(c && i && t && b).toBeTruthy();
    if (!c || !i || !t || !b) return;
    // Inside the composer, and wholly above the bar's top edge.
    expect(c.y + c.height).toBeLessThanOrEqual(b.y + b.height + 0.5);
    expect(c.y + c.height).toBeLessThanOrEqual(t.y + 0.5);
    expect(i.y + i.height).toBeLessThanOrEqual(t.y + 0.5);
    // Nothing of the composer is cut off: it is no taller than it shows.
    const clipped = await page.evaluate(() => {
      const el = document.querySelector("[data-composer]") as HTMLElement | null;
      return el ? el.scrollHeight - el.clientHeight : -1;
    });
    expect(clipped).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it("B7: a Save the server never answered keeps the typed value and says why", async () => {
    const page = await open("#/configuration/review", 1440);
    const field = page.locator("#cfg-review");
    await field.waitFor();
    const before = await field.inputValue();
    expect(before).not.toBe("75");
    await field.fill("75");
    await page.route("**/api/config/review", (r) => r.abort("connectionrefused"));
    await page.locator("[data-review-form] button[type=submit]").click();
    const note = page.locator("[data-review-note]");
    await expect.poll(() => note.innerText()).toMatch(/can't be reached/);
    expect(await field.inputValue()).toBe("75");
    // The Project tab's Agent queue keeps an unsent value the same way.
    await page.goto(`${base}/#/configuration/project`);
    const cap = page.locator("#cfg-queue-cap");
    await cap.waitFor();
    await cap.fill("4");
    await page.route("**/api/config/queue", (r) => r.abort("connectionrefused"));
    await page.locator("[data-queue-form] button[type=submit]").click();
    await expect
      .poll(() => page.locator("[data-queue-note]").innerText())
      .toMatch(/can't be reached/);
    expect(await cap.inputValue()).toBe("4");
    await page.context().close();
  });

  it("B8: the story map with no accepted brief logs no error and requests nothing missing", async () => {
    const { page } = await openContext(browser, 1440, { project: seed.project });
    const errors: string[] = [];
    const missing: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    await page.goto(`${base}/#/board/map`);
    await page.locator("#view .view-host").first().waitFor({ state: "attached" });
    await page.waitForTimeout(1500);
    expect(await page.locator("#view").innerText()).toMatch(/No epics yet|brief/i);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it("B4: the On hold issue page offers Take off hold, which puts the issue back", async () => {
    const page = await open("#/card/card_pk1", 1440);
    const off = page.getByRole("button", { name: /Take off hold/ });
    await off.first().waitFor();
    expect(await off.first().isVisible()).toBe(true);
    await off.first().click();
    await expect
      .poll(async () => (await seed.store.getCard("card_pk1"))?.status, { timeout: 10_000 })
      .not.toBe("parked");
    await page.context().close();
  });
});
