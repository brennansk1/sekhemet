import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSprint } from "../src/pm/sprints.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";

type Server = { port: number; close: () => Promise<void> };

/**
 * The sprint lifecycle in a real Chromium against a real server over a real
 * SQLite file (C2b; dashboard §2.4 item 20, NEW-dashboard-11, DB-N11-1..3,
 * -5; DoD §2A): with no sprint the Sprint field offers New sprint and Plan a
 * sprint with Seshat; the header starts a planned sprint and completes the
 * active one through the Complete sheet, whose report follows; the palette
 * opens the report; at 400 px the header and the sheet fit. No model.
 */
describe("the sprint lifecycle in a browser", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let pm: PmStore;
  let server: Server;
  let browser: Browser;
  let base: string;
  let project: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sprints-ui-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    pm = new PmStore(log);
    mkdirSync(join(dir, "timesheet"));
    project = (await store.ensureProject({ rootPath: join(dir, "timesheet"), name: "Timesheet" }))
      .id;
    for (const [k, title] of [
      ["a", "Record a day's hours"],
      ["b", "Flag hours past 40 as overtime"],
      ["c", "Export the week to CSV"],
    ] as const) {
      ids[k] = (
        await store.createCard({ tier: "story", title, status: "ready", projectId: project })
      ).id;
    }
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 500,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, width = 1440): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#side").waitFor({ state: "attached" });
    return page;
  }

  const sprintNamed = async (name: string) => (await pm.cycles()).find((c) => c.name === name);

  it(
    "DB-N11-5: with no sprint the Sprint field offers New sprint and Plan a sprint with Seshat, never an API path; New sprint creates one",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/board");
      await page.locator(`#tile-${ids.a}`).focus();
      await page.keyboard.press("Shift+C");
      const options = page.locator(".picker-menu [role=option]");
      await options.first().waitFor();
      expect(await options.allInnerTexts()).toEqual([
        expect.stringContaining("New sprint…"),
        expect.stringContaining("Plan a sprint with Seshat"),
      ]);
      expect(await page.locator("body").innerText()).not.toMatch(/\/api\/|POST /);
      await options.filter({ hasText: "New sprint…" }).click();
      const sheet = page.locator("[data-sprint-sheet=new]");
      await sheet.waitFor();
      expect(await sheet.locator("input[name=name]").inputValue()).toBe("Sprint 1");
      await sheet.locator("input[name=goal]").fill("Hours in, overtime flagged");
      await sheet.getByRole("button", { name: "Create sprint" }).click();
      await page.locator(".toast", { hasText: "Created Sprint 1" }).waitFor();
      await expect.poll(async () => (await sprintNamed("Sprint 1"))?.projectId).toBe(project);
      expect((await sprintNamed("Sprint 1"))?.state).toBe("planned");
      await page.context().close();
    },
  );

  it(
    "DB-N11-1: the header offers Start sprint on the planned sprint, and starting it records the start",
    { timeout: 60_000 },
    async () => {
      const s1 = (await sprintNamed("Sprint 1")) as { id: string };
      for (const k of ["a", "b", "c"]) await store.updateCard(ids[k] as string, { cycleId: s1.id });
      await store.updateCardStatus(ids.a as string, "done", "accepted", "human", {
        override: true,
      });
      await pm.createCycle({
        name: "Sprint 2",
        startsOn: "2099-01-01",
        endsOn: "2099-01-14",
        projectId: project,
      });
      const page = await open("#/board");
      const header = page.locator(".cyc");
      await header.waitFor();
      expect(await header.innerText()).toContain("Planned");
      await header.locator("[data-sprint-action=start]").click();
      await page.locator(".toast", { hasText: "Sprint started: Sprint 1" }).waitFor();
      await header.locator("[data-sprint-action=complete]").waitFor();
      const started = await log.getEventsByTypes(["cycle/started"]);
      expect(started.at(-1)?.payload).toMatchObject({ id: s1.id });
      await page.context().close();
    },
  );

  it(
    "DB-N11-2, -3: Complete sprint lists the done and not-done issues, carries them to Backlog as one group, and shows the report",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/board");
      await page.locator(".cyc [data-sprint-action=complete]").click();
      const sheet = page.locator("[data-sprint-sheet=complete]");
      await sheet.waitFor();
      const text = await sheet.innerText();
      expect(text).toContain("1 done · 2 not done");
      expect(text).toContain("Record a day's hours");
      expect(text).toContain("Flag hours past 40 as overtime");
      const labels = await sheet.locator(".sprint-carry label").allInnerTexts();
      expect(labels.map((l) => l.split("\n")[0])).toEqual(["Sprint 2", "A new sprint", "Backlog"]);
      await sheet.locator(".sprint-carry label", { hasText: "Backlog" }).click();
      await sheet.getByRole("button", { name: "Complete sprint" }).click();
      const report = page.locator("[data-sprint-sheet=report]");
      await report.waitFor();
      const rows = await report.locator(".sprint-row").allInnerTexts();
      expect(rows[0]).toMatch(/Committed at start\s+3 issues/);
      expect(rows[3]).toMatch(/Completed\s+1 issue/);
      expect(rows[4]).toMatch(/Carried over\s+2 issues/);
      expect(rows[4]).toContain("→ Backlog");
      expect((await store.getCard(ids.b as string))?.cycleId).toBeUndefined();
      expect((await store.getCard(ids.c as string))?.cycleId).toBeUndefined();
      expect((await sprintNamed("Sprint 1"))?.state).toBe("closed");
      await page.context().close();
    },
  );

  it("DB-N11-3: the palette opens a completed sprint's report", { timeout: 60_000 }, async () => {
    const page = await open("#/board");
    await page.locator(`#tile-${ids.a}`).waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Sprint report");
    await page.getByText("Sprint report: Sprint 1").click();
    const report = page.locator("[data-sprint-sheet=report]");
    await report.waitFor();
    expect(await report.innerText()).toContain("Committed at start");
    await page.context().close();
  });

  it(
    "at 400 px the header's sprint actions, the Complete sheet and the report fit the screen; the report names the new sprint",
    { timeout: 60_000 },
    async () => {
      const s2 = (await sprintNamed("Sprint 2")) as { id: string };
      await store.updateCard(ids.b as string, { cycleId: s2.id });
      await startSprint({ log, cardStore: store, pmStore: pm }, s2.id);
      const page = await open("#/board", 400);
      const complete = page.locator(".cyc [data-sprint-action=complete]");
      await complete.waitFor();
      const box = await complete.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(400);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        400,
      );
      await complete.click();
      const dialog = page.locator("[data-sprint-sheet=complete]");
      await dialog.waitFor();
      const d = await dialog.boundingBox();
      expect(d?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((d?.x ?? 0) + (d?.width ?? 0)).toBeLessThanOrEqual(400);
      // Carried to a new sprint, the report names it.
      await dialog.locator(".sprint-carry label", { hasText: "A new sprint" }).click();
      await dialog.getByRole("button", { name: "Complete sprint" }).click();
      const report = page.locator("[data-sprint-sheet=report]");
      await report.waitFor();
      expect(await report.innerText()).toContain("→ Sprint 3");
      const r = await report.boundingBox();
      expect((r?.x ?? 0) + (r?.width ?? 0)).toBeLessThanOrEqual(400);
      await page.keyboard.press("Escape");
      await report.waitFor({ state: "detached" });
      await page.context().close();
    },
  );
});
