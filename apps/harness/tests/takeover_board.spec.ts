import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { startDashboardServer } from "../src/server.js";
import { runTakeover } from "../src/takeover.js";
import { buildTakeoverFixture, fakeTracker } from "./takeover_fixtures.js";

// DS-TO-16 (dashboard item 10) in a real Chromium: a board with no cards
// offers Take over a project beside Start a project, and pressing it opens
// Seshat and starts the take-over of this repository (recon only: it is not
// trusted). No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("the empty board's Start and Take over (DS-TO-16)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let server: Server;
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-takeover-board-"));
    writeGguf(join(dir, "models", "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama" });
    const user = join(dir, "user.toml");
    writeFileSync(user, '[team]\nmode = "solo"\n');
    vi.stubEnv("SEKHEMET_USER_CONFIG", user);
    vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "models"));
    vi.stubEnv("SEKHEMET_TRUST_DIR", join(dir, "trust"));
    const root = join(dir, "repo");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), "# Shop\n\n- Lists orders\n");
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      streamIntervalMs: 1000,
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "offers both, and Take over opens Seshat with the take-over",
    { timeout: 60_000 },
    async () => {
      const page = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage();
      await page.goto(`http://127.0.0.1:${server.port}/#/board`);
      const empty = page.locator(".board-empty");
      await empty.waitFor();
      const start = empty.getByRole("button", { name: "Start a project" });
      const takeOver = empty.getByRole("button", { name: "Take over a project" });
      expect(await start.isVisible()).toBe(true);
      expect(await takeOver.isVisible()).toBe(true);
      // Start a project opens Seshat with the words ready to finish, not sent.
      await start.click();
      await page.waitForFunction(() => document.body.classList.contains("pm-open"));
      expect(await page.locator("aside textarea").first().inputValue()).toBe("Start a project: ");
      const posted = page.waitForResponse(
        (r) => r.url().endsWith("/api/takeover") && r.request().method() === "POST",
      );
      await takeOver.click();
      const res = await posted;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { trusted: boolean; inventory: { findings: unknown[] } };
      expect(body.trusted).toBe(false);
      expect(await log.getEventsByTypes(["takeover/inventory"])).toHaveLength(1);
      // Seshat says what it found in the thread, with no repository text in it (DS-TO-10).
      const [reply] = await log.getEventsByTypes(["pm/reply"]);
      const said = (reply?.payload as { text: string }).text;
      expect(said).toMatch(/^I read the repository as it is: \d+ finding/);
      expect(said).not.toContain("Lists orders");
      await page.close();
    },
  );
});

// The take-over's routes (PM_CONTRACT §0): the records as the person sees
// them, the approval that creates the cards, and a reconciliation dismissed
// by a person. The take-over itself ran trusted, on the same ledger.
describe("the take-over routes (DS-TO-11 to DS-TO-14)", () => {
  it(
    "shows the records, approves the plan into cards, and dismisses a reconciliation",
    { timeout: 60_000 },
    async () => {
      const trust = mkdtempSync(join(tmpdir(), "sek-takeover-routes-trust-"));
      vi.stubEnv("SEKHEMET_TRUST_DIR", trust);
      const fx = buildTakeoverFixture("inherited-issues");
      const dbDir = mkdtempSync(join(tmpdir(), "sek-takeover-routes-"));
      const db = new DatabaseSync(join(dbDir, "events.db"));
      initSchema(db);
      const log = new EventLog(db);
      const cardStore = new CardStore(db, log);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(cardStore),
        cardStore,
        repoPath: fx.root,
        port: 0,
        streamIntervalMs: 1000,
      });
      try {
        await runTakeover(fx.root, {
          store: cardStore,
          log,
          principal: "p_owner",
          trusted: true,
          gitleaks: false,
          osvScanner: false,
          tracker: fakeTracker(fx.issues),
          say: () => undefined,
        });
        const base = `http://127.0.0.1:${server.port}`;
        const headers = { "Content-Type": "application/json", "X-Sekhemet-Action": "1" };
        const state = (await (await fetch(`${base}/api/takeover`)).json()) as {
          brief: { claims: { text: string; label: string }[] };
          backlog: { proposalId: string; approved: boolean; cards: unknown[] };
          reconciliations: { id: string }[];
        };
        expect(state.brief.claims.map((c) => [c.text, c.label])).toEqual([
          ["Rounds totals to cents", "proven"],
        ]);
        expect(state.backlog).toMatchObject({ proposalId: "TOP-1", approved: false });
        expect(state.reconciliations.map((r) => r.id)).toEqual(["REC-1"]);
        // A write without the action header is refused, and creates nothing.
        const bare = await fetch(`${base}/api/takeover/approve`, {
          method: "POST",
          body: JSON.stringify({ proposalId: "TOP-1" }),
        });
        expect(bare.status).toBe(403);
        expect(await cardStore.listCards()).toHaveLength(0);
        const approved = await fetch(`${base}/api/takeover/approve`, {
          method: "POST",
          headers,
          body: JSON.stringify({ proposalId: "TOP-1" }),
        });
        expect(approved.status).toBe(200);
        const { cards } = (await approved.json()) as { cards: string[] };
        // The plan's epic holds the cards the pipeline planned (PM-P1-1).
        const stories = (await cardStore.listCards()).filter((c) => c.tier !== "epic");
        expect(stories.map((c) => c.id).sort()).toEqual([...cards].sort());
        const dismissed = await fetch(`${base}/api/takeover/reconciliation/dismiss`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "REC-1" }),
        });
        expect(dismissed.status).toBe(200);
        expect((await cardStore.reconciliation.get("REC-1"))?.state).toBe("dismissed");
        // Applying needs a connected tracker: this repository has none.
        const applied = await fetch(`${base}/api/takeover/reconciliation/apply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "REC-1" }),
        });
        expect(applied.status).toBe(409);
      } finally {
        await server.close();
        db.close();
        for (const d of [trust, fx.root, dbDir]) rmSync(d, { recursive: true, force: true });
      }
    },
  );
});
