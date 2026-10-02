import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawRetiredIn, retiredIn } from "../../../packages/ui/tests/copy_scan.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";

type Server = { port: number; close: () => Promise<void> };

/**
 * The one-pass rename (C2a; dashboard NEW-dashboard-23, DEC-52, FINDINGS_C1
 * "Words and names") in a real Chromium against a real server over real
 * SQLite (DoD §2A). Every page a person opens is read as rendered, server
 * words included, for a retired word (the copy scan's list); and the renamed
 * controls are where a person looks for them: Request changes and Put on
 * hold on Review, Needs you, the Activity log, Acceptance criteria and Files
 * in scope, Seshat on the phone's tab bar. No model is loaded.
 */
describe("the professional words in a browser (C2a rename)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-rename-c2a-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    const card = async (id: string, title: string, status: string, extra = {}) => {
      const start = status === "backlog" || status === "ready" ? status : "ready";
      await store.createCard({ id, tier: "story", title, status: start, ...extra });
      if (status !== start)
        await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
    };
    await card("card_rv", "Flag hours past 40 in a week as overtime", "review", {
      scopeFiles: ["src/overtime.ts"],
      acceptanceCriteria: ["Hours past 40 in one week are overtime."],
      spec: "Flag hours past 40 in a week as overtime.",
      delegate: { kind: "worker" },
    });
    await card("card_hold", "Export the week to CSV", "parked", { scopeFiles: ["src/csv.ts"] });
    await card("card_todo", "Show the weekly total", "ready", { scopeFiles: ["src/total.ts"] });
    // The finished run's evidence, so Review offers its verdicts.
    const evDir = join(dir, ".sekhemet", "evidence");
    mkdirSync(evDir, { recursive: true });
    const body = JSON.stringify({
      id: "ev_card_rv",
      cardId: "card_rv",
      attempt: 1,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      passed: true,
      failures: [],
      skipped: [],
      unavailable: [],
      stopReason: "gate_passed",
      turnsUsed: 2,
      durationMs: 1000,
      rungResults: [
        { gate: "types", rung: "hygiene", layer: "functional", passed: true, exitCode: 0 },
      ],
    });
    writeFileSync(join(evDir, "ev_card_rv.json"), body);
    writeFileSync(join(evDir, "latest-card_rv.json"), body);
    await recordLedgerRun(store, {
      cardId: "card_rv",
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_card_rv",
      path: ".sekhemet/evidence/ev_card_rv.json",
      body,
      filesTouched: ["src/overtime.ts"],
    });
    // The events a real workspace's Activity log reads whose words came from
    // the type itself (FINDINGS_C1 rename pass; DB-N23-3): a sprint, a release,
    // a delegate, a check's result, a step budget and a field edit.
    await log.append({
      actor: "planner",
      type: "cycle/created",
      payload: {
        id: "cycle_9ca6e3c4",
        name: "Sprint 4",
        startsOn: "2026-09-25",
        endsOn: "2026-10-09",
      },
    });
    await log.append({
      actor: "planner",
      type: "slice/created",
      payload: { sliceId: "SLICE-1", projectId: "proj_ts", appetiteCards: 6, appetiteHours: 40 },
    });
    await store.delegateCard("card_todo", { kind: "worker" }, log.localPrincipal());
    await store.updateCard("card_todo", { priority: 2, estimate: 3 }, "human");
    await log.append({
      actor: "executor",
      type: "card/budget_set",
      cardId: "card_rv",
      payload: { id: "card_rv", from: 6, to: 5, reason: "passing attempts used 2 steps" },
    });
    await log.append({
      actor: "executor",
      type: "gate/result",
      cardId: "card_rv",
      payload: { cardId: "card_rv", gate: "unit", layer: "functional", passed: true, exitCode: 0 },
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
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
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#side").waitFor({ state: "attached" });
    return page;
  }

  /** The page's visible words, line by line, with each retired word found. */
  async function retiredOnPage(page: Page): Promise<string[]> {
    const text = await page.locator("body").innerText();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        // The Activity log's mono Type column shows the event's type, an
        // identifier the spec keeps (`gate/result`; DB-N23-3, "mono event
        // types unchanged"): the scan reads the words around it.
        const read = l.replace(/(?<![\w/])[a-z]+\/[a-z_]+(?![\w/])/g, " ");
        return [...retiredIn(read), ...rawRetiredIn(read)].map((h) => `${h} :: ${l}`);
      });
  }

  it(
    "R-01..R-40: no page a person opens says a retired word, server words included",
    { timeout: 120_000 },
    async () => {
      const routes = [
        "#/board",
        "#/review/card_rv",
        "#/status",
        "#/pm",
        "#/insights",
        "#/ledger",
        "#/playbook",
        "#/integrations",
        "#/machine",
        "#/configuration",
        "#/inbox",
        "#/projects",
        "#/card/card_rv",
        "#/card/card_rv/plan",
        "#/card/card_hold",
      ];
      const found: string[] = [];
      for (const route of routes) {
        const page = await open(route);
        // Let the view's reads land: its words stop changing (the live stream
        // keeps the network busy, so network idle never comes).
        let last = "";
        await expect
          .poll(
            async () => {
              const now = await page.locator("main, #main, body").first().innerText();
              const same = now === last && now.trim().length > 0;
              last = now;
              return same;
            },
            { timeout: 20_000, intervals: [400, 400, 600, 800] },
          )
          .toBe(true);
        for (const hit of await retiredOnPage(page)) found.push(`${route}: ${hit}`);
        await page.context().close();
      }
      expect(found).toEqual([]);
    },
  );

  it(
    "R-08, R-04, R-18: Review offers Request changes and Put on hold, under Needs you",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review/card_rv");
      const back = page.locator(".triage [data-back]");
      await back.waitFor();
      expect((await back.innerText()).trim()).toMatch(/^Request changes/);
      expect((await page.locator(".triage [data-park]").innerText()).trim()).toMatch(
        /^Put on hold/,
      );
      expect((await page.locator("#q-need").innerText()).trim()).toMatch(/^Needs you/);
      await page.context().close();
    },
  );

  it(
    "R-09: the Activity log is named so in the navigation and on its page",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/ledger");
      await expect.poll(() => page.locator("#top").innerText()).toContain("Activity log");
      expect(await page.locator("#side").innerText()).toContain("Activity log");
      expect(await page.locator("#side").innerText()).not.toMatch(/\bLedger\b/);
      await page.context().close();
    },
  );

  it(
    "DB-N23-3: the Activity log says a sprint, a release, a delegate, a check and a field edit in NAMING's words",
    { timeout: 60_000 },
    async () => {
      for (const width of [1440, 400]) {
        const page = await open("#/ledger", width);
        const sentences = page.locator("td.sentence");
        await sentences.first().waitFor();
        await expect
          .poll(async () => (await sentences.allInnerTexts()).join("\n"), { timeout: 10_000 })
          .toMatch(/created the sprint Sprint 4/);
        const text = (await sentences.allInnerTexts()).join("\n");
        for (const said of [
          /created a release/,
          /delegated Show the weekly total to the Agent/,
          /updated Show the weekly total \(priority, points\)/,
          /set the step budget of Flag hours past 40 in a week as overtime to 5/,
          /ran a check on Flag hours past 40 in a week as overtime · .+ passed/,
        ])
          expect(text, `${width} px`).toMatch(said);
        expect(text).not.toMatch(/\b(?:card|cycle|slice|gate)s?\b|\bepic id\b|\bcycle id\b/i);
        await page.context().close();
      }
    },
  );

  it("R-27, R-30: the Plan tab says Acceptance criteria and Files in scope", async () => {
    const page = await open("#/card/card_rv/plan");
    await expect
      .poll(() => page.locator("body").innerText(), { timeout: 20_000 })
      .toContain("Acceptance criteria");
    expect(await page.locator("body").innerText()).toContain("Files in scope");
    await page.context().close();
  });

  it("R-10: at 400 px the tab bar names Seshat, never PM", { timeout: 60_000 }, async () => {
    const page = await open("#/review", 400);
    const bar = page.locator("#tabbar");
    await bar.waitFor();
    const words = await bar.innerText();
    expect(words).toContain("Seshat");
    expect(words).not.toMatch(/\bPM\b/);
    await page.context().close();
  });
});
