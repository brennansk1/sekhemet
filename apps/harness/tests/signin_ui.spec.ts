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

/**
 * B4.10 part 2, the Team setup's pages in a real Chromium against a real
 * server (dashboard §2.2.6, §2.17 item 1; DB-N9-11, -12, -13; teams §2.3):
 * the setup token makes the first Admin, a password signs in, Sign out ends
 * the session, a personal token is shown once and revoked, an invite link
 * shows the invite and joins only on Accept invite, a 403 shows the server's
 * sentence, and Solo shows no sign-in page.
 */

const PASSWORD = "correct horse battery staple";
const MEMBER_PASSWORD = "a different long passphrase here";

interface Started {
  base: string;
  close: () => Promise<void>;
  db: DatabaseSync;
}

async function startServer(root: string, team: boolean): Promise<Started> {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  await cardStore.createCard({
    id: "card_signin_1",
    tier: "task",
    title: "A card ready to start",
    status: "ready",
    scopeFiles: ["src/a.ts"],
  });
  writeFileSync(join(root, "common.txt"), "password\n123456\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: root,
    port: 0,
    streamIntervalMs: 1000,
    identity: {
      dir: join(root, "identity"),
      passwordList: join(root, "common.txt"),
      settings: identitySettings(
        team ? { mode: "team", workspace: "Northwind" } : { mode: "solo" },
      ),
    },
  });
  vi.mocked(console.log).mockRestore();
  return { base: `http://127.0.0.1:${server.port}`, close: server.close, db };
}

