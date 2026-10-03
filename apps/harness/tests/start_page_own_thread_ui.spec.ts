import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";

// DS-N7-1 in a workspace that already holds a project (DEC-57): the New
// project page is the start page's own conversation. Seshat's open proposals
// for the current project — a suggestion and a Create issue — are not shown
// there, so nothing on the New project page can apply them to the existing
// project; the Seshat panel on that project's board still shows them. A real
// Chromium at 1440 and 400 px against the real server over real SQLite;
// Seshat is a scripted adapter and no model is loaded.

type Server = { port: number; close: () => Promise<void> };
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const OLD = "Show overtime hours on each week's summary";

describe("the New project page holds its own conversation (DS-N7-1)", () => {
  let root: string;
  let db: DatabaseSync;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sek-start-own-")));
    const ws = join(root, "alpha");
    mkdirSync(join(ws, ".sekhemet"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: ws, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ada@example.com");
    git("config", "user.name", "Ada Lovelace");
    git("commit", "-q", "--allow-empty", "-m", "chore: empty");
    execFileSync("sh", ["-c", "echo .sekhemet/ > .git/info/exclude"], { cwd: ws });
    db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const alpha = await store.ensureProject({ rootPath: ws, name: "Alpha" });
    await store.createCard({ id: "a1", tier: "task", title: "Alpha's work", projectId: alpha.id });
    // The current project's conversation: an open Create issue proposal.
    await new PmStore(log).appendReply({
      replyTo: [],
      text: "The weekly summary leaves out overtime.",
      proposals: [
        {
          kind: "create_card",
          summary: `Create issue: ${OLD}`,
          cards: [{ title: OLD, spec: "Show the overtime hours on the weekly summary." }],
        },
      ],
      model: "planner",
    });
    const seshat = new MockInferenceAdapter(
      "scripted",
      [{ text: "Tell me about the new project.", toolCalls: [], usage }],
      { exhaustion: "cycle" },
    );
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: ws,
      port: 0,
      streamIntervalMs: 200,
      pressureLevel: () => 1,
      pmAdapter: () => seshat,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const width of [1440, 400]) {
    it(
      `shows none of the current project's proposals at ${width} px`,
      { timeout: 60_000 },
      async () => {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem("sekhemet-role", "code");
          } catch {}
        });
        const page = await ctx.newPage();
        try {
          // The proposal is there on the project's own conversation.
          await page.goto(`${base}/#/pm`);
          await expect
            .poll(() => page.locator(".pm-log").first().innerText(), { timeout: 15_000 })
            .toContain(OLD);
          await page.goto(`${base}/#/projects/new`);
          const convo = page.locator(".start-convo");
          await convo.locator("textarea").waitFor();
          // Loaded (the intro is the start page's), and the project's proposal is absent.
          await expect.poll(() => convo.locator(".pm-log").innerText()).not.toBe("");
          expect(await convo.innerText()).not.toContain(OLD);
          expect(await convo.getByRole("button", { name: /Apply|Discard/ }).count()).toBe(0);
          // Talking on the start page shows that conversation.
          await convo.locator("textarea").fill("A rota app for the kitchen staff");
          await convo.locator("textarea").press("Enter");
          await expect
            .poll(() => convo.innerText(), { timeout: 15_000 })
            .toContain("Tell me about the new project.");
          expect(await convo.innerText()).not.toContain(OLD);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
        } finally {
          await ctx.close();
        }
      },
    );
  }
});
