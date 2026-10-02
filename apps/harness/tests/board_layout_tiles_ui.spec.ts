import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

// The board in a real Chromium (C2a, FINDINGS BRD-01, -02, -06, -09, -10,
// -11, -13; dashboard §2.4.2–4, §2.14.3): every column in view and none
// covered at 1440 px; the queues in their own pane at 1100 px with the board
// opened on In progress, uncut; one column and a column switcher on a phone;
// an In review tile's status on one readable line beside one check summary; a
// click that opens the issue's peek; New issue and Ask Seshat in the top bar.
// A real server over real SQLite; no model is loaded.

type Server = { port: number; close: () => Promise<void> };

const GATES = [
  "unit",
  "secrets",
  "lint",
  "format",
  "types",
  "size",
  "deps",
  "coverage",
  "osv",
  "semgrep",
  "licence",
  "audit",
  "dead",
];

describe("the board's layout and tiles in a browser (BRD-01, -02, -06, -09, -10, -11)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: Server;
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-board-c2a-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const card = async (id: string, title: string, status: string, extra = {}) => {
      const start = status === "backlog" || status === "ready" ? status : "ready";
      await store.createCard({
        id,
        tier: "feature",
        title,
        status: start,
        scopeFiles: [`src/${id}.ts`],
        ...extra,
      });
      // A card is never created further along (the transition law): moved there as setup.
      if (status !== start)
        await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
    };
    await card("card_b1", "Show a manager every week waiting for approval", "backlog", {
      labels: ["approvals", "weekly-approvals"],
    });
    await card("card_b2", "Import last month's timesheets from a spreadsheet", "backlog", {
      spec: "Read the CSV a spreadsheet exports and add each row as an entry.",
    });
    await card("card_t1", "Pay public holidays at double time", "ready");
    await card("card_p1", "Work out the pay period of a date", "in_progress");
    await card("card_r1", "Show the weekly total on the timesheet", "review");
    await card("card_r2", "Flag hours past 40 in a week as overtime", "review");
    await card("card_d1", "Export a week's entries as CSV", "done");
    await card("card_h1", "Let a manager approve a submitted week", "parked");
    // A repository issue form for spikes (DB-N15-3).
    mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "ISSUE_TEMPLATE", "research.yml"),
      [
        "name: Research question",
        "labels: [research]",
        "body:",
        "  - type: input",
        "    id: question",
        "    attributes:",
        "      label: What do we need to find out?",
        "    validations:",
        "      required: true",
        "  - type: dropdown",
        "    id: timebox",
        "    attributes:",
        "      label: Timebox",
        "      options: [Half a day, A day]",
        "",
      ].join("\n"),
    );
    // Thirteen checks on an In review issue, as the audit's board had (BRD-02).
    const evidence = join(dir, ".sekhemet", "evidence");
    mkdirSync(evidence, { recursive: true });
    for (const id of ["card_r1", "card_r2"]) {
      writeFileSync(
        join(evidence, `latest-${id}.json`),
        JSON.stringify({
          id: `ev_${id}`,
          cardId: id,
          attempt: 1,
          createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          passed: true,
          failures: [],
          skipped: [],
          unavailable: [],
          stopReason: "passed",
          turnsUsed: 3,
          durationMs: 1000,
          rungResults: GATES.map((gate, i) => ({
            gate,
            rung: "hygiene",
            layer: "functional",
            passed: i < 11,
            ...(i >= 11 ? { skipped: true } : {}),
            exitCode: 0,
            durationMs: 90,
          })),
        }),
      );
    }
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function board(width: number, height = 900): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height } });
    // The first-run question is answered: this browser writes code.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/#/board`);
    await page.locator(".tile").first().waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    return page;
  }

  /** Each column's box, and whether the point at its header's centre belongs to it. */
  const columns = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".col[data-col]")]
        .filter((c) => c.offsetParent !== null)
        .map((c) => {
          const r = c.getBoundingClientRect();
          const h = c.querySelector("h2")?.getBoundingClientRect();
          const hit = h ? document.elementFromPoint(h.x + h.width / 2, h.y + h.height / 2) : null;
          return {
            id: c.dataset.col ?? "",
            left: Math.round(r.left),
            right: Math.round(r.right),
            own: Boolean(hit && c.contains(hit)),
          };
        }),
    );

  it(
    "at 1440 px every column is in view and none covers another (BRD-01)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const cols = await columns(page);
      expect(cols.map((c) => c.id)).toEqual([
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "on_hold",
      ]);
      for (const c of cols) {
        expect(c.own, `${c.id} is covered`).toBe(true);
        expect(c.right, `${c.id} runs past the window`).toBeLessThanOrEqual(1440);
      }
      // BRD-10: the first column starts inside the board's 16 px padding, uncut.
      const host = await page.locator(".board").boundingBox();
      expect(cols[0]?.left).toBeGreaterThanOrEqual(Math.round((host?.x ?? 0) + 16));
      expect(
        await page.evaluate(() => (document.querySelector(".board") as HTMLElement).scrollLeft),
      ).toBe(0);
      await page.context().close();
    },
  );

  it(
    "columns hold tiles with no box of their own: one level of container (BRD-10)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const style = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector(".col[data-col]") as Element);
        return { border: s.borderTopWidth, bg: s.backgroundColor };
      });
      expect(style.border).toBe("0px");
      expect(style.bg).toBe("rgba(0, 0, 0, 0)");
      await page.context().close();
    },
  );

  it(
    "at 1100 px the queues sit in their own pane and the board opens on In progress, uncut (BRD-01)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1100, 800);
      const pane = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".board-pin .col[data-col]")].map(
          (c) => c.dataset.col,
        ),
      );
      expect(pane).toEqual(["in_review", "on_hold"]);
      const scroller = await page.locator(".board").boundingBox();
      const cols = await columns(page);
      const inView = cols.filter(
        (c) => c.right > (scroller?.x ?? 0) && c.left < (scroller?.x ?? 0) + (scroller?.width ?? 0),
      );
      // The first column in view starts inside the board, one gap in: nothing
      // opens cut at the left, not even a sliver of the column before it.
      const first = inView.find((c) => !pane.includes(c.id));
      expect(first?.id).toBe("in_progress");
      expect(first?.left).toBe(Math.round((scroller?.x ?? 0) + 8));
      // Nothing is drawn over a column: each one in view owns its header.
      for (const c of inView) expect(c.own, `${c.id} is covered`).toBe(true);
      await page.context().close();
    },
  );

  it(
    "on a phone one column shows, with a switcher to the others (BRD-01, §2.14.3)",
    { timeout: 60_000 },
    async () => {
      const page = await board(400, 800);
      const shown = (await columns(page)).map((c) => c.id);
      expect(shown).toEqual(["in_progress"]);
      const sw = page.getByRole("group", { name: "Columns on this board" });
      await sw.getByRole("button", { name: /^To do/ }).click();
      expect((await columns(page)).map((c) => c.id)).toEqual(["todo"]);
      const hit = await page.evaluate(() => {
        const el = document.elementFromPoint(200, 500);
        return el?.closest(".col[data-col]")?.getAttribute("data-col") ?? "";
      });
      expect(hit).toBe("todo");
      // No sideways page scroll, and no Tab stop off the left edge.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const offLeft = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(".board [tabindex='0'], .board button"),
          ].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().right < 0).length,
      );
      expect(offLeft).toBe(0);
      await page.context().close();
    },
  );

  it(
    "an In review tile reads its status on one line beside one check summary (BRD-02)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const tile = page.locator("#tile-card_r1");
      const st = tile.locator(".r4s .st");
      const box = await st.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(60);
      expect(box?.height ?? 99).toBeLessThanOrEqual(20);
      // Thirteen checks are one summary with its words, not thirteen pips.
      const pips = tile.locator(".pips");
      expect(await pips.locator(".pip").count()).toBe(1);
      const said = /(\d+) of (\d+) checks passed/.exec(
        (await pips.getAttribute("aria-label")) ?? "",
      );
      expect(Number(said?.[2])).toBeGreaterThanOrEqual(13);
      expect((await pips.innerText()).trim()).toBe(`${said?.[1]}/${said?.[2]}`);
      await page.context().close();
    },
  );

  it("chips on a tile are never cut to say nothing (BRD-11)", { timeout: 60_000 }, async () => {
    const page = await board(1440);
    const cut = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "#tile-card_b1 .lbl-chip, #tile-card_b1 .epic-chip span",
        ),
      ]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent),
    );
    expect(cut).toEqual([]);
    await page.context().close();
  });

  it(
    "a click on a tile opens its peek; a modifier click only selects (BRD-06)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.locator("#tile-card_t1 .title").click();
      const peek = page.locator(".peek");
      await peek.waitFor();
      expect(await peek.innerText()).toContain("Pay public holidays at double time");
      await page.keyboard.press("Escape");
      await peek.waitFor({ state: "detached" });
      await page.locator("#tile-card_b2 .title").click({ modifiers: ["Shift"] });
      await page.waitForTimeout(200);
      expect(await page.locator(".peek").count()).toBe(0);
      await page.context().close();
    },
  );

  it("the top bar has New issue and Ask Seshat (BRD-09)", { timeout: 60_000 }, async () => {
    const page = await board(1440);
    const top = page.locator("#top");
    await top.getByRole("button", { name: "Ask Seshat" }).waitFor();
    await top.getByRole("button", { name: "New issue" }).click();
    await page.getByRole("dialog", { name: "New issue" }).waitFor();
    await page.context().close();
  });

  const priorityOf = (id: string) =>
    (
      db.prepare("SELECT priority FROM cards WHERE id = ?").get(id) as
        | { priority: number | null }
        | undefined
    )?.priority ?? 0;
  const updates = (id: string) =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE card_id = ? AND type = 'card/updated'")
        .get(id) as { n: number }
    ).n;

  it(
    "an inline edit offers Undo; z restores the value as one more event (NEW-dashboard-16)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      const was = priorityOf("card_t1");
      const before = updates("card_t1");
      await page.locator("#tile-card_t1").focus();
      await page.keyboard.press("Shift+P");
      await page.locator(".picker-menu [role=option]", { hasText: "Urgent" }).click();
      const done = page.locator(".toast", { hasText: "Set priority to Urgent" });
      await done.waitFor();
      expect(await done.getByRole("button", { name: /Undo/ }).count()).toBe(1);
      await expect.poll(() => priorityOf("card_t1")).toBe(1);
      await page.keyboard.press("z");
      await page.locator(".toast", { hasText: "Priority restored on" }).waitFor();
      await expect.poll(() => priorityOf("card_t1")).toBe(was);
      // Append-only: the edit and its undo are two events; the first is still there.
      expect(updates("card_t1")).toBe(before + 2);
      await page.context().close();
    },
  );

  it(
    "a bulk label edit is one toast, and nothing is left on the page's cards (BRD-12)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.locator("#tile-card_b1 .title").click({ modifiers: ["Shift"] });
      await page.locator("#tile-card_b2 .title").click({ modifiers: ["Shift"] });
      await page.locator(".bulk [data-bulk=labels]").click();
      await page.locator(".picker-menu [role=option]", { hasText: "approvals" }).first().click();
      const done = page.locator(".toast", { hasText: "on 2 issues" });
      await done.waitFor({ timeout: 5000 });
      expect(await page.locator(".toast").count()).toBe(1);
      // A string, so the page's own module loader runs the import, not the test's.
      const scratch = await page.evaluate(
        `import("/app/store.js").then(({ store }) => store.state.cards.filter((c) => "_nextLabels" in c).length)`,
      );
      expect(scratch).toBe(0);
      await page.context().close();
    },
  );

  it(
    "New issue offers the type as pills, and a Bug asks how to see it (NEW-dashboard-15)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.locator("#top").getByRole("button", { name: "New issue" }).click();
      const dialog = page.getByRole("dialog", { name: "New issue" });
      await dialog.waitFor();
      for (const t of ["Story", "Bug", "Task", "Spike"])
        expect(await dialog.getByRole("radio", { name: t }).count()).toBe(1);
      for (const p of ["Priority", "Sprint", "Assignee"])
        expect(await dialog.getByRole("combobox", { name: p }).count()).toBe(1);
      expect(await dialog.getByLabel("What happened").isVisible()).toBe(false);
      await dialog.getByText("Bug", { exact: true }).click();
      await dialog.getByLabel("What happened").waitFor();
      await dialog.getByLabel("Title").fill("The weekly total ignores Sunday");
      await dialog.getByLabel("What happened").fill("32 hours instead of 40.");
      await dialog.getByLabel("What you expected").fill("40 hours.");
      await dialog.getByLabel("Steps").fill("1. Enter Sunday hours");
      await dialog.getByRole("combobox", { name: "Priority" }).selectOption({ label: "High" });
      await dialog.getByLabel("Labels").fill("timesheet, totals");
      const sent = page.waitForRequest((r) => r.url().endsWith("/api/pm/create-card"));
      await dialog.getByRole("button", { name: "Propose issue" }).click();
      const body = (await sent).postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        title: "The weekly total ignores Sunday",
        type: "bug",
        priority: 2,
        labels: ["timesheet", "totals"],
        reproduction: {
          happened: "32 hours instead of 40.",
          expected: "40 hours.",
          steps: "1. Enter Sunday hours",
        },
      });
      await page.context().close();
    },
  );

  it(
    "comfortable density adds what it says it adds: the description's first line (BRD-13)",
    { timeout: 60_000 },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("sekhemet-role", "code");
          localStorage.setItem("sekhemet-density", "comfortable");
        } catch {}
      });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/#/board`);
      const line = page.locator("#tile-card_b2 .spec");
      await line.waitFor();
      expect(await line.innerText()).toBe(
        "Read the CSV a spreadsheet exports and add each row as an entry.",
      );
      await page.goto(`http://127.0.0.1:${server.port}/#/configuration/preferences`);
      const why = page.locator("#cfg-density-why");
      await why.waitFor({ state: "attached" });
      expect(await why.innerText()).toContain(
        "Comfortable board cards add the first line of the issue's description.",
      );
      expect(await why.innerText()).not.toMatch(/token|time bars|difficulty/i);
      await ctx.close();
    },
  );

  it(
    "a repository issue form gives its type's fields, shown as labels (DB-N15-3)",
    { timeout: 60_000 },
    async () => {
      const page = await board(1440);
      await page.locator("#top").getByRole("button", { name: "New issue" }).click();
      const dialog = page.getByRole("dialog", { name: "New issue" });
      await dialog.waitFor();
      await dialog.getByText("Spike", { exact: true }).click();
      const q = dialog.getByLabel("What do we need to find out?");
      await q.waitFor();
      await dialog.getByLabel("Title").fill("Can the totals stream a year of entries?");
      // A required field of the form is asked for before anything is sent.
      await dialog.getByRole("button", { name: "Propose issue" }).click();
      expect(await dialog.locator("#qc-err").innerText()).toContain("What do we need to find out?");
      await q.fill("Whether a year of entries totals in under a second.");
      await dialog.getByRole("combobox", { name: "Timebox" }).selectOption("A day");
      const sent = page.waitForRequest((r) => r.url().endsWith("/api/pm/create-card"));
      await dialog.getByRole("button", { name: "Propose issue" }).click();
      const body = (await sent).postDataJSON() as Record<string, unknown>;
      expect(body.type).toBe("spike");
      expect(String(body.description)).toBe(
        "What do we need to find out?: Whether a year of entries totals in under a second.\nTimebox: A day",
      );
      await page.context().close();
    },
  );
});
