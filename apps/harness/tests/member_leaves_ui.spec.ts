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

// NEW-teams-13 in a real Chromium against a real Team server over real
// SQLite (teams item 9a; FINDINGS_C1 PRC-09): Members' *Remove* first lists
// what the person leaves behind — a warning for an Accept rule naming only
// them — and Cancel removes nothing (TEAM-49); confirmed, the person is
// removed and the Admin's Inbox holds the emptied rule's notice under Needs
// you (TEAM-51). At 1440 and 400 px. No model is loaded.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

describe("when a member leaves, in a browser (NEW-teams-13)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let lee: Person;

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
    dir = mkdtempSync(join(tmpdir(), "sek-leave-ui-"));
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
    const ada = await signedIn(
      await call("POST", "/api/setup", nobody, {
        token,
        name: "Ada Admin",
        email: "ada@northwind.test",
        password: PASSWORD,
      }),
    );
    const made = await call("POST", "/api/invites", ada, {
      level: "member",
      email: "lee@northwind.test",
    });
    const { id } = (await made.json()) as { id: string };
    lee = await signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, {
        name: "Lee Lead",
        email: "lee@northwind.test",
        password: PASSWORD,
      }),
    );
    const project = (
      await EventLog.actingFor(ada.principal, () =>
        store.ensureProject({ rootPath: join(dir, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    expect(
      (
        await call("PATCH", `/api/projects/${project}/settings`, ada, {
          accept_rule: [lee.principal],
        })
      ).status,
    ).toBe(200);
    await store.createCard({
      id: "c_own",
      tier: "story",
      title: "Hash the chain",
      projectId: project,
    });
    await store.changeOwner("c_own", lee.principal, ada.principal);
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function asAda(width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/#/signin`);
    await page.getByLabel("Email").fill("ada@northwind.test");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("[data-account]").waitFor({ state: "attached" });
    await page.waitForFunction(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the app exposes its view for tests
      Boolean((window as any).sekhemetView?.()),
    );
    return page;
  }

  async function openRemove(page: Page) {
    await page.goto(`${base}/#/members`);
    const menu = page.locator(`[data-mb-menu="${lee.principal}"]`);
    await menu.waitFor();
    await menu.click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const dialog = page.locator(".mb-remove");
    await dialog.waitFor();
    return dialog;
  }

  it(
    "TEAM-49 at 400 px: Remove lists what Lee leaves behind, warns of the emptied rule, and Cancel removes nothing",
    { timeout: 60_000 },
    async () => {
      const page = await asAda(400);
      const dialog = await openRemove(page);
      const text = await dialog.innerText();
      expect(text).toContain("Remove Lee Lead?");
      expect(text).toContain(
        "Chronicle's Accept rule names only them. Its issues cannot be accepted until the project lead or an Admin edits the rule; no one else gains Accept.",
      );
      expect(text).toContain("They are the assignee of 1 open issue: Hash the chain.");
      expect(text).not.toMatch(/p_[0-9a-f]{6}/);
      const box = await dialog.boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 400).toBe(true);
      await dialog.locator("[data-cancel]").click();
      await expect.poll(() => page.locator(".mb-remove").count()).toBe(0);
      const members = (await (await call("GET", "/api/members", lee)).json()) as {
        members: { principal: string }[];
      };
      expect(members.members.map((m) => m.principal)).toContain(lee.principal);
      await page.context().close();
    },
  );

  it(
    "TEAM-50, -51 at 1440 px: confirmed, Lee is removed and the Admin's Inbox holds the rule's notice",
    { timeout: 60_000 },
    async () => {
      const page = await asAda(1440);
      const dialog = await openRemove(page);
      await dialog.locator("[data-confirm-remove]").click();
      await page.locator(".toast", { hasText: "Removed Lee Lead." }).waitFor();
      // Their session ended: Lee's own request is refused now.
      expect((await call("GET", "/api/members", lee)).status).toBe(401);
      expect((await store.getCard("c_own"))?.owner).toBe(lee.principal);
      await page.goto(`${base}/#/inbox`);
      const row = page.locator(".ib-row", { hasText: "Chronicle's Accept rule" });
      await row.waitFor();
      await row.click();
      const pane = page.locator(".ib-pane-b");
      await expect
        .poll(() => pane.innerText())
        .toContain(
          "Chronicle's Accept rule names no current member, so no one can accept its issues.",
        );
      await page.context().close();
    },
  );
});
