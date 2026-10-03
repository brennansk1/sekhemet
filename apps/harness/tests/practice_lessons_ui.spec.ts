import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// NEW-dashboard-13 in a real Chromium against a real Solo server (dashboard
// §2.9.5; FINDINGS PRC-05; DESIGN_GAPS b15): with Tips on, a learner meets a
// lesson on the practice in front of them — reviewing a change, requesting
// changes, acceptance criteria — as the `?` marked new, offered once; the
// lesson's line comes from this project's own ledger and its link is the
// canon; the action beside it is never blocked; with Tips off there is no
// trace of it. At 1440 and 400 px. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("lessons for the practice a person performs (NEW-dashboard-13)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;

  async function evidence(id: string) {
    const body = JSON.stringify({
      id: `ev_${id}`,
      cardId: id,
      attempt: 1,
      passed: true,
      failures: [],
      stopReason: "gate_passed",
      rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
      filesTouched: ["src/a.ts"],
      linesAdded: 1,
      linesRemoved: 0,
    });
    mkdirSync(join(dir, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(dir, ".sekhemet", "evidence", `ev_${id}.json`), body);
    writeFileSync(join(dir, ".sekhemet", "evidence", `latest-${id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: `ev_${id}`,
      path: `.sekhemet/evidence/ev_${id}.json`,
      body,
      filesTouched: ["src/a.ts"],
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-practice-ui-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    for (const [id, title] of [
      ["card_done1", "Export a week as CSV"],
      ["card_wait1", "Flag hours past 40 as overtime"],
    ]) {
      await store.createCard({
        id,
        tier: "story",
        title,
        acceptanceCriteria: ["Hours past 40 in one week are overtime."],
      });
      await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
      await evidence(id);
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
    base = `http://127.0.0.1:${server.port}`;
    // This person's one review so far: changes requested on card_done1.
    const res = await fetch(`${base}/api/cards/card_done1/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ reason: "Name the week's start day in src/a.ts." }),
    });
    expect(res.status).toBe(200);
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, width: number, role = "learn"): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((r) => {
      try {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem("sekhemet-role", r);
          sessionStorage.setItem("seeded", "1");
        }
      } catch {}
    }, role);
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor();
    await page.waitForTimeout(600);
    return page;
  }

  it(
    "DB-N13-1..3 at 1440 px: the review lesson is offered once, marked new, with this person's own numbers and the canon",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review", 1440);
      const q = page.locator('.q-h [data-tip="practice:review"]');
      await q.waitFor();
      expect(await q.getAttribute("data-new")).toBe("true");
      expect(await q.getAttribute("aria-label")).toBe("About Reviewing a change, new");
      await q.click();
      const pop = page.locator(".tip-pop");
      await pop.waitFor();
      const words = await pop.innerText();
      expect(words).toContain("Reviewing a change");
      expect(words).toContain(
        "You reviewed 1 issue here: 0 accepted, changes requested on 1. 1 issue waits in In review now.",
      );
      expect(await pop.locator("a.tip-src").getAttribute("href")).toMatch(
        /^https:\/\/www\.atlassian\.com\//,
      );
      await page.keyboard.press("Escape");
      // Offered: the mark is gone, and stays gone after a reload.
      await expect.poll(() => q.getAttribute("data-new")).toBeNull();
      await page.reload();
      await page.locator('.q-h [data-tip="practice:review"]').waitFor();
      expect(
        await page.locator('.q-h [data-tip="practice:review"]').getAttribute("data-new"),
      ).toBeNull();
      await page.context().close();
    },
  );

  it(
    "DB-N13-3: a lesson shown but not opened is offered once — leaving the view settles it — and never blocks the action",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_wait1", 1440);
      const crit = page.locator('#iss-crit-h [data-tip="practice:criteria"]');
      await crit.waitFor();
      expect(await crit.getAttribute("data-new")).toBe("true");
      // Request changes opens with its lesson beside the note, and the note takes the typing.
      await page.locator(".cv-h [data-back]").click();
      const lesson = page.locator('[data-composer] [data-tip="practice:request_changes"]');
      await lesson.waitFor();
      await page.locator("#sb-note").fill("Count the hours per pay week.");
      expect(await page.locator("#sb-note").inputValue()).toBe("Count the hours per pay week.");
      await page.locator("[data-composer] [data-cancel]").click();
      // Leave and come back: offered once, no longer marked new.
      await page.evaluate(() => {
        location.hash = "#/board";
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        location.hash = "#/card/card_wait1";
      });
      await page.locator('#iss-crit-h [data-tip="practice:criteria"]').waitFor();
      expect(
        await page.locator('#iss-crit-h [data-tip="practice:criteria"]').getAttribute("data-new"),
      ).toBeNull();
      const seen = JSON.parse(
        (await page.evaluate(() => localStorage.getItem("sekhemet-lessons-seen"))) ?? "[]",
      );
      expect(seen).toEqual(
        expect.arrayContaining(["practice:criteria", "practice:request_changes"]),
      );
      await page.context().close();
    },
  );

  it(
    "DB-N13-2 at 400 px: the criteria lesson reads the board and fits the phone",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_wait1", 400);
      const crit = page.locator('#iss-crit-h [data-tip="practice:criteria"]');
      await crit.waitFor();
      await crit.click();
      const pop = page.locator(".tip-pop");
      await pop.waitFor();
      expect(await pop.innerText()).toContain("2 of 2 open issues here have acceptance criteria.");
      const box = await pop.boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 400).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.context().close();
    },
  );

  it(
    "DB-P4-1: with Tips off there is no practice lesson anywhere",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review", 1440, "code");
      await page.locator(".q-h").first().waitFor();
      expect(await page.locator('[data-tip^="practice:"]').count()).toBe(0);
      await page.evaluate(() => {
        location.hash = "#/card/card_wait1";
      });
      await page.locator("#iss-crit-h").waitFor();
      expect(await page.locator('[data-tip^="practice:"]').count()).toBe(0);
      await page.context().close();
    },
  );
});
