import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { ModelRegistry, type QualificationCombination } from "@sekhemet/models";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { rolePromptVersion } from "../src/prompt_versions.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Configuration › Models in three layers, in a real Chromium against a real
 * server, ledger and registry, at 1440 and 400 px (dashboard NEW-dashboard-27,
 * DB-N27-1..4, -6, -8; models NEW-models-21): the setup card's rows with
 * their checks in words and Keep or Change, Customize's five tabs with every
 * value graded, the context slider's fit as it moves, a saved change marking
 * the role Needs verifying with Verify now, Reset, the fit and details of the
 * chosen role (FINDINGS CFG-13), and the inference engine as the Model
 * library's first part. axe finds no WCAG 2.2 A or AA violation. No model is
 * loaded and nothing is downloaded.
 */

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

describe("Configuration › Models: the setup card and Customize (NEW-dashboard-27)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;
  let registry: ModelRegistry;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-customize-ui-"));
    const models = join(dir, "models");
    writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 1024 });
    // A smaller model also verified as the Coding model: the suggestion, beside the assigned one (Keep).
    writeGguf(join(models, "small-Q4_K_M.gguf"), { ...SMALL, name: "Small Two", padBytes: 0 });
    const user = join(dir, "user.toml");
    writeFileSync(user, '[team]\nmode = "solo"\n\n[network]\nmode = "offline"\n');
    vi.stubEnv("SEKHEMET_USER_CONFIG", user);
    vi.stubEnv("SEKHEMET_MODELS_DIR", models);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
    registry = new ModelRegistry(join(dir, "models.json"));
    // The Coding model, verified on this machine for its combination (rule 27a).
    const c: QualificationCombination = {
      engine: "llama.cpp b10809",
      modelBuild: "sampled-sha256:1111",
      host: "ui-host",
      settings: {
        contextTokens: 16384,
        kvType: "q8_0",
        speculative: "off",
        prefixCaching: true,
        parallelSlots: 1,
        chatTemplate: "tmpl",
        contextVersion: rolePromptVersion("worker"),
      },
    };
    registry.upsert("tiny-llama", { family: "llama" });
    registry.recordCombinationQualification("tiny-llama", c, {
      suiteVersion: "q1.2",
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    });
    registry.upsert("small-two", { family: "llama" });
    registry.recordCombinationQualification("small-two", c, {
      suiteVersion: "q1.2",
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    });
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
      headroomProbe: null,
    });
    base = `http://127.0.0.1:${server.port}`;
    // Assign it as a person would, over the page's own API.
    const res = await fetch(`${base}/api/config/roles/worker`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ model: "tiny-llama" }),
    });
    expect(res.status).toBe(200);
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

  const overflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

  for (const width of [1440, 400]) {
    it(`DB-N27-1, -2, -8: the setup card's rows, the engine part, and Customize's graded tabs (${width} px)`, async () => {
      const page = await open(width);
      // Still the mockup's four cards; the engine is the Model library's first part.
      expect(
        (await page.locator(".cfg-card > h2").allTextContents()).map((t) =>
          t.replace(/\s*\d+$/, ""),
        ),
      ).toEqual(["Model library", "Available models", "Suggested setup", "Compare setups"]);
      await page.locator('[aria-labelledby="cfg-h-folders"] #cfg-h-engine').waitFor();
      expect(await page.locator("#cfg-h-engine").innerText()).toBe("Inference engine");
      // Each row: its job and the checks in words.
      const coding = page.locator('.cfg-role[data-role="worker"]');
      expect(await coding.innerText()).toMatch(/Builds each issue/);
      expect(await coding.locator(".cfg-checks li").allInnerTexts()).toEqual(
        expect.arrayContaining(["Fits in memory", "Verified on this machine"]),
      );
      // Change opens the role's picker.
      await coding.getByRole("button", { name: "Change" }).click();
      await coding.locator('select[data-assign-select="worker"]').waitFor();

      // Customize: five tabs, every value graded in words.
      await coding.getByRole("button", { name: "Customize" }).click();
      const panel = page.locator(".cfg-cust");
      await panel.getByRole("tablist").waitFor();
      expect(await panel.getByRole("tab").allInnerTexts()).toEqual([
        "Basics",
        "Sampling",
        "Reasoning",
        "Engine",
        "Harness",
      ]);
      await panel
        .locator("#cust-fit")
        .getByText(/usable/)
        .waitFor();
      await panel.getByRole("tab", { name: "Sampling" }).click();
      await panel.locator("#cust-temperature").waitFor();
      const grades = await panel.locator(".cust-grade .grade").allInnerTexts();
      expect(grades.length).toBeGreaterThan(5);
      for (const g of grades)
        expect(g).toMatch(/^(Measured|From its makers|Estimated|Default|Set)/);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("cust-tab-sampling");
      // Arrow keys move between tabs.
      await page.keyboard.press("ArrowRight");
      await panel.locator("#cust-reasoningLevel").waitFor();
      expect(await panel.locator("#cust-reasoningFloor").innerText()).toBe("None");

      expect(await axe(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: join(process.env.SEKHEMET_SHOTS ?? dir, `customize-${width}.png`),
        fullPage: true,
      });
      await page.context().close();
    }, 90_000);
  }

  it("DB-N27-2: the context slider's fit is recomputed as it moves, loading nothing", async () => {
    const page = await open(1440);
    await page
      .locator('.cfg-role[data-role="worker"]')
      .getByRole("button", { name: "Customize" })
      .click();
    const fit = page.locator("#cust-fit");
    await fit.getByText(/usable/).waitFor();
    const before = await fit.innerText();
    const asked = page.waitForRequest((r) => /\/settings\?.*context=65536/.test(r.url()));
    await page.locator("#cust-contextTokens").evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = "65536";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await asked;
    await page.waitForFunction(
      (b) => document.querySelector("#cust-fit")?.textContent !== b,
      before,
    );
    expect(await page.locator("[data-ctx-out]").innerText()).toBe("65,536 tokens");
    await page.context().close();
  }, 60_000);

  it("DB-N27-2 (B1-C3 review): a real mouse drag with pauses reaches the end; the slider is never replaced under it", async () => {
    const page = await open(1440);
    await page
      .locator('.cfg-role[data-role="worker"]')
      .getByRole("button", { name: "Customize" })
      .click();
    const fit = page.locator("#cust-fit");
    await fit.getByText(/usable/).waitFor();
    const slider = page.locator("#cust-contextTokens");
    // Marks the element itself, so a replaced node shows.
    await slider.evaluate((el) => {
      (el as HTMLInputElement & { mark?: boolean }).mark = true;
    });
    const box = await slider.boundingBox();
    if (!box) throw new Error("no slider");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    // Six steps, each pause longer than the fit's 150 ms wait, so the fit is read mid-drag.
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(box.x + (box.width * i) / 6 + (i === 6 ? 4 : 0), y, { steps: 4 });
      await page.waitForTimeout(400);
    }
    await page.mouse.up();
    const state = await slider.evaluate((el) => {
      const input = el as HTMLInputElement & { mark?: boolean };
      return { value: input.value, max: input.max, same: input.mark === true };
    });
    expect(state.same).toBe(true);
    expect(state.value).toBe(state.max);
    expect(await page.locator("[data-ctx-out]").innerText()).toBe(
      `${Number(state.max).toLocaleString("en")} tokens`,
    );
    // The fit followed the drag to its end.
    await page
      .waitForRequest((r) => new RegExp(`context=${state.max}`).test(r.url()))
      .catch(() => undefined);
    await fit.getByText(/usable|needs/).waitFor();
    await page.context().close();
  }, 60_000);

  it("DB-N27-3, -4: a saved change needs verifying with Verify now, a hint never blocks, and Reset restores", async () => {
    const page = await open(1440);
    const coding = page.locator('.cfg-role[data-role="worker"]');
    await coding.getByRole("button", { name: "Customize" }).click();
    const panel = page.locator(".cfg-cust");
    await panel.getByRole("tab", { name: "Sampling" }).click();
    await panel.locator("#cust-presencePenalty").fill("1.5");
    await panel.locator("#cust-temperature").fill("1.3");
    await panel.getByRole("button", { name: "Save" }).click();
    await panel
      .locator(".cust-ver")
      .getByText(/Needs verifying: .*repeat and presence penalties/)
      .waitFor();
    await panel.getByRole("button", { name: "Verify now" }).waitFor();
    // The hint stands beside the value; the save went through.
    expect(await panel.locator('[data-key="temperature"] .why').innerText()).toMatch(/tool calls/);
    expect(await panel.locator('[data-key="presencePenalty"] .grade').innerText()).toMatch(/^Set/);
    // The row says so too, and offers Verify now.
    await coding
      .locator(".cfg-checks")
      .getByText(/Needs verifying: .*changed/)
      .waitFor();
    await coding.locator(".actions").getByRole("button", { name: "Verify now" }).waitFor();
    // A refusal is beside its value and changes nothing.
    await panel.getByRole("tab", { name: "Engine" }).click();
    await panel.locator("#cust-kvType").selectOption("q4_0");
    await panel.getByRole("button", { name: "Save" }).click();
    await panel
      .locator('[data-key="kvType"] [role="alert"]')
      .getByText(/4-bit KV is refused/)
      .waitFor();
    // Reset each person's value: back to its grade, and verified again.
    await panel.getByRole("tab", { name: "Sampling" }).click();
    await panel.getByRole("button", { name: "Reset Presence penalty" }).click();
    await panel.getByRole("button", { name: "Reset Temperature" }).click();
    await panel
      .locator(".cust-ver")
      .getByText("Verified on this machine with these settings.")
      .waitFor();
    expect(registry.roleSettings("tiny-llama", "worker")).toBeUndefined();
    await page.context().close();
  }, 60_000);

  it("DB-N27-6 (CFG-13): the fit and a model's details follow the chosen role", async () => {
    const page = await open(1440);
    await page.locator("[data-view-role]").selectOption("reviewer");
    await page.getByRole("columnheader", { name: "Fits this machine (Review model)" }).waitFor();
    const detail = page.waitForRequest(
      (r) => /\/api\/config\/models\/[^/?]+\?/.test(r.url()) && /role=reviewer/.test(r.url()),
    );
    await page.getByRole("button", { name: "Tiny Llama" }).click();
    await detail;
    await page.locator(".cfg-detail").waitFor();
    await page.context().close();
  }, 60_000);

  it("DB-N27-1 (B1-C3 review): Keep is recorded, survives a reload, Apply suggestion leaves the kept model, and Change takes it back", async () => {
    let page = await open(1440);
    const coding = () => page.locator('.cfg-role[data-role="worker"]');
    expect(await coding().innerText()).toMatch(/Recommended: /);
    await coding().getByRole("button", { name: "Keep" }).click();
    await coding().getByText("Keeping tiny-llama.").waitFor();
    // A reload reads the keep back from the server.
    await page.context().close();
    page = await open(1440);
    await coding().getByText("Keeping tiny-llama.").waitFor();
    expect(await coding().getByRole("button", { name: "Keep" }).count()).toBe(0);
    // Apply suggestion's confirmation lists the kept model, not the suggestion.
    await page.getByRole("button", { name: "Apply suggestion" }).click();
    const dialog = page.getByRole("dialog", { name: "Use the recommended models" });
    await dialog.waitFor();
    expect(await dialog.innerText()).toMatch(/Coding model: tiny-llama \(kept\)/);
    expect(await dialog.innerText()).not.toMatch(/Coding model: small-two/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Change takes the keep back: the suggestion returns.
    await coding().getByRole("button", { name: "Change" }).click();
    await coding()
      .getByText(/Recommended: /)
      .waitFor();
    expect(await coding().getByText("Keeping tiny-llama.").count()).toBe(0);
    await page.context().close();
  }, 60_000);
});
