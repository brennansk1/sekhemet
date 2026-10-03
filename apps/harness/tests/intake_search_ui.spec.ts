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

// Intake, triage and full-text search in a real Chromium against a real
// Team server over real SQLite (DoD §2A; dashboard §2.4.19, §2.4.21):
// - DB-N10-1: a Stakeholder's New issue opens the same form and files the
//   issue for triage, with the project lead as its assignee;
// - DB-N10-2, -3: the View menu's Triage lists it with who filed it, and a
//   Member decides with a key or a button — at 1440 and 400 px, no sideways
//   scroll; below Member the decisions are disabled with the level's note;
// - DB-N10-4: the lead's Inbox shows the count, and opens Triage;
// - DB-N12-1: the palette lists issues whose description or comments hold
//   the words, with the project, the column and the words in context, and
//   the query box finds them on the board.
// No model is loaded.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

describe("intake, triage and search in the browser (NEW-dashboard-10, -12)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let ada: Person;
  let lee: Person;
  let sam: Person;
  let project = "";
  let described = "";

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
  async function join_(level: string, name: string, email: string) {
    const res = await call("POST", "/api/invites", ada, { level, email });
    const id = ((await res.json()) as { id: string }).id;
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  }
  const file = async (title: string) => {
    const res = await call("POST", `/api/projects/${project}/cards`, sam, { title });
    expect(res.status).toBe(201);
    return ((await res.json()) as { card: { id: string } }).card.id;
  };
  const triaged = (cardId: string) =>
    (
      db
        .prepare("SELECT payload FROM events WHERE type = 'issue/triaged' AND card_id = ?")
        .all(cardId) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload).decision as string);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-intake-ui-"));
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
    mkdirSync(join(dir, "app"));
    project = (
      await EventLog.actingFor(ada.principal, () =>
        store.ensureProject({ rootPath: join(dir, "app"), name: "Lending" }),
      )
    ).id;
    lee = await join_("member", "Lee Lead", "lee@northwind.test");
    await join_("member", "Mo Member", "mo@northwind.test");
    sam = await join_("stakeholder", "Sam Stake", "sam@northwind.test");
    expect(
      (await call("PATCH", `/api/projects/${project}/settings`, ada, { lead: lee.principal }))
        .status,
    ).toBe(200);
    // A Member's issue whose description, not its title, holds the words searched for.
    described = (
      await EventLog.actingFor(ada.principal, () =>
        store.createCard(
          {
            tier: "task",
            title: "Round invoice totals",
            status: "ready",
            spec: "Borrowers see the wrong amount on overdue invoices.",
            projectId: project,
          },
          "human",
        ),
      )
    ).id;
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
  const noSideScroll = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );

  it("a Stakeholder files from New issue, for triage, with the lead as assignee (DB-N10-1)", async () => {
    const page = await as("sam@northwind.test", 1440);
    await page.goto(`${base}/#/board`);
    const create = page.locator("[data-top-create]");
    await create.waitFor();
    expect(await create.isDisabled()).toBe(false);
    await create.click();
    const form = page.locator("form.qc");
    await form.waitFor();
    // The same form; priority, sprint and assignee are a Member's to set.
    expect(await form.locator('select[name="priority"]').count()).toBe(0);
    expect(await form.locator('select[name="assignee"]').count()).toBe(0);
    expect(await form.locator("#qc-note").innerText()).toContain("A Member triages what you file");
    await page.locator("#qc-title").fill("Renewal emails go to the wrong address");
    await form.getByRole("button", { name: "File issue" }).click();
    await page.locator(".toast", { hasText: "It waits in Triage" }).waitFor();
    const card = (await store.listCards()).find(
      (c) => c.title === "Renewal emails go to the wrong address",
    );
    expect(card?.status).toBe("backlog");
    expect(card?.owner).toBe(lee.principal);
    await page.context().close();
  });

  it("below Member, Triage's decisions are disabled with the level's note", async () => {
    const page = await as("sam@northwind.test", 1440);
    await page.goto(`${base}/#/board/triage`);
    const accept = page.locator(".tri-row [data-decide=accept]").first();
    await accept.waitFor();
    expect(await accept.isDisabled()).toBe(true);
    expect(await page.locator(".tri > p.level-note").innerText()).toContain("A Member can");
    await page.context().close();
  });

  for (const width of [1440, 400]) {
    it(`a Member triages from the View menu's Triage at ${width} px (DB-N10-2, -3)`, async () => {
      const first = await file(`Fines double-count weekends (${width})`);
      const second = await file(`Add a dark logo (${width})`);
      const page = await as("mo@northwind.test", width);
      await page.goto(`${base}/#/board`);
      await page.locator("[data-view-menu]").click();
      const option = page.getByRole("option", { name: /Triage/ });
      await option.waitFor();
      expect(await option.innerText()).toMatch(/\d+ waiting/);
      await option.click();
      await expect.poll(() => new URL(page.url()).hash).toBe("#/board/triage");
      const row = page.locator(`.tri-row[data-id="${first}"]`);
      await row.waitFor();
      expect(await row.locator(".tri-from").innerText()).toBe("Filed by Sam Stake, a Stakeholder");
      const labels = await row.locator("[data-decide]").allTextContents();
      expect(labels.map((t) => t.replace(/\s+/g, " "))).toEqual([
        "Accept into Backlog 1",
        "Decline 2",
        "Duplicate of… 3",
        "Snooze H",
      ]);
      expect(await noSideScroll(page)).toBe(true);
      // Key 1 on the focused row: Accept into Backlog.
      await row.focus();
      await page.keyboard.press("1");
      await expect.poll(() => triaged(first)).toEqual(["accept"]);
      await page.locator(`.tri-row[data-id="${first}"]`).waitFor({ state: "detached" });
      expect((await store.getCard(first))?.status).toBe("backlog");
      // Decline, with its reason.
      const other = page.locator(`.tri-row[data-id="${second}"]`);
      await other.locator("[data-decide=decline]").click();
      const reason = page.getByLabel("Decline: why won't this be done?");
      await reason.fill("Branding is out of scope");
      await reason.press("Enter");
      await expect.poll(() => triaged(second)).toEqual(["decline"]);
      expect((await store.getCard(second))?.status).toBe("rejected");
      expect(await noSideScroll(page)).toBe(true);
      await page.context().close();
    });
  }

  it("the lead's Inbox counts what waits in Triage and opens it (DB-N10-4)", async () => {
    await file("Holds expire a day early");
    const page = await as("lee@northwind.test", 1440);
    await page.goto(`${base}/#/inbox`);
    const row = page.locator(".ib-row", { hasText: "Triage" }).first();
    await row.waitFor();
    expect(await row.innerText()).toMatch(/\d+ issues? waits? in Triage\./);
    await row.locator("[data-open]").click();
    await page.getByRole("link", { name: "Open Triage" }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/board/triage");
    await page.locator(".tri-row").first().waitFor();
    await page.context().close();
  });

  for (const width of [1440, 400]) {
    it(`the palette finds an issue by its description, with its project, column and the words in context, at ${width} px (DB-N12-1)`, async () => {
      const page = await as("mo@northwind.test", width);
      await page.goto(`${base}/#/board`);
      await page.locator("[data-view-menu]").waitFor();
      await page.keyboard.press("ControlOrMeta+k");
      const input = page.locator(".palette input");
      await input.waitFor();
      await input.fill("overdue invoices");
      const hit = page.locator(".po.po-hit").first();
      await hit.waitFor();
      expect(await hit.locator(".t").innerText()).toBe("Round invoice totals");
      expect(await hit.locator(".meta").innerText()).toContain("Lending");
      expect(await hit.locator(".meta").innerText()).toContain("To do");
      expect(await hit.locator(".po-ctx mark").allInnerTexts()).toEqual(["overdue", "invoices"]);
      expect(await noSideScroll(page)).toBe(true);
      await input.press("Enter");
      await expect
        .poll(() => new URL(page.url()).hash)
        .toBe(`#/card/${encodeURIComponent(described)}`);
      await page.context().close();
    });
  }

  it("the query box finds an issue by words in its description (DB-N12-1)", async () => {
    const page = await as("mo@northwind.test", 1440);
    await page.goto(`${base}/#/board`);
    const q = page.locator("[data-q]");
    await q.waitFor();
    await q.fill("borrowers");
    await expect.poll(() => page.locator(".tile").count()).toBe(1);
    expect(await page.locator(`#tile-${described}`).count()).toBe(1);
    await page.context().close();
  });
});
