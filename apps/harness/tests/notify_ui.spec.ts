import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { shortId } from "@sekhemet/ui";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// NEW-dashboard-22 in a real Chromium against a real Solo server (DB-N22-1
// to -4; DEC-53 c4; FINDINGS PRC-11). The page's Notification is replaced
// by a recorder before load, so the test sees every permission request and
// every notification the page raises, and decides whether the tab is in
// front; the server, its ledger and its live stream are real. At 1440 and
// 400 px. No model is loaded.

type Server = { port: number; close: () => Promise<void> };

const RECORDER = (permission: string) => {
  const w = window as unknown as Record<string, unknown>;
  w.__requests = 0;
  w.__shown = [];
  w.__front = true;
  class FakeNotification {
    static permission = permission;
    static requestPermission() {
      (w.__requests as number)++;
      if (FakeNotification.permission === "default") FakeNotification.permission = "granted";
      return Promise.resolve(FakeNotification.permission);
    }
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options: Record<string, unknown> = {},
    ) {
      (w.__shown as unknown[]).push(this);
    }
    close() {}
  }
  w.Notification = FakeNotification;
  Object.defineProperty(document, "hasFocus", { value: () => w.__front === true });
};

describe("a browser notification when work waits (NEW-dashboard-22)", () => {
  let repo: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-notify-ui-"));
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    await store.createCard({ id: "card_waiting1", tier: "story", title: "Export a week as CSV" });
    await store.updateCardStatus("card_waiting1", "review", "verified", "harness", {
      override: true,
    });
    for (const [id, title] of [
      ["card_arrive01", "Implement canonical JSON"],
      ["card_arrive02", "Hash the chain"],
      ["card_arrive03", "Verify the chain"],
    ]) {
      await store.createCard({ id, tier: "story", title, status: "ready" });
      await store.updateCardStatus(id, "in_progress", "started", "harness", { override: true });
    }
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 200,
    });
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  async function context(permission: string, width = 1440) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(RECORDER, permission);
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sekhemet-role", "code");
      } catch {}
    });
    return ctx;
  }

  async function open(ctx: Awaited<ReturnType<typeof context>>, hash: string): Promise<Page> {
    const page = await ctx.newPage();
    await page.goto(`${base}/${hash}`);
    await page.locator("#view .view-host").first().waitFor();
    await page.waitForTimeout(500);
    return page;
  }

  const requests = (page: Page) =>
    page.evaluate(() => (window as never as { __requests: number }).__requests);
  const shown = (page: Page) =>
    page.evaluate(() =>
      (window as never as { __shown: { title: string; options: { tag?: string } }[] }).__shown.map(
        (n) => ({ title: n.title, tag: n.options?.tag }),
      ),
    );

  it(
    "DB-N22-1: no permission is asked on load; the offer shows once above the queue, and Not now is remembered",
    { timeout: 60_000 },
    async () => {
      const ctx = await context("default");
      const page = await open(ctx, "#/review");
      expect(await requests(page)).toBe(0);
      const offer = page.locator(".notify-offer");
      await offer.waitFor();
      expect(await offer.innerText()).toContain(
        "Get a browser notification when work waits for you.",
      );
      // It sits above the queue, not inside the listbox.
      expect(await page.locator(".queue .notify-offer").count()).toBe(0);
      await offer.locator("[data-notify-not-now]").click();
      await expect.poll(() => offer.count()).toBe(0);
      await page.reload();
      await page.locator("#view .view-host").first().waitFor();
      await page.waitForTimeout(500);
      expect(await page.locator(".notify-offer").count()).toBe(0);
      expect(await requests(page)).toBe(0);
      await ctx.close();
    },
  );

  it(
    "DB-N22-2, -3: Turn on asks once; an issue entering In review while the tab is not in front raises one notification, and more count in it",
    { timeout: 60_000 },
    async () => {
      const ctx = await context("default");
      const page = await open(ctx, "#/review");
      await page.locator(".notify-offer [data-notify-on]").click();
      await expect.poll(() => requests(page)).toBe(1);
      await expect.poll(() => page.locator(".notify-offer").count()).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem("sekhemet-notify"))).toBe("on");

      // In front: nothing is raised.
      await store.updateCardStatus("card_arrive01", "review", "verified", "harness", {
        override: true,
      });
      await page.locator("#q-card_arrive01").waitFor({ timeout: 10_000 });
      expect(await shown(page)).toEqual([]);

      // Not in front: one notification naming the issue, then the count.
      await page.evaluate(() => {
        (window as never as { __front: boolean }).__front = false;
      });
      await store.updateCardStatus("card_arrive02", "review", "verified", "harness", {
        override: true,
      });
      await expect
        .poll(() => shown(page), { timeout: 10_000 })
        .toEqual([
          {
            title: `${shortId("card_arrive02")} Hash the chain · waiting in In review`,
            tag: "sekhemet-waiting",
          },
        ]);
      await store.updateCardStatus("card_arrive03", "review", "verified", "harness", {
        override: true,
      });
      await expect.poll(async () => (await shown(page)).length, { timeout: 10_000 }).toBe(2);
      const all = await shown(page);
      // The same tag: the second replaces the first on screen, counting both.
      expect(all[1]).toEqual({ title: "2 issues wait in In review", tag: "sekhemet-waiting" });
      for (const n of all) expect(n.title).not.toMatch(/diff|```|\+\+\+/);
      expect(await requests(page)).toBe(1);

      // Clicking the first opens the issue in Review.
      await page.evaluate(() => {
        location.hash = "#/board";
        (window as never as { __shown: { onclick: () => void }[] }).__shown[0]?.onclick();
      });
      await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/review/card_arrive02");
      await ctx.close();
    },
  );

  it(
    "DB-N22-4: when the browser blocks notifications, Preferences says so and how to allow them, and none is offered",
    { timeout: 60_000 },
    async () => {
      const ctx = await context("denied");
      const review = await open(ctx, "#/review");
      expect(await review.locator(".notify-offer").count()).toBe(0);
      const page = await open(ctx, "#/configuration/preferences");
      const state = page.locator("[data-notify-state]");
      await state.waitFor();
      expect(await state.getAttribute("data-notify-state")).toBe("blocked");
      expect(await state.innerText()).toMatch(/blocks notifications/);
      expect(await state.innerText()).toMatch(/site settings/);
      expect(await page.locator("[data-notify-prefs] [data-notify-on]").count()).toBe(0);
      expect(await requests(page)).toBe(0);
      await ctx.close();
    },
  );

  it(
    "§2.16.4 at 400 px: Preferences holds the browser setting and, in Solo, this computer's switch, off by default",
    { timeout: 60_000 },
    async () => {
      const ctx = await context("default", 400);
      const page = await open(ctx, "#/configuration/preferences");
      const prefs = page.locator("[data-notify-prefs]");
      await prefs.locator("[data-notify-state]").waitFor();
      const text = await prefs.innerText();
      expect(text).toContain("Notify me in this browser when work waits for me");
      expect(text).toContain("Also notify me on this computer when no dashboard tab is open");
      // The test configuration has no user file: the switch starts off.
      expect(await prefs.locator("[data-notify-desktop]").isChecked()).toBe(false);
      expect(await requests(page)).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await ctx.close();
    },
  );
});

describe("in the Team setup, work reaching the person's Inbox (DB-N22-2)", () => {
  const PASSWORD = "correct horse battery staple";
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let browser: Browser;
  let base: string;
  let project = "";
  type Person = { principal: string; headers: Record<string, string> };
  const nobody: Person = { principal: "", headers: {} };
  let ada: Person = nobody;
  const call = (method: string, path: string, who: Person, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function signedIn(res: Response): Promise<Person> {
    const body = (await res.json()) as { principal: string; csrf: string; error?: string };
    expect(res.status, body.error).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-notify-team-ui-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(dir, "cfg", "config.toml"));
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db, { setup: "team" });
    store = new CardStore(db, log);
    writeFileSync(join(dir, "list.txt"), "passwordpassword1\n");
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 200,
      pressureLevel: () => 1,
      identity: {
        dir: join(dir, "identity"),
        passwordList: join(dir, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    const token = readFileSync(join(dir, "identity", "setup-token"), "utf8").trim();
    ada = await signedIn(
      await call("POST", "/api/setup", nobody, {
        token,
        name: "Ada Admin",
        email: "ada@northwind.test",
        password: PASSWORD,
      }),
    );
    project = (
      await EventLog.actingFor(ada.principal, () =>
        store.ensureProject({ rootPath: join(dir, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    await store.createCard({
      id: "card_team01",
      tier: "story",
      title: "Hash the chain",
      projectId: project,
      status: "ready",
    });
    await store.updateCardStatus("card_team01", "in_progress", "started", "harness", {
      override: true,
    });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "raises one notification when an issue reaches Review requested in the person's Inbox, not before",
    { timeout: 60_000 },
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript(RECORDER, "granted");
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("sekhemet-notify", "on");
        } catch {}
      });
      const page = await ctx.newPage();
      await page.goto(`${base}/#/signin`);
      await page.getByLabel("Email").fill("ada@northwind.test");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.locator("[data-account]").waitFor({ state: "attached" });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        (window as never as { __front: boolean }).__front = false;
      });
      const shownTitles = () =>
        page.evaluate(() =>
          (window as never as { __shown: { title: string }[] }).__shown.map((n) => n.title),
        );
      expect(await shownTitles()).toEqual([]);
      // Ada is the workspace's default accepter: the issue in review asks her to review it.
      await store.updateCardStatus("card_team01", "review", "verified", "harness", {
        override: true,
      });
      await expect
        .poll(shownTitles, { timeout: 10_000 })
        .toEqual([`${shortId("card_team01")} Hash the chain · waiting in In review`]);
      await ctx.close();
    },
  );

  it(
    "raises none for an Inbox item that is not an issue — a Triage count names no id and no column (DB-N22-2)",
    { timeout: 60_000 },
    async () => {
      // Ada leads the project, so issues filed for triage are counted in her Inbox.
      expect(
        (await call("PATCH", `/api/projects/${project}/settings`, ada, { lead: ada.principal }))
          .status,
      ).toBe(200);
      const invite = await call("POST", "/api/invites", ada, {
        level: "stakeholder",
        email: "sam@northwind.test",
      });
      const id = ((await invite.json()) as { id: string }).id;
      const sam = await signedIn(
        await call("POST", `/api/invites/${id}/accept`, nobody, {
          name: "Sam Stakeholder",
          email: "sam@northwind.test",
          password: PASSWORD,
        }),
      );
      await store.createCard({
        id: "card_team02",
        tier: "story",
        title: "Seal the log",
        projectId: project,
        status: "ready",
      });
      await store.updateCardStatus("card_team02", "in_progress", "started", "harness", {
        override: true,
      });
      for (const width of [1440, 400]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        await ctx.addInitScript(RECORDER, "granted");
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem("sekhemet-notify", "on");
          } catch {}
        });
        const page = await ctx.newPage();
        await page.goto(`${base}/#/signin`);
        await page.getByLabel("Email").fill("ada@northwind.test");
        await page.getByLabel("Password").fill(PASSWORD);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.locator("[data-account]").waitFor({ state: "attached" });
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
          (window as never as { __front: boolean }).__front = false;
        });
        const shownTitles = () =>
          page.evaluate(() =>
            (window as never as { __shown: { title: string }[] }).__shown.map((n) => n.title),
          );
        // Sam files an issue for triage: Ada's Inbox gains the Triage count.
        const filed = await call("POST", `/api/projects/${project}/cards`, sam, {
          title: `Overdue entries have no flag (${width})`,
        });
        expect(filed.status).toBe(201);
        const inbox = async () =>
          (
            (await (await call("GET", "/api/inbox?filter=inbox", ada)).json()) as {
              items: { id: string }[];
            }
          ).items.map((i) => i.id);
        await expect.poll(inbox, { timeout: 10_000 }).toContain(`triage:${project}`);
        await page.waitForTimeout(2500);
        expect(await shownTitles()).toEqual([]);
        if (width === 1440) {
          // An issue still raises its notification, and only it.
          await store.updateCardStatus("card_team02", "review", "verified", "harness", {
            override: true,
          });
          await expect
            .poll(shownTitles, { timeout: 10_000 })
            .toEqual([`${shortId("card_team02")} Seal the log · waiting in In review`]);
        }
        await ctx.close();
      }
    },
  );
});
