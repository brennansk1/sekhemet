import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// The shell, Status and the states in a real Chromium against real servers
// over real SQLite (C2a, the status-shell builder; DEFINITION_OF_DONE §2A):
// - SHL-01, DB-N25-1..4 (DEC-57): the project switcher in the sidebar, never
//   the repository's path; a choice kept in this browser and followed by every
//   project page; Switch workspace in the account menu, in Solo too;
// - SHL-02: the person's name, never a principal; SHL-03, SHL-04: the first
//   run's welcome with *I'll just talk to Seshat*, and one model status;
// - STA-02, STA-03, NEW-dashboard-18: Status about the chosen project, the
//   mockup's grid at 1440 px and one column at 400 px, key numbers as values;
// - ERR-01, ERR-03, ERR-04: a failed or unreachable read says so with Try
//   again, never "No issues yet" or "Failed to fetch";
// - NEW-dashboard-14: the Definition of done in Configuration › Project and
//   Ready to start on an issue not yet started;
// - SEC-01: a Viewer's page sends no write it may not make, so no toast blames
//   them. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

describe("the shell, Status and the states in a browser (C2a status-shell)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let chronicle: string;
  let storefront: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-shell-c2a-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir });
    mkdirSync(join(dir, "shop"), { recursive: true });
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    chronicle = (await store.ensureProject({ name: "Chronicle", rootPath: dir })).id;
    storefront = (await store.ensureProject({ name: "Storefront", rootPath: join(dir, "shop") }))
      .id;
    const card = async (
      id: string,
      title: string,
      status: string,
      projectId: string,
      extra = {},
    ) => {
      const start = status === "backlog" || status === "ready" ? status : "ready";
      await store.createCard({ id, tier: "task", title, status: start, projectId, ...extra });
      if (status !== start)
        await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
    };
    await card("card_c1", "Record every change", "done", chronicle, { scopeFiles: ["a.ts"] });
    await card("card_c2", "Verify the chain", "review", chronicle, { scopeFiles: ["b.ts"] });
    await card("card_c3", "Search history", "in_progress", chronicle, { scopeFiles: ["c.ts"] });
    await card("card_c4", "Export to CSV", "backlog", chronicle, {
      acceptanceCriteria: ["Each entry is one line."],
    });
    await card("card_s1", "Checkout", "ready", storefront, { scopeFiles: ["s.ts"] });
    // Two models' tokens this period, for Insights › Model use (STA-05).
    for (const [role, purpose] of [
      ["worker", "card_step"],
      ["seshat", "chat"],
    ] as const) {
      await log.append({
        actor: "harness",
        type: "model/usage",
        payload: {
          role,
          purpose,
          model: role === "worker" ? "cyber-tiel" : "dirk-27b",
          promptTokens: 120_000,
          cachedPromptTokens: 80_000,
          completionTokens: 9_000,
          thinkingTokens: 2_000,
          answerTokens: 7_000,
          durationMs: 1000,
        },
      });
    }
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(
    hash: string,
    width = 1440,
    opts: { role?: string | null; project?: string } = {},
  ): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const role = opts.role === undefined ? "code" : opts.role;
    await ctx.addInitScript(
      ([r, p]) => {
        try {
          if (r && !sessionStorage.getItem("seeded")) localStorage.setItem("sekhemet-role", r);
          if (p && !sessionStorage.getItem("seeded")) localStorage.setItem("sekhemet-project", p);
          sessionStorage.setItem("seeded", "1");
        } catch {}
      },
      [role, opts.project ?? null] as const,
    );
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    return { ctx, page };
  }

  it(
    "SHL-01, SHL-02, STA-02: the switcher, never the path; the choice is kept and followed",
    { timeout: 60_000 },
    async () => {
      const { ctx, page } = await open("#/status");
      const sw = page.locator("#side [data-project-switch]");
      await sw.waitFor();
      expect((await sw.innerText()).trim()).toContain("Chronicle");
      // DB-N25-1: no repository path in the sidebar; it is in the switcher's tooltip.
      expect(await page.locator("#side").innerText()).not.toContain(dir);
      expect(await sw.getAttribute("title")).toContain(dir);
      // SHL-02: the person by name.
      expect((await page.locator("#side [data-account]").innerText()).trim()).toContain(
        "Ada Lovelace",
      );
      expect(await page.locator("#side").innerText()).not.toMatch(/p_[0-9a-f]{6,}/);
      // STA-02: Status is about the current project.
      await expect.poll(() => page.locator("#top .crumb").innerText()).toBe("Chronicle");
      // DB-N25-2: the list, filtered as the person types; choosing one keeps the page kind.
      await sw.click();
      const options = page.locator("#proj-list [role=option]");
      await expect.poll(() => options.count()).toBe(2);
      await page.locator("#proj-filter").fill("store");
      await expect.poll(() => options.count()).toBe(1);
      await options.first().click();
      await expect.poll(() => sw.innerText()).toContain("Storefront");
      expect(page.url()).toMatch(/#\/status$/);
      await expect.poll(() => page.locator("#top .crumb").innerText()).toBe("Storefront");
      expect(await page.evaluate(() => localStorage.getItem("sekhemet-project"))).toBe(storefront);
      // Kept in this browser: a reload opens on it, and the board shows its issues.
      await page.goto(`${base}/#/board`);
      await page.locator(".tile").first().waitFor({ state: "attached" });
      expect(await page.locator(".tile").allInnerTexts()).toEqual([
        expect.stringContaining("Checkout"),
      ]);
      // DB-N25-2: a link to an issue of another project makes that project current.
      await page.goto(`${base}/#/card/card_c2`);
      await expect.poll(() => sw.innerText()).toContain("Chronicle");
      await ctx.close();
    },
  );

  it("STA-05: Model use's headers sit over their values; the sentence wraps; the scroller is reachable", async () => {
    for (const width of [1440, 400]) {
      const { ctx, page } = await open("#/insights", width, { project: chronicle });
      const sec = page.locator(".model-use");
      await sec.locator("tbody tr").first().waitFor();
      const v = await sec.evaluate((s) => {
        const heads = [...s.querySelectorAll("thead th")].slice(1);
        const cells = [...s.querySelectorAll("tbody tr:first-child td")];
        const wrap = s.querySelector(".tbl-wrap") as HTMLElement;
        const cap = s.querySelector(".mu-caption") as HTMLElement;
        return {
          heads: heads.map((h) => getComputedStyle(h).textAlign),
          cells: cells.map((c) => getComputedStyle(c).textAlign),
          caption: s.querySelector("caption") === null,
          wraps: cap.scrollWidth <= cap.clientWidth + 1,
          focusable: wrap.tabIndex === 0 && wrap.getAttribute("role") === "region",
          pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      expect(v.heads).toEqual(v.cells);
      expect(new Set(v.cells)).toEqual(new Set(["right"]));
      expect(v.caption).toBe(true);
      expect(v.wraps).toBe(true);
      expect(v.focusable).toBe(true);
      expect(v.pageScroll).toBe(false);
      await ctx.close();
    }
  });

  it(
    "DB-N17-1: Projects' Waiting on you and the Inbox open the criteria view for a person who manages the work",
    { timeout: 60_000 },
    async () => {
      for (const [role, href] of [
        ["manage", "#/card/card_c2/criteria"],
        ["code", "#/review/card_c2"],
      ] as const) {
        const { ctx, page } = await open("#/projects", 1440, { role });
        const waiting = page.locator('.view-host a:has-text("Review it")').first();
        await waiting.waitFor();
        expect(await waiting.getAttribute("href"), `${role} Projects`).toBe(href);
        await page.goto(`${base}/#/inbox`);
        const row = page.locator(".ib-list .ib-row", { hasText: "Verify the chain" }).first();
        await row.waitFor();
        expect(await row.locator(".ib-main").getAttribute("href"), `${role} Inbox row`).toBe(href);
        await row.locator(".ib-main").click();
        const review = page.locator(".ib-pane a", { hasText: "Review it" });
        await review.waitFor();
        expect(await review.getAttribute("href"), `${role} Inbox pane`).toBe(href);
        await ctx.close();
      }
    },
  );

  it(
    "STA-10, ERR-05, ERR-06: an empty Ask is refused beside the box; Runs' empty state points to the Board; the Activity log names a project and links only an issue",
    { timeout: 60_000 },
    async () => {
      const { ctx, page } = await open("#/status", 1440, { project: chronicle });
      // STA-10: Ask with nothing typed says so beside the box and sends nothing.
      let asked = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/pm/messages")) asked += 1;
      });
      const form = page.locator("form[data-ask]");
      await form.waitFor();
      await form.getByRole("button", { name: "Ask" }).click();
      await expect
        .poll(() => page.locator("[data-ask-note]").textContent())
        .toBe("Type a question for Seshat first.");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("stp-ask-q");
      expect(asked).toBe(0);
      // ERR-05: with no runs, the next step is the Board, never a CLI command.
      await page.goto(`${base}/#/runs`);
      const empty = page.locator(".ev-empty", { hasText: "No runs yet." });
      await empty.waitFor();
      expect(await empty.getByRole("link", { name: "Open the Board" }).getAttribute("href")).toBe(
        "#/board",
      );
      expect(await empty.innerText()).not.toMatch(/sekhemet|--auto-accept/);
      // ERR-06: a project's entry names the project and links nowhere; an issue's links to it.
      await page.goto(`${base}/#/ledger`);
      const created = page.locator("tr", {
        has: page.locator("td.mono", { hasText: /^project\/created$/ }),
      });
      await created.first().waitFor();
      const sentences = await created.locator("td.sentence").allInnerTexts();
      expect(sentences.join(" ")).toMatch(/Chronicle/);
      expect(sentences.join(" ")).not.toMatch(/proj_/);
      expect(await created.locator("td.sentence a").count()).toBe(0);
      const issueLinks = await page
        .locator("td.sentence a")
        .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      expect(issueLinks.length).toBeGreaterThan(0);
      for (const h of issueLinks) expect(h).toMatch(/^#\/card\/card_[a-z0-9]+\/thread$/);
      await ctx.close();
    },
  );

  it("DB-N25-3: Switch workspace lists this machine's workspaces, in Solo too", async () => {
    const { ctx, page } = await open("#/board");
    await page.locator("#side [data-account]").click();
    await page.getByRole("menuitem", { name: "Switch workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Switch workspace" });
    await dialog.locator(".ws-list li").first().waitFor();
    const here = dialog.locator('.ws-list li[aria-current="true"]');
    expect(await here.innerText()).toContain(`${base} · Solo`);
    expect(await here.innerText()).toContain("This workspace");
    expect(await dialog.innerText()).toContain("Add a workspace…");
    await ctx.close();
  });

  it(
    "NEW-dashboard-18, STA-03: the mockup's grid at 1440 px, one column at 400 px",
    { timeout: 60_000 },
    async () => {
      const { ctx, page } = await open("#/status", 1440, { project: chronicle });
      await page.locator(".stp-a-working").waitFor();
      const box = async (sel: string) => {
        const b = await page.locator(sel).boundingBox();
        if (!b) throw new Error(`${sel} has no box`);
        return b;
      };
      const burn = await box(".stp-a-burnup");
      const needs = await box(".stp-a-needs");
      // The burn-up (two thirds) beside Needs you (one third), on one row.
      expect(needs.x).toBeGreaterThanOrEqual(burn.x + burn.width - 1);
      expect(Math.abs(needs.y - burn.y)).toBeLessThan(4);
      expect(burn.width).toBeGreaterThan(needs.width * 1.6);
      const req = await box(".stp-a-requirements");
      const risks = await box(".stp-a-risks");
      const working = await box(".stp-a-working");
      expect([risks.y, working.y].map((y) => Math.round(y))).toEqual([
        Math.round(req.y),
        Math.round(req.y),
      ]);
      expect(req.x < risks.x && risks.x < working.x).toBe(true);
      // The reading order stays §2.8's: the DOM's.
      expect(
        await page.$$eval(".stp > section", (s) =>
          s.map((x) => (x.className.match(/stp-a-(\w+)/) ?? [])[1]),
        ),
      ).toEqual([
        "numbers",
        "burnup",
        "needs",
        "requirements",
        "risks",
        "done",
        "today",
        "working",
        "models",
        "flow",
        "ask",
      ]);
      // STA-03: no browser indent on the strip; the values at --text-xl, 600.
      const num = await page.$eval(".stp-num dd", (d) => {
        const v = d.querySelector(".stp-v") as HTMLElement;
        const cs = getComputedStyle(v);
        return {
          dd: getComputedStyle(d).marginLeft,
          weight: cs.fontWeight,
          size: Number.parseFloat(cs.fontSize),
          xl: Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--text-xl"),
          ),
        };
      });
      expect(num.dd).toBe("0px");
      expect(num.weight).toBe("600");
      expect(num.size).toBe(num.xl);
      // Needs attention reads as a value, never as a field.
      expect(
        await page.$eval('.stp-num [data-jump="needs"]', (b) => getComputedStyle(b).borderTopWidth),
      ).toBe("0px");
      await ctx.close();

      const phone = await open("#/status", 400, { project: chronicle });
      await phone.page.locator(".stp-a-working").waitFor();
      const lefts = await phone.page.$$eval(".stp > section", (s) =>
        s.map((x) => Math.round(x.getBoundingClientRect().left)),
      );
      expect(new Set(lefts).size).toBe(1);
      expect(
        await phone.page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await phone.ctx.close();
    },
  );

  it(
    "ERR-03, ERR-01, ERR-04: a failed or unreachable read says so with Try again",
    { timeout: 60_000 },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(() => localStorage.setItem("sekhemet-role", "code"));
      const page = await ctx.newPage();
      let fail = true;
      await page.route("**/api/board**", (route) =>
        fail
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' })
          : route.continue(),
      );
      await page.goto(`${base}/#/board`);
      const empty = page.locator(".board-empty");
      await empty.waitFor();
      expect(await empty.innerText()).toContain("Couldn't load the issues.");
      expect(await empty.innerText()).not.toContain("No issues yet");
      fail = false;
      await empty.getByRole("button", { name: "Try again" }).click();
      await page.locator(".tile").first().waitFor({ state: "attached" });

      await page.route("**/api/projects/overview", (route) => route.abort());
      await page.goto(`${base}/#/projects`);
      const notice = page.locator(".pj .stp-notice");
      await notice.waitFor();
      expect(await notice.innerText()).toContain("Couldn't load the projects.");
      expect(await notice.innerText()).toContain("can't be reached");
      expect(await page.locator("#view").innerText()).not.toMatch(/Failed to fetch|returned/);
      await ctx.close();
    },
  );

  it(
    "SHL-03, SHL-04: the first run welcomes, offers Seshat, and says one thing about models",
    { timeout: 60_000 },
    async () => {
      const { ctx, page } = await open("", 1440, { role: null });
      const bar = page.locator("#sk-firstrun");
      await bar.waitFor();
      const text = await bar.innerText();
      expect(text).toContain("Welcome to Sekhemet.");
      expect(text).toContain("set up a model");
      // No model anywhere: the sidebar and the bar agree.
      await expect.poll(() => page.locator("#sk-noworker").count()).toBe(1);
      expect(await page.locator("#side").innerText()).toContain("No Coding model set up");
      await bar.getByRole("button", { name: /I'll just talk to Seshat/ }).click();
      await expect.poll(() => page.url()).toMatch(/#\/pm$/);
      await ctx.close();
    },
  );

  it(
    "NEW-dashboard-14: the Definition of done in Configuration, Ready to start on the issue",
    { timeout: 60_000 },
    async () => {
      const { ctx, page } = await open("#/configuration/project", 1440, { project: chronicle });
      const dod = page.locator(".cfg-dod");
      await dod.waitFor();
      expect(await dod.innerText()).toContain("An issue is done when its checks pass");
      // DB-N25-1: the repository's path is here, not in the sidebar.
      expect(await page.locator(".cfg-sec").first().innerText()).toContain(dir);
      await page.goto(`${base}/#/card/card_c4`);
      const ready = page.locator(".rd");
      await ready.waitFor();
      const words = await ready.innerText();
      expect(words).toContain("Ready to start");
      expect(words).toContain("The files it may change are declared");
      expect(words).toContain("Not met");
      expect(words).toContain("It declares no files it may change.");
      await ctx.close();
    },
  );
});

describe("SEC-01: a Viewer's page sends no write it may not make", () => {
  let root: string;
  let db: DatabaseSync;
  let server: Server;
  let base: string;
  let browser: Browser;
  const PASSWORD = "correct horse battery staple";

  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function session(res: Response) {
    const body = (await res.json()) as { csrf: string; error?: string };
    expect(res.status, body.error).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { cookie, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sek-shell-c2a-team-"));
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db, { setup: "team" });
    const store = new CardStore(db, log);
    writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: root,
      port: 0,
      streamIntervalMs: 1000,
      identity: {
        dir: join(root, "identity"),
        passwordList: join(root, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "opens Status at 400 px with no focus write, no refusal toast and no refusal in Audit",
    { timeout: 60_000 },
    async () => {
      const token = readFileSync(join(root, "identity", "setup-token"), "utf8").trim();
      const ada = await session(
        await call(
          "POST",
          "/api/setup",
          {},
          {
            token,
            name: "Ada Admin",
            email: "ada@northwind.test",
            password: PASSWORD,
          },
        ),
      );
      const invite = await call("POST", "/api/invites", ada.headers, {
        level: "viewer",
        email: "vi@northwind.test",
      });
      const id = ((await invite.json()) as { id: string }).id;
      const vi_ = await session(
        await call(
          "POST",
          `/api/invites/${id}/accept`,
          {},
          {
            name: "Vi Viewer",
            email: "vi@northwind.test",
            password: PASSWORD,
          },
        ),
      );
      const refusals = () =>
        (
          db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE '%refus%'").get() as {
            n: number;
          }
        ).n;
      const before = refusals();
      const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
      const eq = vi_.cookie.indexOf("=");
      // The session cookie is `__Host-`: secure, path /, on this host (127.0.0.1 is trustworthy).
      await ctx.addCookies([
        {
          name: vi_.cookie.slice(0, eq),
          value: vi_.cookie.slice(eq + 1),
          domain: "127.0.0.1",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await ctx.addInitScript(() => localStorage.setItem("sekhemet-role", "manage"));
      const page = await ctx.newPage();
      const focus: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/pm/focus")) focus.push(r.method());
      });
      await page.goto(`${base}/#/status`);
      await page.locator(".stp").waitFor();
      await page.bringToFront();
      await page.waitForTimeout(2500);
      expect(focus).toEqual([]);
      expect(await page.locator(".toast.fail").count()).toBe(0);
      expect(refusals()).toBe(before);
      // The tab bar stays reachable: nothing covers it.
      const tab = page.locator("#tabbar a").first();
      await tab.click({ timeout: 5000 });
      await ctx.close();
    },
  );
});
