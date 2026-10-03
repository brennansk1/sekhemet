import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// A workspace of many projects on one Team server (DEC-57), in a real
// Chromium against the real server over real SQLite (DoD §2A):
// - dashboard DB-N26-2: My issues, the Inbox and the palette's Issues list
//   every project the person can see, name each row's project, offer a
//   project filter, and opening a row of another project makes it current —
//   at 1440 and 400 px;
// - teams TEAM-58: once a per-project override takes a project away (*No
//   access*), it is left out of the person's switcher list, Projects, My
//   issues, Inbox and search, and their requests on it are refused.
// No model is loaded.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

describe("the views across a workspace's projects (DB-N26-2, TEAM-58)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let ada: Person;
  let mo: Person;
  let lee: Person;
  let alpha = "";
  let beta = "";
  let a1 = "";
  let b1 = "";

  const call = (method: string, path: string, who: Person, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async <T>(path: string, who: Person): Promise<T> =>
    (await (await call("GET", path, who)).json()) as T;
  async function signedIn(res: Response): Promise<Person> {
    const body = (await res.json()) as { principal: string; csrf: string; error?: string };
    expect(res.status, body.error).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
  }
  async function join_(level: string, name: string, email: string) {
    const res = await call("POST", "/api/invites", ada, { level, email });
    const id = ((await res.json()) as { id: string }).id;
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-xp-ui-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(dir, "cfg", "config.toml"));
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db, { setup: "team" });
    store = new CardStore(db, log);
    writeFileSync(join(dir, "list.txt"), "passwordpassword1\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
      identity: {
        dir: join(dir, "identity"),
        passwordList: join(dir, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    vi.mocked(console.log).mockRestore();
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
    // Two projects of one workspace, each in its own folder (kernel rule 38a).
    for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
    [alpha, beta] = await EventLog.actingFor(ada.principal, async () => [
      (await store.ensureProject({ rootPath: join(dir, "alpha"), name: "Alpha" })).id,
      (await store.ensureProject({ rootPath: join(dir, "beta"), name: "Beta" })).id,
    ]);
    mo = await join_("member", "Mo Member", "mo@northwind.test");
    lee = await join_("member", "Lee Lead", "lee@northwind.test");
    const made = (title: string, projectId: string) =>
      EventLog.actingFor(ada.principal, () =>
        store.createCard(
          { tier: "task", title, status: "ready", projectId, owner: mo.principal },
          "human",
        ),
      );
    a1 = (await made("Export loans as CSV", alpha)).id;
    b1 = (await made("Round invoice totals per line", beta)).id;
    // Lee mentions Mo on both: an Inbox item in each project.
    for (const [id, text] of [
      [a1, "@MoMember the export includes returned items. Keep it?"],
      [b1, "@MoMember the totals round per invoice today."],
    ] as const) {
      expect((await call("POST", `/api/cards/${id}/comments`, lee, { text })).status).toBe(200);
    }
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function as(email: string, width: number): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/#/signin`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("[data-account]").waitFor({ state: "attached" });
    await page.waitForFunction(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the app exposes its view for tests
      Boolean((window as any).sekhemetView?.()),
    );
    return page;
  }
  const current = (page: Page) =>
    page.evaluate(() => localStorage.getItem("sekhemet-project") ?? "");
  const noSideScroll = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );

  it("search spans every project the person can see, each issue with its project", async () => {
    const hits = await read<{ issues: { id: string; project?: { name: string } }[] }>(
      "/api/issues/search?q=",
      mo,
    );
    expect(hits.issues.map((h) => [h.id, h.project?.name]).sort()).toEqual(
      [
        [a1, "Alpha"],
        [b1, "Beta"],
      ].sort(),
    );
    const one = await read<{ issues: { id: string }[] }>("/api/issues/search?q=invoice", mo);
    expect(one.issues.map((h) => h.id)).toEqual([b1]);
  });

  for (const width of [1440, 400]) {
    it(`My issues and the Inbox at ${width} px: each row's project, a project filter, and opening another project's issue makes it current`, async () => {
      const page = await as("mo@northwind.test", width);
      // My issues: both projects, the filter with counts.
      await page.goto(`${base}/#/my-issues`);
      const filter = page.locator(".mi [data-project-filter]");
      await filter.waitFor();
      expect(await filter.locator("option").allInnerTexts()).toEqual([
        "All projects (2)",
        "Alpha (1)",
        "Beta (1)",
      ]);
      expect(await page.locator(".mi .ib-group h2").allInnerTexts()).toEqual(
        expect.arrayContaining([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]),
      );
      await filter.selectOption(beta);
      await expect.poll(() => page.locator(".mi tbody tr").count()).toBe(1);
      expect(await page.locator(".mi tbody").innerText()).toContain("Round invoice totals");
      expect(await noSideScroll(page)).toBe(true);
      await filter.selectOption("");
      await expect.poll(() => page.locator(".mi tbody tr").count()).toBe(2);
      // The browser's project was Alpha: opening Beta's issue makes Beta current.
      await page.evaluate((id) => localStorage.setItem("sekhemet-project", id), alpha);
      await page.locator(`.mi a[data-project="${beta}"]`).click();
      await expect.poll(() => current(page)).toBe(beta);
      await expect.poll(() => new URL(page.url()).hash).toContain(`#/card/${b1}`);

      // The Inbox: the filter narrows the list to one project's items.
      await page.goto(`${base}/#/inbox`);
      const inboxFilter = page.locator(".ib-list [data-project-filter]");
      await inboxFilter.waitFor();
      expect(await inboxFilter.locator("option").allInnerTexts()).toEqual([
        "All projects (2)",
        "Alpha (1)",
        "Beta (1)",
      ]);
      await inboxFilter.selectOption(alpha);
      await expect.poll(() => page.locator(".ib-list .ib-row").count()).toBe(1);
      expect(await page.locator(".ib-list .ib-row .ib-proj").innerText()).toBe("Alpha");
      expect(await noSideScroll(page)).toBe(true);
      await page.context().close();
    });
  }

  it("the palette's Issues finds another project's issue, named with its project, and opens it there", async () => {
    const page = await as("mo@northwind.test", 1440);
    await page.evaluate((id) => localStorage.setItem("sekhemet-project", id), alpha);
    await page.goto(`${base}/#/board`);
    await page.reload();
    await page.locator("#side").waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.locator(".palette input");
    await input.waitFor();
    await input.fill("#invoice");
    const option = page.getByRole("option", { name: /Round invoice totals per line/ });
    await expect.poll(() => option.count()).toBe(1);
    expect(await option.innerText()).toContain("Beta");
    await option.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/card/${b1}`);
    await expect.poll(() => current(page)).toBe(beta);
    await page.context().close();
  });

  it("TEAM-58: No access on a project leaves it out of everything the person sees, and refuses their requests on it", async () => {
    expect(
      (
        await call("POST", `/api/members/${mo.principal}/level`, ada, {
          level: "none",
          project: beta,
        })
      ).status,
    ).toBe(200);
    // A fresh sign-in of Mo's (the browser tests signed Mo in elsewhere).
    mo = await signedIn(
      await call("POST", "/api/session", nobody, {
        email: "mo@northwind.test",
        password: PASSWORD,
      }),
    );
    const overview = await read<{ overview: { projects: { id: string }[] } }>(
      "/api/projects/overview",
      mo,
    );
    expect(overview.overview.projects.map((p) => p.id)).toEqual([alpha]);
    const mine = await read<{ issues: { id: string }[] }>("/api/my-issues", mo);
    expect(mine.issues.map((i) => i.id)).toEqual([a1]);
    const inbox = await read<{ items: { cardId?: string }[] }>("/api/inbox", mo);
    expect(inbox.items.map((i) => i.cardId)).toEqual([a1]);
    const search = await read<{ issues: { id: string }[] }>("/api/issues/search?q=", mo);
    expect(search.issues.map((i) => i.id)).toEqual([a1]);
    const edit = await call("PATCH", `/api/cards/${b1}`, mo, { title: "Renamed" });
    expect([403, 404]).toContain(edit.status);
    expect((await store.getCard(b1))?.title).toBe("Round invoice totals per line");
    // The Admin still sees both.
    const all = await read<{ issues: { id: string }[] }>("/api/issues/search?q=", ada);
    expect(all.issues.map((i) => i.id).sort()).toEqual([a1, b1].sort());
  });
});
