import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import {
  type SeededBoard,
  acceptableCard,
  git,
  openContext,
  seedBoard,
} from "./support/dashboard_seed.js";

// The test-and-refine loop's wave 10, the dashboard half of A1–A3
// (sweep5_kernel_reviewgit.json): a refusal the CLI answers with its `Do:`
// step reaches the page with what it needs to say the same step in the
// board's words — a conflicting Accept, a Revert of a Done issue Sekhemet
// merged nothing of — and taking an issue off hold says where it went. A
// real server over a real ledger in a real repository, driven in Chromium;
// no model is loaded.

type Server = { port: number; close: () => Promise<void> };

const PR_URL = "https://github.com/o/r/pull/7";
const MERGE = "b".repeat(40);

describe("refusals with their next step, and holds that say where (wave 10 A1–A3)", () => {
  let seed: SeededBoard;
  let server: Server;
  let browser: Browser;
  let base: string;
  let write: Record<string, string>;

  beforeAll(async () => {
    seed = await seedBoard("sek-w10-steps-");
    // A1: the card's branch adds src/card_cf1.ts; main then adds it differently.
    await acceptableCard(seed, "card_cf1", "Share the overtime rate");
    mkdirSync(join(seed.dir, "src"), { recursive: true });
    writeFileSync(join(seed.dir, "src", "card_cf1.ts"), "export const card_cf1 = 3;\n");
    git(seed.dir, "add", "-A");
    git(seed.dir, "commit", "-q", "-m", "main moved");
    // A2: Done through its pull request, merged on the hosting service (rule 24, K-N3-4).
    const board = new BoardServiceImpl(seed.store);
    await seed.store.createCard({
      id: "card_pr",
      tier: "story",
      title: "Email the weekly report",
      status: "ready",
      projectId: seed.project,
      scopeFiles: ["src/report.ts"],
    });
    await seed.store.updateCardStatus("card_pr", "review", "setup", "harness", { override: true });
    const principal = seed.store.localPrincipal();
    await board.acceptWithPullRequest(
      "card_pr",
      { pr: 7, url: PR_URL, headSha: "a".repeat(40) },
      principal,
      "harness",
      [
        {
          type: "card/accepted",
          actor: "human",
          principal,
          payload: { id: "card_pr", pr: PR_URL, principal },
        },
      ],
    );
    await board.closePullRequest("card_pr", { pr: 7, merged: true, mergeCommit: MERGE });
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: board,
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    write = await pageWriteHeaders(base);
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function open(hash: string): Promise<Page> {
    const { page } = await openContext(browser, 1440, { project: seed.project });
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    return page;
  }

  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...write, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("A1: a conflicting Accept's refusal carries the conflict, over HTTP", async () => {
    await post("/api/cards/card_cf1/opened", { filesShown: ["src/card_cf1.ts"] });
    const res = await post("/api/cards/card_cf1/accept");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "conflict",
      conflict: { onto: "main", files: ["src/card_cf1.ts"] },
    });
    expect((await seed.store.getCard("card_cf1"))?.status).toBe("review");
  }, 60_000);

  it("A1: on the page, a conflicting Accept says the step and offers Request changes with it", async () => {
    const page = await open("#/card/card_cf1/changes");
    const accept = page.locator("[data-accept]").first();
    await expect.poll(() => accept.isEnabled(), { timeout: 10_000 }).toBe(true);
    await accept.click();
    const failed = page.locator(".toast", { hasText: "Couldn't accept." });
    await failed.waitFor({ timeout: 20_000 });
    expect(await failed.innerText()).toContain(
      "Request changes and ask the Agent to rebase onto main and resolve the conflict in src/card_cf1.ts.",
    );
    await failed.getByRole("button", { name: "Request changes" }).click();
    const note = page.locator("[data-composer] textarea");
    await note.waitFor();
    expect(await note.inputValue()).toBe(
      "Rebase onto main and resolve the conflict in src/card_cf1.ts.",
    );
    await page.context().close();
  }, 60_000);

  it("A2: Revert of an issue merged on the hosting service is refused with its step, over HTTP", async () => {
    const desk = (await (await fetch(`${base}/api/cards/card_pr/review`)).json()) as {
      revert?: unknown;
    };
    expect(desk.revert).toEqual({ may: false, nothing: { pr: PR_URL, merge: MERGE } });
    const res = await post("/api/cards/card_pr/revert");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "nothing_to_revert",
      nothing: { pr: PR_URL, merge: MERGE },
    });
    expect(String(body.next)).toMatch(/^revert that merge where the pull request lives/);
    expect((await seed.store.getCard("card_pr"))?.status).toBe("done");
  });

  it("A2: on the page, its Revert is disabled with where to revert and how to start again", async () => {
    const page = await open("#/card/card_pr");
    await page.locator("[data-issue-more]").first().click();
    const revert = page.getByRole("menuitem", { name: "Revert" });
    await revert.waitFor();
    expect(await revert.isDisabled()).toBe(true);
    const why = page.locator("#ia-why-revert");
    expect(await why.innerText()).toBe(
      `It was accepted through its pull request ${PR_URL}, merged as bbbbbbb, so there is no merge here to revert. Revert that merge where the pull request lives, then add a New issue to do the work again.`,
    );
    await page.keyboard.press("Escape");
    await page.context().close();
  });

  it("A3: Undo of a hold put on In review says it goes to To do and runs again", async () => {
    const page = await open("#/card/card_rv1");
    await page.locator("[data-park]").first().click();
    await page
      .locator(".park-pop")
      .getByRole("button", { name: /Put on hold/ })
      .click();
    const held = page.locator(".toast", { hasText: "On hold." });
    await held.waitFor();
    await held.getByRole("button", { name: /Undo/ }).click();
    await page
      .locator(".toast", {
        hasText: "Taken off hold. It is in To do, not In review: the Agent runs it again.",
      })
      .waitFor({ timeout: 10_000 });
    expect((await seed.store.getCard("card_rv1"))?.status).toBe("ready");
    await page.context().close();
  });

  it("A3: Take off hold names the column the issue went to", async () => {
    const page = await open("#/card/card_pk1");
    await page
      .getByRole("button", { name: /Take off hold/ })
      .first()
      .click();
    await page
      .locator(".toast", { hasText: "Taken off hold. It is in To do." })
      .waitFor({ timeout: 10_000 });
    expect(await page.locator(".toast", { hasText: "back where it was" }).count()).toBe(0);
    await page.context().close();
  });
});