describe("the Team setup's pages in Chromium (DB-N9-11, DB-N9-12, DB-N9-13)", () => {
  let root: string;
  let team: Started;
  let solo: Started;
  let browser: Browser;
  let admin: Page;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sekhemet-signin-"));
    team = await startServer(join(root, "team"), true);
    solo = await startServer(join(root, "solo"), false);
    browser = await chromium.launch();
    admin = await (await browser.newContext()).newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await team?.close();
    await solo?.close();
    team?.db.close();
    solo?.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "a signed-out app opens Set up Sekhemet, and the setup token makes the first Admin",
    {
      timeout: 60_000,
    },
    async () => {
      await admin.goto(`${team.base}/#/board`);
      await admin.getByRole("heading", { name: "Set up Sekhemet" }).waitFor();
      // Nothing of the app shows before signing in.
      expect(await admin.locator("#side").isVisible()).toBe(false);

      const token = readFileSync(join(root, "team", "identity", "setup-token"), "utf8").trim();
      await admin.getByLabel("Setup token").fill(token);
      await admin.getByLabel("Your name").fill("Ada Admin");
      await admin.getByLabel("Email").fill("ada@northwind.test");
      await admin.getByLabel("Password").fill(PASSWORD);
      await admin.getByRole("button", { name: "Create the Admin account" }).click();

      // On to where it was going, signed in.
      await admin.waitForFunction(() => location.hash === "#/board");
      const account = admin.locator("[data-account]");
      await account.waitFor();
      expect(await account.innerText()).toContain("Ada Admin");
      await account.click();
      const menu = admin.getByRole("menu");
      await menu.waitFor();
      const text = await menu.innerText();
      expect(text).toContain("Ada Admin");
      expect(text).toContain("Admin");
      expect(text).toContain("Sign out");
      expect(text).toContain("Keyboard shortcuts");
      await admin.keyboard.press("Escape");
    },
  );

  it(
    "Sign out ends the session; Sign in shows only what is on, and a password signs back in",
    {
      timeout: 60_000,
    },
    async () => {
      await admin.locator("[data-account]").click();
      await admin.getByRole("menuitem", { name: "Sign out" }).click();
      await admin.getByRole("heading", { name: "Sign in" }).waitFor();
      const page = await admin.locator("main").innerText();
      expect(page).toContain("Ask an admin for an invite link");
      expect(page).toContain("Self-hosted · your code and data stay on this server");
      expect(await admin.getByRole("button", { name: /passkey/i }).count()).toBe(0);
      expect(await admin.getByRole("button", { name: /SSO/ }).count()).toBe(0);
      // The session is gone on the server too.
      const status = await admin.evaluate(async () => (await fetch("/api/board")).status);
      expect(status).toBe(401);

      await admin.getByLabel("Email").fill("ada@northwind.test");
      await admin.getByLabel("Password").fill("not the right password at all");
      await admin.getByRole("button", { name: "Sign in", exact: true }).click();
      await admin.getByRole("alert").waitFor();
      expect(await admin.getByRole("alert").innerText()).not.toBe("");

      // A failed attempt backs off before the next is checked (teams item 14a).
      await admin.waitForTimeout(400);
      await admin.getByLabel("Password").fill(PASSWORD);
      await admin.getByRole("button", { name: "Sign in", exact: true }).click();
      await admin.locator("[data-account]").waitFor();
      expect(await admin.evaluate(async () => (await fetch("/api/board")).status)).toBe(200);
    },
  );

  it(
    "creates a personal access token shown once, and revokes it",
    {
      timeout: 60_000,
    },
    async () => {
      await admin.goto(`${team.base}/#/account/profile`);
      await admin.getByRole("heading", { name: "Personal access tokens" }).waitFor();
      await admin.getByLabel("Token name").fill("laptop cli");
      await admin.getByLabel("Expires in").selectOption("30");
      await admin.getByRole("button", { name: "Create token" }).click();
      const shown = admin.locator("[data-token-value]");
      await shown.waitFor();
      const value = (await shown.innerText()).trim();
      expect(value).toMatch(/^sekp_t_[0-9a-f]+_/);
      // The token works as a Bearer token until it is revoked.
      const ok = await fetch(`${team.base}/api/board`, {
        headers: { Authorization: `Bearer ${value}` },
      });
      expect(ok.status).toBe(200);

      await admin
        .getByRole("button", { name: /^Revoke/ })
        .first()
        .click();
      await admin.waitForFunction(() => !document.querySelector("[data-token-value]"));
      const after = await fetch(`${team.base}/api/board`, {
        headers: { Authorization: `Bearer ${value}` },
      });
      expect(after.status).toBe(401);
    },
  );

  it(
    "an invite link shows the invite, and joins only on Accept invite",
    {
      timeout: 60_000,
    },
    async () => {
      const id = await admin.evaluate(async () => {
        const me = await (await fetch("/api/session")).json();
        const res = await fetch("/api/invites", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sekhemet-Action": "1",
            "X-Sekhemet-CSRF": me.csrf,
          },
          body: JSON.stringify({ level: "member" }),
        });
        return (await res.json()).id as string;
      });
      expect(id).toBeTruthy();

      const guest = await (await browser.newContext()).newPage();
      await guest.goto(`${team.base}/#/invite/${id}`);
      await guest.getByRole("heading", { name: "You're invited" }).waitFor();
      const shown = await guest.locator("main").innerText();
      expect(shown).toContain("Northwind");
      expect(shown).toContain("Member");
      expect(shown).toContain("Ada Admin");
      // Opening the link consumed nothing: it still shows.
      expect((await fetch(`${team.base}/api/invites/${id}`)).status).toBe(200);

      await guest.getByLabel("Your name").fill("Mo Member");
      await guest.getByLabel("Email").fill("mo@northwind.test");
      await guest.getByLabel("Password").fill(MEMBER_PASSWORD);
      await guest.getByRole("button", { name: "Accept invite" }).click();
      await guest.locator("[data-account]").waitFor();
      expect(await guest.locator("[data-account]").innerText()).toContain("Mo Member");

      // A 403 shows the missing permission and who can grant it: the server's sentence.
      // (A string, so the test runner does not rewrite the page's own import.)
      await guest.evaluate(
        'import("/app/dom.js").then((dom) => dom.postJSON("/api/invites", { level: "member" }))',
      );
      const toast = guest.locator("#toasts");
      await toast.getByText("Only an Admin can invite people. An Admin can grant it.").waitFor();
      await guest.close();
    },
  );

  it("Solo shows no sign-in page", { timeout: 60_000 }, async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${solo.base}/#/signin`);
    await page.waitForFunction(() => location.hash !== "#/signin" && location.hash !== "");
    expect(await page.getByRole("heading", { name: "Sign in" }).count()).toBe(0);
    expect(await page.locator("#side").isVisible()).toBe(true);
    await page.locator("[data-account]").click();
    const menu = await page.getByRole("menu").innerText();
    expect(menu).toContain("This computer");
    expect(menu).not.toContain("Sign out");
    await page.close();
  });
});
