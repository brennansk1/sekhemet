import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// Loop waves 5 and 6, builder A (sweep 3, integrations): the Integrations
// page's states and its Import sheet, as a person meets them. A real server
// over a real ledger, in Chromium; the repository has no GitHub remote, and
// no model is loaded.

type Server = { port: number; close: () => Promise<void> };

/** The seeded board's titles as a Jira file, one row changed and one new. */
const JIRA_TWO_CHANGES = [
  "Summary,Issue Type,Priority,Sekhemet ID",
  "Import last month's timesheets (edited),Story,High,card_bk1",
  "Send a reminder on Friday,Task,Low,",
].join("\n");

describe("Integrations, honest states and the Import sheet (loop waves 5–6, builder A)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-int-ui-");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function open(width = 1440): Promise<Page> {
    const { page } = await openContext(browser, width);
    await page.goto(`${base}/#/integrations`);
    await page.locator('[data-int="jira"]').waitFor();
    return page;
  }

  async function preview(page: Page, format: string, content: string): Promise<void> {
    await page.locator(`[data-import="${format}"]`).click();
    await page.locator(".isheet textarea").fill(content);
    await page.locator(".isheet [type=submit]").click();
    await page.waitForFunction(
      () =>
        !document.querySelector(".isheet [type=submit]")?.hasAttribute("disabled") &&
        (document.querySelector(".isheet .pgroup") || document.querySelector(".isheet .ierr")),
    );
  }

  it("A1, A2: Jira and Linear are not Connected; PR on Accept cannot be switched on without GitHub", async () => {
    const page = await open();
    for (const id of ["jira", "linear"]) {
      const tag = (await page.locator(`[data-int="${id}"] .itag`).innerText()).trim();
      expect(tag).not.toMatch(/connected/i);
      expect(await page.locator(`[data-int="${id}"] .itag.on`).count()).toBe(0);
    }
    // Nothing is connected on a fresh install, so the header counts none.
    expect(await page.locator("body").innerText()).toMatch(/\b0 of \d+ connected/);
    const sw = page.locator("[data-toggle-pr]");
    expect(await sw.isDisabled()).toBe(true);
    expect(await sw.getAttribute("aria-checked")).toBe("false");
    expect(await page.locator('[data-int="github-pr"]').innerText()).toMatch(
      /Connect GitHub first/,
    );
    await page.context().close();
  });

  it("A5: when the server stops answering, the last known cards stay on the page", async () => {
    const page = await open();
    const before = await page.locator(".icard").count();
    expect(before).toBeGreaterThan(4);
    await page.route("**/api/**", (r) => r.abort("connectionrefused"));
    // A change the person asks for reloads the list, which now fails.
    await page.locator("[data-toggle-web]").click();
    await page.waitForTimeout(800);
    expect(await page.locator(".icard").count()).toBe(before);
    expect(await page.locator("body").innerText()).not.toMatch(/0 of 0 connected/);
    expect(await page.locator("body").innerText()).not.toMatch(/returned 0|returned -1/);
    await page.context().close();
  });

  it("W6 A6: Escape closes the Import sheet and gives focus back to its Import button", async () => {
    const page = await open();
    await page.locator('[data-import="jira-csv"]').click();
    await page.locator(".isheet").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator(".isheet").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-import"))).toBe(
      "jira-csv",
    );
    await page.context().close();
  });

  it("W6 A1, A4: the preview speaks in words, with the type that will be applied", async () => {
    const page = await open();
    await preview(page, "jira-csv", JIRA_TWO_CHANGES);
    const text = await page.locator(".isheet").innerText();
    expect(text).not.toMatch(/externalRef|External Ref|\{"system"/);
    expect(text).not.toMatch(/\bImport Send a reminder/);
    // The new row is a Task in the file, and a Task is what Apply creates.
    expect(text).toMatch(/Send a reminder on Friday\s*Task/);
    expect(text).not.toMatch(/jira-csv/);
    await page.context().close();
  });

  it("W6 A2: after Apply all, the sheet says every change is decided and offers no Apply", async () => {
    const page = await open();
    // Two rows that are already issues: a new one would need its project named,
    // and this workspace has two (reported separately).
    await preview(
      page,
      "jira-csv",
      [
        "Summary,Priority,Sekhemet ID",
        "Pay public holidays at double time (edited),High,card_td1",
        "Plan the overtime report (edited),Low,card_td2",
      ].join("\n"),
    );
    await page.locator(".isheet [data-apply-all]").click();
    await page.waitForFunction(() =>
      /All decided/.test(document.querySelector(".isheet .pgroup")?.textContent ?? ""),
    );
    expect(await page.locator(".isheet [data-apply-all]").count()).toBe(0);
    expect(await page.locator(".isheet .pgroup").innerText()).not.toMatch(/\d+ open/);
    await page.context().close();
  });

  it("W6 A3: rows left out and values not kept are named; a repeated row is proposed once", async () => {
    const page = await open();
    const csv = [
      "Title,Priority,Estimate",
      "Spaces around,9,-3",
      "Spaces around,9,-3",
      ",2,3",
      "Plain row,2,3",
    ].join("\n");
    await preview(page, "linear-csv", csv);
    const sheet = await page.locator(".isheet").innerText();
    expect(sheet).toMatch(/Line 4.*no title/i);
    expect(sheet).toMatch(/Line 3.*same as line 2/i);
    expect(sheet).toMatch(/priority “9”/i);
    expect(sheet).toMatch(/estimate “-3”/i);
    expect(await page.locator(".isheet .prop.open").count()).toBe(2);
    await page.context().close();
  });

  it("W6 A5: a file that cannot be read is named once, in plain words, with the line", async () => {
    const page = await open();
    await preview(page, "jira-csv", 'Summary\n"never closed\n');
    const err = (await page.locator(".isheet .ierr").innerText()).trim();
    expect(err).toMatch(/line 2/i);
    expect(err.match(/read that/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(err).not.toMatch(/a quoted field opens there|unterminated/i);
    await page.context().close();
  });

  it("W6 A6: a long title stays inside its row; the File label sits with its control at 400 px", async () => {
    const page = await open(1440);
    await preview(page, "jira-csv", `Summary\n${"A".repeat(300)}\n`);
    // Neither the proposal's summary nor its row title runs out of its box.
    const fits = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".isheet .prop .sum, .isheet .pcards .t")];
      if (boxes.length < 2) return "missing";
      const over = boxes.filter((b) => b.scrollWidth > b.clientWidth + 1);
      return over.length
        ? over.map((b) => `${b.className} ${b.scrollWidth}>${b.clientWidth}`).join("; ")
        : "ok";
    });
    expect(fits).toBe("ok");
    await page.context().close();

    const narrow = await open(400);
    await narrow.locator('[data-import="jira-csv"]').click();
    // The word *File* and its control share a line, centred on each other.
    const aligned = await narrow.evaluate(() => {
      const label = document.querySelector(".isheet label.file");
      const input = label?.querySelector("input[type=file]");
      const text = [...(label?.childNodes ?? [])].find(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
      );
      if (!label || !input || !text) return "missing";
      const range = document.createRange();
      range.selectNodeContents(text);
      const w = range.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      const centre = (r: DOMRect) => r.top + r.height / 2;
      return Math.abs(centre(w) - centre(i)) <= 3 && w.right <= i.left && i.right <= innerWidth
        ? "ok"
        : `word ${JSON.stringify(w)} input ${JSON.stringify(i)}`;
    });
    expect(aligned).toBe("ok");
    expect(await narrow.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      400,
    );
    await narrow.context().close();
  });
});
