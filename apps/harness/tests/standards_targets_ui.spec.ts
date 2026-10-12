import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// Wave 3 of the test-and-refine loop (sweep 2 and sweep 3, standards and
// accessibility): dashboard §2.14.5's targets measured on a full seeded board —
// at least 24×24 px on desktop and 44×44 px on a phone, links set in a line of
// text included, since the rule names no exception — and the clipping, scroll
// region, first-run and column-header faults the sweeps found. A real server
// over a real ledger, in Chromium; no model is loaded.

type Server = { port: number; close: () => Promise<void> };

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const ROUTES = [
  "#/projects",
  "#/inbox",
  "#/my-issues",
  "#/status",
  "#/board",
  "#/review",
  "#/pm",
  "#/insights",
  "#/runs",
  "#/graph",
  "#/playbook",
  "#/integrations",
  "#/machine",
  "#/ledger",
  "#/configuration",
  "#/configuration/benchmark",
  "#/configuration/review",
  "#/configuration/browser",
  "#/configuration/project",
  "#/configuration/preferences",
  "#/card/card_ac9",
  "#/card/card_ip1",
  "#/card/card_pk1",
  "#/projects/new",
  "#/map",
  "#/account/profile",
];

/** Every visible target under `min` px on either side, named for the failure message. */
function smallTargets(page: Page, min: number): Promise<string[]> {
  return page.evaluate((min) => {
    const sel =
      "button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary";
    return [...document.querySelectorAll(sel)]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none")
          return false;
        // Off screen until focused (the skip link): measured on its own, focused.
        if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth) return false;
        // Clipped to nothing (`.sr-only`) is not a target.
        if (r.width <= 1 && r.height <= 1) return false;
        return r.width < min || r.height < min;
      })
      .map((e) => {
        const r = e.getBoundingClientRect();
        const name = (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 32);
        return `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} "${name}" (${Math.round(r.width)}×${Math.round(r.height)})`;
      });
  }, min);
}

/** The skip link as a person meets it: focused, on screen. */
async function skipLinkBox(page: Page): Promise<{ width: number; height: number } | null> {
  await page.locator("a.skip").focus();
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !a.classList.contains("skip")) return null;
    const r = a.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

