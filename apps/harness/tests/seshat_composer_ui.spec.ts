import { BoardServiceImpl } from "@sekhemet/board";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// Seshat's composer through its door (planner-pm PM-N10-4, PM-N10-5; C2d,
// FINDINGS_C1 TST-01): a real server over a real ledger in a real git
// repository, Seshat a stand-in at the adapter boundary (no model loaded),
// the panel driven in Chromium. A paste longer than a comfortable message
// becomes a document chip, removable before sending; a long message sent is
// shown by its opening and the document that holds all of it; what the
// server would refuse is refused in the composer before anything is sent.

const standIn = (): LocalInferenceAdapter => ({
  modelId: "dirk-27b-stand-in",
  supportedArms: ["arm_a_flat"],
  contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
  generate: async () => ({
    text: "Read it.",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  }),
});

/** Text of `n` characters with a heading, as a pasted brief is. */
const brief = (n: number, title = "Overtime rules") =>
  `# ${title}\n\n${"Each week closes on Sunday night. ".repeat(Math.ceil(n / 34))}`.slice(0, n);

describe("Seshat's composer in Chromium, through the dashboard server (PM-N10)", () => {
  let seed: SeededBoard;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-composer-");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 100,
      pressureLevel: () => 1,
      pmModel: "dirk-27b-stand-in",
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

  async function panel(): Promise<{ page: Page; posts: () => number }> {
    const { page } = await openContext(browser, 1440, { project: seed.project });
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/pm/messages")) posted++;
    });
    await page.goto(`${base}/#/board`);
    await page.locator(".tile").first().waitFor();
    await page.keyboard.press("Control+j");
    await page.getByRole("textbox", { name: "Message Seshat" }).waitFor();
    return { page, posts: () => posted };
  }

  /** A paste into the composer, as the browser delivers one. */
  const paste = (page: Page, text: string) =>
    page.getByRole("textbox", { name: "Message Seshat" }).evaluate((ta, t) => {
      const data = new DataTransfer();
      data.setData("text/plain", t);
      ta.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);

  it(
    "PM-N10-5: a paste over 8,000 characters is attached whole as a document shown by name and size, removable before sending; a long message sent shows its opening and the document holding all of it",
    { timeout: 90_000 },
    async () => {
      const { page } = await panel();
      const box = page.getByRole("textbox", { name: "Message Seshat" });
      await paste(page, brief(9_000));
      // Attached, not typed: the box stays empty and a chip names it and its size.
      expect(await box.inputValue()).toBe("");
      const chip = page.locator(".pm-compose [data-docs] .dchip", { hasText: "Overtime rules.md" });
      await chip.waitFor();
      expect(await chip.innerText()).toContain("Overtime rules.md · 9,000 characters");
      // Removable before sending.
      await chip.getByRole("button", { name: "Remove Overtime rules.md" }).click();
      expect(
        await page
          .locator(".pm-compose [data-docs] .dchip", { hasText: "Overtime rules.md" })
          .count(),
      ).toBe(0);
      // A paste under the limit is ordinary text.
      await paste(page, "short words");
      expect(await page.locator(".pm-compose [data-docs] .dchip").count()).toBe(0);
      // Pasted again and sent: the document goes with the words.
      await paste(page, brief(9_000, "Night shifts"));
      await box.fill("Here is the brief.");
      await box.press("Enter");
      const sent = page.locator("article.msg.user", { hasText: "Here is the brief." }).last();
      await sent.waitFor({ timeout: 20_000 });
      await sent.locator(".dchip", { hasText: "Night shifts.md" }).waitFor({ timeout: 20_000 });
      // A long message typed whole is shown by its opening and the document that holds it.
      const long = `${"Overtime starts after forty hours in one week. ".repeat(220)}`.trim();
      expect(long.length).toBeGreaterThan(8_000);
      await box.fill(long);
      await box.press("Enter");
      const note = page.locator("article.msg.user .doc-note").last();
      await note.waitFor({ timeout: 20_000 });
      expect(await note.innerText()).toMatch(
        new RegExp(
          `^The whole message, ${long.length.toLocaleString("en-US")} characters, is attached as .+\\.md\\.$`,
        ),
      );
      const shown = await page.locator("article.msg.user .bubble").last().innerText();
      expect(shown.length).toBeLessThan(700);
      expect(shown.endsWith("…")).toBe(true);
      expect(long.startsWith(shown.slice(0, -1).trim())).toBe(true);
      await page.context().close();
    },
  );

  it(
    "PM-N10-4: in the composer, more than ten documents, or a message over 1 MB, is refused before anything is sent, in words naming its size and the limit",
    { timeout: 120_000 },
    async () => {
      const { page, posts } = await panel();
      const box = page.getByRole("textbox", { name: "Message Seshat" });
      const before = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
        messages: unknown[];
      };
      for (let i = 0; i < 11; i++) await paste(page, brief(8_100, `Part ${i + 1}`));
      expect(await page.locator(".pm-compose [data-docs] .dchip").count()).toBe(11);
      await box.fill("All the parts.");
      await box.press("Enter");
      const toast = page.locator("#toasts", { hasText: "Couldn't send to Seshat." });
      await toast.waitFor();
      expect(await toast.innerText()).toContain(
        "This message has 11 documents; one message to Seshat can carry at most 10. Nothing was sent.",
      );
      expect(posts()).toBe(0);
      await page.context().close();

      // Over the request cap: two documents of 600,000 characters each.
      const second = await panel();
      await paste(second.page, brief(600_000, "Ledger one"));
      await paste(second.page, brief(600_000, "Ledger two"));
      const box2 = second.page.getByRole("textbox", { name: "Message Seshat" });
      await box2.fill("Both ledgers.");
      await box2.press("Enter");
      const big = second.page.locator("#toasts", { hasText: "Couldn't send to Seshat." });
      await big.waitFor();
      expect(await big.innerText()).toMatch(
        /This message is 1\.\d MB, over the 1 MB one message to Seshat can carry\. Nothing was sent\./,
      );
      expect(second.posts()).toBe(0);
      const after = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
        messages: unknown[];
      };
      expect(after.messages.length).toBe(before.messages.length);
      await second.page.context().close();
    },
  );
});
