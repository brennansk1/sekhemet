import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// The issue page and Review in a real Chromium (C2a; FINDINGS ISS-01, -02,
// -03, -05, -06, -07, -08, REV-01, -02, -03, -04, -06, -07, -08, -10;
// dashboard §2.5, §2.6, NEW-dashboard-17, NEW-dashboard-19): the properties
// rail and its edits; a stopped run as one state with Resume; one answer to
// "did it pass?"; Accept's conditions as a checklist and the phone's bar; a
// teammate's open thread on Review; the Accept toast in plain words, sent even
// when the page moves on; the criteria view for a person who manages the
// work. A real server over real SQLite; no model is loaded.

type Server = { port: number; close: () => Promise<void> };

const GATES = [
  "unit",
  "secrets",
  "lint",
  "format",
  "types",
  "size",
  "deps",
  "coverage",
  "licence",
  "audit",
  "dead",
  "osv",
  "semgrep",
];

const DIFF = [
  "diff --git a/src/overtime.ts b/src/overtime.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/overtime.ts",
  "@@ -0,0 +1,3 @@",
  "+export function overtime(hours: number): number {",
  "+  return Math.max(0, hours - 40);",
  "+}",
  "",
].join("\n");

describe("the issue page and Review in a browser (C2a: ISS, REV, NEW-dashboard-17, -19)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;

  const bundle = (id: string, passed: boolean, extra: Record<string, unknown> = {}) => ({
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    passed,
    failures: [],
    skipped: [],
    unavailable: [],
    stopReason: passed ? "gate_passed" : "human_abort",
    turnsUsed: 2,
    durationMs: 1000,
    rungResults: GATES.map((gate) => ({
      gate,
      rung: "hygiene",
      layer: "functional",
      passed: gate !== "osv" && gate !== "semgrep",
      ...(gate === "osv" || gate === "semgrep" ? { skipped: true } : {}),
      exitCode: 0,
      durationMs: 90,
    })),
    ...extra,
  });

  /** The bundle on disk and on the ledger, as a run leaves it. */
  async function evidence(id: string, passed: boolean, extra: Record<string, unknown> = {}) {
    const dirEv = join(dir, ".sekhemet", "evidence");
    mkdirSync(dirEv, { recursive: true });
    const body = JSON.stringify(bundle(id, passed, extra));
    writeFileSync(join(dirEv, `ev_${id}.json`), body);
    writeFileSync(join(dirEv, `latest-${id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "stand-in",
      passed,
      stopReason: passed ? "gate_passed" : "human_abort",
      evidenceId: `ev_${id}`,
      path: `.sekhemet/evidence/ev_${id}.json`,
      body,
      filesTouched: (extra.filesTouched as string[] | undefined) ?? [],
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-issue-c2a-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    const card = async (id: string, title: string, status: string, extra = {}) => {
      const start = status === "backlog" || status === "ready" ? status : "ready";
      await store.createCard({ id, tier: "story", title, status: start, ...extra });
      if (status !== start)
        await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
    };
    await card("card_dep", "Show the weekly total on the timesheet", "ready", {
      scopeFiles: ["src/total.ts"],
    });
    await card("card_rv", "Flag hours past 40 in a week as overtime", "review", {
      scopeFiles: ["src/overtime.ts"],
      acceptanceCriteria: [
        "Hours past 40 in one week are overtime.",
        "A week of 40 hours or fewer has no overtime.",
      ],
      spec: "Flag hours past 40 in a week as overtime.",
      priority: 3,
      estimate: 3,
      labels: ["overtime-rules"],
      dependsOn: ["card_dep"],
      difficulty: 4,
      assignee: "worker",
      delegate: { kind: "worker" },
    });
    await evidence("card_rv", true, {
      filesTouched: ["src/overtime.ts"],
      linesAdded: 3,
      linesRemoved: 0,
      diff: DIFF,
    });
    // The AI review's findings on the change under review (RG-P8-9).
    await store.recordDossierEntry({
      cardId: "card_rv",
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      text: "no test: Hours past 40 in one week are overtime. — No staged test case names this criterion. (src/overtime.ts:2)",
      sources: ["src/overtime.ts"],
      modelId: "stand-in",
    });
    await store.recordDossierEntry({
      cardId: "card_rv",
      kind: "review",
      actor: "reviewer",
      verdict: "met",
      text: "A week of 40 hours or fewer has no overtime. (src/overtime.ts:2)",
      sources: ["src/overtime.ts"],
      modelId: "stand-in",
    });
    await card("card_ok", "Export a week's entries as CSV", "review", {
      scopeFiles: ["src/csv.ts"],
      acceptanceCriteria: ["A week exports as CSV."],
    });
    await evidence("card_ok", true);
    // A run a person stopped (ISS-02): asked to stop, then left in Verify.
    await card("card_stop", "Work out the pay period of a date", "in_progress", {
      scopeFiles: ["src/pay_period.ts"],
      stepBudget: 5,
      delegate: { kind: "worker" },
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    const headers = { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) };
    expect(
      (
        await fetch(`${base}/api/cards/card_stop/abort`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
    await evidence("card_stop", false);
    await store.updateCardStatus("card_stop", "verify", "the run stopped", "executor", {
      override: true,
    });
    await store.updateCard("card_stop", { stopReason: "human_abort", stepsUsed: 2 }, "executor");
    // A teammate's open review thread (REV-03).
    const thread = await fetch(`${base}/api/cards/card_rv/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "Do contractors get overtime too?" }),
    });
    expect(thread.status).toBe(200);
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, width: number, role = "code", height = 900): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((r) => {
      try {
        localStorage.setItem("sekhemet-role", r);
      } catch {}
    }, role);
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host, #view > *").first().waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    return page;
  }

  const noSideScroll = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  it(
    "ISS-01: at 1440 px a 288 px properties rail on the right, in the mockup's order, edited with the list's editor",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv", 1440);
      const rail = page.locator("[data-rail]");
      await rail.locator(".iprop").first().waitFor();
      const box = await rail.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(288);
      expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(1440);
      expect(await rail.locator("summary").isVisible()).toBe(false);
      const labels = await rail.locator(".iprop dt").allInnerTexts();
      expect(labels).toEqual([
        "Assignee",
        "Delegate",
        "Reviewers",
        "Reporter",
        "Type",
        "Priority",
        "Sprint",
        "Epic",
        "Labels",
        "Due",
        "Blocked by",
        "Blocks",
        "Branch",
      ]);
      const text = await rail.innerText();
      expect(text).toContain("overtime-rules");
      // No run made a branch in this repository yet.
      expect(await rail.locator('[data-prop-row="Branch"]').innerText()).toMatch(/None yet/);
      expect(text).toContain("Medium");
      // Blocked by names the issue with its board column.
      expect(await rail.locator('[data-prop-row="Blocked by"]').innerText()).toMatch(/To do/);
      // The rail edits with the list's editor and records the same edit.
      await rail.locator('[data-prop="priority"]').click();
      await page.getByRole("option", { name: "Urgent" }).click();
      await expect
        .poll(
          async () =>
            (
              (await (await fetch(`${base}/api/cards/card_rv`)).json()) as {
                card: { priority?: number };
              }
            ).card.priority,
          { timeout: 5000 },
        )
        .toBe(1);
      expect(await page.locator(".toast").last().innerText()).toMatch(/Undo/);
      await page.context().close();
    },
  );

  it(
    "ISS-01, ISS-07, ISS-08: below 1280 px the rail is a Properties disclosure under the header; the tab names the issue",
    { timeout: 60_000 },
    async () => {
      for (const width of [1100, 400]) {
        const page = await open("#/card/card_rv", width);
        const rail = page.locator("[data-rail]");
        await rail.locator("summary").waitFor();
        expect(await rail.locator("summary").innerText()).toBe("Properties");
        expect(await rail.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
        const railTop = (await rail.boundingBox())?.y ?? 0;
        const tabsTop = (await page.locator(".cv-tabs").boundingBox())?.y ?? 0;
        const headBottom = await page
          .locator(".cv-h")
          .evaluate((h) => h.getBoundingClientRect().bottom);
        expect(railTop).toBeGreaterThanOrEqual(Math.floor(headBottom));
        expect(railTop).toBeLessThan(tabsTop);
        expect(await noSideScroll(page), `${width} px scrolls sideways`).toBe(true);
        expect(await page.title()).toMatch(/Flag hours past 40 in a week as overtime · /);
        await page.context().close();
      }
    },
  );

  it(
    "ISS-02, ISS-03: a stopped run is one state, Stopped, with who stopped it and Resume",
    { timeout: 60_000 },
    async () => {
      const api = (await (await fetch(`${base}/api/cards/card_stop`)).json()) as {
        card: { display: { stopLabel?: string } };
        ai: { who: string; state: string; stopped?: boolean }[];
      };
      expect(api.ai[0]).toMatchObject({ who: "agent", state: "paused", stopped: true });
      expect(api.card.display.stopLabel).toBe("Stopped");
      const page = await open("#/card/card_stop", 1440);
      await page.locator(".agent-bar").waitFor();
      expect(await page.locator(".cv-h .pill").innerText()).toBe("Stopped");
      const bar = await page.locator(".agent-bar").innerText();
      expect(bar).toMatch(/Stopped by you after step 2/);
      const all = await page.locator(".cv").innerText();
      expect(all).not.toMatch(/checks are running|Checks failed|working/i);
      expect(await page.locator(".activity, #panel").first().innerText()).toMatch(
        /stopped the run/,
      );
      await page.locator('[data-agent="resume"]').click();
      await expect
        .poll(
          async () =>
            (
              (await (await fetch(`${base}/api/cards/card_stop`)).json()) as {
                card: { status: string };
              }
            ).card.status,
          { timeout: 5000 },
        )
        .toBe("ready");
      await page.context().close();
    },
  );

  it("ISS-06: Activity says what happened, never an event type", { timeout: 60_000 }, async () => {
    const page = await open("#/card/card_rv/activity", 1440);
    await page.locator("#panel").waitFor();
    await page.waitForTimeout(500);
    const text = await page.locator("#panel").innerText();
    // One line for the AI review, with its AI badge (DEC-36) and its counts.
    expect(text).toMatch(/AI review\s+AI[\s\S]{0,20}reviewed the change: 1 unmet, 1 met/);
    expect(text).not.toMatch(/card review|to Verify/);
    await page.context().close();
  });

  it(
    "REV-01: the queue, the Checks heading, the tip and the rail give one answer; a skipped check is no failure",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review/card_rv", 1440);
      await page.locator(".g-strip").waitFor();
      const row = page.locator("#q-card_rv");
      const short = /(\d+) passed · 2 skipped/.exec(await row.innerText());
      expect(short, "the queue row's verdict").not.toBeNull();
      expect(await row.locator(".i-fail").count()).toBe(0);
      expect(await row.locator(".i-pass").count()).toBe(1);
      // The Checks heading counts the same checks the same way.
      const heading = await page.locator('section[aria-label="Checks"] h3').innerText();
      expect(heading).toContain(
        `All ${short?.[1]} checks that ran passed · OSV and Semgrep skipped`,
      );
      const facts = await page.locator(".facts").innerText();
      expect(facts).not.toMatch(/Criteria are checked by the acceptance tests/);
      expect(facts).toMatch(/No acceptance test checks these criteria/);
      // REV-08: the security family holds only skipped misses — neutral, and a click explains it.
      const security = page.locator(".g-seg.grp", { hasText: "OSV" });
      expect(await security.getAttribute("class")).toMatch(/\bskipped\b/);
      const red = await security
        .locator(".fl")
        .evaluate(
          (n) =>
            getComputedStyle(n).color ===
            getComputedStyle(document.body).getPropertyValue("--state-fail"),
        );
      expect(red).toBe(false);
      await security.click();
      await expect.poll(() => page.locator(".toast").last().innerText()).toMatch(/skipped/);
      await page.context().close();
    },
  );

  it(
    "REV-02, REV-03: Accept's conditions are a full-width checklist, the open conversation among them",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review/card_rv", 1440);
      const list = page.locator("#accept-why");
      await list.waitFor();
      const items = await list.locator("li").allInnerTexts();
      expect(items).toEqual(
        expect.arrayContaining(["1 finding to acknowledge", "1 open conversation"]),
      );
      const box = await list.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(400);
      for (const li of await list.locator("li").all()) {
        expect((await li.boundingBox())?.height ?? 99).toBeLessThan(40);
      }
      // The teammate's question is on Review, before Accept.
      expect(await page.locator(".ev-scroll").innerText()).toMatch(
        /Do contractors get overtime too\?/,
      );
      await page.context().close();
    },
  );

  it(
    "REV-02: at 400 px the bar is equal 48 px buttons, none cut or overprinted, under the checklist",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review/card_rv", 400, "code", 860);
      await page.locator(".triage [data-accept]").waitFor();
      const buttons = await page.locator(".triage .btn:visible").all();
      expect(buttons.length).toBeGreaterThanOrEqual(3);
      const boxes = [];
      for (const b of buttons) {
        const r = await b.boundingBox();
        expect(r?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(await b.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
        boxes.push(r as { x: number; y: number; width: number; height: number });
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i], boxes[j]];
          if (!a || !b) continue;
          const apart =
            a.x + a.width <= b.x + 0.5 ||
            b.x + b.width <= a.x + 0.5 ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y;
          expect(apart, `buttons ${i} and ${j} overlap`).toBe(true);
        }
      const list = await page.locator("#accept-why").boundingBox();
      expect((list?.y ?? 0) + (list?.height ?? 0)).toBeLessThanOrEqual(
        Math.min(...boxes.map((b) => b.y)),
      );
      expect(await noSideScroll(page)).toBe(true);
      // A finding's Acknowledge stays inside its card.
      const ack = await page.locator("[data-ack]").first().boundingBox();
      const card = await page.locator("li.rf").first().boundingBox();
      expect((ack?.x ?? 0) + (ack?.width ?? 0)).toBeLessThanOrEqual(
        (card?.x ?? 0) + (card?.width ?? 0) + 0.5,
      );
      await page.context().close();
    },
  );

  it(
    "BRD-11: the Review checks bar cuts no family, failed name or count at 1440 and 1100 px",
    { timeout: 60_000 },
    async () => {
      for (const width of [1440, 1100, 400]) {
        const page = await open("#/review/card_rv", width);
        await page.locator(".g-strip .g-seg.grp").first().waitFor();
        const cut = await page.evaluate(() =>
          [...document.querySelectorAll(".g-strip .g-seg")].flatMap((seg) => {
            const parts = [...seg.querySelectorAll(".nm, .sec, .fl, .t")];
            const edge = seg.getBoundingClientRect().right;
            return [
              ...parts
                .filter((e) => e.scrollWidth > e.clientWidth + 0.5)
                .map((e) => `${e.className}: ${e.textContent} ${e.scrollWidth}>${e.clientWidth}`),
              ...parts
                .filter((e) => e.getBoundingClientRect().right > edge + 0.5)
                .map((e) => `${e.className}: ${e.textContent} past its segment`),
            ];
          }),
        );
        expect(cut, `${width} px`).toEqual([]);
        expect(await page.locator(".g-seg.grp", { hasText: "OSV, Semgrep" }).count()).toBe(1);
        expect(await noSideScroll(page)).toBe(true);
        await page.context().close();
      }
    },
  );

  it("REV-07: with the note open, one Request changes shows", { timeout: 60_000 }, async () => {
    const page = await open("#/review/card_rv", 1440);
    await page.locator(".triage [data-back]").waitFor();
    await page.locator(".triage [data-back]").click();
    await page.locator("[data-composer]").waitFor();
    expect(await page.locator("button:visible", { hasText: "Request changes" }).count()).toBe(1);
    await page.context().close();
  });

  it(
    "REV-04, REV-06: the Accept toast is plain, and leaving within the grace sends the Accept",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/review/card_ok", 1440);
      let sent = 0;
      await page.route("**/api/cards/card_ok/accept", async (route) => {
        sent += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            status: "done",
            sha: "a394ee4f0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
            notice:
              "Your checkout /Users/someone/timesheets is on main, which moved to a394ee4f0c; to bring its files up to date (unsaved edits kept): `git -C /Users/someone/timesheets read-tree -m -u 1111111 main`",
          }),
        });
      });
      const accept = page.locator(".triage [data-accept]");
      await expect.poll(() => accept.isEnabled(), { timeout: 5000 }).toBe(true);
      await accept.click();
      // Leave the view inside the 3-second grace: the Accept goes now, not never.
      await page.evaluate(() => {
        location.hash = "#/board";
      });
      await expect.poll(() => sent, { timeout: 1500 }).toBe(1);
      const toast = page.locator(".toast", { hasText: "Merged to main" });
      await toast.waitFor();
      const words = await toast.innerText();
      expect(words).toMatch(/Merged to main as a394ee4/);
      // The issue page offers Revert (NEW-dashboard-21), so the toast says where (§2.5.10).
      expect(words).toMatch(/You can revert it from the issue page\./);
      expect(words).toMatch(/Your checkout of main is now behind it\./);
      expect(words).not.toMatch(/read-tree|\/Users\/|a394ee4f0c/);
      await page.context().close();
    },
  );

  it(
    "§2.5.10: Esc on the issue page inside Accept's grace cancels it, with no request sent",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_ok", 1440);
      let sent = 0;
      await page.route("**/api/cards/card_ok/accept", async (route) => {
        sent += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      const accept = page.locator("[data-accept]").first();
      await expect.poll(() => accept.isEnabled(), { timeout: 5000 }).toBe(true);
      await accept.click();
      await page.locator(".toast", { hasText: "Accepting" }).waitFor();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await page.locator(".toast", { hasText: "Accept cancelled. Nothing was merged." }).waitFor();
      expect(await page.evaluate(() => location.hash)).toBe("#/card/card_ok");
      await page.waitForTimeout(3500);
      expect(sent).toBe(0);
      await page.context().close();
    },
  );

  it(
    "NEW-dashboard-17: a person who manages the work reviews on the criteria view, under Accept's own conditions",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/status", 1440, "manage");
      const link = page.locator('a:has-text("Review it")').first();
      await link.waitFor();
      expect(await link.getAttribute("href")).toMatch(/^#\/card\/card_(rv|ok)\/criteria$/);
      await page.goto(`${base}/#/card/card_rv/criteria`);
      await page.locator("#panel .crit-view").waitFor();
      expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toMatch(
        /^Criteria/,
      );
      const panel = await page.locator("#panel").innerText();
      expect(panel).toMatch(/Hours past 40 in one week are overtime\./);
      expect(panel).toMatch(/Unmet/);
      // Accept stays disabled, its conditions beside it, each linked to where it is met.
      const findings = page.locator("#accept-why li.bl-findings a");
      await findings.waitFor();
      expect(await page.locator(".cv-h [data-accept]").isDisabled()).toBe(true);
      expect(await findings.getAttribute("href")).toBe("#/card/card_rv/criteria");
      await page.locator("#panel [data-ack]").first().click();
      await expect
        .poll(() => page.locator("#accept-why li.bl-findings").count(), { timeout: 3000 })
        .toBe(0);
      // DB-N17-2: Accept is enabled exactly when no condition is left — the
      // files Review showed count here too, the conversation only informs.
      const left = await page.locator("#accept-why li.bl-block").count();
      expect(await page.locator(".cv-h [data-accept]").isDisabled()).toBe(left > 0);
      for (const a of await page.locator("#accept-why li.bl-files a").all())
        expect(await a.getAttribute("href")).toBe("#/card/card_rv/changes");
      await page.context().close();
    },
  );

  it(
    "REV-09: a diff line on Changes shows a comment control on hover and opens its comment",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv/changes", 1440);
      const line = page.locator("#panel .group .ln.add").first();
      await line.waitFor();
      await line.hover();
      const plus = await line
        .locator(".o")
        .evaluate((n) => getComputedStyle(n, "::before").content);
      expect(plus).toBe('"+"');
      await line.click();
      const form = page.locator("[data-lc-form]");
      expect(await form.locator('[name="file"]').inputValue()).toBe("src/overtime.ts");
      expect(await form.locator('[name="line"]').inputValue()).toMatch(/^\d+$/);
      await page.context().close();
    },
  );

  it(
    "ISS-05: the peek names the difficulty, the assignee, the delegate",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/board", 1440);
      await page.locator("#tile-card_rv").click();
      const peek = page.locator(".peek");
      await expect.poll(() => peek.innerText(), { timeout: 5000 }).toMatch(/Delegate/);
      const text = await peek.innerText();
      expect(text).toMatch(/Difficulty\s*4 of 10/);
      expect(text).toMatch(/Assignee/);
      await page.context().close();
    },
  );
});
