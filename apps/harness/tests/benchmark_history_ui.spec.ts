import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import type { ScreeningSets } from "@sekhemet/eval";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";

/**
 * Configuration › Benchmark built out (dashboard §2.16 item 2, DB-N6-19..22;
 * measurement NEW-measurement-7, -8; FINDINGS CFG-10), in a real Chromium
 * against a real server and ledger at 1440 and 400 px: the per-role settings
 * picker, Find best settings with its verdict in words and Apply only when
 * there is something to apply, the history with its inline SVG charts and
 * their tables, the capstone's and Web-Bench's results with their protocol,
 * every disabled control saying why, and a Viewer's read-only controls with
 * the level note. axe finds no WCAG 2.2 A or AA violation. No model loads.
 */

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

function sets(): ScreeningSets {
  const not = (role: "planner" | "researcher") => ({
    role,
    version: "1",
    state: "not_built" as const,
    reason: `the ${role}'s golden set waits on a person's labels`,
    capSeconds: 60,
    expectedSize: 3,
    items: [],
  });
  return {
    roles: {
      worker: {
        role: "worker",
        version: "1",
        state: "ready",
        capSeconds: 120,
        expectedSize: 6,
        items: Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, referenceSeconds: 30 + i })),
        hash: "a".repeat(64),
      },
      planner: not("planner"),
      reviewer: {
        role: "reviewer",
        version: "1",
        state: "ready",
        capSeconds: 30,
        expectedSize: 10,
        items: Array.from({ length: 10 }, (_, i) => ({ id: `d${i}` })),
        hash: "c".repeat(64),
      },
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: [] },
  };
}

async function seed(log: EventLog): Promise<void> {
  const run = (scores: number[], extra: Record<string, string> = {}) =>
    log.append({
      actor: "harness",
      type: "measure/benchmarked",
      payload: {
        tier: "quick",
        profileHash: "f".repeat(64),
        host: "ui-host",
        combination: { worker: "tiny-llama", planner: "tiny-llama", ...extra },
        partial: false,
        roles: [
          {
            role: "worker",
            model: "tiny-llama",
            state: "measured",
            cacheKey: `ck_${scores.join("_")}_${Object.keys(extra).length}`,
            setHash: "a".repeat(64),
            score: scores.reduce((a, b) => a + b, 0) / scores.length,
            low: Math.min(...scores),
            high: Math.max(...scores),
            items: scores.map((score, i) => ({ id: `w${i}`, score })),
            secondary: { secondsPerItem: 40, fits: true },
          },
        ],
        comparisons: [],
        endToEnd: { passed: 1, total: 2 },
      },
    });
  await run([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  await run([1, 1, 1, 1, 1, 1]);
  await run([1, 1, 1, 1, 1, 0.75], { "worker.settings": "temperature=0.2" });
  const candidate = (id: string, values: Record<string, string | number>, score: number) => ({
    id,
    values,
    items: Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, score, seconds: 40 })),
    score,
    secondsPerItem: 40,
  });
  await log.append({
    actor: "human",
    principal: "p_owner",
    type: "measure/settings_tuned",
    payload: {
      runId: "tune_aaaaaaaaaaaa",
      kind: "find_best",
      role: "worker",
      model: "tiny-llama",
      host: "ui-host",
      setHash: "a".repeat(64),
      candidates: [
        candidate("current", { temperature: 0.7 }, 0.5),
        candidate("temperature-0.2", { temperature: 0.2 }, 1),
      ],
      rungs: [{ items: 1, candidates: ["current", "temperature-0.2"] }],
      incumbent: "current",
      survivor: "temperature-0.2",
      comparison: { better: 6, worse: 0, ties: 0, p: 0.03125 },
      verdict: "best",
      adopted: { temperature: 0.2 },
      partial: false,
    },
  });
  await log.append({
    actor: "human",
    principal: "p_owner",
    type: "measure/settings_tuned",
    payload: {
      runId: "tune_bbbbbbbbbbbb",
      kind: "find_best",
      role: "reviewer",
      model: "tiny-llama",
      host: "ui-host",
      setHash: "c".repeat(64),
      candidates: [candidate("current", { reasoningLevel: "off" }, 0.5)],
      rungs: [],
      incumbent: "current",
      survivor: "current",
      verdict: "no_clear_difference",
      partial: false,
    },
  });
}

