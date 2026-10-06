import { BoardServiceImpl } from "@sekhemet/board";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// Seshat's panel through its door (C2d, FINDINGS_C1 TST-01, TST-02): a real
// server over a real ledger, Seshat answered by a stand-in model at the
// adapter boundary (no model is loaded, nothing leaves the machine), driven
// in Chromium. The panel's header and cost line never name the model; a
// reply's id that is no card stays plain text; a stale proposal cannot be
// applied and says why.

const MODEL = "dirk-27b-stand-in";
const REPLY = "Next is @card_td1, then @card_nope once someone files it.";

const standIn = (): LocalInferenceAdapter => ({
  modelId: MODEL,
  supportedArms: ["arm_a_flat"],
  contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
  generate: async () => ({
    text: REPLY,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  }),
});

describe("Seshat's panel in Chromium, through the dashboard server (C2d)", () => {
  let seed: SeededBoard;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-seshat-entry-");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 100,
      pressureLevel: () => 1,
      pmModel: MODEL,
      pmAdapter: standIn,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function panel(): Promise<Page> {
    const { page } = await openContext(browser, 1440, { project: seed.project });
    await page.goto(`${base}/#/board`);
    await page.locator(".tile").first().waitFor();
    await page.keyboard.press("Control+j");
    await page.locator(".pm-head .who").waitFor();
    return page;
  }

  it(
    "DB-P5-6: the header reads Seshat · Project manager with the presence line, and names no model",
    { timeout: 60_000 },
    async () => {
      const page = await panel();
      const head = page.locator(".pm-head");
      await expect.poll(() => head.locator(".nm b").innerText()).toBe("Seshat · Project manager");
      expect(await head.locator(".line").innerText()).toBe("Replies in about a minute");
      // Nowhere in the header or its details: not its text, titles or labels.
      const all = await head.evaluate((h) =>
        [
          h.textContent ?? "",
          ...[...h.querySelectorAll("*")].flatMap((e) =>
            ["title", "aria-label", "aria-description"].map((a) => e.getAttribute(a) ?? ""),
          ),
        ].join(" "),
      );
      expect(all).not.toContain(MODEL);
      expect(all.toLowerCase()).not.toContain("dirk");
      await page.context().close();
    },
  );

  it(
    "DB-P5-5: the composer's cost line has no API path and no model name or id",
    { timeout: 60_000 },
    async () => {
      const page = await panel();
      const cost = page.locator(".pm-head ~ * [data-cost], [data-cost]").first();
      await expect.poll(() => cost.innerText()).not.toBe("");
      const text = await cost.innerText();
      // An issue is In progress: the line says what sending does to the Agent, in words.
      expect(text).toBe(
        "The Agent will pause at its first safe step while Seshat answers (about 40s), then carry on.",
      );
      expect(text).not.toMatch(/\/api\/|https?:/);
      expect(text).not.toContain(MODEL);
      expect(text.toLowerCase()).not.toContain("dirk");
      await page.context().close();
    },
  );

  it(
    "DB-7: a reply's id that is not a card is plain text; a card's id is its chip",
    { timeout: 60_000 },
    async () => {
      const page = await panel();
      const box = page.getByRole("textbox", { name: "Message Seshat" });
      await box.fill("What should the Agent pick up next?");
      await box.press("Enter");
      const reply = page.locator("article.msg.pm", { hasText: "once someone files it" }).first();
      await reply.waitFor({ timeout: 20_000 });
      // card_td1 is a card: a chip linking to it.
      const chip = reply.locator('a.cchip[data-chip="card_td1"]');
      expect(await chip.count()).toBe(1);
      expect(await chip.getAttribute("href")).toBe("#/card/card_td1");
      // card_nope is not: the words as written, and no link of any kind.
      expect(await reply.innerText()).toContain("@card_nope");
      expect(
        await reply.locator("a").evaluateAll((as) => as.map((a) => a.textContent ?? "")),
      ).not.toEqual(expect.arrayContaining([expect.stringContaining("card_nope")]));
      await page.context().close();
    },
  );

  it(
    "DB-8: a stale proposal's Apply is disabled and the proposal says why",
    { timeout: 60_000 },
    async () => {
      // A proposal from New issue, then the board moves on (recorded as the server records it).
      const r = await fetch(`${base}/api/pm/create-card`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ title: "Show the overtime total per month", type: "story" }),
      });
      expect(r.status).toBe(200);
      const { proposal } = (await r.json()) as { proposal: { id: string } };
      await new PmStore(seed.log).setProposalState(proposal.id, "stale");
      const page = await panel();
      const li = page.locator(`li.prop[data-prop="${proposal.id}"]`);
      await li.waitFor({ timeout: 20_000 });
      expect(await li.getAttribute("class")).toContain("stale");
      const apply = li.getByRole("button", { name: "Apply" });
      expect(await apply.isDisabled()).toBe(true);
      expect(await li.locator(".why").innerText()).toBe("Out of date");
      expect(await li.locator(".pstale").innerText()).toContain(
        "The board changed after this was proposed. Ask again for a fresh proposal.",
      );
      // And pressing y on it applies nothing.
      await li.focus();
      await page.keyboard.press("y");
      await page.waitForTimeout(300);
      expect(await li.getAttribute("class")).toContain("stale");
      await page.context().close();
    },
  );
});
