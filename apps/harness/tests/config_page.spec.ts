import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { startDashboardServer } from "../src/server.js";

// The Configuration page in a real Chromium (B4.1 part b; dashboard DB-N6-1,
// DB-N6-2, DB-N6-4, DB-N6-14, DB-NM14-1): its sections, the model folders and
// the models found, the four roles, a model's graded numbers, and no model
// name beside the chat. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

async function server(root: string): Promise<{ server: Server; db: DatabaseSync }> {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const s = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: root,
    port: 0,
    streamIntervalMs: 1000,
  });
  return { server: s, db };
}

describe("the Configuration page (NEW-dashboard-6)", () => {
  let dir: string;
  let withModels: { server: Server; db: DatabaseSync };
  let empty: { server: Server; db: DatabaseSync };
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-config-page-"));
    const models = join(dir, "models");
    writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 1024 });
    writeGguf(join(models, "giant-Q4_K_M.gguf"), {
      ...SMALL,
      name: "Giant",
      blockCount: 400,
      headCount: 64,
      headCountKv: 64,
      embeddingLength: 16384,
    });
    const user = join(dir, "user.toml");
    writeFileSync(user, '[team]\nmode = "solo"\n');
    vi.stubEnv("SEKHEMET_USER_CONFIG", user);
    vi.stubEnv("SEKHEMET_MODELS_DIR", models);
    withModels = await server(join(dir, "a"));
    empty = await server(join(dir, "b"));
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await withModels?.server.close();
    await empty?.server.close();
    withModels?.db.close();
    empty?.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${withModels.server.port}`;

  it(
    "shows the five sections, and #/registry and #/settings open Benchmark and This browser (DB-N6-1)",
    { timeout: 60_000 },
    async () => {
      await page.goto(`${base()}/#/configuration`);
      const tabs = page.getByRole("navigation", { name: "Configuration sections" });
      await tabs.waitFor();
      expect(await tabs.getByRole("link").allInnerTexts()).toEqual([
        "Models",
        "Benchmark",
        "Review capacity",
        "This browser",
        "Project configuration",
      ]);
      expect(await tabs.locator('[aria-current="page"]').innerText()).toBe("Models");
      await page.goto(`${base()}/#/registry`);
      await page.waitForFunction(
        () =>
          document.querySelector('.cfg-tabs [aria-current="page"]')?.textContent === "Benchmark",
      );
      await page.goto(`${base()}/#/settings`);
      await page.waitForFunction(
        () =>
          document.querySelector('.cfg-tabs [aria-current="page"]')?.textContent === "This browser",
      );
    },
  );

  it(
    "lists the folder and both models with their fit, and the four roles in order (DB-N6-3, DB-N6-4)",
    { timeout: 60_000 },
    async () => {
      await page.goto(`${base()}/#/configuration/models`);
      await page.getByRole("heading", { name: "Models found" }).waitFor();
      const text = await page.locator(".cfg-models").innerText();
      expect(text).toContain("SEKHEMET_MODELS_DIR");
      expect(text).toContain("Tiny Llama");
      expect(text).toContain("Giant");
      expect(text).toMatch(/Needs \d+(\.\d)? GB more/);
      await page.getByRole("heading", { name: "Roles" }).waitFor();
      const roles = await page.locator(".cfg-role b:first-child").allInnerTexts();
      expect(roles.slice(0, 4)).toEqual(["Worker", "Planner", "Reviewer", "Researcher"]);
      expect(text + (await page.locator(".cfg-roles").innerText())).toContain(
        "Seshat, the project manager, runs on this model.",
      );
    },
  );

  it(
    "grades every number in a model's details, one of each grade shown (DB-NM14-1)",
    { timeout: 60_000 },
    async () => {
      await page.goto(`${base()}/#/configuration/models`);
      await page.getByRole("button", { name: "Tiny Llama" }).click();
      await page.locator(".cfg-detail").waitFor();
      const grades = await page.evaluate(() => {
        const nums = [...document.querySelectorAll(".cfg-models [data-num]")];
        return {
          ungraded: nums.filter((n) => !n.querySelector(".grade")).length,
          words: [...new Set(nums.map((n) => n.querySelector(".grade")?.textContent ?? ""))],
        };
      });
      expect(grades.ungraded).toBe(0);
      expect(grades.words).toEqual(
        expect.arrayContaining(["Measured", "From the file", "Estimated", "Design value"]),
      );
      // Measure speed asks first, naming the model and the memory it loads; Cancel loads nothing.
      await page.getByRole("button", { name: "Measure speed…" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Measure the speed of Tiny Llama").waitFor();
      expect(await dialog.innerText()).toMatch(/Memory it loads\s*[\d.]+ GB/);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      // The what-if recomputes without loading anything.
      const before = await page.locator(".cfg-detail").innerText();
      await page.locator('select[data-whatif="context"]').selectOption("65536");
      await page.waitForFunction(
        (b) => document.querySelector(".cfg-detail")?.textContent !== b,
        before,
      );
    },
  );

  it("names no model beside the chat (DB-N6-14)", { timeout: 60_000 }, async () => {
    await page.goto(`${base()}/#/pm`);
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/dirk-27b|Dirk-Qwen/);
  });

  it(
    "opens Configuration › Models when no model is found in any folder (DB-N6-2)",
    { timeout: 60_000 },
    async () => {
      // The folder is read when the page asks, so with none named nothing is found.
      const models = process.env.SEKHEMET_MODELS_DIR ?? "";
      vi.stubEnv("SEKHEMET_MODELS_DIR", "");
      try {
        const p = await (await browser.newContext()).newPage();
        await p.goto(`http://127.0.0.1:${empty.server.port}/`);
        await p.waitForFunction(() => location.hash === "#/configuration/models");
        await p.close();
      } finally {
        vi.stubEnv("SEKHEMET_MODELS_DIR", models);
      }
    },
  );
});
