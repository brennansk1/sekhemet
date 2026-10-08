import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Seed, type Served, seen, serveWorkspace } from "./support/audience.js";

/**
 * The developer's job (DEFINITION_OF_DONE §6.4; dashboard DB-P3-17; W10):
 * from the board, find which issue is blocked and why within three actions,
 * at 1440 and 1100 px. The built `sekhemet serve` over a real ledger in a
 * real git repository (`support/audience.ts`), in Chromium. The actions
 * counted are the reach check's (`reach.ts`): what a person does, a click, a
 * key or a scroll, until the blocked tile's face, which names the issue and
 * what it waits on, is in view; the issue page then names its blocker too.
 * No model is loaded.
 */

const BLOCKER = "Work out the pay period of a date";
const BLOCKED = "Export a pay period as CSV";

async function seed({ store, project }: Seed): Promise<void> {
  const card = async (
    id: string,
    title: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    const start = status === "backlog" || status === "ready" ? status : "ready";
    await store.createCard({
      id,
      tier: "task",
      title,
      status: start as never,
      projectId: project,
      scopeFiles: [`src/${id}.ts`],
      ...extra,
    });
    if (status !== start)
      await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
  };
  // A board a team works on: every column holds work, and one issue waits on another.
  await card("card_bk1", "Import last month's timesheets", "backlog", { estimate: 3 });
  await card("card_bk2", "Show bank holidays on the calendar", "backlog", { estimate: 2 });
  await card("card_td1", "Pay public holidays at double time", "ready", { estimate: 2 });
  await card("card_ip1", BLOCKER, "in_progress", { estimate: 5 });
  await card("card_td2", BLOCKED, "ready", { estimate: 3, dependsOn: ["card_ip1"] });
  await card("card_vf1", "Round minutes to the quarter hour", "verify", { estimate: 1 });
  await card("card_rv1", "Show the weekly total on the timesheet", "review", { estimate: 2 });
  await card("card_dn1", "Export a week's entries as CSV", "done", { estimate: 8 });
  await card("card_pk1", "Let a manager approve a week", "parked", { estimate: 2 });
}

describe("a developer finds the blocked issue and why from the board (DB-P3-17, DoD §6.4)", () => {
  let served: Served;
  let browser: Browser;

  beforeAll(async () => {
    served = await serveWorkspace({ seed });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await served?.stop();
  });

  async function board(width: number, height: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height } });
    // A developer who has answered the first-run question: I write code.
    await ctx.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("seeded")) localStorage.setItem("sekhemet-role", "code");
        sessionStorage.setItem("seeded", "1");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${served.base}/#/board`);
    await page.locator(".tile").first().waitFor();
    await page.waitForTimeout(300);
    return page;
  }

  for (const [width, height] of [
    [1440, 900],
    [1100, 800],
  ] as const) {
    it(
      `at ${width} px: the blocked issue and its reason in at most three actions`,
      { timeout: 60_000 },
      async () => {
        const page = await board(width, height);
        // DB-P3-17 counts the actions to the blocked tile's face, which says which issue and why
        // (the reach check's measure, `reach.ts`): at most three.
        let actions = 0;
        const tile = '.tile.blocked[data-id="card_td2"]';
        if (!(await seen(page, tile))) {
          // The board opens on In progress (C2a): where To do sits left of the view, one
          // horizontal scroll of the board brings it in.
          const board = await page.locator(".board").first().boundingBox();
          await page.mouse.move((board?.x ?? 0) + 300, (board?.y ?? 0) + 200);
          await page.mouse.wheel(-2000, 0);
          await page.waitForTimeout(200);
          actions += 1;
        }
        expect(await seen(page, tile), `the blocked tile is in view at ${width} px`).toBe(true);
        expect(actions).toBeLessThanOrEqual(3);
        expect(actions).toBe(width >= 1440 ? 0 : 1);
        const face = (await page.locator(`${tile} .blk`).innerText()).replace(/\s+/g, " ").trim();
        expect(face).toBe(`Blocked · waits on ${BLOCKER}`);
        expect((await page.locator(`${tile}`).innerText()).includes(BLOCKED)).toBe(true);
        // Only the waiting issue is flagged.
        expect(await page.locator(".tile.blocked").count()).toBe(1);

        // From there the issue itself names its blocker: open it in the peek, Enter opens the
        // issue, whose properties link the blocking issue (below 1280 px, under a disclosure).
        await page.locator(tile).click();
        await page.getByText("open issue").first().waitFor();
        await page.keyboard.press("Enter");
        await expect.poll(() => new URL(page.url()).hash).toBe("#/card/card_td2");
        const blockedBy = page.locator('.iprop[data-prop-row="Blocked by"]').first();
        await blockedBy.waitFor({ state: "attached" });
        if (!(await blockedBy.isVisible()))
          await page.locator("details[data-rail] > summary").first().click();
        await blockedBy.waitFor();
        const link = blockedBy.locator('a[href="#/card/card_ip1"]');
        expect((await link.innerText()).trim()).toBe("ip1");
        expect((await blockedBy.locator("dd").innerText()).replace(/\s+/g, " ").trim()).toBe(
          "ip1 In progress",
        );
        await page.context().close();
      },
    );
  }
});
