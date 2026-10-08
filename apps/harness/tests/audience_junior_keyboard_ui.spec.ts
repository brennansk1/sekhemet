import { CardStore } from "@sekhemet/kernel";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { type Seed, type Served, focusState, serveWorkspace } from "./support/audience.js";

/**
 * The beginner's job (DEFINITION_OF_DONE §6.4; dashboard DB-P4-8, DB-P4-3,
 * DB-P4-7; FINISH_LINE_PLAN W10 *the junior's keyboard path*): on a first
 * visit, answer *I'm learning* and reach the explanation of a WIP limit from
 * the board by keyboard alone, with focus never lost or hidden at any step.
 * The built `sekhemet serve` over a real ledger (`support/audience.ts`), in
 * Chromium; no mouse event is sent and no model is loaded.
 */

async function seed({ store, project }: Seed): Promise<void> {
  const card = async (id: string, title: string, status: string) => {
    const start = status === "backlog" || status === "ready" ? status : "ready";
    await store.createCard({
      id,
      tier: "task",
      title,
      status: start as never,
      projectId: project,
      scopeFiles: [`src/${id}.ts`],
    });
    if (status !== start)
      await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
  };
  await card("card_a", "Pay public holidays at double time", "ready");
  await card("card_b", "Show the weekly total on the timesheet", "review");
  await card("card_c", "Round minutes to the quarter hour", "review");
}

describe("a beginner reaches the WIP limit's explanation by keyboard alone (DB-P4-8, DoD §6.4)", () => {
  let served: Served;
  let browser: Browser;

  beforeAll(async () => {
    served = await serveWorkspace({ seed, model: true });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await served?.stop();
  });

  it(
    "Tab and Enter alone: I'm learning, then About WIP limit, its lesson, and Esc back, focus always on something visible",
    { timeout: 90_000 },
    async () => {
      const page = await (
        await browser.newContext({ viewport: { width: 1440, height: 900 } })
      ).newPage();
      await page.goto(`${served.base}/#/board`);
      await page.locator("#sk-firstrun").waitFor();
      await page.locator(".col-h").first().waitFor();
      expect(await page.locator(".tip-q").count()).toBe(0);

      /** Tab until `done` holds, checking focus after every key. */
      const tabUntil = async (done: () => Promise<boolean>, max = 250) => {
        for (let i = 0; i < max; i++) {
          await page.keyboard.press("Tab");
          const f = await focusState(page);
          expect(f.lost, `focus lost after Tab ${i + 1}`).toBe(false);
          expect(f.hidden, `focus hidden on "${f.label}" after Tab ${i + 1}`).toBe(false);
          if (await done()) return i + 1;
        }
        throw new Error("never reached");
      };

      // The first-run question, by keyboard: Tab to I'm learning, Enter.
      await tabUntil(() =>
        page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.fr === "learn"),
      );
      await page.keyboard.press("Enter");
      await page.locator("#sk-firstrun").waitFor({ state: "detached" });
      expect(await page.evaluate(() => document.documentElement.dataset.learn)).toBe("on");
      const after = await focusState(page);
      expect(after.lost, "focus lost when the question closed").toBe(false);
      expect(after.hidden, `focus hidden on "${after.label}" when the question closed`).toBe(false);
      await page.locator(".col-h .tip-q").first().waitFor();

      // From there, Tab alone to the WIP limit's `?`.
      await tabUntil(() =>
        page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") === "About WIP limit",
        ),
      );
      await page.keyboard.press("Enter");
      const pop = page.locator(".tip-pop[role=dialog]");
      await pop.waitFor();
      // Focus moved into the lesson, which explains the limit from this board's own numbers.
      expect(await pop.evaluate((p) => p.contains(document.activeElement))).toBe(true);
      const text = (await pop.innerText()).replace(/\s+/g, " ");
      expect(text).toContain("WIP limit");
      expect(text).toMatch(/In review holds at most \d+/);
      expect(text).toMatch(/It holds 2 now/);
      // Tab stays inside the lesson while it is open (DB-P4-3).
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        expect(await pop.evaluate((p) => p.contains(document.activeElement))).toBe(true);
      }
      // Esc closes it and returns focus to the `?`.
      await page.keyboard.press("Escape");
      await pop.waitFor({ state: "detached" });
      const back = await focusState(page);
      expect(back).toMatchObject({ lost: false, hidden: false, label: "About WIP limit" });
      await page.context().close();
    },
  );

  it(
    "DB-P4-8: focus on a column header's control stays on it when a frame from the server rewrites that header",
    { timeout: 90_000 },
    async () => {
      const page = await (
        await browser.newContext({ viewport: { width: 1440, height: 900 } })
      ).newPage();
      await page.goto(`${served.base}/#/board`);
      await page.locator("#sk-firstrun").waitFor();
      await page.locator('[data-fr="learn"]').click();
      await page.locator("#sk-firstrun").waitFor({ state: "detached" });
      const wip = page.locator('[aria-label="About WIP limit"]').first();
      await wip.waitFor();
      await wip.focus();
      const headId = await page
        .locator('.col-head:has([aria-label="About WIP limit"])')
        .first()
        .getAttribute("data-head");
      const before = await page.locator(`[data-head="${headId}"]`).innerHTML();
      // Another person (here, the ledger itself) moves an issue into In review:
      // the next frame rewrites the In review header's count and its lessons.
      const { db, log } = openLocalLedger(served.repo);
      try {
        await new CardStore(db, log).updateCardStatus(
          "card_a",
          "review" as never,
          "setup",
          "harness",
          {
            override: true,
          },
        );
      } finally {
        db.close();
      }
      await page.waitForFunction(
        ([id, was]) => document.querySelector(`[data-head="${id}"]`)?.innerHTML !== was,
        [headId, before] as const,
        { timeout: 30_000 },
      );
      const f = await focusState(page);
      expect(f).toMatchObject({ lost: false, hidden: false, label: "About WIP limit" });
      await page.context().close();
    },
  );
});
