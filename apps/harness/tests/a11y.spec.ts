import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NAV_ITEMS } from "@sekhemet/ui";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// DB-P12-6: every route at 400, 1100 and 1440 px in both themes, in a real
// Chromium (the cached build pinned by playwright-core), checked by axe-core
// for accessible names and target size, plus the three checks axe does not make:
// 44 px targets at phone width, reflow at 200% zoom, and nothing only on hover.
// The Team setup's pages are checked on Team servers: Set up Sekhemet (no Admin
// yet), Sign in and an invite (signed out), and Profile (signed in).
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const AXE_SOURCE = readFileSync(AXE, "utf8");
const NAME_RULES = [
  "button-name",
  "link-name",
  "label",
  "select-name",
  "input-button-name",
  "aria-command-name",
  "aria-input-field-name",
  "aria-toggle-field-name",
  "image-alt",
  "svg-img-alt",
  "role-img-alt",
  "target-size",
];
const WIDTHS = [400, 1100, 1440];
const PASSWORD = "correct horse battery staple";
const THEMES = ["basalt", "sand"];

type Server = { port: number; close: () => Promise<void> };

/** A Team server over its own ledger; `db` is closed by the caller. */
async function teamServer(root: string): Promise<{ server: Server; db: DatabaseSync }> {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  writeFileSync(join(root, "common.txt"), "password\n");
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
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  return { server, db };
}

