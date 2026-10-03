import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type ReleaseProject, releaseProject } from "./release_fixture.js";

/**
 * Releases, the push and the retrospective in a real Chromium against a real
 * server, repository, remote and ledger (C2b; planner-pm NEW-planner-pm-11,
 * -12; review-git NEW-review-git-7; DoD §2A), at 1440 and 400 px:
 * Configuration › Project turns *Push to remote after Accept and on release*
 * on; a push the remote refuses is said on Status and on the issue; Status's
 * Next release lists the accepted issue, *Propose release* shows the notes
 * and *Tag* writes the tag; after a sprint completes, Status holds Seshat's
 * draft retrospective, its proposed issue is filed in Triage by a press, and
 * a person edits and posts it, listed after. No model.
 */
describe("releases and the retrospective in a browser", () => {
  let p: ReleaseProject;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;
  let other: string;

  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: (await r.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    p = await releaseProject();
    server = await startDashboardServer({
      db: p.db,
      log: p.log,
      boardService: p.board,
      cardStore: p.store,
      repoPath: p.repo,
      port: 0,
      streamIntervalMs: 500,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    p?.close();
    if (other) rmSync(other, { recursive: true, force: true });
  });

  async function open(hash: string, width = 1440): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#side").waitFor({ state: "attached" });
    return page;
  }

  it(
    "RG-N7-5, RG-N7-3: Configuration turns the push on; a push the remote refuses is said on the issue and on Status",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/configuration/project");
      const box = page.locator("[data-push-remote]");
      await expect.poll(() => box.isEnabled()).toBe(true);
      expect(await box.isChecked()).toBe(false);
      expect(await page.locator("#cfg-push-why").innerText()).toContain(
        "Off: accepted work and tags stay in this server's repository.",
      );
      await box.check();
      await page.locator("[data-push-note]", { hasText: "Saved: on." }).waitFor();
      const changed = (await p.log.getEventsByTypes(["project/settings_changed"])).at(-1);
      expect(changed?.payload).toEqual({ project: p.project, push_to_remote: true });
      await page.context().close();

      // Someone else pushed to the remote: the next push is refused, never forced.
      other = mkdtempSync(join(tmpdir(), "sek-other-ui-"));
      const og = (...a: string[]) =>
        execFileSync("git", a, { cwd: other, encoding: "utf8", stdio: "pipe" }).trim();
      og("clone", "-q", p.remote, ".");
      og("config", "user.name", "Other");
      og("config", "user.email", "o@example.com");
      writeFileSync(join(other, "theirs.txt"), "theirs\n");
      og("add", "-A");
      og("commit", "-q", "-m", "chore: theirs");
      og("push", "-q", "origin", "main");

      await p.review("c1", "Fix the overtime total on a short week");
      await p.accept("c1");
      const issue = await open("#/card/c1/activity");
      await issue.locator("#panel").waitFor();
      await expect
        .poll(() => issue.locator("#panel").innerText())
        .toContain(
          "could not push main to origin: the remote holds commits this branch does not have",
        );
      await issue.context().close();

      const status = await open("#/status");
      const fail = status.locator(".stp-a-release .stp-push-fail");
      await fail.waitFor();
      expect(await fail.innerText()).toContain(
        "main was not pushed to origin: rejected (fetch first)",
      );
      await status.context().close();
      // The remote is put back, so the tag below can be pushed.
      p.remoteGit("update-ref", "refs/heads/main", p.git("rev-parse", "main~1"));
    },
  );

  it(
    "PM-N12-1..3: Next release lists the issue; Propose shows the notes; Tag writes and pushes the tag",
    { timeout: 60_000 },
    async () => {
      const page = await open("#/status");
      const sec = page.locator(".stp-a-release");
      await sec.waitFor();
      expect(await sec.locator("h2").innerText()).toBe("Next release");
      expect(await sec.innerText()).toContain(
        "1 issue accepted so far, outside a planned release.",
      );
      expect(await sec.innerText()).toContain("Fix the overtime total on a short week");
      await sec.getByRole("button", { name: "Propose release" }).click();
      await page.locator(".toast", { hasText: "Release 0.0.1 proposed" }).waitFor();
      await sec.locator(".stp-rel", { hasText: "Release 0.0.1 is proposed" }).waitFor();
      expect(await sec.locator(".stp-rel .stp-text").first().innerText()).toBe(
        "Fixed\n- Fix the overtime total on a short week",
      );
      expect(p.git("tag", "--list")).toBe("");
      await sec.getByRole("button", { name: "Tag v0.0.1" }).click();
      await page.locator(".toast", { hasText: "Tagged v0.0.1." }).waitFor();
      await sec.getByText("Nothing accepted since v0.0.1.").waitFor();
      expect(p.git("cat-file", "-t", "v0.0.1")).toBe("tag");
      // The tag and the main the remote refused before are both pushed now.
      expect(p.remoteGit("cat-file", "-t", "v0.0.1")).toBe("tag");
      expect(p.remoteGit("rev-parse", "main")).toBe(p.git("rev-parse", "main"));
      expect(await sec.locator(".stp-push-fail").count()).toBe(0);
      await page.context().close();
    },
  );

  it(
    "PM-N11-1..3: after a sprint completes, Status holds Seshat's draft; its issue is filed by a press; a person posts it",
    { timeout: 60_000 },
    async () => {
      const created = await send("POST", "/api/cycles", {
        name: "Sprint 1",
        startsOn: "2026-09-21",
        endsOn: "2026-10-02",
        projectId: p.project,
      });
      const sprint = (created.data.cycle as { id: string }).id;
      await p.review("c2", "Flag hours past 40 as overtime");
      await p.store.createCard({
        id: "c3",
        tier: "story",
        title: "Export the week to payroll",
        status: "ready",
        projectId: p.project,
      });
      for (const id of ["c2", "c3"]) await send("PATCH", `/api/cards/${id}`, { cycleId: sprint });
      expect((await send("POST", `/api/cycles/${sprint}/start`, {})).status).toBe(200);
      await p.accept("c2");
      await send("POST", "/api/cards/c3/park", { reason: "Waiting for payroll's file format" });
      expect(
        (await send("POST", `/api/cycles/${sprint}/complete`, { carryTo: "backlog" })).status,
      ).toBe(200);

      const page = await open("#/status");
      const sec = page.locator(".stp-a-retro");
      await sec.locator(".stp-retro-draft").waitFor();
      const text = await sec.innerText();
      expect(text).toContain(
        "Seshat drafted the retrospective for Sprint 1 from the Activity log. Nothing changes until someone applies an action.",
      );
      expect(text).toContain("What went well");
      expect(text).toContain("1 issue accepted: Flag hours past 40 as overtime.");
      expect(text).toContain("What slowed the team");
      expect(text).toMatch(/Based on: Activity log #\d+–#\d+ · 1 issue accepted\./);

      // PM-N11-2: the proposed issue is filed only by a person's press.
      const before = (await p.store.listCards()).length;
      await sec.getByRole("button", { name: "File it in Triage" }).click();
      await page.locator(".toast", { hasText: "Filed in Triage." }).waitFor();
      const cards = await p.store.listCards();
      expect(cards.length).toBe(before + 1);
      expect(
        cards.some((c) => c.title === "Remove the blocker on “Export the week to payroll”"),
      ).toBe(true);

      // PM-N11-3: edited and posted by a person, then listed.
      await sec.getByRole("button", { name: "Edit and post" }).click();
      const area = page.locator("#stp-retro");
      await area.waitFor();
      expect((await area.inputValue()).split("\n")[0]).toBe("Retrospective: Sprint 1");
      await area.fill(`${await area.inputValue()}\n\nWe agreed: pair on the payroll export.`);
      await page.getByRole("button", { name: "Post retrospective" }).click();
      await page.locator(".toast", { hasText: "Retrospective posted." }).waitFor();
      const posted = sec.locator("details.stp-retro").first();
      await posted.waitFor();
      expect(await posted.locator("summary").innerText()).toMatch(
        /^Retrospective: Sprint 1\s+Posted by you · [A-Z][a-z]{2} \d{1,2}$/,
      );
      expect(await posted.locator(".stp-text").innerText()).toContain(
        "We agreed: pair on the payroll export.",
      );
      expect(await sec.locator(".stp-retro-draft").count()).toBe(0);
      const [ev] = await p.log.getEventsByTypes(["retrospective/posted"]);
      expect(ev?.payload).toMatchObject({ project: p.project, sprint });
      await page.context().close();
    },
  );

  it("fits Status's Next release and Retrospective at 400 px", { timeout: 60_000 }, async () => {
    const page = await open("#/status", 400);
    await page.locator(".stp-a-release").waitFor();
    await page.locator(".stp-a-retro details.stp-retro").waitFor();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    for (const s of [".stp-a-release", ".stp-a-retro"]) {
      const box = await page.locator(s).boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(400);
    }
    await page.context().close();
  });
});
