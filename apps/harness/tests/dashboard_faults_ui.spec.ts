import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog } from "@sekhemet/kernel";
import { type Browser, type Page, type Request, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import {
  type SeededBoard,
  acceptableCard,
  git,
  openContext,
  seedBoard,
  tamperLedger,
} from "./support/dashboard_seed.js";

// The dashboard's §6 acceptance criteria under fault, through the door a
// person uses (C2d, FINDINGS_C1 TST-02): a real server over a real ledger in
// a real repository, driven in Chromium, with the faults injected at the
// browser's network boundary (a stream that drops, a /api/meta that answers
// 500) or in the ledger file itself (an entry edited by hand). Accept's
// grace window, an empty send-back, Undo's ten seconds, and what an
// accepted issue offers instead. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

/** Every write the page sends from now on. */
function writes(page: Page): Request[] {
  const sent: Request[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/")) sent.push(r);
  });
  return sent;
}

describe("Accept, send back and Undo in Chromium (DB-1, DB-2, DB-N16-1, DB-N16-3)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-faults-accept-");
    await acceptableCard(seed, "card_ac1", "Total the hours of a week");
    await acceptableCard(seed, "card_ac3", "Show the week's overtime");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 250,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  /** The issue page with its diff shown, so the page records what it showed (RG-N5-5). */
  async function issue(id: string): Promise<Page> {
    const { page } = await openContext(browser, 1440, { project: seed.project });
    await page.goto(`${base}/#/card/${id}/changes`);
    await page.locator("[data-changes]").waitFor();
    await page.waitForTimeout(800);
    return page;
  }

  it(
    "DB-1: Accept shows a 3-second grace toast, and z within it cancels with no request sent",
    { timeout: 60_000 },
    async () => {
      const page = await issue("card_ac1");
      const sent = writes(page);
      const accept = page.locator("[data-accept]").first();
      await expect.poll(() => accept.isEnabled(), { timeout: 10_000 }).toBe(true);
      await accept.click();
      const toast = page.locator(".toast", { hasText: "Accepting “Total the hours of a week”" });
      await toast.waitFor();
      expect(await toast.getByRole("button", { name: /Undo/ }).count()).toBe(1);
      await page.keyboard.press("z");
      await page.locator(".toast", { hasText: "Accept cancelled. Nothing was merged." }).waitFor();
      // Past the three seconds: still nothing sent, nothing merged.
      await page.waitForTimeout(3500);
      expect(sent.filter((r) => r.url().includes("/accept")).map((r) => r.url())).toEqual([]);
      expect((await seed.store.getCard("card_ac1"))?.status).toBe("review");
      await page.context().close();
    },
  );

  it(
    "DB-N16-3: an accepted issue offers Accept's grace window and Revert, never the edit Undo",
    { timeout: 60_000 },
    async () => {
      const page = await issue("card_ac1");
      const sent = writes(page);
      const main = git(seed.dir, "rev-parse", "main");
      const accept = page.locator("[data-accept]").first();
      await expect.poll(() => accept.isEnabled(), { timeout: 10_000 }).toBe(true);
      await accept.click();
      // The grace window is Accept's own Undo; left alone, it merges.
      await page.locator(".toast", { hasText: "Accepting" }).waitFor();
      const merged = page.locator(".toast", { hasText: /^Merged to main as / });
      await merged.waitFor({ timeout: 15_000 });
      expect(git(seed.dir, "rev-parse", "main")).not.toBe(main);
      expect((await seed.store.getCard("card_ac1"))?.status).toBe("done");
      // The merged toast offers Copy and points at Revert; it offers no Undo.
      expect(await merged.getByRole("button", { name: /Undo/ }).count()).toBe(0);
      expect(await merged.innerText()).toContain("You can revert it from the issue page.");
      // z now undoes nothing: no request, still Done.
      const before = sent.length;
      await page.keyboard.press("z");
      await page.waitForTimeout(800);
      expect(sent.slice(before).map((r) => r.url())).toEqual([]);
      expect((await seed.store.getCard("card_ac1"))?.status).toBe("done");
      // The issue's own menu offers Revert.
      await page.locator("[data-issue-more]").first().click();
      const revert = page.getByRole("menuitem", { name: "Revert" });
      await revert.waitFor();
      expect(await revert.isEnabled()).toBe(true);
      await page.keyboard.press("Escape");
      await page.context().close();
    },
  );

  it(
    "DB-2: an empty send-back is blocked in the page with its sentence, and nothing is sent",
    { timeout: 60_000 },
    async () => {
      const page = await issue("card_ac3");
      const sent = writes(page);
      await page.locator("[data-back]").first().click();
      const form = page.locator("form[data-composer]");
      await form.waitFor();
      await form.getByRole("button", { name: /Request changes/ }).click();
      const err = form.locator("#sb-err");
      await err.waitFor();
      expect(await err.innerText()).toBe("Add a note for the Agent. It's what it reads next.");
      expect(await form.locator("textarea").getAttribute("aria-invalid")).toBe("true");
      await page.waitForTimeout(300);
      expect(sent.filter((r) => r.url().includes("/return")).length).toBe(0);
      expect((await seed.store.getCard("card_ac3"))?.status).toBe("review");
      await page.context().close();
    },
  );

  it(
    "DB-N16-1: an edit, a move, a hold and a Won't do each show a result toast offering Undo (z) for 10 s",
    { timeout: 90_000 },
    async () => {
      const { page } = await openContext(browser, 1440, { project: seed.project });
      await page.goto(`${base}/#/board`);
      await page.locator(".tile").first().waitFor();
      const undoToast = (text: string | RegExp) =>
        page.locator(".toast", { hasText: text }).filter({
          has: page.getByRole("button", { name: /Undo/ }),
        });
      // An inline field edit: priority from the keyboard.
      await page.locator("#tile-card_bk1").focus();
      await page.keyboard.press("Shift+P");
      await page.locator(".picker-menu [role=option]", { hasText: "Urgent" }).click();
      const edit = undoToast("Set priority to Urgent");
      await edit.waitFor();
      expect(await edit.locator("kbd").innerText()).toBe("Z");
      // z restores it, as one more recorded change.
      await page.keyboard.press("z");
      await page.locator(".toast", { hasText: "Priority restored on" }).waitFor();
      // A move within a column (Alt+Down on the focused tile).
      await page.locator("#tile-card_td1").focus();
      await page.keyboard.press("Alt+ArrowDown");
      await undoToast(/^Moved /).waitFor();
      // A hold, from the peek.
      await page.locator("#tile-card_ip1 .title").click();
      await page.locator(".peek").waitFor();
      await page.keyboard.press("p");
      await page
        .locator("form.park-pop")
        .getByRole("button", { name: /Put on hold/ })
        .click();
      await undoToast("On hold. Nothing runs until you take it off hold.").waitFor();
      // Won't do, from the issue page's menu.
      await page.goto(`${base}/#/card/card_td1`);
      await page.locator("[data-issue-more]").first().click();
      await page.getByRole("menuitem", { name: "Won't do" }).click();
      await page.locator("#ia-reason").fill("Out of scope");
      await page.getByRole("button", { name: /Mark Won't do/ }).click();
      const wontDo = undoToast("Marked Won't do. You can reopen it.");
      await wontDo.waitFor();
      const shownAt = Date.now();
      expect((await seed.store.getCard("card_td1"))?.status).toBe("rejected");
      // Ten seconds: the offer is still there just before, gone just after.
      await page.waitForTimeout(Math.max(0, 9000 - (Date.now() - shownAt)));
      expect(await wontDo.count()).toBe(1);
      await page.waitForTimeout(Math.max(0, 10_800 - (Date.now() - shownAt)));
      expect(await wontDo.count()).toBe(0);
      // After it, z undoes nothing: no request, the issue stays Won't do.
      const sent = writes(page);
      await page.keyboard.press("z");
      await page.waitForTimeout(800);
      expect(sent.map((r) => r.url())).toEqual([]);
      expect((await seed.store.getCard("card_td1"))?.status).toBe("rejected");
      await page.context().close();
    },
  );
});

