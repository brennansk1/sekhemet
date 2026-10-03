import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// Dashboard DB-N26-3 and runtime RUN-82 (DEC-57), in a real Chromium against
// the real server over real SQLite: a project added while the active-project
// cap is reached is shown on Projects as paused with the reason, and *Resume*
// is refused with the cap's sentence until a person pauses another. No model
// is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("a project added at the active-project cap (DB-N26-3, RUN-82)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let alpha = "";
  let beta = "";

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sek-cap-ui-")));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    store.activeProjectCap = 1;
    for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
    alpha = (await store.ensureProject({ rootPath: join(dir, "alpha"), name: "Alpha" })).id;
    beta = (await store.ensureProject({ rootPath: join(dir, "beta"), name: "Beta" })).id;
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
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

  for (const width of [1440, 400]) {
    it(`at ${width} px: paused with the reason; Resume refused with the cap's sentence, then allowed once another is paused`, async () => {
      expect(store.getProject(beta)?.status).toBe("paused");
      const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
      await page.goto(`${base}/#/projects`);
      const row = page.locator(`tr[data-project="${beta}"]`);
      await row.waitFor();
      expect(await row.locator(".pj-state").innerText()).toContain("Paused");
      // Added at the cap the first time; the second time a person paused it.
      expect(await row.locator(".pj-paused").innerText()).toContain(
        width === 1440
          ? "Added while 1 project was active, the most that run at once."
          : "Paused by you.",
      );
      expect(await page.locator(`tr[data-project="${alpha}"] .pj-paused`).count()).toBe(0);
      await row.getByRole("button", { name: "Resume" }).click();
      const refused = row.locator(".pj-refused");
      await refused.waitFor();
      expect(await refused.innerText()).toMatch(
        /1 projects are already active \(the cap is 1\); pause one first\./,
      );
      expect(store.getProject(beta)?.status).toBe("paused");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // A person pauses Alpha; now Resume starts Beta.
      const res = await fetch(`${base}/api/projects/${alpha}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ status: "paused" }),
      });
      expect(res.status).toBe(200);
      await row.getByRole("button", { name: "Resume" }).click();
      await expect.poll(() => store.getProject(beta)?.status).toBe("active");
      await expect.poll(() => row.locator(".pj-paused").count()).toBe(0);
      // Put things back for the next width: Alpha paused by a person says so.
      await expect
        .poll(() => page.locator(`tr[data-project="${alpha}"] .pj-paused`).innerText())
        .toContain("Paused by");
      await store.setProjectStatus(beta, "paused");
      await store.setProjectStatus(alpha, "active");
      await page.context().close();
    });
  }
});
