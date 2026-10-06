import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// The board through its door (C2d, FINDINGS_C1 TST-01, TST-02): a real server
// over a real SQLite ledger in a real git repository, driven in Chromium at
// the widths that matter. Each test names the dashboard criterion it proves;
// before C2d these were proved only by pure render and CSS functions in
// packages/ui/tests. No model is loaded. Chromium is a declared dependency of
// this suite (playwright-core's own build): it is never skipped for want of one.

type Server = { port: number; close: () => Promise<void> };

describe("the board in Chromium, through the dashboard server (C2d)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-board-entry-");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store, { reviewMinutesPerDay: 60 }),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 250,
    });
    base = `http://127.0.0.1:${server.port}`;
    // Preferences → Estimation on story points for the seeded project (DB-N7-2).
    const on = await fetch(`${base}/api/projects/${seed.project}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ estimation: "points" }),
    });
    expect(on.status).toBe(200);
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function board(width: number, project?: string, height = 900): Promise<Page> {
    const { page } = await openContext(browser, width, {
      project: project ?? seed.project,
      height,
    });
    await page.goto(`${base}/#/board`);
    await page.locator(".tile").first().waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    return page;
  }

  /** A server over a ledger with no project yet. */
  async function emptyWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "sek-board-empty-"));
    const db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const s = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    return {
      server: s,
      close: async () => {
        await s.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** The full columns in DOM order, with their header text. */
  const columns = (page: Page) =>
    page.$$eval(".board .col[data-col]", (cs) =>
      cs.map((c) => ({
        id: (c as HTMLElement).dataset.col ?? "",
        label: c.querySelector("h2")?.textContent ?? "",
        tiles: [...c.querySelectorAll(".tile")].map((t) => (t as HTMLElement).dataset.id ?? ""),
      })),
    );

  /** A colour token's computed value, resolved the way the page resolves it. */
  const token = (page: Page, name: string) =>
    page.evaluate((n) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${n})`;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, name);

  it(
    "DB-P3-1: Backlog, To do, In progress, In review, Done and On hold, each stored state in one",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const cols = await columns(page);
      // On hold is there because a card is parked (DB-P3-18 checks the other half).
      expect(cols.map((c) => c.label)).toEqual([
        "Backlog",
        "To do",
        "In progress",
        "In review",
        "Done",
        "On hold",
      ]);
      const where = Object.fromEntries(cols.flatMap((c) => c.tiles.map((t) => [t, c.id])));
      expect(where).toMatchObject({
        card_bk1: "backlog",
        card_td1: "todo",
        card_td2: "todo", // Planning is To do
        card_ip1: "in_progress",
        card_vf1: "in_progress", // Verify is In progress
        card_rv1: "in_review",
        card_rv2: "in_review",
        card_dn1: "done",
        card_pk1: "on_hold",
      });
      // Exactly one column each; Rejected only behind the Won't do filter.
      const all = cols.flatMap((c) => c.tiles);
      expect(all.length).toBe(new Set(all).size);
      expect(all).not.toContain("card_rj1");
      await page.context().close();
    },
  );

  it(
    "DB-P3-9: In review shows count / limit with its derivation; every header shows its points",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const review = page.locator('.col[data-col="in_review"] .col-h');
      const count = review.locator(".c");
      expect((await count.innerText()).trim()).toBe("2 / 4");
      // The derivation, in words, on the count and on the column's menu button.
      const why = (await count.getAttribute("title")) ?? "";
      expect(why).toMatch(/Limit 4, from 60 review minutes a day at ~15 min per issue/);
      expect(await review.locator("[data-colmenu]").getAttribute("aria-description")).toBe(why);
      // Every column header shows its points sum (Estimation is on story points).
      const pts = await page.$$eval(".board .col[data-col]", (cs) =>
        cs.map((c) => [
          (c as HTMLElement).dataset.col,
          c.querySelector(".col-h .pts")?.textContent?.trim(),
        ]),
      );
      expect(Object.fromEntries(pts)).toEqual({
        backlog: "3 pts",
        todo: "3 pts",
        in_progress: "6 pts",
        in_review: "5 pts",
        done: "8 pts",
        on_hold: "2 pts",
      });
      await page.context().close();
    },
  );

  it(
    "DB-P3-9: a limit of any size keeps count / limit and its derivation",
    { timeout: 60_000 },
    async () => {
      // A person fixed the limit at 120 (`[review] wip`): still `count / limit`, still why.
      const fixed = await startDashboardServer({
        db: seed.db,
        log: seed.log,
        boardService: new BoardServiceImpl(seed.store, { customLimits: { review: 120 } }),
        cardStore: seed.store,
        repoPath: seed.dir,
        port: 0,
        streamIntervalMs: 1000,
      });
      try {
        const { page } = await openContext(browser, 1440, { project: seed.project });
        await page.goto(`http://127.0.0.1:${fixed.port}/#/board`);
        const count = page.locator('.col[data-col="in_review"] .col-h .c');
        await count.waitFor();
        expect((await count.innerText()).trim()).toBe("2 / 120");
        expect(await count.getAttribute("title")).toContain(
          "Limit 120, set by [review] wip in the project configuration.",
        );
        await page.context().close();
      } finally {
        await fixed.close();
      }
    },
  );

  it(
    "DB-P3-10: an empty column is a chip above the board; Done stays a full column at every width",
    { timeout: 90_000 },
    async () => {
      // Recipes holds one Backlog issue: every other column is a chip, in column order.
      const recipes = await board(1440, seed.other);
      const chips = await recipes.$$eval(".col-chips [data-chip-col]", (cs) =>
        cs.map((c) => (c as HTMLElement).dataset.chipCol),
      );
      expect(chips).toEqual(["todo", "in_progress", "in_review", "done"]);
      const bar = await recipes.locator(".col-chips").boundingBox();
      const boardBox = await recipes.locator('.board .col[data-col="backlog"]').boundingBox();
      expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeLessThanOrEqual((boardBox?.y ?? 0) + 1);
      // A chip opens its column.
      await recipes.locator('[data-chip-col="in_review"]').click();
      await recipes.locator('.board .col[data-col="in_review"]').waitFor();
      await recipes.context().close();
      // Timesheets has a Done card: a full column, never a chip, wide or narrow.
      for (const width of [1440, 1100, 767, 400]) {
        const page = await board(width);
        expect(await page.locator('.col-chips [data-chip-col="done"]').count(), `${width}`).toBe(0);
        expect(await page.locator('.col[data-col="done"]').count(), `${width}`).toBe(1);
        expect(await page.locator('.col[data-col="done"] .tile[data-id="card_dn1"]').count()).toBe(
          1,
        );
        await page.context().close();
      }
    },
  );

  it(
    "DB-P3-18: On hold is right-most with its count in --state-parked, and absent with none held",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const cols = await columns(page);
      expect(cols.at(-1)?.id).toBe("on_hold");
      const held = page.locator('.col[data-col="on_hold"] .col-h .c');
      expect((await held.innerText()).trim()).toBe("1");
      expect(await held.evaluate((e) => getComputedStyle(e).color)).toBe(
        await token(page, "--state-parked"),
      );
      await page.context().close();
      // Recipes holds nothing on hold: no On hold column, and no chip for it either.
      const recipes = await board(1440, seed.other);
      expect(await recipes.locator('[data-col="on_hold"], [data-chip-col="on_hold"]').count()).toBe(
        0,
      );
      await recipes.context().close();
    },
  );

  it(
    "DB-N9-18: the Agent's chip carries the AI badge and no avatar; a person's has neither badge",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const agent = page.locator("#tile-card_td1 .dlg");
      expect((await agent.innerText()).replace(/\s+/g, " ")).toMatch(/^Agent\s*AI/);
      expect(await agent.locator(".ai-badge").count()).toBe(1);
      expect(await page.locator("#tile-card_td1 .av").count()).toBe(0);
      const person = page.locator("#tile-card_td2 .dlg");
      expect(await person.count()).toBe(1);
      expect(await person.locator(".ai-badge").count()).toBe(0);
      await page.context().close();
    },
  );

  it(
    "DB-11: a WIP-limited column's capacity bar is amber at the limit and red over it",
    { timeout: 60_000 },
    async () => {
      const capped = await startDashboardServer({
        db: seed.db,
        log: seed.log,
        boardService: new BoardServiceImpl(seed.store, { customLimits: { review: 2 } }),
        cardStore: seed.store,
        repoPath: seed.dir,
        port: 0,
        streamIntervalMs: 250,
      });
      try {
        const { page } = await openContext(browser, 1440, { project: seed.project });
        await page.goto(`http://127.0.0.1:${capped.port}/#/board`);
        const bar = page.locator('.col[data-col="in_review"] .cap');
        await bar.waitFor();
        // Two of two: at capacity, amber (the parked/warning hue).
        expect(await bar.getAttribute("class")).toBe("cap full");
        const fill = () => bar.locator("i").evaluate((e) => getComputedStyle(e).backgroundColor);
        expect(await fill()).toBe(await token(page, "--state-parked"));
        // A third arrives (moved in as setup): over the limit, red, from the stream.
        await seed.store.updateCardStatus("card_vf1", "review", "setup", "harness", {
          override: true,
        });
        await expect.poll(() => bar.getAttribute("class"), { timeout: 5000 }).toBe("cap over");
        expect(await fill()).toBe(await token(page, "--state-fail"));
        expect(
          (await page.locator('.col[data-col="in_review"] .col-h .c').innerText()).trim(),
        ).toBe("3 / 2");
        await page.context().close();
      } finally {
        await seed.store.updateCardStatus("card_vf1", "verify", "setup", "harness", {
          override: true,
        });
        await capped.close();
      }
    },
  );

  it(
    "DB-N5-5: delegate:worker and owner:@me filter by those fields; assignee: means the owner",
    { timeout: 60_000 },
    async () => {
      // The install's own person is the Solo session's principal (`@me`).
      const me = seed.log.localPrincipal();
      const session = (await (await fetch(`${base}/api/session`)).json()) as {
        principal?: string;
      };
      expect(session.principal).toBe(me);
      await seed.store.changeOwner("card_ip1", me, me);
      // Grace, a person on the ledger, owns another issue: her principal names her.
      const grace = (
        await seed.store.createCard({
          id: "card_gr1",
          tier: "task",
          title: "Grace's issue",
          status: "backlog",
          projectId: seed.project,
          assignee: "Grace Hopper",
        })
      ).owner as string;
      expect(grace).toMatch(/^p_/);
      try {
        // Typed into the board's filter, as a person types it; each query on a fresh page.
        const shown = async (q: string) => {
          const page = await board(1440);
          const input = page.locator(".vbar [data-q]");
          await input.fill(q);
          await input.press("Enter");
          await page.waitForTimeout(500);
          const ids = await page.$$eval(".board .tile", (ts) =>
            ts.map((t) => (t as HTMLElement).dataset.id ?? ""),
          );
          await page.context().close();
          return ids.filter(Boolean).sort();
        };
        expect(await shown("delegate:worker")).toEqual(["card_td1"]);
        expect(await shown("owner:@me")).toEqual(["card_ip1"]);
        expect(await shown("assignee:@me")).toEqual(["card_ip1"]);
        expect(await shown("assignee:grace-hopper")).toEqual(["card_gr1"]);
      } finally {
        await seed.store.changeOwner("card_ip1", null, me);
        await seed.store.updateCardStatus("card_gr1", "rejected", "setup", "harness", {
          override: true,
        });
      }
    },
  );
  it(
    'DB-P5-4: the palette offers Start a new project for "new project", Ask Seshat: <query> for nothing',
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      const input = dialog.getByRole("combobox");
      await input.fill("new project");
      const first = dialog.locator("[role=option]").first();
      await expect.poll(() => first.innerText()).toBe("Start a new project");
      await input.fill("qzv frobnicate the wombats");
      const options = dialog.locator("[role=option]");
      await expect
        .poll(() => options.allInnerTexts())
        .toEqual(["Ask Seshat: qzv frobnicate the wombats"]);
      await page.context().close();
    },
  );

  it(
    "DB-N25-4: the palette offers Switch project… and Switch workspace…; Configuration names the project switcher",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await dialog.getByRole("combobox").fill("switch");
      const texts = await dialog.locator("[role=option]").allInnerTexts();
      expect(texts.map((t) => t.split("\n")[0])).toEqual(
        expect.arrayContaining(["Switch project…", "Switch workspace…"]),
      );
      // Running Switch project… opens the switcher itself, listing both projects.
      await dialog.getByRole("combobox").fill("switch project");
      await page.keyboard.press("Enter");
      const projects = page.locator(".proj-menu #proj-list [role=option] .proj-name");
      await projects.first().waitFor({ state: "attached" });
      expect((await projects.allInnerTexts()).sort()).toEqual(["Recipes", "Timesheets"]);
      await page.context().close();
      // With no project to choose yet, Configuration says where a project's settings are.
      const empty = await emptyWorkspace();
      try {
        const { page: cfg } = await openContext(browser, 1440);
        await cfg.goto(`http://127.0.0.1:${empty.server.port}/#/configuration/preferences`);
        const where = cfg.locator("#cfg-h-estimation + p.sec");
        await where.waitFor();
        expect(await where.innerText()).toBe(
          "Choose a project with the project switcher, at the head of the sidebar's project pages, to set its estimation.",
        );
        await cfg.context().close();
      } finally {
        await empty.close();
      }
    },
  );

  it(
    "DB-P12-2: the parked/warning hue is at least 20 degrees from the accent, in both themes",
    { timeout: 60_000 },
    async () => {
      const hue = ([r, g, b]: number[]) => {
        const [R, G, B] = [r, g, b].map((v) => (v ?? 0) / 255) as [number, number, number];
        const max = Math.max(R, G, B);
        const d = max - Math.min(R, G, B);
        if (d === 0) return 0;
        const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
        return (h * 60 + 360) % 360;
      };
      const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      for (const theme of ["basalt", "sand"]) {
        const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem("sekhemet-theme", t);
          } catch {}
        }, theme);
        await page.goto(`${base}/#/board`);
        await page.locator(".tile").first().waitFor();
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        const accent = hue(rgb(await token(page, "--accent")));
        const parked = hue(rgb(await token(page, "--state-parked")));
        const apart = Math.min(Math.abs(accent - parked), 360 - Math.abs(accent - parked));
        expect(apart, `${theme}: accent ${accent} vs parked ${parked}`).toBeGreaterThanOrEqual(20);
        // And the page uses it: On hold's count is drawn in that hue.
        const held = page.locator('.col[data-col="on_hold"] .col-h .c');
        expect(hue(rgb(await held.evaluate((e) => getComputedStyle(e).color)))).toBeCloseTo(
          parked,
          0,
        );
        await ctx.close();
      }
    },
  );

  // DB-6, the C2d gate's flake made deterministic: the board's own opening
  // scroll (to the working column) and a person's scroll in the same frame
  // reach the board as ONE scroll event. Read as the board's own, the person's
  // position was then overwritten by the next frame.
  it(
    "DB-6: a person's scroll in the same frame as the board's opening scroll is kept through the next update",
    { timeout: 60_000 },
    async () => {
      const { page } = await openContext(browser, 1100, { project: seed.project, height: 900 });
      await page.addInitScript(() => {
        const w = window as unknown as { __autoAt?: number };
        const mo = new MutationObserver(() => {
          const b = document.querySelector(".board") as HTMLElement | null;
          if (b && w.__autoAt === undefined && b.scrollLeft > 1) {
            w.__autoAt = b.scrollLeft;
            b.scrollLeft = 120;
          }
        });
        document.addEventListener("DOMContentLoaded", () =>
          mo.observe(document.body, { childList: true, subtree: true }),
        );
      });
      await page.goto(`${base}/#/board`);
      await page.waitForFunction(
        () => (window as unknown as { __autoAt?: number }).__autoAt !== undefined,
        null,
        { timeout: 15_000 },
      );
      const auto = await page.evaluate(() => (window as unknown as { __autoAt: number }).__autoAt);
      expect(auto).toBeGreaterThan(120);
      const scroller = page.locator(".board");
      const r = await fetch(`${base}/api/cards/card_bk1/park`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ reason: "Waiting on payroll" }),
      });
      expect(r.status).toBe(200);
      await page
        .locator('.col[data-col="on_hold"] .tile[data-id="card_bk1"]')
        .waitFor({ state: "attached", timeout: 5000 });
      await page.waitForTimeout(300);
      expect(await scroller.evaluate((b) => b.scrollLeft)).toBe(120);
      await page.context().close();
      const back = await fetch(`${base}/api/cards/card_bk1/unpark`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: "{}",
      });
      expect(back.status).toBe(200);
    },
  );

  it(
    "DB-6: a card parked through the API shows in On hold within 1 s, the scroll position kept",
    { timeout: 60_000 },
    async () => {
      // 1100 px: the board scrolls sideways, so a kept position is observable.
      const page = await board(1100);
      const scroller = page.locator(".board");
      const before = await scroller.evaluate((b) => {
        b.scrollLeft = 0;
        return b.scrollLeft;
      });
      await scroller.evaluate((b) => {
        b.scrollLeft = 120;
      });
      const kept = await scroller.evaluate((b) => b.scrollLeft);
      expect(kept).not.toBe(before);
      const sent = Date.now();
      const r = await fetch(`${base}/api/cards/card_bk1/park`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ reason: "Waiting on payroll" }),
      });
      expect(r.status).toBe(200);
      await page
        .locator('.col[data-col="on_hold"] .tile[data-id="card_bk1"]')
        .waitFor({ state: "attached", timeout: 1000 });
      expect(Date.now() - sent).toBeLessThanOrEqual(1000);
      expect(await scroller.evaluate((b) => b.scrollLeft)).toBe(kept);
      await page.context().close();
      const back = await fetch(`${base}/api/cards/card_bk1/unpark`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: "{}",
      });
      expect(back.status).toBe(200);
    },
  );

  it(
    "DB-5: a stream frame that changes one card patches that tile only, keeping scroll, focus and the open drawer",
    { timeout: 60_000 },
    async () => {
      const page = await board(1100);
      await page.locator(".board").evaluate((b) => {
        b.scrollLeft = 80;
      });
      // Open one issue's peek, and focus another tile; then let the page settle.
      await page.locator("#tile-card_td1 .title").click();
      await page.locator(".peek").waitFor();
      await page.locator("#tile-card_ip1").focus();
      await page.waitForTimeout(800);
      const scroll = await page.locator(".board").evaluate((b) => b.scrollLeft);
      expect(scroll).toBeGreaterThan(0);
      // Mark every tile node, and keep its markup: a re-render of the board would replace them.
      // A tile's own clock (*1s*, *Accepted · 3s ago*) may tick between frames, so ages
      // are read as one value.
      const tiles = () =>
        page.$$eval("#view .tile", (ts) =>
          ts.map((t) => {
            const n = t as HTMLElement & { _kept?: boolean };
            const was = Boolean(n._kept);
            n._kept = true;
            return {
              id: n.dataset.id ?? "",
              kept: was,
              raw: t.outerHTML,
              html: t.outerHTML.replace(/\b\d+(s|m|h|d)\b/g, "T"),
            };
          }),
        );
      const first = await tiles();
      const before = new Map(first.map((t) => [t.id, t.html]));
      const raw = new Map(first.map((t) => [t.id, t.raw]));
      expect(before.has("card_rv2")).toBe(true);
      await seed.store.updateCard("card_rv2", { title: "Flag hours past 40 in any week" });
      await expect
        .poll(() => page.locator("#tile-card_rv2 .title").innerText(), { timeout: 5000 })
        .toBe("Flag hours past 40 in any week");
      const after = await tiles();
      // Only card_rv2's tile changed; every tile whose markup is unchanged is the same node.
      expect(after.filter((t) => before.get(t.id) !== t.html).map((t) => t.id)).toEqual([
        "card_rv2",
      ]);
      const untouched = after.filter((t) => raw.get(t.id) === t.raw);
      expect(untouched.length).toBeGreaterThan(3);
      expect(untouched.filter((t) => !t.kept).map((t) => t.id)).toEqual([]);
      expect(await page.locator(".board").evaluate((b) => b.scrollLeft)).toBe(scroll);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("tile-card_ip1");
      expect(await page.locator(".peek").count()).toBe(1);
      expect(await page.locator(".peek").innerText()).toContain(
        "Pay public holidays at double time",
      );
      await page.context().close();
      await seed.store.updateCard("card_rv2", { title: "Flag hours past 40 in a week" });
    },
  );

  it(
    "DB-10: with prefers-reduced-motion: reduce the board shows no pulse and no translate",
    { timeout: 60_000 },
    async () => {
      // The running card's dot pulses with motion allowed; nothing moves with it reduced.
      const motion = async (reduce: boolean) => {
        const { ctx, page } = await openContext(browser, 1440, {
          project: seed.project,
          reducedMotion: reduce,
        });
        await page.goto(`${base}/#/board`);
        await page.locator(".tile").first().waitFor();
        // A dialog rises on open (translateY): open the palette too.
        await page.keyboard.press("Control+k");
        await page.getByRole("dialog", { name: "Command palette" }).waitFor();
        const seen = await page.evaluate(() => {
          const names = new Set<string>();
          for (const el of document.querySelectorAll("*")) {
            const s = getComputedStyle(el);
            if (s.animationName && s.animationName !== "none") names.add(s.animationName);
          }
          const running = document
            .getAnimations()
            .map((a) => (a as CSSAnimation).animationName ?? a.constructor.name);
          return { names: [...names].sort(), running };
        });
        await ctx.close();
        return seen;
      };
      const allowed = await motion(false);
      expect(allowed.names).toEqual(expect.arrayContaining(["pulse"]));
      const reduced = await motion(true);
      expect(reduced.names).toEqual([]);
      expect(reduced.running).toEqual([]);
    },
  );
});
