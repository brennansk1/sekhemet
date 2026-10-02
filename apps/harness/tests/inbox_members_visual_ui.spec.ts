import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// C2a, the team-visual builder, in a real Chromium against a real Team server
// over real SQLite (DoD §2A), at 1440 and 400 px where layout is the finding:
// - A11Y-01: *Skip to content* moves focus to the page and never changes the route;
// - NEW-dashboard-19 (DEC-51): the Inbox in two panes from 1100 px, one list
//   below with the pane in its place (DB-N19-7..9; TEAM-03); Members' tabs,
//   columns, AI teammates, Access levels, Invites with Revoke and Sign-in
//   (DB-N19-3, -4; TEAM-04); Configuration's machine line, tab bar and cards
//   (DB-N19-5; CFG-07); the brand mark's disc on the horizon (DB-N19-6; VIS-02);
// - NEW-dashboard-20: every primary button in ink, in both themes;
// - axe clean (WCAG 2 A and AA) on every page touched, both themes.
// No model is loaded.

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

describe("Inbox, Members, Configuration and the visual system in a browser (C2a team-visual)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let browser: Browser;
  let ada: Person;
  let mo: Person;
  let lee: Person;
  let cardA = "";
  let cardB = "";
  let inviteId = "";

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
    return {
      principal: body.principal,
      headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf },
    };
  }
  async function invite(by: Person, level: string, email: string) {
    const res = await call("POST", "/api/invites", by, { level, email });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }
  async function join_(by: Person, level: string, name: string, email: string) {
    const id = await invite(by, level, email);
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-tv-ui-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    writeGguf(join(dir, "models", "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama" });
    vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "models"));
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
    const project = (
      await EventLog.actingFor(ada.principal, () =>
        store.ensureProject({ rootPath: join(dir, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    mo = await join_(ada, "member", "Mo Member", "mo@northwind.test");
    lee = await join_(ada, "member", "Lee Lead", "lee@northwind.test");
    const made = (title: string) =>
      EventLog.actingFor(ada.principal, () =>
        store.createCard({ tier: "task", title, status: "ready", projectId: project }, "human"),
      );
    cardA = (await made("Export loans as CSV")).id;
    cardB = (await made("Round invoice totals per line")).id;
    // Lee mentions Mo on both: two items in Mo's Inbox, each caused by a comment.
    for (const [id, text] of [
      [cardA, "@MoMember the export includes returned items by default. Keep it?"],
      [cardB, "@MoMember the totals round per invoice today."],
    ] as const) {
      expect((await call("POST", `/api/cards/${id}/comments`, lee, { text })).status).toBe(200);
    }
    inviteId = await invite(ada, "stakeholder", "sam@northwind.test");
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function as(email: string, width: number, theme = "sand"): Promise<Page> {
    const context: BrowserContext = await browser.newContext({
      viewport: { width, height: width >= 1100 ? 900 : 860 },
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("sekhemet-theme", t);
      } catch {}
    }, theme);
    const page = await context.newPage();
    await page.goto(`${base}/#/signin`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("[data-account]").waitFor({ state: "attached" });
    // The shell (and its account button) is drawn before the app has routed;
    // the landing route then replaces `#/` with the default page. Wait for it,
    // so a test's own navigation never races that replace (a reload would
    // otherwise reopen the default page instead of the one the test chose).
    await page.waitForFunction(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the app exposes its view for tests
      Boolean((window as any).sekhemetView?.()),
    );
    return page;
  }

  async function axe(page: Page): Promise<string[]> {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
    if (!(await page.evaluate(() => Boolean((window as any).axe))))
      await page.evaluate(`${AXE_SOURCE}\n;undefined`);
    const r = (await page.evaluate(() =>
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
      (window as any).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      }),
    )) as { violations: { id: string; nodes: { target: string[] }[] }[] };
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`));
  }

  it("A11Y-01: Skip to content moves focus to the page and keeps the route", async () => {
    const page = await as("mo@northwind.test", 1440);
    // The Inbox as the page loaded, so the first Tab starts from the document.
    await page.goto(`${base}/#/inbox`);
    await page.reload();
    await page.locator(".ib-row").first().waitFor();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("skip");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => location.hash)).toBe("#/inbox");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("view");
    expect(await page.locator("#view-title").textContent()).toBe("Inbox");
    // `#view` reached another way is put back to the page it was on.
    await page.evaluate(() => {
      location.hash = "#view";
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => location.hash)).toBe("#/inbox");
    expect(await page.locator("#view-title").textContent()).toBe("Inbox");
    await page.context().close();
  });

  it("DB-N19-7, -8: at 1440 px the list and a reading pane; a click or j/k fills it and stays in the Inbox; Reply posts a comment", async () => {
    const page = await as("mo@northwind.test", 1440);
    await page.goto(`${base}/#/inbox`);
    const rows = page.locator(".ib-list .ib-row");
    await rows.nth(1).waitFor();
    const pane = page.locator(".ib-pane");
    expect(await pane.isVisible()).toBe(true);
    expect(await page.locator(".ib-list").isVisible()).toBe(true);
    // The two panes sit side by side and fill the main area (VIS-03).
    const [l, p] = await Promise.all([page.locator(".ib-list").boundingBox(), pane.boundingBox()]);
    expect((p?.x ?? 0) > (l?.x ?? 0) + (l?.width ?? 0) - 2).toBe(true);
    expect(Math.round((p?.x ?? 0) + (p?.width ?? 0))).toBe(1440);
    // A click selects; the person stays in the Inbox.
    await rows.nth(1).locator(".ib-main").click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => location.hash)).toBe("#/inbox");
    const title = await rows.nth(1).locator(".ib-title").textContent();
    await expect.poll(() => pane.locator(".ib-pane-t").textContent()).toBe(title);
    for (const name of ["Snooze", "Save", "Done", "Reply", "Open issue"])
      expect(await pane.getByText(name, { exact: true }).count(), name).toBeGreaterThan(0);
    await expect.poll(() => pane.locator(".ib-facts").textContent()).toMatch(/^To do · /);
    await expect.poll(() => pane.locator(".ib-quote").textContent()).toContain("Lee Lead");
    // j/k move the selection and the focus together (TEAM-01).
    await page.keyboard.press("k");
    await page.waitForTimeout(300);
    const first = await rows.nth(0).locator(".ib-title").textContent();
    await expect.poll(() => pane.locator(".ib-pane-t").textContent()).toBe(first);
    expect(
      await page.evaluate(() => document.activeElement?.closest(".ib-row")?.getAttribute("data-i")),
    ).toBe("0");
    // Reply posts on the issue as Mo's comment.
    const issue = first === "Export loans as CSV" ? cardA : cardB;
    await pane.getByLabel("Reply on this issue").fill("Keep it, filtered by default.");
    await pane.getByRole("button", { name: "Reply", exact: true }).click();
    await expect
      .poll(async () => {
        const r = await call("GET", `/api/cards/${issue}/comments`, mo);
        const { comments } = (await r.json()) as { comments: { text: string; name: string }[] };
        return comments.find((c) => c.text === "Keep it, filtered by default.")?.name;
      })
      .toBe("You");
    expect(await page.evaluate(() => location.hash)).toBe("#/inbox");
    expect(await axe(page)).toEqual([]);
    await page.context().close();
  });

  it("DB-N19-9: below 1100 px one list; an item opens its pane in the list's place, and Back returns to the same row", async () => {
    const page = await as("mo@northwind.test", 400);
    await page.goto(`${base}/#/inbox`);
    const rows = page.locator(".ib-list .ib-row");
    await rows.nth(1).waitFor();
    expect(await page.locator(".ib-pane").isVisible()).toBe(false);
    await rows.nth(1).locator(".ib-main").click();
    await expect.poll(() => page.locator(".ib-pane").isVisible()).toBe(true);
    expect(await page.locator(".ib-list").isVisible()).toBe(false);
    expect(await page.evaluate(() => location.hash)).toBe("#/inbox");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      400,
    );
    await page.getByRole("button", { name: "Back to Inbox" }).click();
    await expect.poll(() => page.locator(".ib-list").isVisible()).toBe(true);
    expect(await page.locator(".ib-pane").isVisible()).toBe(false);
    expect(
      await page.evaluate(() => document.activeElement?.closest(".ib-row")?.getAttribute("data-i")),
    ).toBe("1");
    expect(await axe(page)).toEqual([]);
    await page.context().close();
  });

  it("DB-N19-7, SHL-02: the pane names the assignee and delegate as people and the Agent, never a principal (DEC-52)", async () => {
    // As `GET /api/cards/:id` stores them: Lee owns the first issue; Mo owns
    // the second and the Agent is its delegate.
    await EventLog.actingFor(ada.principal, async () => {
      await store.changeOwner(cardA, lee.principal, ada.principal);
      await store.changeOwner(cardB, mo.principal, ada.principal);
      await store.delegateCard(cardB, { kind: "worker" }, ada.principal);
    });
    for (const width of [1440, 400]) {
      const page = await as("mo@northwind.test", width);
      for (const [title, facts] of [
        ["Export loans as CSV", "To do · assignee Lee Lead"],
        ["Round invoice totals per line", "To do · assignee Mo Member · delegate Agent"],
      ] as const) {
        await page.goto(`${base}/#/inbox`);
        await page.reload();
        const row = page.locator(".ib-list .ib-row", { hasText: title }).first();
        await row.waitFor();
        await row.locator(".ib-main").click();
        const pane = page.locator(".ib-pane");
        await expect.poll(() => pane.locator(".ib-pane-t").textContent()).toBe(title);
        await expect.poll(() => pane.locator(".ib-facts").textContent()).toBe(facts);
        expect(await pane.textContent()).not.toMatch(/\bp_[0-9a-f]{6,}/);
      }
      await page.context().close();
    }
  }, 90_000);

  it("DB-N19-3, -4: Members' tabs, columns and parts; an Admin revokes an invite and the link stops working", async () => {
    for (const width of [1440, 400]) {
      const page = await as("ada@northwind.test", width);
      await page.goto(`${base}/#/members`);
      await page.locator(".mb-tbl").waitFor();
      const tabs = page.locator(".mb-bar .tab");
      expect((await tabs.allTextContents()).map((t) => t.replace(/\s*\d+$/, ""))).toEqual([
        "Members",
        "Invites",
        "Sign-in",
      ]);
      expect(await page.getByRole("link", { name: "Audit log" }).count()).toBe(1);
      const heads = await page.locator(".mb-tbl thead th").allTextContents();
      expect(heads.slice(0, 6)).toEqual([
        "Name",
        "Access",
        "Labels",
        "Projects",
        "Can accept in",
        "Last active",
      ]);
      // No rule set: the Admins accept (DEC-42).
      const adaRow = page.locator(`tr[data-principal="${ada.principal}"] td[data-col="accept"]`);
      expect(await adaRow.textContent()).toContain("Chronicle");
      expect(await page.locator("#mb-ai-h").textContent()).toContain("not members");
      expect(await page.locator(".mb-ai").textContent()).toContain(
        "Acts with the access of the person who starts it",
      );
      expect(await page.locator(".mb-levels dt").allTextContents()).toEqual([
        "Admin",
        "Member",
        "Stakeholder",
        "Viewer",
      ]);
      expect(await axe(page)).toEqual([]);
      if (width === 1440) {
        // The Access levels sit beside the table, and the page fills the main area (VIS-03).
        const side = await page.locator(".mb-side").boundingBox();
        const main = await page.locator(".mb-main").boundingBox();
        expect((side?.x ?? 0) > (main?.x ?? 0) + (main?.width ?? 0) - 2).toBe(true);
        expect(Math.round((side?.x ?? 0) + (side?.width ?? 0))).toBeGreaterThan(1400);
      }
      await page.getByRole("link", { name: "Sign-in" }).click();
      await page.locator(".mb-signin").waitFor();
      expect(await page.locator(".mb-signin dt").allTextContents()).toEqual([
        "Company SSO",
        "Passkeys",
        "Passwords",
        "Open sign-up",
        "Sessions",
      ]);
      expect(await page.locator(".mb-signin").textContent()).toContain("15 characters minimum");
      expect(await axe(page)).toEqual([]);
      await page.getByRole("link", { name: /^Invites/ }).click();
      await page.locator("[data-invite]").first().waitFor();
      expect(await page.locator("[data-invite]").first().textContent()).toContain(
        "sam@northwind.test",
      );
      expect(await axe(page)).toEqual([]);
      if (width === 400) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          400,
        );
        // Revoke, confirmed: the row goes, and the link is no longer valid.
        page.once("dialog", (d) => void d.accept());
        await page.getByRole("button", { name: "Revoke: sam@northwind.test" }).click();
        await expect.poll(() => page.locator("[data-invite]").count()).toBe(0);
        expect((await call("GET", `/api/invites/${inviteId}`, nobody)).status).toBe(404);
      }
      await page.context().close();
    }
  });

  it("DB-N19-3: a Member sees no Invites tab, and the invites route is not theirs", async () => {
    const page = await as("mo@northwind.test", 1440);
    await page.goto(`${base}/#/members/invites`);
    await page.locator(".mb-tbl").waitFor();
    expect((await page.locator(".mb-bar .tab").allTextContents()).map((t) => t.trim())).toEqual([
      "Members 3",
      "Sign-in",
    ]);
    expect(await page.locator("[data-invite]").count()).toBe(0);
    await page.context().close();
  });

  it("DB-N19-5: Configuration has the machine line, one underlined tab bar and Models' cards", async () => {
    for (const width of [1440, 400]) {
      const page = await as("ada@northwind.test", width);
      await page.goto(`${base}/#/configuration`);
      await page.locator("#cfg-h-roles").waitFor({ timeout: 10_000 });
      expect(await page.locator(".cfg-machine").textContent()).toMatch(/GB/);
      const tabs = page.locator(".cfg-tabs .tab");
      expect(await tabs.allTextContents()).toEqual([
        "Models",
        "Benchmark",
        "Review capacity",
        "Preferences",
        "Project",
      ]);
      expect(await page.locator(".cfg-tabs a.btn").count()).toBe(0);
      expect(
        (await page.locator(".cfg-card > h2").allTextContents()).map((t) =>
          t.replace(/\s*\d+$/, ""),
        ),
      ).toEqual(["Model library", "Available models", "Suggested setup", "Compare setups"]);
      expect(await axe(page)).toEqual([]);
      if (width === 400)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          400,
        );
      await page.context().close();
    }
  });

  it("NEW-dashboard-20 and DB-N19-6: primary buttons in ink in both themes; the disc on the horizon", async () => {
    for (const theme of ["sand", "basalt"]) {
      const page = await as("ada@northwind.test", 1440, theme);
      await page.goto(`${base}/#/members`);
      await page.locator(".mb-tbl").waitFor();
      const colours = await page.evaluate(() => {
        const b = document.querySelector(".btn.primary") as HTMLElement;
        const probe = document.createElement("span");
        probe.style.color = "var(--text-primary)";
        document.body.append(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        return { fill: getComputedStyle(b).backgroundColor, ink };
      });
      expect(colours.fill).toBe(colours.ink);
      const disc = page.locator(".side .brand-mark circle");
      expect(await disc.getAttribute("cy")).toBe("6.5");
      expect(await disc.getAttribute("r")).toBe("2.4");
      await page.context().close();
    }
    const favicon = await (await fetch(`${base}/favicon.svg`)).text();
    expect(favicon).toContain('cy="6.5" r="2.4"');
  });

  it("A11Y-02, -03, -05, -06: Esc leaves an issue, focus never falls to <body>, 24 px targets, short tile names, named numbers", async () => {
    const page = await as("ada@northwind.test", 1440);
    // A11Y-05: a tile's name is its type, key, title and people, not its whole face.
    await page.goto(`${base}/#/board`);
    await page.locator(`#tile-${cardA}`).waitFor();
    const name = (await page.locator(`#tile-${cardA}`).getAttribute("aria-label")) ?? "";
    expect(name).toContain("Export loans as CSV");
    expect(name.length).toBeLessThan(120);
    // A11Y-02: a chord from <body> lands focus on the new page, not on <body>.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("g");
    await page.keyboard.press("x");
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inbox");
    await page.locator(".ib-list").waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("view");
    // Esc on an issue goes back to the page the person came from.
    await page.goto(`${base}/#/card/${cardA}`);
    await page.locator(".cv-tabs").waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inbox");
    // A11Y-03: the list's Select is a 24 px target.
    await page.goto(`${base}/#/board/list`);
    const cbx = page.locator(".c-sel .cbx").first();
    await cbx.waitFor();
    const box = await cbx.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
    // A11Y-06: Status' numbers say what they count.
    await page.goto(`${base}/#/status`);
    const jump = page.locator("[data-jump]").first();
    await jump.waitFor();
    expect(await jump.getAttribute("aria-label")).toMatch(/^Needs attention: \d+\. Show them$/);
    await page.context().close();
  });

  it("DB-N19-2, ISS-09: for a Viewer the rail is read-only with the level note, and a note two controls share is written once", async () => {
    await join_(ada, "viewer", "Vic Viewer", "vic@northwind.test");
    const project = (await store.listCards()).find((c) => c.id === cardA)?.projectId as string;
    const cardR = (
      await EventLog.actingFor(ada.principal, () =>
        store.createCard(
          {
            tier: "task",
            title: "Show overtime on the report",
            status: "ready",
            projectId: project,
          },
          "human",
        ),
      )
    ).id;
    await store.updateCardStatus(cardR, "review", "setup", "harness", { override: true });
    // A finished run's evidence, so Review offers Request changes beside Put on hold.
    const body = JSON.stringify({
      id: `ev_${cardR}`,
      cardId: cardR,
      attempt: 1,
      createdAt: new Date().toISOString(),
      passed: true,
      failures: [],
      skipped: [],
      unavailable: [],
      stopReason: "gate_passed",
      turnsUsed: 1,
      durationMs: 1000,
      rungResults: [
        { gate: "tsc", rung: "hygiene", layer: "functional", passed: true, exitCode: 0 },
      ],
    });
    const evDir = join(dir, ".sekhemet", "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, `ev_${cardR}.json`), body);
    writeFileSync(join(evDir, `latest-${cardR}.json`), body);
    await recordLedgerRun(store, {
      cardId: cardR,
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: `ev_${cardR}`,
      path: `.sekhemet/evidence/ev_${cardR}.json`,
      body,
      filesTouched: [],
    });
    for (const width of [1440, 400]) {
      const page = await as("vic@northwind.test", width);
      await page.goto(`${base}/#/card/${cardR}`);
      const rail = page.locator("[data-rail]");
      await rail.locator(".iprop").first().waitFor({ state: "attached" });
      // DB-N19-2: no field opens an editor; each read-only field names the level.
      expect(await rail.locator(".iprop-edit").count(), `${width} px`).toBe(0);
      const notes = await rail.locator(".iprop-note").allTextContents();
      expect(notes.length).toBeGreaterThan(0);
      expect(new Set(notes).size).toBe(notes.length);
      for (const n of notes) expect(n).toMatch(/^You're a Viewer on [^.]+\. A \w+ can /);
      const described = await rail
        .locator('[aria-describedby^="iprop-note-"]')
        .evaluateAll((els) =>
          els.map((e) =>
            Boolean(document.getElementById(e.getAttribute("aria-describedby") ?? "")),
          ),
        );
      expect(described.length).toBeGreaterThan(0);
      expect(described.every(Boolean)).toBe(true);
      // ISS-09: Request changes and Put on hold need the same level: one note, both described by it.
      await page.goto(`${base}/#/review/${cardR}`);
      const back = page.locator(".triage [data-back]");
      const park = page.locator(".triage [data-park]");
      await back.waitFor();
      expect(await back.isDisabled()).toBe(true);
      expect(await park.isDisabled()).toBe(true);
      const shared = page.locator(".triage .level-note:not(.sr-only)");
      expect(await shared.count()).toBe(1);
      const id = (await shared.getAttribute("id")) ?? "";
      expect(await shared.textContent()).toMatch(/^You're a Viewer on [^.]+\. A \w+ can /);
      for (const b of [back, park])
        expect((await b.getAttribute("aria-describedby"))?.split(" ")).toContain(id);
      await page.context().close();
    }
  }, 90_000);
});
