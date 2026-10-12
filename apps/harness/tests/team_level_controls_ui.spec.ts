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

// Loop sweep 3, wave 6 (teams): in a real Chromium against a real Team server
// over real SQLite (DoD §2A), the page follows the server's access rule and
// says only what the server does. No model is loaded.
// - Controls a person's level does not allow are disabled with the level's
//   note (dashboard §2.15.7 item 7; teams item 6): Start a project, Take over,
//   New project, Status's Start a new project, the start page's folder and
//   repository controls.
// - The start page shows a Viewer no folder of the server's disk.
// - The bare *Start a new project:* starter is not sent in one press.
// - A Viewer is not told to set up a model in Configuration.
// - The Audit page asks the server nothing below Admin; an invite's row names
//   no record id; Members names the one project.
// - The New issue form promises no project-lead assignee where there is no lead.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

describe("access-gated controls and honest words in the Team setup (loop sweep 3, W6)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let ada: Person;
  let vi_: Person;

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
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-level-ctl-ui-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(dir, "cfg", "config.toml"));
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db, { setup: "team" });
    store = new CardStore(db, log);
    writeFileSync(join(dir, "list.txt"), "passwordpassword1\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    // A project with no lead and, until the Stakeholder files, no issues.
    await EventLog.actingFor(ada.principal, () =>
      store.ensureProject({ rootPath: join(dir, "chronicle"), name: "Chronicle" }),
    );
    vi_ = await join_("viewer", "Vi Viewer", "vi@northwind.test");
    await join_("member", "Lee Member", "lee@northwind.test");
    await join_("stakeholder", "Sam Stakeholder", "sam@northwind.test");
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function as(email: string, width = 1440): Promise<Page> {
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

  /** A control, disabled, with the level's sentence beside it (read at once, as a view may redraw it). */
  async function gated(page: Page, selector: string, note: RegExp) {
    await page.locator(selector).first().waitFor();
    await expect
      .poll(() =>
        page.evaluate((sel) => {
          const control = document.querySelector(sel);
          if (!(control instanceof HTMLButtonElement)) return "";
          const ids = (control.getAttribute("aria-describedby") ?? "").split(" ");
          const text = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
          return `${control.disabled ? "disabled" : "enabled"}: ${text}`;
        }, selector),
      )
      .toMatch(new RegExp(`^disabled: .*${note.source}`));
  }

  it("a Viewer's Start a project, Take over, New project and Start a new project are disabled with the note", async () => {
    const page = await as("vi@northwind.test");
    await page.goto(`${base}/#/board`);
    await gated(
      page,
      '[data-empty-action="start"]',
      /You're a Viewer in this workspace\. A Stakeholder can start a project conversation\./,
    );
    await gated(page, '[data-empty-action="takeover"]', /can create a project\./);
    await page.goto(`${base}/#/projects`);
    await gated(page, "[data-new]", /A Stakeholder can start a project conversation\./);
    await page.goto(`${base}/#/status`);
    await gated(page, "[data-start]", /A Stakeholder can start a project conversation\./);
    await page.context().close();
  });

  it("the start page shows a Viewer no server folder, offers no starter and disables taking a repository over", async () => {
    // The server says no folder to a Viewer.
    const asked = await call("GET", "/api/projects/new", vi_);
    const answer = (await asked.json()) as Record<string, unknown>;
    expect(answer.folder).toBeUndefined();
    expect(answer.shown).toBeUndefined();
    expect(answer.projectsDir).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain(dir);

    const page = await as("vi@northwind.test");
    await page.goto(`${base}/#/projects/new`);
    await page.locator(".start-place [data-add-repo]").waitFor();
    await gated(page, ".start-place [data-add-repo]", /can create a project\./);
    expect(await page.locator("[data-change-folder]").count()).toBe(0);
    expect(await page.locator(".start-place").innerText()).toMatch(
      /A Stakeholder can start a project conversation\./,
    );
    expect(await page.locator("body").innerText()).not.toContain(dir);
    await page.waitForTimeout(300);
    expect(await page.locator(".start-convo textarea").inputValue()).toBe("");
    await page.context().close();
  });

  it("a Viewer's switcher and Configuration show no folder of the server's disk; an Admin's do (W6 review)", async () => {
    const folder = /sek-level-ctl-ui-[^"'<\s]*chronicle/;
    const viewer = await as("vi@northwind.test");
    await viewer.goto(`${base}/#/configuration/project`);
    await viewer.locator("#cfg-h-project").waitFor();
    await viewer.locator("[data-project-switch]").waitFor();
    await viewer.waitForTimeout(300);
    expect(await viewer.content()).not.toMatch(folder);
    await viewer.context().close();
    const admin = await as("ada@northwind.test");
    await admin.goto(`${base}/#/configuration/project`);
    await admin.locator("#cfg-h-project").waitFor();
    await expect.poll(async () => folder.test(await admin.content())).toBe(true);
    await admin.context().close();
  });

  it("an Admin's bare starter is not sent until they finish it", async () => {
    const page = await as("ada@northwind.test");
    await page.goto(`${base}/#/projects/new`);
    const ta = page.locator(".start-convo textarea");
    await expect.poll(() => ta.inputValue()).toBe("Start a new project: ");
    const send = page.locator(".start-convo [data-send]");
    expect(await send.isDisabled()).toBe(true);
    await ta.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(await ta.inputValue()).toBe("Start a new project: ");
    const thread = (await (await call("GET", "/api/pm/thread", ada)).json()) as {
      messages: { role: string }[];
    };
    expect(thread.messages.filter((m) => m.role === "user")).toHaveLength(0);
    await ta.type("a recipe site");
    await expect.poll(() => send.isDisabled()).toBe(false);
    await page.context().close();
  });

  it("a Viewer whose message finds no model is told an Admin sets one up", async () => {
    const sent = await call("POST", "/api/pm/messages", vi_, {
      text: "What is in the next release?",
      context: { view: "pm" },
    });
    expect(sent.status).toBe(200);
    let reply: { text: string; cause?: string } | undefined;
    for (let i = 0; i < 100 && !reply; i++) {
      const thread = (await (await call("GET", "/api/pm/thread", vi_)).json()) as {
        messages: { role: string; text: string; cause?: string; state?: string }[];
      };
      reply = thread.messages.find((m) => m.role === "pm" && m.state === "error");
      if (!reply) await new Promise((r) => setTimeout(r, 100));
    }
    expect(reply?.cause).toBe("no_model");
    expect(reply?.text).toMatch(/an Admin sets up a Planning model in Configuration › Models/);
    expect(reply?.text).not.toMatch(/choose and verify|set up a Planning model in Configuration/);
  });

  it("the Audit page asks a Member's server nothing it would refuse, and says who can open it", async () => {
    const page = await as("lee@northwind.test");
    const audit: number[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname === "/api/audit") audit.push(r.status());
    });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`${base}/#/audit`);
    await page
      .locator(".au", {
        hasText: "You're a Member in this workspace. An Admin can open the audit view.",
      })
      .waitFor();
    await page.waitForTimeout(500);
    expect(audit).toEqual([]);
    expect(errors.filter((e) => /403/.test(e))).toEqual([]);
    await page.context().close();
  });

  it("an Admin's audit names where an invite is to, never its record id; Members names the one project", async () => {
    const page = await as("ada@northwind.test");
    await page.goto(`${base}/#/audit`);
    const invited = page.locator(".au-tbl tr", { hasText: "Invited as Viewer" }).first();
    await invited.waitFor();
    expect(await invited.innerText()).toMatch(/Whole workspace/);
    expect(await page.locator(".au-tbl").innerText()).not.toMatch(/inv_[0-9a-f]/);
    await page.goto(`${base}/#/members`);
    const cell = page.locator('.mb-tbl td[data-col="projects"]').first();
    await cell.waitFor();
    expect(await cell.innerText()).toMatch(/Chronicle/);
    expect(await page.locator(".mb-tbl").innerText()).not.toMatch(/The 1 project/);
    await page.context().close();
  });

  it("a Stakeholder's New issue promises no project-lead assignee in a project with no lead", async () => {
    const page = await as("sam@northwind.test");
    await page.goto(`${base}/#/board`);
    const create = page.locator("[data-top-create]");
    await create.waitFor();
    await create.click();
    const note = page.locator("form.qc #qc-note");
    await note.waitFor();
    await expect
      .poll(() => note.innerText())
      .toBe("A Member triages what you file. Until then it waits in Backlog, unassigned.");
    await page.locator("#qc-title").fill("Renewal emails go to the wrong address");
    await page.locator("form.qc").getByRole("button", { name: "File issue" }).click();
    await page.locator(".toast", { hasText: "It waits in Triage" }).waitFor();
    const card = (await store.listCards()).find(
      (c) => c.title === "Renewal emails go to the wrong address",
    );
    expect(card?.owner ?? null).toBeNull();
    await page.context().close();
  });
});