describe("shell states and the ledger under fault (DB-3, DB-4, DB-N2-2)", () => {
  let seed: SeededBoard;
  let server: Server;
  let base: string;
  let browser: Browser;
  /** The entry the DB-3 test alters by hand; DB-N2-2 reads its sentence. */
  let tampered = 0;

  /** The page's connection state, from its own store. */
  const connection = (page: Page) =>
    page.evaluate(`import("/app/store.js").then(({ store }) => store.state.connection)`);
  /** The clock the page's wait times count from. */
  const nowOf = (page: Page) =>
    page.evaluate(
      `import("/app/store.js").then(({ store }) => store.state.now)`,
    ) as Promise<number>;

  beforeAll(async () => {
    seed = await seedBoard("sek-faults-shell-");
    await acceptableCard(seed, "card_ac2", "Round a week's total");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      // Review holds three: card_rv1, card_rv2 and card_ac2 fill it.
      boardService: new BoardServiceImpl(seed.store, { customLimits: { review: 3 } }),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 250,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  it(
    "DB-4: a silent stream with a failing /api/meta shows Offline since…, freezes the clocks and disables every action",
    { timeout: 90_000 },
    async () => {
      const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
      // The stream never connects (a dropped connection, injected at the network);
      // /api/meta answers until the test makes it fail.
      let metaFails = false;
      await ctx.route("**/api/stream**", (r) => r.abort("connectionreset"));
      await ctx.route("**/api/meta", (r) =>
        metaFails ? r.fulfill({ status: 500, body: "{}" }) : r.continue(),
      );
      // The page's own clock, so a 30-second tick can be stepped past.
      await page.clock.install();
      await page.goto(`${base}/#/board`);
      await page.locator(".tile").first().waitFor();
      // Silent past ten seconds, but /api/meta answers: not offline.
      await page.waitForTimeout(11_500);
      expect(await page.locator("#bar .bar.offline").count()).toBe(0);
      // Now /api/meta fails too: offline within the next check.
      metaFails = true;
      const bar = page.locator("#bar .bar.offline");
      await bar.waitFor({ timeout: 15_000 });
      expect(await bar.innerText()).toMatch(
        /^Offline since \d{1,2}:\d{2}.*\. Showing the last known state\. Actions are disabled\./s,
      );
      expect(await connection(page)).toBe("offline");
      // Timestamps are frozen: past the page's 30-second tick, the clock wait
      // times count from has not moved and a tile's age in seconds reads the same.
      const ages = () =>
        page.$$eval(".tile .age, .tile .st", (es) => es.map((e) => e.textContent).join("|"));
      const was = await ages();
      expect(was).toMatch(/\b\d+s\b/);
      const frozenAt = await nowOf(page);
      await page.clock.fastForward(31_000);
      await page.waitForTimeout(300);
      expect(await nowOf(page)).toBe(frozenAt);
      expect(await ages()).toBe(was);
      // Every action is disabled: the issue's buttons, and the keys send nothing.
      const sent = writes(page);
      await page.locator("#tile-card_ac2 .title").click();
      await page.locator(".peek").waitFor();
      for (const sel of ["[data-accept]", "[data-back]", "[data-park]"]) {
        const b = page.locator(`.peek ${sel}`);
        if (await b.count()) expect(await b.isDisabled(), sel).toBe(true);
      }
      // Accept's request would leave after its 3-second grace window (DB-1),
      // so wait past it: no grace toast opens, and Offline. is said instead.
      const offlineToast = page.locator(".toast", { hasText: "Offline." });
      await page.keyboard.press("a");
      await page.waitForTimeout(3500);
      expect(await page.locator(".toast", { hasText: "Accepting" }).count()).toBe(0);
      expect(await offlineToast.count()).toBeGreaterThan(0);
      // p opens no hold popover.
      await page.keyboard.press("p");
      await page.waitForTimeout(400);
      expect(await page.locator("form.park-pop").count()).toBe(0);
      // r: a send-back with its note filled in is refused at submit, Offline.
      // (The key still opens the composer the disabled button would: peek.js
      // `act("r")` checks only for evidence, a finding for the lead.)
      await page.keyboard.press("r");
      const composer = page.locator("form[data-composer]");
      await page.waitForTimeout(400);
      if (await composer.count()) {
        await composer.locator("textarea").fill("Round to the nearest quarter hour.");
        await composer.getByRole("button", { name: /Request changes/ }).click();
        await page.waitForTimeout(800);
      }
      expect(sent.map((r) => r.url())).toEqual([]);
      expect((await seed.store.getCard("card_ac2"))?.status).toBe("review");
      await ctx.close();
    },
  );

  it(
    "DB-3: with Review full showing, offline beginning replaces its bar; one bar at a time",
    { timeout: 90_000 },
    async () => {
      const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
      await page.goto(`${base}/#/board`);
      const bars = page.locator("#bar .bar");
      // Review is full: its bar alone.
      await expect
        .poll(() => bars.allInnerTexts(), { timeout: 10_000 })
        .toEqual([expect.stringMatching(/^Review is full \(3 of 3\)\./)]);
      // The network drops: offline outranks Review full, and only its bar shows.
      await ctx.setOffline(true);
      await expect
        .poll(() => bars.allInnerTexts(), { timeout: 25_000 })
        .toEqual([expect.stringMatching(/^Offline since /)]);
      await ctx.close();
    },
  );

  it(
    "DB-3: an altered ledger outranks Review full, and stays the one bar when offline begins",
    { timeout: 90_000 },
    async () => {
      // DB-N2-2's control: on the intact ledger Accept on card_ac2 is enabled
      // and names no ledger reason, so its disabling below is the ledger's.
      {
        const { page } = await openContext(browser, 1440, { project: seed.project });
        await page.goto(`${base}/#/card/card_ac2/changes`);
        await page.locator("[data-changes]").waitFor();
        const accept = page.locator("[data-accept]").first();
        await expect.poll(() => accept.isEnabled(), { timeout: 10_000 }).toBe(true);
        expect(await page.locator("body").innerText()).not.toContain("Activity log altered");
        await page.context().close();
      }
      // The ledger file is edited by hand while the server is down; it starts again over it.
      await server.close();
      const seq = tamperLedger(seed);
      tampered = seq;
      const log = new EventLog(seed.db);
      const store = new CardStore(seed.db, log);
      server = await startDashboardServer({
        db: seed.db,
        log,
        boardService: new BoardServiceImpl(store, { customLimits: { review: 3 } }),
        cardStore: store,
        repoPath: seed.dir,
        port: 0,
        streamIntervalMs: 250,
      });
      base = `http://127.0.0.1:${server.port}`;
      const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
      await page.goto(`${base}/#/board`);
      const bars = page.locator("#bar .bar");
      // Review is still full (3 of 3), but only the altered ledger's bar shows.
      await expect
        .poll(() => bars.allInnerTexts(), { timeout: 10_000 })
        .toEqual([expect.stringMatching(new RegExp(`^Activity log altered at entry #${seq}\\.`))]);
      expect((await store.listCards()).filter((c) => c.status === "review").length).toBe(3);
      // Offline begins (the page's own state says so): still one bar, the ledger's.
      await ctx.setOffline(true);
      await expect.poll(() => connection(page), { timeout: 30_000 }).toBe("offline");
      await page.waitForTimeout(500);
      expect(await bars.allInnerTexts()).toEqual([expect.stringMatching(/^Activity log altered/)]);
      await ctx.close();
    },
  );

  it(
    "DB-N2-2: with the ledger failing verification, Accept is disabled on Review, the issue page and the peek",
    { timeout: 60_000 },
    async () => {
      // The ledger was altered by hand by the test above; its chain no longer verifies.
      const v = (await (await fetch(`${base}/api/integrity`)).json()) as {
        chain: { valid: boolean };
      };
      expect(v.chain.valid).toBe(false);
      expect(tampered).toBeGreaterThan(0);
      // The ledger's own sentence beside Accept, not any other reason (an
      // unloaded evidence, files not yet shown) that also disables it.
      const reason = `Activity log altered at entry #${tampered}. Inspect before accepting.`;
      const { page } = await openContext(browser, 1440, { project: seed.project });
      const sent = writes(page);
      // The issue page.
      await page.goto(`${base}/#/card/card_ac2/changes`);
      await page.locator("[data-changes]").waitFor();
      const onIssue = page.locator("[data-accept]").first();
      await onIssue.waitFor();
      await expect
        .poll(() => page.locator("#accept-why").innerText(), { timeout: 10_000 })
        .toContain(reason);
      expect(await onIssue.isDisabled()).toBe(true);
      // The peek.
      await page.goto(`${base}/#/board`);
      await page.locator("#tile-card_ac2 .title").click();
      const inPeek = page.locator(".peek [data-accept]");
      await inPeek.waitFor();
      await expect
        .poll(() => page.locator(".peek #accept-why").innerText(), { timeout: 10_000 })
        .toContain(reason);
      expect(await inPeek.isDisabled()).toBe(true);
      await page.keyboard.press("a");
      await page.keyboard.press("Escape");
      // Review.
      await page.goto(`${base}/#/review`);
      await page.locator("#q-card_ac2").click();
      const onReview = page.locator("[data-accept]").first();
      await onReview.waitFor();
      await expect
        .poll(() => page.locator("#accept-why").innerText(), { timeout: 10_000 })
        .toContain(reason);
      expect(await onReview.isDisabled()).toBe(true);
      await page.keyboard.press("a");
      await page.waitForTimeout(3500);
      expect(sent.filter((r) => r.url().includes("/accept")).length).toBe(0);
      expect((await seed.store.getCard("card_ac2"))?.status).toBe("review");
      await page.context().close();
    },
  );
});
