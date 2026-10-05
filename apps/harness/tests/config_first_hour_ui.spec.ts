import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { FakeHeadroomProbe, type MemoryReading } from "@sekhemet/models";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";

/**
 * Configuration › Models in the first hour (B1-C3 review; dashboard
 * DB-N27-1, §2.16; models MD-N18-3, rule 6b; FINDINGS CFG-10), in a real
 * Chromium against a real server and ledger, at 1440 and 400 px: a clean
 * machine — no model folder, nothing assigned, no inference engine, the
 * network offline as it is by default — is offered the shipped set, each row
 * states its checks for the suggested model, *Apply suggestion*'s
 * confirmation states the set's total size and licence before the yes, and
 * *Get the inference engine* is disabled before the press, saying why, with
 * the other way to get it beside it. Nothing is loaded or downloaded.
 */

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
const GB = 1e9;
const GiB = 1024 ** 3;

/** Room for the shipped set on a 96 GB machine, so the suggestion does not depend on this host. */
function reading(): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 72 * GiB,
    metalInUseBytes: 72 * GiB - 1 * GiB - 64 * GB,
    totalBytes: 96 * GiB,
    wiredBytes: 0,
    anonymousBytes: 0,
    compressorBytes: 0,
    swapUsedBytes: 0,
    processes: [],
  };
}

describe("Configuration › Models on a clean machine (DB-N27-1, MD-N18-3, §2.16)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-first-hour-ui-"));
    const user = join(dir, "user.toml");
    writeFileSync(user, '[team]\nmode = "solo"\n\n[network]\nmode = "offline"\n');
    vi.stubEnv("SEKHEMET_USER_CONFIG", user);
    vi.stubEnv("SEKHEMET_MODELS_DIR", "");
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
    // No inference engine on this machine: the one named is not there.
    vi.stubEnv("SEKHEMET_LLAMA_SERVER", join(dir, "no-llama-server"));
    const opened = openLocalLedger(dir);
    db = opened.db;
    const cardStore = new CardStore(db, opened.log);
    server = await startDashboardServer({
      db,
      log: opened.log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
      headroomProbe: new FakeHeadroomProbe(reading()),
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/#/configuration/models`);
    await page.getByRole("heading", { name: "Suggested setup" }).waitFor();
    await page.locator('.cfg-role[data-role="worker"] .cfg-checks').waitFor();
    return page;
  }

  async function axe(page: Page): Promise<string[]> {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
    if (!(await page.evaluate(() => Boolean((window as any).axe))))
      await page.evaluate(`${AXE_SOURCE}\n;undefined`);
    const r = (await page.evaluate(() =>
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
      (window as any).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      }),
    )) as { violations: { id: string; nodes: { target: string[] }[] }[] };
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`));
  }

  for (const width of [1440, 400]) {
    it(`each row states its checks for the suggested model; Apply suggestion states the size and licence before the yes; the engine says why it cannot be fetched (${width} px)`, async () => {
      const page = await open(width);
      // DB-N27-1: nothing is assigned, and every suggested row still states its checks.
      const coding = page.locator('.cfg-role[data-role="worker"]');
      expect(await coding.innerText()).toMatch(/No model/);
      expect(await coding.innerText()).toMatch(/Recommended:/);
      expect(await coding.locator(".cfg-checks li").allInnerTexts()).toEqual([
        "Fits in memory",
        "Not verified on this machine yet",
      ]);
      expect(
        await page.locator('.cfg-role[data-role="planner"] .cfg-checks li').count(),
      ).toBeGreaterThan(0);

      // MD-N18-3: the confirmation states the set's total size and its licence.
      await page.getByRole("button", { name: "Apply suggestion" }).click();
      const dialog = page.getByRole("dialog", { name: "Use the recommended models" });
      await dialog.waitFor();
      const text = await dialog.innerText();
      expect(text).toMatch(/Coding model: nail-mtp/);
      expect(text).toMatch(/Planning model: qwen3\.8-27b-gsq-rco/);
      expect(text).toMatch(/Research model: apodex-1\.1-mini/);
      expect(text).toMatch(/In all: 42\.2 GB\s*(Published)?\s*to download\./);
      expect(text).toMatch(/Licences: Apache-2\.0\./);
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // §2.16, CFG-10: the engine's download is refused by the network
      // setting, so the button is disabled before the press, saying why,
      // and the other way to get the engine is shown beside it.
      const engine = page.locator(".cfg-engine");
      const get = engine.getByRole("button", { name: "Get the inference engine" });
      await get.waitFor();
      expect(await get.isDisabled()).toBe(true);
      const why = await page.locator("#cfg-engine-why").innerText();
      expect(why).toMatch(/^Downloads are off: Sekhemet is offline by default\./);
      expect(await get.getAttribute("aria-describedby")).toBe("cfg-engine-why");
      // This platform's fix, shown beside the disabled offer (it was hidden while the offer showed).
      if (process.platform === "darwin")
        expect(await engine.innerText()).toMatch(/brew install llama\.cpp/);

      expect(await axe(page)).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: join(process.env.SEKHEMET_SHOTS ?? dir, `first-hour-${width}.png`),
        fullPage: true,
      });
      await page.context().close();
    }, 90_000);
  }
});