describe("standards and accessibility on a full board (dashboard §2.13, §2.14; loop wave 3)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-standards-");
    await acceptableCard(seed, "card_ac9", "Round a week's total");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
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
    "§2.14.5: every target is at least 24×24 px at 1440 and 44×44 px at 400, the skip link and links in text included",
    {
      timeout: 300_000,
    },
    async () => {
      const problems: string[] = [];
      for (const [width, min] of [
        [1440, 24],
        [400, 44],
      ] as const) {
        const { ctx, page } = await openContext(browser, width);
        for (const route of ROUTES) {
          await page.goto(`${base}/${route}`);
          await page.waitForTimeout(900);
          for (const s of new Set(await smallTargets(page, min)))
            problems.push(`${route} ${width}px: ${s}`);
        }
        // The banner with no Coding model carries its *Set up models* link on every view.
        await page.goto(`${base}/#/board`);
        await page.locator("#sk-noworker a").waitFor({ timeout: 10_000 });
        const skip = await skipLinkBox(page);
        expect(skip, "Skip to content takes focus").not.toBeNull();
        if (skip && (skip.width < min || skip.height < min))
          problems.push(
            `${width}px: Skip to content (${Math.round(skip.width)}×${Math.round(skip.height)})`,
          );
        // The Seshat panel beside an issue (a desktop panel; a phone opens the full view):
        // its context row's *Don't send this context*.
        if (width === 1440) {
          await page.goto(`${base}/#/card/card_ac9`);
          await page.waitForTimeout(900);
          await page.evaluate(() => window.dispatchEvent(new CustomEvent("sekhemet:open-pm")));
          await page.locator(".ctx [data-ctx-dismiss]").waitFor({ timeout: 10_000 });
          for (const s of new Set(await smallTargets(page, min)))
            problems.push(`Seshat panel ${width}px: ${s}`);
        }
        await ctx.close();
        // A first visit: the welcome's own *Set up models* and its answers.
        const first = await (
          await browser.newContext({ viewport: { width, height: 900 } })
        ).newPage();
        await first.goto(`${base}/#/board`);
        await first.locator("#sk-firstrun .fr-step a").waitFor({ timeout: 10_000 });
        for (const s of new Set(await smallTargets(first, min)))
          problems.push(`first visit ${width}px: ${s}`);
        await first.context().close();
      }
      expect(problems).toEqual([]);
    },
  );

  it(
    "§2.14.5, WCAG 2.1.1: at 400 px no view has a scroll region a keyboard cannot reach (Insights)",
    {
      timeout: 120_000,
    },
    async () => {
      const problems: string[] = [];
      for (const height of [900, 600]) {
        const { ctx, page } = await openContext(browser, 400, { height });
        for (const route of ["#/insights", "#/board", "#/status", "#/review", "#/ledger"]) {
          await page.goto(`${base}/${route}`);
          await page.waitForTimeout(900);
          // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
          if (!(await page.evaluate(() => Boolean((window as any).axe))))
            await page.evaluate(`${AXE_SOURCE}\n;undefined`);
          const axe = await page.evaluate(() =>
            // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
            (window as any).axe.run(document, {
              runOnly: { type: "rule", values: ["scrollable-region-focusable"] },
            }),
          );
          for (const v of axe.violations as { id: string; nodes: { target: string[] }[] }[])
            for (const n of v.nodes)
              problems.push(`${route} 400×${height}: ${v.id} ${n.target.join(" ")}`);
          // And nothing on a phone scrolls sideways inside a view.
          const wide = await page.evaluate(() =>
            [...document.querySelectorAll(".view-host")]
              .filter((e) => e.scrollWidth > e.clientWidth + 1)
              .map((e) => `${e.className} ${e.scrollWidth}/${e.clientWidth}`),
          );
          for (const w of wide) problems.push(`${route}: scrolls sideways ${w}`);
        }
        await ctx.close();
      }
      expect(problems).toEqual([]);
    },
  );

  it(
    "DB-P3-7: the sidebar's status lines and the topbar's subtitle are never cut off",
    {
      timeout: 60_000,
    },
    async () => {
      const clipped = (page: Page) =>
        page.evaluate(() =>
          [...document.querySelectorAll(".foot .lbl, .top .crumb")]
            .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
            .map((e) => `"${e.textContent}" ${e.scrollWidth}/${e.clientWidth}`),
        );
      const problems: string[] = [];
      for (const width of [1440, 400]) {
        const { ctx, page } = await openContext(browser, width);
        for (const route of ["#/review", "#/board", "#/insights"]) {
          await page.goto(`${base}/${route}`);
          await page.locator(".foot .lbl, .top .crumb").first().waitFor({ state: "attached" });
          await page.waitForTimeout(900);
          for (const c of await clipped(page)) problems.push(`${route} ${width}px: ${c}`);
        }
        await ctx.close();
      }
      expect(problems).toEqual([]);
    },
  );

  it(
    "the first-run welcome on a phone is a bar: the view stays in the first screen",
    {
      timeout: 60_000,
    },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 812 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/#/board`);
      const bar = page.locator("#sk-firstrun");
      await bar.waitFor({ timeout: 10_000 });
      const h = (await bar.boundingBox())?.height ?? 0;
      // Its answers are all there and all reachable.
      await expect.poll(() => page.locator("#sk-firstrun [data-fr]").count()).toBe(5);
      expect(h, "the welcome's height at 400×812").toBeLessThanOrEqual(812 * 0.4);
      await ctx.close();
    },
  );

  it(
    "§2.4, DB-N4-3: a 20-digit review capacity is refused, and at the most a day holds the In review header shows its whole count / limit",
    {
      timeout: 60_000,
    },
    async () => {
      const { ctx, page } = await openContext(browser, 1440);
      await page.goto(`${base}/#/configuration/review`);
      const field = page.locator("#cfg-review");
      await field.waitFor({ timeout: 10_000 });
      const save = page.getByRole("button", { name: "Save", exact: true });
      // Refused beside the field; the previous value stays.
      await field.fill("99999999999999999999");
      await save.click();
      await page
        .getByText("Review minutes per day must be at most 1,440, the minutes in a day.")
        .waitFor({ timeout: 10_000 });
      expect(await field.inputValue()).toBe("60");
      // The largest value accepted: the header shows count / limit whole.
      await field.fill("1440");
      await save.click();
      await page.getByText("Saved.").waitFor({ timeout: 10_000 });
      await page.goto(`${base}/#/board`);
      await page.locator('[data-head="in_review"] .col-h .c').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const head = await page.evaluate(() => {
        const h = document.querySelector('[data-head="in_review"] .col-h');
        const c = h?.querySelector(".c");
        if (!h || !(c instanceof HTMLElement)) return null;
        const box = h.getBoundingClientRect();
        return {
          text: c.textContent ?? "",
          clipped: c.scrollWidth > c.clientWidth,
          outside: [...h.querySelectorAll("*")]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
            })
            .map((e) => `${e.tagName.toLowerCase()}.${e.className}`),
        };
      });
      expect(head?.text).toMatch(/^\d+ \/ \d+$/);
      expect(head?.clipped, `"${head?.text}" is cut off`).toBe(false);
      expect(head?.outside).toEqual([]);
      // The column's options stay reachable on the header.
      expect(await page.getByRole("button", { name: "In review column options" }).isVisible()).toBe(
        true,
      );
      // Put back, so no other check sees the changed limit.
      await page.goto(`${base}/#/configuration/review`);
      await field.fill("60");
      await save.click();
      await page.getByText("Saved.").waitFor({ timeout: 10_000 });
      await ctx.close();
    },
  );
});