describe("the accessibility check (dashboard DB-P12-6)", () => {
  let dir: string;
  let db: DatabaseSync;
  let server: Server;
  let browser: Browser;
  let firstRun: { server: Server; db: DatabaseSync };
  let team: { server: Server; db: DatabaseSync };
  let inviteId = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sekhemet-a11y-"));
    // Configuration › Models (B4.1) renders a folder with a model in it, and
    // never the owner's real model folder.
    writeGguf(join(dir, "models", "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama" });
    vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "models"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    await cardStore.createCard({
      id: "card_a11y_1",
      tier: "feature",
      title: "A card in progress",
      status: "in_progress",
      scopeFiles: ["src/a.ts"],
    });
    await cardStore.createCard({
      id: "card_a11y_2",
      tier: "task",
      title: "A card ready to start",
      status: "ready",
      scopeFiles: ["src/b.ts"],
    });
    // PM-N7-5: a planned card waiting on a person's approval shows its criteria and Approve.
    await cardStore.createCard({
      id: "card_a11y_3",
      tier: "task",
      title: "A card waiting on approval",
      status: "planning",
      scopeFiles: ["src/c.ts"],
      acceptanceCriteria: ["Saving a recipe keeps its title"],
      criterionIds: ["card_a11y_3.c1"],
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    firstRun = await teamServer(join(dir, "first-run"));
    team = await teamServer(join(dir, "team"));
    const base = `http://127.0.0.1:${team.server.port}`;
    const headers = { "Content-Type": "application/json", "X-Sekhemet-Action": "1" };
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: readFileSync(join(dir, "team", "identity", "setup-token"), "utf8").trim(),
        name: "Ada Admin",
        email: "ada@northwind.test",
        password: PASSWORD,
      }),
    });
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { csrf } = (await setup.json()) as { csrf: string };
    const invite = await fetch(`${base}/api/invites`, {
      method: "POST",
      headers: { ...headers, Cookie: cookie, "X-Sekhemet-CSRF": csrf },
      body: JSON.stringify({ level: "member" }),
    });
    inviteId = ((await invite.json()) as { id: string }).id;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    await firstRun?.server.close();
    await team?.server.close();
    db?.close();
    firstRun?.db.close();
    team?.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "finds no unnamed control, small target, broken reflow or hover-only information",
    {
      timeout: 300_000,
    },
    async () => {
      const problems: string[] = [];
      const routes = [
        ...NAV_ITEMS.map((n) => n.route),
        "#/card/card_a11y_1",
        "#/card/card_a11y_3",
        "#/account/profile",
        // Configuration's other sections (B4.1, DB-N6-1); Models is its default.
        "#/configuration/benchmark",
        "#/configuration/review",
        "#/configuration/browser",
        "#/configuration/project",
        // The start page (design-stage §2.11, NEW-design-stage-7).
        "#/projects/new",
      ];
      const solo = `http://127.0.0.1:${server.port}`;
      const teamBase = `http://127.0.0.1:${team.server.port}`;
      // Each page and the browser state it is seen in: signed out or signed in.
      const targets: { url: string; as: "out" | "in" }[] = [
        ...routes.map((r) => ({ url: `${solo}/${r}`, as: "out" as const })),
        { url: `http://127.0.0.1:${firstRun.server.port}/#/signin`, as: "out" },
        { url: `${teamBase}/#/signin`, as: "out" },
        { url: `${teamBase}/#/invite/${inviteId}`, as: "out" },
        { url: `${teamBase}/#/account/profile`, as: "in" },
        // B4.11 (DB-N9-14, -15): the Inbox and My issues as a signed-in person sees them.
        { url: `${teamBase}/#/inbox`, as: "in" },
        { url: `${teamBase}/#/my-issues`, as: "in" },
        // B4.11 T5 (DB-N9-16, TEAM-27): Members and Audit as an Admin sees them.
        { url: `${teamBase}/#/members`, as: "in" },
        { url: `${teamBase}/#/audit`, as: "in" },
      ];
      const open = async (width: number, height: number, signedIn: boolean): Promise<Page> => {
        const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
        if (signedIn) {
          // Signed in the way a person is: the Sign in page's form.
          await page.goto(`${teamBase}/#/signin`);
          await page.getByLabel("Email").fill("ada@northwind.test");
          await page.getByLabel("Password").fill(PASSWORD);
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await page.locator("[data-account]").waitFor({ state: "attached" });
        }
        return page;
      };
      for (const width of WIDTHS) {
        const pages = { out: await open(width, 900, false), in: await open(width, 900, true) };
        for (const theme of THEMES) {
          for (const { url, as } of targets) {
            const page = pages[as];
            const route = url.slice(url.indexOf("#"));
            await page.goto(url);
            await page.evaluate((t) => {
              document.documentElement.dataset.theme = t;
            }, theme);
            await page.waitForTimeout(250);
            // Configuration › Models renders after its reads: check it filled in.
            if (url.startsWith(solo) && route === "#/configuration") {
              await page.locator("#cfg-h-roles").waitFor({ timeout: 10_000 });
            }
            // Configuration › Benchmark renders after its reads too.
            if (url.startsWith(solo) && route === "#/configuration/benchmark") {
              await page.locator("#bench-h").waitFor({ timeout: 10_000 });
            }
            // The card waiting on approval shows its criteria and Approve (PM-N7-5).
            if (url.startsWith(solo) && route === "#/card/card_a11y_3") {
              await page.locator("[data-approve]").waitFor({ timeout: 10_000 });
            }
            const at = `${url.startsWith(solo) ? "" : "team "}${route} ${width}px ${theme}`;
            // Injected by evaluation, not a <script> tag: the page's policy
            // (security item 37) refuses inline script, and stays in force here.
            // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
            if (!(await page.evaluate(() => Boolean((window as any).axe)))) {
              // Evaluated as global code (DevTools, outside the page's policy);
              // `undefined` keeps the completion value serializable.
              await page.evaluate(`${AXE_SOURCE}\n;undefined`);
            }
            const axe = await page.evaluate(
              (rules) =>
                // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
                (window as any).axe.run(document, { runOnly: { type: "rule", values: rules } }),
              NAME_RULES,
            );
            for (const v of axe.violations as { id: string; nodes: { target: string[] }[] }[]) {
              for (const n of v.nodes) problems.push(`${at}: ${v.id} ${n.target.join(" ")}`);
            }
            // Phone width: 44×44 targets (WCAG 2.5.5), not only axe's 24 px.
            if (width === 400) {
              const small = await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    "button, a[href], [role=button], input, select, summary",
                  ),
                ]
                  .filter((e) => {
                    const r = e.getBoundingClientRect();
                    const s = getComputedStyle(e);
                    if (r.width === 0 || s.visibility === "hidden" || s.display === "none")
                      return false;
                    // Off screen until focused (the skip link) is not a target yet.
                    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth) return false;
                    // Links inside running text are exempt (WCAG 2.5.5, inline).
                    if (e.tagName === "A" && s.display === "inline") return false;
                    return r.width < 44 || r.height < 44;
                  })
                  .map((e) => {
                    const r = e.getBoundingClientRect();
                    const where = e.closest("[class]:not(:scope)")?.classList[0] ?? "";
                    return `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} in .${where} (${Math.round(r.width)}×${Math.round(r.height)})`;
                  }),
              );
              for (const s of new Set(small)) problems.push(`${at}: target under 44px ${s}`);
            }
            // Information only on hover: a `title` whose text a keyboard, touch or
            // screen-reader user cannot reach. The title may repeat the visible
            // name or accessible description, plus a shortcut in parentheses (the
            // cheat sheet and palette list every shortcut).
            const hoverOnly = await page.evaluate(() =>
              [...document.querySelectorAll("[title]")]
                .filter((e) => {
                  const t = (e.getAttribute("title") ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim();
                  if (!t) return false;
                  const described = (e.getAttribute("aria-describedby") ?? "")
                    .split(/\s+/)
                    .map((id) => document.getElementById(id)?.textContent ?? "")
                    .join(" ");
                  // A control inside a closed disclosure (the sidebar's More) has no
                  // rendered text, so innerText is empty and its own label would
                  // read as hover-only; it cannot be hovered until it is shown, so
                  // it is judged by the text it shows then.
                  const text = e.checkVisibility()
                    ? ((e as HTMLElement).innerText ?? "")
                    : (e.textContent ?? "");
                  const reachable = [
                    e.getAttribute("aria-label") ?? "",
                    e.getAttribute("aria-description") ?? "",
                    described,
                    text,
                  ].join(" ");
                  return !reachable.includes(t);
                })
                .map((e) => `${e.tagName.toLowerCase()}[title="${e.getAttribute("title")}"]`),
            );
            for (const h of new Set(hoverOnly)) problems.push(`${at}: hover-only ${h}`);
          }
        }
        await pages.out.context().close();
        await pages.in.context().close();
      }
      // Reflow at 200% zoom: 1280 px at 200% is a 640 px viewport (WCAG 1.4.10).
      const zoomed = { out: await open(640, 450, false), in: await open(640, 450, true) };
      for (const { url, as } of targets) {
        await zoomed[as].goto(url);
        await zoomed[as].waitForTimeout(250);
        const over = await zoomed[as].evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (over > 1) problems.push(`${url} 200% zoom: scrolls sideways by ${over}px`);
      }
      await zoomed.out.context().close();
      await zoomed.in.context().close();
      expect(problems).toEqual([]);
    },
  );
});
