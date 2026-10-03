import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// NEW-dashboard-21 in a real Chromium against a real Solo server, a real
// repository and a real ledger (FINDINGS ISS-04; dashboard §2.6 *Issue
// actions*, §2.4.23, §2.5.10): the issue page's `⋯` menu offers Won't do (a
// reason required, Undo with `z`), Reopen, and Revert (a confirmation naming
// the commit; a revert git cannot apply names its files and leaves the issue
// in Done); a disabled Revert says who may; the palette offers the same
// actions. At 1440 and 400 px. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("Won't do, Reopen and Revert in the dashboard (NEW-dashboard-21)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;
  const shas: Record<string, string> = {};
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  async function builtInReview(id: string, title: string, file: string): Promise<void> {
    const adapter = new NodeGitSyncAdapter(repo);
    await store.createCard({ id, tier: "story", title, scopeFiles: ["src/**"] });
    const wt = await adapter.createWorktree(id, "main", title);
    write(wt, file, `export const v = "${id}";\n`);
    await adapter.commitCheckpoint({
      cardId: id,
      step: 1,
      gateStatus: "pass",
      agentModel: "stand-in",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const evidence = {
      id: `ev_${id}`,
      cardId: id,
      attempt: 1,
      passed: true,
      rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
      filesTouched: [file],
      linesAdded: 1,
      linesRemoved: 0,
      diff: "",
      settings: { modelId: "stand-in" },
      stopReason: "gate_passed",
      repoState: await adapter.getRepoStateHash(id),
    };
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(join(repo, ".sekhemet", "evidence", `ev_${id}.json`), body);
    writeFileSync(join(repo, ".sekhemet", "evidence", `latest-${id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: `ev_${id}`,
      path: join(".sekhemet", "evidence", `ev_${id}.json`),
      body,
      filesTouched: [file],
    });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  }

  async function post(path: string, body: unknown = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  async function accepted(id: string, file: string): Promise<void> {
    expect((await post(`/api/cards/${id}/opened`, { filesShown: [file] })).status).toBe(200);
    const res = await post(`/api/cards/${id}/accept`);
    expect(res.status, String(res.data.error)).toBe(200);
    shas[id] = String(res.data.sha);
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-issue-actions-ui-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    write(repo, "src/a.ts", "export const a = 1;\n");
    write(repo, ".gitignore", ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "card_todo", tier: "story", title: "Round hours to the quarter" });
    await store.createCard({ id: "card_phone", tier: "story", title: "Show the week's total" });
    await store.createCard({ id: "card_closed", tier: "story", title: "Import from Harvest" });
    await builtInReview("card_done", "Export a week's entries as CSV", "src/csv.ts");
    await builtInReview("card_clash", "Flag hours past 40 as overtime", "src/overtime.ts");
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    expect(
      (await post("/api/cards/card_closed/reject", { reason: "Harvest is out of scope" })).status,
    ).toBe(200);
    await accepted("card_done", "src/csv.ts");
    await accepted("card_clash", "src/overtime.ts");
    // A later change on main to the same file: card_clash's revert cannot apply.
    git("reset", "-q", "--hard", "main");
    write(repo, "src/overtime.ts", 'export const v = "changed later";\n');
    git("commit", "-q", "-am", "a later change to overtime");
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  async function open(hash: string, width: number, height = 900): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator(".cv-h .ttl, #view .view-host").first().waitFor();
    await page.waitForTimeout(600);
    return page;
  }

  const status = async (id: string) => (await store.getCard(id))?.status;
  const noSideScroll = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  it(
    "DB-N21-1: at 1440 px the ⋯ menu offers Won't do, which needs a reason, and z undoes it",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_todo", 1440);
      await page.locator(".cv-h [data-issue-more]").click();
      const menu = page.locator(".ia-menu");
      await menu.waitFor();
      expect(await menu.locator("[role=menuitem]").allInnerTexts()).toEqual(["Won't do"]);
      expect(await menu.innerText()).toContain(
        "Closes the issue without building it. You can reopen it.",
      );
      await menu.locator('[data-ia="wontdo"]').click();
      const form = page.locator(".ia-pop");
      await form.waitFor();
      // A reason is required: an empty submit says so and sends nothing.
      await form.locator("button[type=submit]").click();
      await expect.poll(() => form.locator(".err").isVisible()).toBe(true);
      expect(await form.locator(".err").innerText()).toMatch(/Add a reason/);
      expect(await status("card_todo")).toBe("ready");
      await form.locator("input").fill("Rounding is decided by payroll, not here");
      await form.locator("input").press("Enter");
      const toast = page.locator(".toast", { hasText: "Marked Won't do" });
      await toast.waitFor();
      expect(await toast.innerText()).toMatch(/Undo/);
      await expect.poll(() => status("card_todo")).toBe("rejected");
      // §2.4.23: z within 10 s undoes it with a compensating Reopen.
      await page.locator("body").press("z");
      await page.locator(".toast", { hasText: "Reopened. It is back in To do." }).waitFor();
      await expect.poll(() => status("card_todo")).toBe("ready");
      const moves = (await store.cardEvents("card_todo", ["card/status_changed"])).map(
        (e) => (e.payload as { toStatus?: string }).toStatus,
      );
      expect(moves.slice(-2)).toEqual(["rejected", "ready"]);
      await page.context().close();
    },
  );

  it(
    "DB-N21-2: at 400 px a Won't do issue offers Reopen, with no side scroll, and Won't do's form fits",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_closed", 400, 800);
      await page.locator(".cv-h [data-issue-more]").click();
      const menu = page.locator(".ia-menu");
      await menu.waitFor();
      expect(await menu.locator("[role=menuitem]").allInnerTexts()).toEqual(["Reopen"]);
      const box = await menu.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(400);
      await menu.locator('[data-ia="reopen"]').click();
      await page.locator(".toast", { hasText: "Reopened. It is back in To do." }).waitFor();
      await expect.poll(() => status("card_closed")).toBe("ready");
      expect(await noSideScroll(page)).toBe(true);
      await page.context().close();

      const phone = await open("#/card/card_phone", 400, 800);
      await phone.locator(".cv-h [data-issue-more]").click();
      await phone.locator('.ia-menu [data-ia="wontdo"]').click();
      const form = phone.locator(".ia-pop");
      await form.waitFor();
      const f = await form.boundingBox();
      expect(f?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((f?.x ?? 0) + (f?.width ?? 0)).toBeLessThanOrEqual(400);
      expect(await noSideScroll(phone)).toBe(true);
      await form.locator("[data-cancel]").click();
      expect(await status("card_phone")).toBe("ready");
      await phone.context().close();
    },
  );

  it(
    "DB-N21-3: Revert is disabled with who may revert when the Accept rule does not name the viewer",
    { timeout: 60_000 },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      // The desk as a Team server answers a person the rule does not name.
      await page.route("**/api/cards/card_done/review", async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        await route.fulfill({
          response: res,
          json: {
            ...body,
            revert: { may: false, who: [{ principal: "p_ada", name: "Ada Admin" }] },
          },
        });
      });
      await page.goto(`${base}/#/card/card_done`);
      await page.locator(".cv-h .ttl").waitFor();
      await page.locator(".cv-h [data-issue-more]").click();
      const item = page.locator('.ia-menu [data-ia="revert"]');
      await item.waitFor();
      expect(await item.isDisabled()).toBe(true);
      const why = await page.locator("#ia-why-revert").innerText();
      expect(why).toBe("Only Ada Admin can revert it: the Accept rule names them.");
      expect(await status("card_done")).toBe("done");
      await ctx.close();
    },
  );

  it(
    "DB-N21-3: Revert confirms naming the commit, then adds a revert commit and moves the issue to To do",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_done", 1440);
      const before = git("rev-parse", "main");
      await page.locator(".cv-h [data-issue-more]").click();
      await page.locator('.ia-menu [data-ia="revert"]').click();
      const dialog = page.locator(".ia-pop[role=alertdialog]");
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain(
        `Revert adds a commit to main that undoes ${String(shas.card_done).slice(0, 7)}, and moves this issue back to To do.`,
      );
      // Nothing happens before the confirmation.
      expect(git("rev-parse", "main")).toBe(before);
      await dialog.locator("[data-confirm-revert]").click();
      await page.locator(".toast", { hasText: "Reverted as" }).waitFor();
      await expect.poll(() => status("card_done")).toBe("ready");
      expect(git("rev-parse", "main^")).toBe(before);
      const reverted = await store.cardEvents("card_done", ["card/reverted"]);
      expect(reverted.at(-1)?.payload).toMatchObject({
        sha: shas.card_done,
        revertSha: git("rev-parse", "main"),
      });
      await page.context().close();
    },
  );

  it(
    "DB-N21-4: a revert git cannot apply leaves the issue in Done and the toast names the file",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_clash", 1440);
      const before = git("rev-parse", "main");
      await page.locator(".cv-h [data-issue-more]").click();
      await page.locator('.ia-menu [data-ia="revert"]').click();
      await page.locator("[data-confirm-revert]").click();
      const toast = page.locator(".toast.fail", { hasText: "Couldn't revert" });
      await toast.waitFor();
      const words = await toast.innerText();
      expect(words).toContain("The issue stays in Done.");
      expect(words).toContain("src/overtime.ts");
      expect(git("rev-parse", "main")).toBe(before);
      expect(await status("card_clash")).toBe("done");
      await page.context().close();
    },
  );

  it(
    "§2.5.10: the palette offers the focused issue's Won't do, in NAMING's words",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_phone", 1440);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      const input = page.locator(".palette input");
      await input.waitFor();
      // The focused issue's actions are commands (`>`), as Accept is.
      await input.fill(">Won't do");
      const item = page.locator(".palette [role=option]", {
        hasText: "Won't do “Show the week's total”",
      });
      await item.waitFor();
      await item.click();
      await page.locator(".ia-pop").waitFor();
      await page.locator(".ia-pop input").fill("Totals come from the payroll export");
      await page.locator(".ia-pop button[type=submit]").click();
      await expect.poll(() => status("card_phone")).toBe("rejected");
      await page.context().close();
    },
  );
});
