import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import {
  type SeededBoard,
  openContext,
  seedBoard,
  writeEvidence,
} from "./support/dashboard_seed.js";

// The issue page, the peek and Review through their door (C2d, FINDINGS_C1
// TST-01): a real server over a real ledger and a real gates.toml, driven in
// Chromium. Each test names the dashboard criterion it proves; before C2d
// these were proved only by pure render functions in packages/ui/tests. No
// model is loaded: the Worker's live output is the runner's own live file.

/** Thirteen declared checks in five families; the Size check is derived (domain17 §2). */
const DECLARED: [string, string, string][] = [
  ["typecheck", "typecheck", "static"],
  ["lint", "lint", "static"],
  ["unit", "test", "functional"],
  ["acceptance", "test", "functional"],
  ["regression", "test", "functional"],
  ["gitleaks", "security", "security"],
  ["osv", "security", "security"],
  ["licenses", "security", "security"],
  ["semgrep", "security", "security"],
  ["trailers", "hygiene", "hygiene"],
  ["architecture", "hygiene", "hygiene"],
  ["claims", "hygiene", "hygiene"],
  ["mutation", "robustness", "robustness"],
];

function gatesToml(gates: [string, string, string][]): string {
  return [
    "[project]",
    "max_files = 10",
    "max_diff_lines = 400",
    "",
    ...gates.flatMap(([id, rung, layer]) => [
      "[[gate]]",
      `id = "${id}"`,
      `rung = "${rung}"`,
      `layer = "${layer}"`,
      'command = "node"',
      'args = ["-e", "process.exit(0)"]',
      "timeout_s = 60",
      'parser = "generic"',
      "",
    ]),
  ].join("\n");
}

