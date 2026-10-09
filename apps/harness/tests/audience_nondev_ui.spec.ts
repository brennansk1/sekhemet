import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type Seed, type Served, serveWorkspace } from "./support/audience.js";

/**
 * The non-developer's job (DEFINITION_OF_DONE §6.4; dashboard DB-P5-7,
 * DB-P5-2, DB-P5-3; design-stage DS-N7-1, DS-N7-2; W10): at 400 px, with no
 * terminal, start a new project and get its status in plain words.
 *
 * 1. The built `sekhemet serve` (`support/audience.ts`) over a workspace with
 *    work under way: the first-run answer *I manage the work* opens Status,
 *    which says how it is going in sentences, and *Start a new project* opens
 *    the start page naming its folder, where the sentence is taken. Its
 *    Seshat is the shipped Planning default, which this host has not got:
 *    the conversation names the missing model and Configuration › Models at
 *    once, never *The model is still loading* for ever (N0, c6 #3).
 * 2. Seshat answering: `serve`'s Seshat is the person's Planning model
 *    (N0, c6 #2), but a scripted one is an HTTP model the load guard
 *    refuses, so it is reached through the server module the command runs,
 *    `startDashboardServer`, over a real ledger in a real git repository:
 *    the same pages, start to *Create project* to Status.
 */

const W = 400;
const H = 860;
const SENTENCE =
  "a way for our office to lend laptops and cameras, seeing who has what and when it is due back";

