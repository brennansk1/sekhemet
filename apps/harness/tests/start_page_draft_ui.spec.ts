import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

// The start page in a real Chromium against the real server over real SQLite
// and a real git repository (C2a, the start-server builder; DEFINITION_OF_DONE
// §2A), design-stage §2.11, NEW-design-stage-7:
// - DS-N7-1: New project (Projects, the switcher, Status, the palette) opens
//   #/projects/new, the conversation beside a live draft that shows only the
//   parts Seshat has drafted, and Review plan once a plan exists;
// - DS-N7-2: at 400 px the draft is a tab beside the conversation, and New
//   project is at the top of Projects and of Status;
// - DS-N7-3: the Seshat panel keeps its Start a new project starter;
// - DS-N7-5: while the draft is shown, nothing is created — no issue, no
//   project, no brief, no repository file — until the plan is approved.
// Seshat is a scripted adapter that answers every message with a
// `start_project` call; no model is loaded.

type Server = { port: number; close: () => Promise<void> };

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const SENTENCE =
  "a way for our office to lend laptops and cameras, seeing who has what and when it is due back";

describe("the start page with a live draft (C2a start-server, NEW-design-stage-7)", () => {
  let dir: string;
  let configDir: string;
  let prevConfig: string | undefined;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-start-c2a-"));
    configDir = mkdtempSync(join(tmpdir(), "sek-start-c2a-config-"));
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
      repoPath: dir,
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
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  async function open(
    hash: string,
    width = 1440,
    seed: Record<string, string> = {},
  ): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((s) => {
      try {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem("sekhemet-role", "code");
          for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
        }
        sessionStorage.setItem("seeded", "1");
      } catch {}
    }, seed);
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    return { ctx, page };
  }

  const gitStatus = () =>
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: dir,
      encoding: "utf8",
    });
  const eventTypes = () =>
    (db.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[]).map(
      (r) => r.type,
    );

  it("DS-N7-3: the Seshat panel keeps its Start a new project starter; the empty board opens the start page", async () => {
    const { ctx, page } = await open("#/board", 1440, { "sekhemet-pm-panel": "open" });
    const starter = page.locator(".pm-dock [data-starter]", { hasText: "Start a new project" });
    await starter.waitFor();
    expect(await starter.getAttribute("data-starter")).toBe("Start a new project: ");
    // The empty board's Start a project opens the start page (dashboard item 10).
    await page.locator("[data-empty-action=start]").click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
    await ctx.close();
  });

  it(
    "DS-N7-1, DS-N7-5: New project opens the start page; the draft grows as Seshat drafts, and nothing is created before approval",
    { timeout: 90_000 },
    async () => {
      // DS-N7-1: an empty folder can hold a new project; the page asks before drafting.
      const check = await fetch(`${base}/api/projects/new`);
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ allowed: true });
      const { ctx, page } = await open("#/projects", 1440, { "sekhemet-pm-panel": "open" });
      // The Projects page's New project (here its empty state) opens the start page.
      await page.locator(".pj [data-new]").click();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
      const convo = page.locator(".start-convo");
      const draft = page.locator(".start-draft");
      await convo.locator("textarea").waitFor();
      // The conversation beside the draft: two halves, the draft on the right.
      const [c, d] = [await convo.boundingBox(), await draft.boundingBox()];
      expect(c && d && d.x >= c.x + c.width - 1).toBe(true);
      expect(d && d.width > 300).toBe(true);
      // The page is the conversation: the dock does not repeat it beside the page.
      expect(await page.locator(".pm-dock").count()).toBe(0);
      expect(await page.locator("#top h1").innerText()).toBe("New project");
      expect(await draft.locator("h2").innerText()).toBe("Draft · updates as you talk");
      // Nothing drafted yet: no part shown as empty, Review plan waits with its reason.
      expect(await draft.locator("[role=tab]").count()).toBe(0);
      const review = draft.locator("[data-review-plan]");
      expect(await review.isDisabled()).toBe(true);
      expect(await draft.locator(".start-foot").innerText()).toContain(
        "Review plan opens once Seshat has drafted a plan.",
      );
      // One primary action on the page: Review plan (§2.11 item 7).
      expect(await page.locator("#view .btn.primary").count()).toBe(1);

      // The composer is ready to start a project; the person finishes the sentence and sends.
      const ta = convo.locator("textarea");
      expect(await ta.inputValue()).toBe("Start a new project: ");
      const gitBefore = gitStatus();
      const typesBefore = eventTypes().length;
      await ta.fill(`Start a new project: ${SENTENCE}`);
      await ta.press("Enter");

      // The live draft: Brief, Requirements and Plan, as far as they exist.
      const tabs = draft.locator("[role=tablist] [role=tab]");
      await expect.poll(() => tabs.count(), { timeout: 30_000 }).toBe(3);
      expect((await tabs.allInnerTexts()).map((t) => t.replace(/\s+\d+$/, "").trim())).toEqual([
        "Brief",
        "Requirements",
        "Plan",
      ]);
      const brief = await draft.locator("[role=tabpanel]").innerText();
      // Only filled sections: none is shown empty (Review plan's "Not stated." placeholder).
      expect(brief).not.toMatch(/^Not stated\.$/m);
      expect(brief).toContain("Problem");
      // The brief's emphasis reads as emphasis, not as asterisks.
      expect(brief).not.toContain("*");
      expect(await review.isDisabled()).toBe(false);
      // §2.11 item 7: one primary action in dark ink; the thread's own Review plan is secondary here.
      const inks = await page.evaluate(() =>
        [...document.querySelectorAll("#view [data-review-plan]")].map(
          (b) => getComputedStyle(b).backgroundColor,
        ),
      );
      expect(inks.length).toBe(2);
      expect(new Set(inks).size).toBe(2);
      const summary = await draft.locator(".start-foot").innerText();
      expect(summary).toMatch(/Release 1: \d+ requirements? · about \d+ issues?/);

      // DS-N7-5: the draft exists and nothing else does.
      expect(await store.listCards()).toHaveLength(0);
      expect(existsSync(join(dir, "docs", "product"))).toBe(false);
      expect(gitStatus()).toBe(gitBefore);
      const added = eventTypes().slice(typesBefore);
      expect(added.filter((t) => /^(card|project|requirement|brief|epic)\//.test(t))).toEqual([]);

      // Requirements: Remove one; Review plan opens with that choice.
      await tabs.nth(1).click();
      const first = draft.locator("[data-cand]").first();
      const key = await first.getAttribute("data-cand");
      await first.locator("[data-remove]").click();
      await expect
        .poll(() => draft.locator(`[data-cand="${key}"]`).innerText())
        .toContain("Removed");
      await tabs.nth(2).click();
      expect(await draft.locator("[role=tabpanel]").innerText()).toMatch(/Release 1/);
      await review.click();
      const dialog = page.locator(".rp-dialog");
      await dialog.waitFor();
      expect(await dialog.locator(`[data-cand="${key}"]`).innerText()).toContain("Removed");
      // Keep talking returns to the conversation, creating nothing.
      await dialog.locator("[data-keep-talking]").click();
      await expect.poll(() => page.locator(".rp-dialog").count()).toBe(0);
      expect(await store.listCards()).toHaveLength(0);

      // DS-N7-2: at 400 px the draft is a tab beside the conversation.
      await page.setViewportSize({ width: 400, height: 860 });
      const pageTabs = page.locator(".start-tabs [role=tab]");
      await expect.poll(() => pageTabs.allInnerTexts()).toEqual(["Conversation", "Draft"]);
      expect(await page.locator(".start-convo").isVisible()).toBe(true);
      expect(await draft.isVisible()).toBe(false);
      await pageTabs.nth(1).click();
      expect(await page.locator(".start-convo").isVisible()).toBe(false);
      expect(await draft.isVisible()).toBe(true);
      expect(await draft.locator("[role=tablist] [role=tab]").count()).toBe(3);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);
      expect(
        await draft.evaluate((d) => {
          const r = d.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth + 1;
        }),
      ).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => page.locator(".start-convo").isVisible()).toBe(true);

      // Approval (Solo: Create project) is what creates the project and its issues.
      await review.click();
      await page.locator(".rp-dialog [data-create]").click();
      await expect.poll(async () => (await store.listCards()).length).toBeGreaterThan(2);
      await expect.poll(() => new URL(page.url()).hash).toBe("#/status");
      await ctx.close();
    },
  );

  it(
    "DS-N7-1 (DEC-57): in a folder that already holds a project, New project says so before any drafting and offers /plan",
    { timeout: 90_000 },
    async () => {
      // The server says it first: this folder cannot hold a second project.
      const check = (await (await fetch(`${base}/api/projects/new`)).json()) as {
        allowed: boolean;
        reason?: string;
      };
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(
        /^This folder already holds the project ".+", with .+: plan the next piece of work with \/plan instead\.$/,
      );
      for (const [from, width, button] of [
        ["#/projects", 1440, ".pj-head [data-new]"],
        ["#/projects", 400, ".pj-head [data-new]"],
        ["#/status", 400, ".stp [data-new-project]"],
      ] as const) {
        const { ctx, page } = await open(from, width);
        const top = page.locator(button);
        await top.waitFor();
        const box = await top.boundingBox();
        expect(box && box.y < 260, `${from} ${width}`).toBe(true);
        await top.click();
        await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
        const blocked = page.locator(".start-blocked");
        await blocked.waitFor();
        expect(await blocked.locator("h2").innerText()).toBe("This folder already holds a project");
        expect(await blocked.innerText()).toContain(check.reason as string);
        // No conversation to invest in, and no other thread's proposal to apply here.
        expect(await page.locator(".start-convo textarea").count()).toBe(0);
        expect(await page.locator("#view [data-apply], #view .pm-proposal").count()).toBe(0);
        // §2.11 item 7: one primary action — plan the next piece of work.
        const primary = page.locator("#view .btn.primary");
        expect(await primary.count()).toBe(1);
        expect(await primary.innerText()).toBe("Plan the next piece of work");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          ),
        ).toBe(false);
        await primary.click();
        await expect
          .poll(() => page.locator("textarea:visible").first().inputValue())
          .toBe("/plan ");
        await ctx.close();
      }
    },
  );

  it("DS-N7-1: the switcher's New project and the palette's Start a new project open the start page", async () => {
    const { ctx, page } = await open("#/board", 1440);
    const sw = page.locator("#side [data-project-switch]");
    await sw.waitFor();
    await sw.click();
    await page.locator("[data-new-project]").click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
    await page.locator(".start-blocked").waitFor();
    await page.goto(`${base}/#/board`);
    await page.locator("#side").waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.locator(".palette input, [role=combobox]").first();
    await input.waitFor();
    await input.fill("new project");
    await page
      .getByRole("option", { name: /Start a new project/ })
      .first()
      .click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/projects/new");
    await ctx.close();
  });
});