/** A diff touching three implementation files: 5, 20 and 1 changed lines. */
const DIFF = [
  ["src/alpha.ts", 5],
  ["src/beta.ts", 20],
  ["src/gamma.ts", 1],
]
  .flatMap(([path, n]) => [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${n} @@`,
    ...Array.from({ length: Number(n) }, (_, i) => `+export const v${i} = ${i};`),
  ])
  .concat("")
  .join("\n");

async function startOver(seed: SeededBoard) {
  const server = await startDashboardServer({
    db: seed.db,
    log: seed.log,
    boardService: new BoardServiceImpl(seed.store, { entryConditions: true }),
    cardStore: seed.store,
    repoPath: seed.dir,
    port: 0,
    streamIntervalMs: 200,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("the issue page, the peek and Review in Chromium (C2d)", () => {
  let seed: SeededBoard;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-issue-entry-");
    writeFileSync(join(seed.dir, ".sekhemet", "gates.toml"), gatesToml(DECLARED));
    // card_rv1: In review after a run that ran all thirteen checks; Tests and
    // Gitleaks failed. Its diff touches three files, the failure is in the
    // smallest; it supersedes a base test (gates rule 25a).
    await seed.store.updateCard("card_rv1", {
      scopeFiles: ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"],
      supersedes: ["tests/week.spec.ts > totals a week"],
    } as never);
    writeEvidence(seed.dir, "card_rv1", {
      passed: false,
      stopReason: "gate_failed",
      filesTouched: ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"],
      linesAdded: 26,
      linesRemoved: 0,
      diff: DIFF,
      rungResults: DECLARED.map(([gate, rung, layer]) => ({
        gate,
        rung,
        layer,
        passed: gate !== "unit" && gate !== "gitleaks",
        exitCode: gate === "unit" || gate === "gitleaks" ? 1 : 0,
        durationMs: 120,
      })),
      failures: [
        {
          gate: "unit",
          rung: "test",
          errorExcerpt: "expected 40 to be 32",
          location: { file: "src/gamma.ts", line: 1 },
        },
        { gate: "gitleaks", rung: "security", errorExcerpt: "generic-api-key in src/beta.ts" },
      ],
      superseded: [
        {
          test: "tests/week.spec.ts > totals a week",
          staged: ["tests/week.spec.ts > totals a week with Sunday hours"],
        },
      ],
    });
    // card_rv2: passed, having run only two checks; no Parse check is declared.
    writeEvidence(seed.dir, "card_rv2", {
      passed: true,
      stopReason: "gate_passed",
      filesTouched: ["src/flag.ts"],
      linesAdded: 3,
      linesRemoved: 0,
      rungResults: [
        { gate: "typecheck", rung: "typecheck", layer: "static", passed: true, exitCode: 0 },
        { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 },
      ],
    });
    // card_td2: back in Planning after an attempt whose type check failed (DB-N1-3).
    writeEvidence(seed.dir, "card_td2", {
      passed: false,
      stopReason: "gate_failed",
      rungResults: [{ gate: "typecheck", rung: "typecheck", layer: "static", passed: false }],
      failures: [{ gate: "typecheck", rung: "typecheck", errorExcerpt: "TS2322 in src/plan.ts" }],
    });
    // card_td1: To do, its last attempt stopped for a reason this build has no words for.
    writeEvidence(seed.dir, "card_td1", {
      passed: false,
      stopReason: "gpu_fell_asleep",
      rungResults: [],
      failures: [],
    });
    ({ server, base } = await startOver(seed));
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  async function open(hash: string, width = 1440): Promise<Page> {
    const { page } = await openContext(browser, width, { project: seed.project });
    await page.goto(`${base}/${hash}`);
    return page;
  }

  /** The Checks strip's segments as a person reads them. */
  const segments = (page: Page, scope: string) =>
    page.$$eval(`${scope} .g-strip .g-seg`, (ss) =>
      ss.map((s) => ({
        label: s.querySelector(".nm")?.textContent ?? "",
        count: s.querySelector(".sec")?.textContent ?? "",
        failing: s.querySelector(".fl")?.textContent ?? "",
        overflow: s.querySelector(".t")?.textContent ?? "",
        state: [...s.classList].filter((c) => !["g-seg", "grp"].includes(c)).join(" "),
      })),
    );

  it(
    "DB-N1-1: 14 checks in 5 families are 5 grouped segments, failing groups first, with +n passed",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv1/checks");
      await page.locator("#panel .g-strip .g-seg").first().waitFor();
      const segs = await segments(page, "#panel");
      expect(segs.map((s) => [s.label, s.count, s.overflow])).toEqual([
        ["Tests", "2/3", "+2 passed"],
        ["Security", "3/4", "+3 passed"],
        ["Static", "2/2", ""],
        ["Mutation", "1/1", ""],
        ["Size and integrity", "4/4", ""],
      ]);
      // A failing group names its failed checks by their own names.
      expect(segs[0]?.failing).toMatch(/^Tests/);
      expect(segs[1]?.failing).toMatch(/^Gitleaks/);
      // The peek shows the same strip.
      await page.goto(`${base}/#/board`);
      await page.locator("#tile-card_rv1 .title").click();
      await page.locator(".peek .g-strip .g-seg").first().waitFor();
      expect((await segments(page, ".peek")).map((s) => s.label)).toEqual(segs.map((s) => s.label));
      await page.context().close();
    },
  );

  it(
    "DB-N1-2: at 400 px the strip is a vertical list with no overlapping text",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv1/checks", 400);
      await page.locator("#panel .g-strip .g-seg").first().waitFor();
      const boxes = await page.$$eval("#panel .g-strip .g-seg", (ss) =>
        ss.map((s) => {
          const r = s.getBoundingClientRect();
          const texts = [...s.querySelectorAll<HTMLElement>(".nm, .sec, .fl, .t")]
            .filter((t) => t.offsetParent !== null)
            .map((t) => t.getBoundingClientRect());
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, texts };
        }),
      );
      expect(boxes.length).toBe(5);
      for (let i = 1; i < boxes.length; i++) {
        const [a, b] = [boxes[i - 1], boxes[i]] as [(typeof boxes)[0], (typeof boxes)[0]];
        // One under another, never side by side, never overlapping.
        expect(b.top).toBeGreaterThanOrEqual(a.bottom - 0.5);
        expect(Math.abs(b.left - a.left)).toBeLessThan(1);
      }
      for (const b of boxes) {
        expect(b.right).toBeLessThanOrEqual(400);
        // The texts inside a segment do not overlap each other.
        for (let i = 0; i < b.texts.length; i++)
          for (let j = i + 1; j < b.texts.length; j++) {
            const [p, q] = [b.texts[i], b.texts[j]] as [DOMRect, DOMRect];
            const overlap =
              p.left < q.right - 0.5 &&
              q.left < p.right - 0.5 &&
              p.top < q.bottom - 0.5 &&
              q.top < p.bottom - 0.5;
            expect(overlap).toBe(false);
          }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.context().close();
    },
  );

  it(
    "DB-N1-3: a card in Planning with failing evidence shows one badge, Needs a new plan, never a failure mark",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_td2");
      const pill = page.locator(".pill").first();
      await expect.poll(() => pill.innerText()).toBe("Needs a new plan");
      expect(await pill.locator(".i-fail").count()).toBe(0);
      expect(await page.locator(".pill").count()).toBe(1);
      // The board's tile says the state first, with no failure tone on the stage.
      await page.goto(`${base}/#/board`);
      const tile = page.locator("#tile-card_td2");
      await tile.waitFor();
      expect(await tile.locator(".st").innerText()).toMatch(/^Needs a new plan · Types failed/);
      expect(await tile.getAttribute("class")).not.toContain("t-fail");
      await page.context().close();
    },
  );

  it(
    "DB-N1-4: no Parse segment when Parse neither ran nor is declared; a declared Parse that did not run reads Not run",
    { timeout: 90_000 },
    async () => {
      const page = await open("#/card/card_rv2/checks");
      await page.locator("#panel .g-strip .g-seg").first().waitFor();
      const labels = (await segments(page, "#panel")).map((s) => s.label);
      expect(labels.join(" ")).not.toMatch(/Parse/);
      await page.context().close();
      // A second repository whose gates.toml declares Parse, which this run did not reach.
      const other = await seedBoard("sek-issue-parse-");
      try {
        writeFileSync(
          join(other.dir, ".sekhemet", "gates.toml"),
          gatesToml([
            ["parse", "parse", "static"],
            ["typecheck", "typecheck", "static"],
            ["unit", "test", "functional"],
          ]),
        );
        writeEvidence(other.dir, "card_rv2", {
          passed: true,
          stopReason: "gate_passed",
          filesTouched: ["src/flag.ts"],
          rungResults: [
            { gate: "typecheck", rung: "typecheck", layer: "static", passed: true, exitCode: 0 },
            { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 },
          ],
        });
        const s = await startOver(other);
        try {
          const { page: p } = await openContext(browser, 1440, { project: other.project });
          await p.goto(`${s.base}/#/card/card_rv2/checks`);
          const parse = p.locator('#panel .g-strip .g-seg[data-gate="parse"]');
          await parse.waitFor();
          const said = `${await parse.innerText()} ${await parse.getAttribute("aria-label")}`;
          expect(said).toMatch(/not run/i);
          expect(said).not.toMatch(/passed/i);
          expect(await parse.getAttribute("class")).toContain("not_run");
          await p.context().close();
        } finally {
          await s.server.close();
        }
      } finally {
        other.cleanup();
      }
    },
  );

  it(
    "DB-N2-6: a stop reason the vocabulary does not know reads as its humanised enum",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/board");
      const st = page.locator("#tile-card_td1 .st");
      await st.waitFor();
      expect(await st.innerText()).toBe("Failed · Gpu fell asleep · will retry");
      await page.context().close();
    },
  );

  it(
    "DB-N2-5: the type reads from the stored change and split, never from the kind or the title",
    { timeout: 60_000 },
    async () => {
      // A fix whose title says nothing of a bug; a title naming a SPIDR split it was not given.
      await seed.store.createCard({
        id: "card_fx1",
        tier: "task",
        title: "Add the weekly report",
        status: "backlog",
        projectId: seed.project,
        kind: "implement",
        change: "fix",
      });
      await seed.store.createCard({
        id: "card_sp1",
        tier: "task",
        title: "Store the totals (SPIDR: Data)",
        status: "backlog",
        projectId: seed.project,
        kind: "data",
        split: null,
      });
      await seed.store.createCard({
        id: "card_sp2",
        tier: "task",
        title: "Pay one route of overtime",
        status: "backlog",
        projectId: seed.project,
        kind: "implement",
        split: "path",
      });
      const { ctx, page } = await openContext(browser, 1440, { project: seed.project });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("sekhemet-tips", "on");
        } catch {}
      });
      const typeOf = async (id: string) => {
        await page.goto(`${base}/#/card/${id}`);
        const q = page.locator('[data-tip="type"]').first();
        await q.waitFor();
        await q.click();
        const yours = page.locator(".tip-yours");
        await yours.waitFor();
        const out = {
          term: await page.locator("#tip-pop-h").innerText(),
          yours: await yours.innerText(),
        };
        await page.keyboard.press("Escape");
        return out;
      };
      expect((await typeOf("card_fx1")).term).toMatch(/Bug/);
      expect((await typeOf("card_sp1")).yours).toContain(
        "This issue was not split from a larger one.",
      );
      expect((await typeOf("card_sp2")).yours).toContain(
        "Split from a larger story along its Path: one way through it, built end to end.",
      );
      await ctx.close();
    },
  );

  it(
    "DB-N5-1: Review orders Implementation files by failures, then changed lines, never alphabetically",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv1/changes");
      await page.locator("[data-changes] .group[data-file]").first().waitFor();
      const files = await page.$$eval("[data-changes] .group[data-file]", (gs) =>
        gs.map((g) => (g as HTMLElement).dataset.file ?? ""),
      );
      const impl = files.filter((f) => f.startsWith("src/"));
      // gamma has the failure; then beta (20 lines) before alpha (5): not a, b, g.
      expect(impl).toEqual(["src/gamma.ts", "src/beta.ts", "src/alpha.ts"]);
      await page.context().close();
    },
  );

  it(
    "DB-N5-7: a superseded base test is listed old beside new in the Acceptance tests group",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_rv1/changes");
      const table = page.locator("[data-changes] table.sup");
      await table.waitFor();
      const head = await table.locator("thead th").allInnerTexts();
      expect(head.length).toBe(2);
      const row = await table.locator("tbody tr").first().locator("td").allInnerTexts();
      expect(row).toEqual([
        "tests/week.spec.ts > totals a week",
        "tests/week.spec.ts > totals a week with Sunday hours",
      ]);
      // It sits in an Acceptance tests group.
      expect(
        await table.evaluate((t) => t.closest(".group")?.classList.contains("acceptance")),
      ).toBe(true);
      await page.context().close();
    },
  );

  it(
    "DB-N3-1: the Steps tab of a running card appends the stream's tokens to the current step, with no animation, then shows the step's summary",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_ip1/steps");
      const out = page.locator("[data-live-out]");
      await out.waitFor({ state: "attached" });
      const live = join(seed.dir, ".sekhemet", "live");
      mkdirSync(live, { recursive: true });
      const file = join(live, "card_ip1.txt");
      writeFileSync(file, "I will read src/pay.ts");
      await expect.poll(() => out.textContent(), { timeout: 5000 }).toBe("I will read src/pay.ts");
      writeFileSync(file, "I will read src/pay.ts first, then write the period.");
      await expect
        .poll(() => out.textContent(), { timeout: 5000 })
        .toBe("I will read src/pay.ts first, then write the period.");
      // No animation on the streamed text.
      const style = await out.evaluate((e) => {
        const s = getComputedStyle(e);
        return {
          animation: s.animationName,
          transition: s.transitionDuration,
          anims: e.getAnimations().length,
        };
      });
      expect(style).toEqual({ animation: "none", transition: "0s", anims: 0 });
      // The step ends: its summary replaces the streamed text.
      await seed.store.recordEvent({
        type: "card/step",
        cardId: "card_ip1",
        actor: "executor",
        payload: {
          id: "card_ip1",
          turn: 1,
          calls: [{ name: "read_file", target: "src/pay.ts", ok: true, summary: "Read 20 lines" }],
        },
      });
      const step = page.locator("#step-1");
      await step.waitFor({ timeout: 5000 });
      expect(await step.innerText()).toContain("src/pay.ts");
      await expect.poll(() => out.textContent(), { timeout: 5000 }).toBe("");
      expect(await page.locator("[data-live-out]").isHidden()).toBe(true);
      await page.context().close();
      writeFileSync(file, "");
    },
  );

  it(
    "DB-N3-2: with the Steps tab closed no token text is kept; the tab shows only what streams after it opens",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/card/card_ip1/activity");
      await page.locator("#tab-activity").waitFor();
      const file = join(seed.dir, ".sekhemet", "live", "card_ip1.txt");
      writeFileSync(file, "TOKENS-WHILE-CLOSED and more text");
      await page.waitForTimeout(1200);
      // Nothing on the page or in its store holds the text.
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        "TOKENS-WHILE-CLOSED",
      );
      const kept = await page.evaluate(
        `import("/app/store.js").then(({ store }) => JSON.stringify(store.state))`,
      );
      expect(String(kept)).not.toContain("TOKENS-WHILE-CLOSED");
      // Opened now, the tab waits for the next frame: the earlier text was not kept.
      await page.locator("#tab-steps").click();
      const out = page.locator("[data-live-out]");
      await out.waitFor({ state: "attached" });
      await page.waitForTimeout(800);
      expect(await out.textContent()).toBe("");
      expect(await page.locator("[data-live-wait]").isVisible()).toBe(true);
      // The next frame shows.
      writeFileSync(file, "TOKENS-AFTER-OPEN");
      const later = new Date(Date.now() + 2000);
      utimesSync(file, later, later);
      await expect.poll(() => out.textContent(), { timeout: 5000 }).toBe("TOKENS-AFTER-OPEN");
      await page.context().close();
      writeFileSync(file, "");
    },
  );

  it(
    "DB-N14-2: an issue in Backlog shows Ready to start, each entry condition met or not with its reason",
    { timeout: 60_000 },
    async () => {
      // A Backlog issue waiting on an unfinished one, with no criteria approved and no scope.
      await seed.store.createCard({
        id: "card_rd1",
        tier: "task",
        title: "Pay overtime for a split week",
        status: "backlog",
        projectId: seed.project,
        dependsOn: ["card_ip1"],
        acceptanceCriteria: ["A week split across two periods pays overtime once."],
        criterionIds: ["rd1.c1"],
      });
      const page = await open("#/card/card_rd1");
      const ready = page.locator("[data-ready] .rd");
      await ready.waitFor();
      expect(await ready.locator("#rd-h").innerText()).toMatch(/^Ready to start/);
      const rows = await ready.locator(".rd-row").evaluateAll((rs) =>
        rs.map((r) => ({
          met: r.classList.contains("met"),
          label: r.querySelector(".rd-l")?.textContent ?? "",
          state: r.querySelector(".rd-s")?.textContent ?? "",
          reason: r.querySelector(".rd-r")?.textContent ?? "",
        })),
      );
      expect(rows.length).toBeGreaterThanOrEqual(5);
      const waits = rows.find((r) => /depend|wait/i.test(r.label + r.reason));
      expect(waits).toMatchObject({ met: false });
      expect(waits?.reason).toContain("Work out the pay period of a date");
      const scope = rows.find((r) => /declares no files/.test(r.reason));
      expect(scope?.met).toBe(false);
      expect(rows.some((r) => r.met)).toBe(true);
      for (const r of rows) expect(r.state).toBe(r.met ? "Met" : "Not met");
      // In progress: building started, so no Ready to start.
      await page.goto(`${base}/#/card/card_ip1`);
      await page.locator(".pill").first().waitFor();
      await page.waitForTimeout(400);
      expect(await page.locator("[data-ready] .rd").count()).toBe(0);
      await page.context().close();
    },
  );
});
