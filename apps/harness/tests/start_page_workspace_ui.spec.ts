import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { readLocator } from "../src/workspace_locator.js";

// New project in a workspace of many, in a real Chromium against the real
// server over real SQLite and real git repositories (DEC-57; design-stage
// DS-N8-1..3, dashboard DB-N26-1, teams TEAM-54, -55, -56, -60):
// - the start page names the folder its approval creates, above the
//   conversation, at 1440 and 400 px, and the person may change it;
// - a folder that holds a project is said before approval, with Open it, and
//   Review plan waits; one nested in a project's root is refused too;
// - approval creates the chosen folder with git init and records the project;
// - Add an existing repository refuses a folder that is no repository and
//   takes over one that is, opening the board with Seshat.
// Seshat is a scripted adapter; no model is loaded.

type Server = { port: number; close: () => Promise<void> };
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const SENTENCE = "a timesheet app for a small team that applies our overtime rules";

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ada@example.com");
  git("config", "user.name", "Ada Lovelace");
  git("commit", "-q", "--allow-empty", "-m", "chore: empty");
  return realpathSync(dir);
}

describe("the start page in a workspace of many projects (DS-N8-1..3, DB-N26-1)", () => {
  let root: string;
  let ws: string;
  let configDir: string;
  let prevConfig: string | undefined;
  let prevTrust: string | undefined;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sek-start-ws-")));
    configDir = mkdtempSync(join(tmpdir(), "sek-start-ws-config-"));
    prevConfig = process.env.SEKHEMET_CONFIG_DIR;
    prevTrust = process.env.SEKHEMET_TRUST_DIR;
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    process.env.SEKHEMET_TRUST_DIR = join(configDir, "trust");
    // The workspace folder is project Alpha's root, as on every install before DEC-57.
    ws = gitRepo(join(root, "alpha"));
    mkdirSync(join(ws, ".sekhemet"), { recursive: true });
    execFileSync("sh", ["-c", "echo .sekhemet/ > .git/info/exclude"], { cwd: ws });
    db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    const alpha = await store.ensureProject({ rootPath: ws, name: "Alpha" });
    // Alpha has work, so New project is another project in a new folder (DS-N8-1).
    await store.createCard({ id: "a1", tier: "task", title: "Alpha's work", projectId: alpha.id });
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
      ],
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
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    else process.env.SEKHEMET_CONFIG_DIR = prevConfig;
    if (prevTrust === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_TRUST_DIR");
    else process.env.SEKHEMET_TRUST_DIR = prevTrust;
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  async function open(hash: string, width: number): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    return { ctx, page };
  }

  const noSideScroll = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );

  it(
    "names the folder, refuses one that holds or nests in a project before approval, and approval creates the chosen folder",
    { timeout: 120_000 },
    async () => {
      const { ctx, page } = await open("#/projects/new", 1440);
      const place = page.locator(".start-place");
      const line = place.locator("[data-folder-line]");
      await page.locator(".start-convo textarea").waitFor();
      // DS-N8-1: named before any draft, under the projects folder (beside Alpha).
      await expect.poll(() => line.innerText()).toMatch(/^Will be created in /);
      // The place sits above the conversation, across the page.
      const [p, c] = [await place.boundingBox(), await page.locator(".start-convo").boundingBox()];
      expect(p && c && p.y + p.height <= c.y + 1).toBe(true);
      expect(
        await place.getByRole("button", { name: "Add an existing repository" }).isVisible(),
      ).toBe(true);

      // Seshat drafts; the folder is the draft's.
      const ta = page.locator(".start-convo textarea");
      await ta.fill(`Start a new project: ${SENTENCE}`);
      await ta.press("Enter");
      const review = page.locator(".start-draft [data-review-plan]");
      await expect.poll(() => review.isDisabled(), { timeout: 30_000 }).toBe(false);
      // The draft's name as a folder, cut at 48 characters (`folderNameOf`).
      await expect
        .poll(() => line.innerText())
        .toBe(
          `Will be created in ${join(root, "a-timesheet-app-for-a-small-team-that-applies-ou")}`,
        );

      // DS-N8-3: Alpha's own folder is refused before approval, with Open it.
      const change = async (folder: string) => {
        await place.getByRole("button", { name: "Change folder" }).click();
        const input = page.locator("#sp-folder-in");
        await input.fill(folder);
        await input.press("Enter");
      };
      await change(ws);
      const refusal = place.locator(".sp-refusal");
      await expect.poll(() => refusal.innerText()).toContain("already holds the project Alpha");
      expect(await refusal.getByRole("button", { name: "Open it" }).isVisible()).toBe(true);
      await expect.poll(() => review.isDisabled()).toBe(true);
      expect(await page.locator(".start-foot").innerText()).toContain("Alpha");
      // TEAM-60: a folder inside Alpha's root is refused, naming Alpha.
      await change(join(ws, "packages", "web"));
      await expect
        .poll(() => refusal.innerText())
        .toContain("lies inside the folder of the project Alpha");
      expect(await refusal.getByRole("button", { name: "Open it" }).count()).toBe(1);

      // A free folder: the refusal goes and Review plan opens; approval creates it.
      const chosen = join(root, "chronicle");
      await change(chosen);
      await expect.poll(() => line.innerText()).toBe(`Will be created in ${chosen}`);
      await expect.poll(() => refusal.count()).toBe(0);
      await expect.poll(() => review.isDisabled()).toBe(false);
      expect(existsSync(chosen)).toBe(false);
      await review.click();
      await page.locator(".rp-dialog [data-create]").click();
      await expect.poll(() => new URL(page.url()).hash, { timeout: 30_000 }).toBe("#/status");
      // TEAM-54: the folder, git init with one commit, the project and its locator.
      expect(
        execFileSync("git", ["rev-list", "--count", "main"], {
          cwd: chosen,
          encoding: "utf8",
        }).trim(),
      ).toBe("1");
      expect(readLocator(chosen)?.workspaceFolder).toBe(ws);
      const project = store.listProjects().find((x) => x.rootPath === chosen);
      expect(project).toBeDefined();
      expect(
        (await store.listCards())
          .filter((x) => x.id !== "a1")
          .every((x) => x.projectId === project?.id),
      ).toBe(true);
      await ctx.close();
    },
  );

  it(
    "at 400 px the place bar fits, and Add an existing repository refuses a folder that is no repository and takes over one that is",
    { timeout: 120_000 },
    async () => {
      const { ctx, page } = await open("#/projects/new", 400);
      const place = page.locator(".start-place");
      await expect
        .poll(() => place.locator("[data-folder-line]").innerText())
        .toMatch(/^Will be created in /);
      expect(await noSideScroll(page)).toBe(true);
      const box = await place.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 401).toBe(true);
      await place.getByRole("button", { name: "Add an existing repository" }).click();
      const input = page.locator("#sp-repo-in");
      const plain = join(root, "plain");
      mkdirSync(plain, { recursive: true });
      await input.fill(plain);
      await input.press("Enter");
      await expect
        .poll(() => place.locator("[data-repo-form] .sp-refusal").innerText())
        .toContain("is not a git repository");
      expect(await noSideScroll(page)).toBe(true);
      // A repository with code: Seshat reads it as it is (untrusted: recon only).
      const legacy = gitRepo(join(root, "legacy"));
      execFileSync(
        "sh",
        [
          "-c",
          "mkdir -p src && echo 'export const a = 1;' > src/a.ts && git add -A && git commit -qm feat",
        ],
        { cwd: legacy },
      );
      await page.locator("#sp-repo-in").fill(legacy);
      const posted = page.waitForResponse(
        (r) => r.url().endsWith("/api/takeover") && r.request().method() === "POST",
      );
      await page.locator("#sp-repo-in").press("Enter");
      const res = await posted;
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { path: string }).path).toBe(legacy);
      await expect.poll(() => new URL(page.url()).hash).toBe("#/board");
      // No project yet: it is one when its plan is approved (TEAM-56).
      expect(store.listProjects().some((x) => x.rootPath === legacy)).toBe(false);
      await ctx.close();
    },
  );
});
