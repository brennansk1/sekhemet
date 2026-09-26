import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NAV_ITEMS } from "@sekhemet/ui";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

// DB-P12-6: every route at 400, 1100 and 1440 px in both themes, in a real
// Chromium (the cached build pinned by playwright-core), checked by axe-core
// for accessible names and target size, plus the three checks axe does not make:
// 44 px targets at phone width, reflow at 200% zoom, and nothing only on hover.
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const NAME_RULES = [
  "button-name",
  "link-name",
  "label",
  "select-name",
  "input-button-name",
  "aria-command-name",
  "aria-input-field-name",
  "aria-toggle-field-name",
  "image-alt",
  "svg-img-alt",
  "role-img-alt",
  "target-size",
];
const WIDTHS = [400, 1100, 1440];
const THEMES = ["basalt", "sand"];

describe("the accessibility check (dashboard DB-P12-6)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sekhemet-a11y-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({
      id: "card_a11y_1",
      tier: "feature",
      title: "A card in progress",
      status: "in_progress",
      scopeFiles: ["src/a.ts"],
    });
    await cardStore.createCard({
      id: "card_a11y_2",
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
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "finds no unnamed control, small target, broken reflow or hover-only information",
    {
      timeout: 300_000,
    },
    async () => {
      const problems: string[] = [];
      const routes = [...NAV_ITEMS.map((n) => n.route), "#/card/card_a11y_1"];
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        for (const theme of THEMES) {
          for (const route of routes) {
            await page.goto(`http://127.0.0.1:${server.port}/${route}`);
            await page.evaluate((t) => {
              document.documentElement.dataset.theme = t;
            }, theme);
            await page.waitForTimeout(250);
            const at = `${route} ${width}px ${theme}`;
            if ((await page.$('script[data-axe="1"]')) === null) {
              await page.addScriptTag({ path: AXE });
              await page.evaluate(() =>
                document.querySelector("script:last-of-type")?.setAttribute("data-axe", "1"),
              );
            }
            const axe = await page.evaluate(
              (rules) =>
                // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
                (window as any).axe.run(document, { runOnly: { type: "rule", values: rules } }),
              NAME_RULES,
            );
            for (const v of axe.violations as { id: string; nodes: { target: string[] }[] }[]) {
              for (const n of v.nodes) problems.push(`${at}: ${v.id} ${n.target.join(" ")}`);
            }
            // Phone width: 44×44 targets (WCAG 2.5.5), not only axe's 24 px.
            if (width === 400) {
              const small = await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    "button, a[href], [role=button], input, select, summary",
                  ),
                ]
                  .filter((e) => {
                    const r = e.getBoundingClientRect();
                    const s = getComputedStyle(e);
                    if (r.width === 0 || s.visibility === "hidden" || s.display === "none")
                      return false;
                    // Off screen until focused (the skip link) is not a target yet.
                    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth) return false;
                    // Links inside running text are exempt (WCAG 2.5.5, inline).
                    if (e.tagName === "A" && s.display === "inline") return false;
                    return r.width < 44 || r.height < 44;
                  })
                  .map((e) => {
                    const r = e.getBoundingClientRect();
                    const where = e.closest("[class]:not(:scope)")?.classList[0] ?? "";
                    return `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} in .${where} (${Math.round(r.width)}×${Math.round(r.height)})`;
                  }),
              );
              for (const s of new Set(small)) problems.push(`${at}: target under 44px ${s}`);
            }
            // Information only on hover: a `title` whose text a keyboard, touch or
            // screen-reader user cannot reach. The title may repeat the visible
            // name or accessible description, plus a shortcut in parentheses (the
            // cheat sheet and palette list every shortcut).
            const hoverOnly = await page.evaluate(() =>
              [...document.querySelectorAll("[title]")]
                .filter((e) => {
                  const t = (e.getAttribute("title") ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim();
                  if (!t) return false;
                  const described = (e.getAttribute("aria-describedby") ?? "")
                    .split(/\s+/)
                    .map((id) => document.getElementById(id)?.textContent ?? "")
                    .join(" ");
                  // A control inside a closed disclosure (the sidebar's More) has no
                  // rendered text, so innerText is empty and its own label would
                  // read as hover-only; it cannot be hovered until it is shown, so
                  // it is judged by the text it shows then.
                  const text = e.checkVisibility()
                    ? ((e as HTMLElement).innerText ?? "")
                    : (e.textContent ?? "");
                  const reachable = [
                    e.getAttribute("aria-label") ?? "",
                    e.getAttribute("aria-description") ?? "",
                    described,
                    text,
                  ].join(" ");
                  return !reachable.includes(t);
                })
                .map((e) => `${e.tagName.toLowerCase()}[title="${e.getAttribute("title")}"]`),
            );
            for (const h of new Set(hoverOnly)) problems.push(`${at}: hover-only ${h}`);
          }
        }
        await page.close();
      }
      // Reflow at 200% zoom: 1280 px at 200% is a 640 px viewport (WCAG 1.4.10).
      const zoomed = await browser.newPage({ viewport: { width: 640, height: 450 } });
      for (const route of routes) {
        await zoomed.goto(`http://127.0.0.1:${server.port}/${route}`);
        await zoomed.waitForTimeout(250);
        const over = await zoomed.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (over > 1) problems.push(`${route} 200% zoom: scrolls sideways by ${over}px`);
      }
      await zoomed.close();
      expect(problems).toEqual([]);
    },
  );
});
