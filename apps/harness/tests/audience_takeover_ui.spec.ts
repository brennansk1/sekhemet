import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Served, serveWorkspace } from "./support/audience.js";
import { type TakeoverFixture, halfDoneFixture } from "./takeover_fixture.js";

/**
 * The take-over audience (DEFINITION_OF_DONE §6.4 item 4; design-stage
 * DS-TO-15, DS-TO-16, DS-TO-1 to -3; W10): a person inherits a half-built
 * repository and, from *Take over a project*, with no terminal, reads what
 * Sekhemet found, with nothing in the repository run before trust. The
 * built `sekhemet serve` over the DS-TO-8 fixture (`takeover_fixture.ts`: a
 * half-built TypeScript service with lifecycle scripts that write markers,
 * another agent's hooks, a submodule and a secret committed then deleted),
 * in Chromium. No model is loaded.
 *
 * Reachable today, and proved here: the empty board's Take over, Seshat's
 * report in counts only (DS-TO-10), nothing of the repository run, the
 * secret found in history. Not reachable from the dashboard, so DS-TO-15
 * stops here (stated, not asserted): there is no control to trust the
 * server's own folder (Seshat's reply asks the person to "Trust the
 * repository … then take it over again", and only *Add an existing
 * repository*'s route takes `trust`, which the start page never sends), and
 * none to approve the take-over plan (`POST /api/takeover/approve` has no
 * caller in `packages/ui/web`); the Worker building a card then needs a
 * Coding model `serve` can reach.
 */

describe("a person takes over a half-built repository from the dashboard (DS-TO-15 as far as it is reachable, DoD §6.4)", () => {
  let fx: TakeoverFixture;
  let served: Served;
  let browser: Browser;

  beforeAll(async () => {
    fx = halfDoneFixture();
    served = await serveWorkspace({ repo: fx.root, model: true });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await served?.stop();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it(
    "Take over a project: Seshat reports the findings in counts, nothing in the repository runs, and the deleted secret is found in history",
    { timeout: 120_000 },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        try {
          if (!sessionStorage.getItem("seeded")) localStorage.setItem("sekhemet-role", "seshat");
          sessionStorage.setItem("seeded", "1");
        } catch {}
      });
      const page = await ctx.newPage();
      await page.goto(`${served.base}/#/board`);
      const empty = page.locator(".board-empty");
      await empty.waitFor();
      const posted = page.waitForResponse(
        (r) => r.url().endsWith("/api/takeover") && r.request().method() === "POST",
        { timeout: 90_000 },
      );
      await empty.getByRole("button", { name: "Take over a project" }).click();
      const res = await posted;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        trusted: boolean;
        inventory?: { findings?: { kind?: string; commit?: string; path?: string }[] };
      };
      expect(body.trusted).toBe(false);
      // Seshat says what it found, in counts, with no repository text (DS-TO-10), and what trust would do.
      const reply = page.getByText(
        /^I read the repository as it is: \d+ findings? from its files and history, nothing of it run\./,
      );
      await reply.first().waitFor({ timeout: 30_000 });
      const said = (await reply.first().innerText()).replace(/\s+/g, " ");
      expect(said).toMatch(
        /Trust the repository to let me install, build and run its tests, confined, then take it over again\./,
      );
      expect(said).not.toContain("invoicer");
      expect(said).not.toContain("example.invalid");
      // Nothing in the repository ran: no lifecycle script, no other agent's hook (DS-TO-1, DS-TO-2).
      for (const m of Object.values(fx.markers)) expect(existsSync(m), m).toBe(false);
      expect(existsSync(join(fx.root, "pwned"))).toBe(false);
      // The secret committed and later deleted is found by its commit, never shown (DS-TO-3).
      const state = (await (await page.request.get(`${served.base}/api/takeover`)).json()) as {
        inventory?: { findings?: { kind?: string; commit?: string; detail?: string }[] };
      };
      const findings = JSON.stringify(state);
      expect(findings).toContain(fx.leakCommit.slice(0, 7));
      expect(findings).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
      await ctx.close();
    },
  );
});