/** What a non-developer must never be shown: an id, a command, a check's id. */
async function plainWords(page: Page): Promise<string> {
  const text = (await page.locator("#view").innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/\bcard_[a-z0-9_]+/);
  expect(text).not.toMatch(/\bsekhemet [a-z-]+/);
  expect(text).not.toMatch(/`[^`]+`/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    "no sideways scroll at 400 px",
  ).toBe(false);
  return text;
}

async function seed({ store, project }: Seed): Promise<void> {
  const card = async (id: string, title: string, status: string) => {
    const start = status === "backlog" || status === "ready" ? status : "ready";
    await store.createCard({
      id,
      tier: "task",
      title,
      status: start as never,
      projectId: project,
      scopeFiles: [`src/${id}.ts`],
    });
    if (status !== start)
      await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
  };
  await card("card_d1", "Export a week's entries as a spreadsheet", "done");
  await card("card_r1", "Show the weekly total on the timesheet", "review");
  await card("card_p1", "Work out the pay period of a date", "in_progress");
  await card("card_t1", "Pay public holidays at double time", "ready");
}

describe("a non-developer at 400 px, through `sekhemet serve` (DB-P5-7, DoD §6.4)", () => {
  let served: Served;
  let browser: Browser;

  beforeAll(async () => {
    served = await serveWorkspace({ seed, model: true });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await served?.stop();
  });

  it(
    "I manage the work opens Status in plain words, and Start a new project opens the start page, by touch",
    { timeout: 90_000 },
    async () => {
      const ctx = await browser.newContext({
        viewport: { width: W, height: H },
        hasTouch: true,
        isMobile: true,
      });
      const page = await ctx.newPage();
      await page.goto(served.base);
      await page.locator("#sk-firstrun").waitFor();
      await page.getByRole("button", { name: /^I manage the work/ }).tap();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/status");
      await page.locator("#view h1, #view h2").first().waitFor();
      const status = await plainWords(page);
      // The project's state as sentences: titles, never ids.
      expect(status).toContain("Show the weekly total on the timesheet");
      // Start a new project, at the top of Status (DS-N7-2).
      await page
        .getByRole("button", { name: /Start a new project/ })
        .first()
        .tap();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
      const ta = page.locator(".start-convo textarea");
      await ta.waitFor();
      await ta.fill(`Start a new project: ${SENTENCE}`);
      await ta.press("Enter");
      // The message is taken, in the conversation, with no command anywhere on the page.
      await expect
        .poll(async () => (await page.locator(".start-convo").innerText()).replace(/\s+/g, " "))
        .toContain(SENTENCE);
      expect(await page.locator(".start-convo").innerText()).toMatch(/Seshat/);
      await plainWords(page);
      // The folder the approval would create is named above the conversation (DS-N8-1).
      expect(await page.locator("#view").innerText()).toMatch(/Will be created in \S+/);
      // N0 (c6 #3): this host has no Seshat model (the shipped Planning default), and the
      // conversation says so with where to set it up, instead of "The model is still loading".
      await expect
        .poll(async () => (await page.locator(".start-convo").innerText()).replace(/\s+/g, " "), {
          timeout: 20_000,
        })
        .toMatch(/is not in Sekhemet's model list.*Configuration › Models/);
      expect(await page.locator(".start-convo").innerText()).not.toMatch(/still loading/);
      await plainWords(page);
      await ctx.close();
    },
  );
});

describe("a non-developer at 400 px starts a project and asks how it is going, Seshat answering (DB-P5-7, DS-N7-1)", () => {
  let dir: string;
  let configDir: string;
  let prevConfig: string | undefined;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sek-nondev-")));
    configDir = mkdtempSync(join(tmpdir(), "sek-nondev-config-"));
    prevConfig = process.env.SEKHEMET_CONFIG_DIR;
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ada@example.com");
    git("config", "user.name", "Ada Lovelace");
    git("commit", "-q", "--allow-empty", "-m", "chore: empty");
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    execFileSync("sh", ["-c", "echo .sekhemet/ > .git/info/exclude"], { cwd: dir });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const seshat = new MockInferenceAdapter(
      "scripted",
      [
        {
          text: "I've drafted a brief, the requirements and a plan beside this conversation.",
          toolCalls: [
            {
              id: "c1",
              name: "start_project",
              arguments: { brief: SENTENCE, reason: "you asked to start it" },
            },
          ],
          finishReason: "tool_calls",
          usage,
        },
        {
          text: "The plan is in place and nothing has shipped yet: the setup issue comes first, then the first test.",
          toolCalls: [],
          usage,
        },
      ],
      { exhaustion: "cycle" },
    );
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 200,
      pressureLevel: () => 1,
      pmAdapter: () => seshat,
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    else process.env.SEKHEMET_CONFIG_DIR = prevConfig;
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it(
    "Start a new project, send the sentence, Review plan, Create project, then Status and Ask, by touch at 400 px",
    { timeout: 120_000 },
    async () => {
      const ctx = await browser.newContext({
        viewport: { width: W, height: H },
        hasTouch: true,
        isMobile: true,
      });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.locator("#sk-firstrun").waitFor();
      await page.getByRole("button", { name: /^I manage the work/ }).tap();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/status");
      // An empty workspace: Status says so in words and offers the one thing to do.
      await expect
        .poll(async () => (await page.locator("#view").innerText()).replace(/\s+/g, " "))
        .toContain("No issues yet. Start a new project and Seshat plans the first ones with you.");
      await plainWords(page);
      await page
        .getByRole("button", { name: /Start a new project/ })
        .first()
        .tap();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
      const ta = page.locator(".start-convo textarea");
      await ta.waitFor();
      expect(await ta.inputValue()).toBe("Start a new project: ");
      await ta.fill(`Start a new project: ${SENTENCE}`);
      await ta.press("Enter");
      // Seshat answers with one proposal: the plan, to review.
      const review = page.locator(".start-convo [data-review-plan]").first();
      await review.waitFor({ timeout: 30_000 });
      const convo = (await page.locator(".start-convo").innerText()).replace(/\s+/g, " ");
      expect(convo).toMatch(/Review the plan: 1 epic and \d+ issues/);
      await plainWords(page);
      expect(await store.listCards()).toHaveLength(0);
      // Review plan, then Create project: the issues exist, and the person lands on Status.
      await review.tap();
      // One dialog, the start page's (with the draft's choices and folder).
      const dialog = page.locator(".rp-dialog");
      await dialog.first().waitFor();
      await page.waitForTimeout(300);
      expect(await dialog.count()).toBe(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);
      await dialog.locator("[data-create]").tap();
      await expect
        .poll(async () => (await store.listCards()).filter((c) => c.tier !== "epic").length)
        .toBeGreaterThan(2);
      await expect.poll(() => new URL(page.url()).hash).toBe("#/status");
      // How it is going, in plain words: titles and counts, no ids, no commands.
      await expect
        .poll(async () => (await page.locator("#view").innerText()).replace(/\s+/g, " "))
        .toMatch(/0 of \d+ issues done/);
      const status = await plainWords(page);
      const first = (await store.listCards()).find((c) => /^Set the project up with/.test(c.title));
      expect(first, "the setup issue").toBeDefined();
      expect(status).not.toContain(first?.id as string);
      // And to Seshat, in words, from Status's Ask box.
      const ask = page.locator("form[data-ask] input");
      await ask.fill("How is it going?");
      await ask.press("Enter");
      await expect
        .poll(async () => (await page.locator("body").innerText()).replace(/\s+/g, " "), {
          timeout: 30_000,
        })
        .toContain("The plan is in place and nothing has shipped yet");
      await plainWords(page);
      await ctx.close();
    },
  );
});