describe("Configuration › Benchmark built out (DB-N6-19..22; NEW-measurement-7, -8)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-bench-ui-"));
    const models = join(dir, "models");
    writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 1024 });
    writeGguf(join(models, "huge-Q4_K_M.gguf"), {
      name: "Huge Llama",
      blockCount: 400,
      embeddingLength: 16384,
      headCount: 128,
      headCountKv: 128,
      contextLength: 131072,
      padBytes: 1024,
    });
    const user = join(dir, "user.toml");
    writeFileSync(user, '[team]\nmode = "solo"\n\n[network]\nmode = "offline"\n');
    const runs = join(dir, "capstone-runs");
    const score = join(runs, "webbench-sekhemet-nail-mtp", "1", "score.json");
    mkdirSync(dirname(score), { recursive: true });
    writeFileSync(
      score,
      JSON.stringify({
        benchmark: "web-bench",
        project: "react",
        commit: "abc1234",
        arm: "sekhemet-nail-mtp",
        model: "nail-mtp",
        run: 1,
        tasks: 20,
        pass: { "pass@1": 0.25, "pass@2": 0.35 },
        error: { "error@1": 0.1 },
      }),
    );
    vi.stubEnv("SEKHEMET_USER_CONFIG", user);
    vi.stubEnv("SEKHEMET_MODELS_DIR", models);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
    vi.stubEnv("SEKHEMET_CAPSTONE_RUNS", runs);
    const opened = openLocalLedger(dir);
    db = opened.db;
    await seed(opened.log);
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
      benchmarkEnv: (env) => ({
        ...env,
        host: "ui-host",
        sets,
        hostReading: () => ({ swapUsedBytes: 0, freeRatio: 0.8 }),
        screenRunner: () => ({
          load: async () => ({ seconds: 1 }),
          runItem: async () => ({ outcome: { kind: "tests", passed: 1, total: 2 }, seconds: 5 }),
          endToEnd: async () => ({ passed: true, seconds: 5 }),
        }),
      }),
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
    await page.goto(`${base}/#/configuration/benchmark`);
    await page.locator(".config-benchmark .bench-history svg").first().waitFor();
    await page.locator(".bench-tune [data-tune-role='worker'] .tune-verdict").waitFor();
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
    it(`DB-N6-19..22: settings, Find best settings, history charts and the other benchmarks (${width} px)`, async () => {
      const page = await open(width);
      const section = page.locator(".config-benchmark");

      // CFG-10: Run quick is disabled and says why; a model that does not fit is disabled with Needs N GB.
      const quick = section.locator("button[data-quick]");
      expect(await quick.isDisabled()).toBe(true);
      const why = await quick.getAttribute("aria-describedby");
      expect(await page.locator(`#${why}`).innerText()).toMatch(
        /Choose a Coding model and a Planning model/,
      );
      const huge = section.locator('select[data-role="worker"] option', { hasText: "Huge Llama" });
      expect(await huge.getAttribute("disabled")).not.toBeNull();
      expect(await huge.innerText()).toMatch(/Needs \d+(\.\d+)? GB/);

      // The settings picker offers what Find best settings found for the model, in words.
      await section.locator('select[data-role="worker"]').selectOption({ label: "Tiny Llama" });
      await section.locator('select[data-role="planner"]').selectOption({ label: "Tiny Llama" });
      const settings = section.locator('select[data-settings-role="worker"]');
      await settings
        .locator("option", { hasText: "temperature 0.2" })
        .waitFor({ state: "attached" });
      expect(await settings.locator("option").allInnerTexts()).toEqual(
        expect.arrayContaining(["As set", "temperature 0.2"]),
      );
      await page.waitForFunction(
        () => !(document.querySelector("button[data-quick]") as HTMLButtonElement | null)?.disabled,
      );

      // Find best settings: the verdict in words; Apply only when there is something to apply.
      const coding = section.locator(".bench-tune [data-tune-role='worker']");
      expect(await coding.locator(".tune-verdict").innerText()).toMatch(
        /Best combination: temperature 0\.2 — higher on 6 of 6/,
      );
      expect(await coding.getByRole("button", { name: "Apply" }).isDisabled()).toBe(false);
      const review = section.locator(".bench-tune [data-tune-role='reviewer']");
      expect(await review.locator(".tune-verdict").innerText()).toMatch(/No clear difference/);
      const apply = review.getByRole("button", { name: "Apply" });
      expect(await apply.isDisabled()).toBe(true);
      expect(
        await page.locator(`#${await apply.getAttribute("aria-describedby")}`).innerText(),
      ).toMatch(/nothing to apply/);
      await review.getByRole("button", { name: "Settle overnight" }).waitFor();
      // Planning has no screen: it says why instead of offering a run.
      expect(await section.locator(".bench-tune").innerText()).toMatch(
        /Planning model.*golden set waits on a person's labels/s,
      );

      // History: inline SVG charts, each with its table, and each run against the one before.
      const history = section.locator(".bench-history");
      expect(await history.locator("svg").count()).toBeGreaterThanOrEqual(2);
      expect(await history.locator("table").count()).toBeGreaterThanOrEqual(1);
      expect(await history.innerText()).toMatch(/Better/);
      expect(await history.innerText()).toMatch(/temperature 0\.2/);

      // The other benchmarks, with their protocol.
      const other = section.locator(".bench-external");
      expect(await other.innerText()).toMatch(/Web-Bench/);
      expect(await other.innerText()).toMatch(/react @ abc1234/);
      expect(await other.innerText()).toMatch(/pass@1 25%/);
      expect(await other.innerText()).toMatch(/one retry with the test output/);
      expect(await other.innerText()).toMatch(/No capstone result is recorded/);

      expect(await axe(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const cards = section.locator(".cfg-card");
      for (let i = 0; i < (await cards.count()); i++)
        await cards.nth(i).screenshot({
          path: join(process.env.SEKHEMET_SHOTS ?? dir, `benchmark-${width}-${i}.png`),
        });
      await page.context().close();
    }, 90_000);
  }

  it("DB-N6-19, DB-N6-15: a Viewer sees every control read-only with the level note", async () => {
    const page = await open(1440);
    // A string, so the test's bundler leaves the page's own dynamic import alone.
    const state = (await page.evaluate(`(async () => {
      const host = document.createElement("div");
      host.id = "viewer-host";
      document.querySelector("main")?.append(host);
      // The module as the page loaded it, from wherever the server serves it.
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((n) => n.includes("config_benchmark.js"));
      const mod = await import(url);
      const child = mod.mountBenchmark(host, {
        readOnly: "Read-only. Changing this needs the Admin level; you are a Viewer.",
      });
      await child.ready;
      const controls = [...host.querySelectorAll("button, select")];
      return {
        note: host.querySelector(".readonly-note")?.textContent ?? "",
        controls: controls.length,
        enabled: controls.filter((c) => !c.disabled).map((c) => c.outerHTML.slice(0, 80)),
      };
    })()`)) as { note: string; controls: number; enabled: string[] };
    expect(state.note).toMatch(/Read-only\. Changing this needs the Admin level/);
    expect(state.controls).toBeGreaterThan(3);
    expect(state.enabled).toEqual([]);
    await page.context().close();
  }, 60_000);
});
