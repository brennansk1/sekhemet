import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

// DB-N21-3's refusal end to end, on a real Team server with a recorded
// Accept rule (NEW-dashboard-21; teams item 7): a Done issue's Revert is
// disabled for a Member the rule does not name, and says who may — the
// names the review desk computes from the rule (`revertVerdict`) — and the
// server refuses that Member's revert through the access table, changing
// nothing; the person the rule names reverts it. A real Chromium, a real
// repository and a real ledger; no model is loaded.

const PASSWORD = "correct horse battery staple";
type Person = { principal: string; headers: Record<string, string> };
const nobody: Person = { principal: "", headers: {} };

describe("Revert on a Team server with an Accept rule (DB-N21-3)", () => {
  let repo: string;
  let cfg: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;
  let base: string;
  let ada: Person;
  let mo: Person;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
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

  /** An issue built and checked, in Review, in the project. */
  async function builtInReview(id: string, title: string, file: string): Promise<void> {
    const adapter = new NodeGitSyncAdapter(repo);
    await store.createCard({
      id,
      tier: "story",
      title,
      scopeFiles: ["src/**"],
      projectId: project,
    });
    const wt = await adapter.createWorktree(id, "main", title);
    write(wt, file, `export const v = "${id}";\n`);
    await adapter.commitCheckpoint({
      cardId: id,
      step: 1,
      gateStatus: "pass",
      agentModel: "stand-in",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const evidence = {
      id: `ev_${id}`,
      cardId: id,
      attempt: 1,
      passed: true,
      rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
      filesTouched: [file],
      linesAdded: 1,
      linesRemoved: 0,
      diff: "",
      settings: { modelId: "stand-in" },
      stopReason: "gate_passed",
      repoState: await adapter.getRepoStateHash(id),
    };
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(join(repo, ".sekhemet", "evidence", `ev_${id}.json`), body);
    writeFileSync(join(repo, ".sekhemet", "evidence", `latest-${id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "stand-in",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: `ev_${id}`,
      path: join(".sekhemet", "evidence", `ev_${id}.json`),
      body,
      filesTouched: [file],
    });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-revert-team-ui-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Jane Doe");
    git("config", "user.email", "jane@example.com");
    write(repo, "src/a.ts", "export const a = 1;\n");
    write(repo, ".gitignore", ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    cfg = mkdtempSync(join(tmpdir(), "sek-revert-team-cfg-"));
    vi.stubEnv("SEKHEMET_CONFIG_DIR", cfg);
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(cfg, "config.toml"));
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db, { setup: "team" });
    store = new CardStore(db, log);
    writeFileSync(join(repo, ".sekhemet", "list.txt"), "passwordpassword1\n");
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 1000,
      pressureLevel: () => 1,
      identity: {
        dir: join(repo, ".sekhemet", "identity"),
        passwordList: join(repo, ".sekhemet", "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    const token = readFileSync(join(repo, ".sekhemet", "identity", "setup-token"), "utf8").trim();
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
        store.ensureProject({ rootPath: repo, name: "Chronicle" }),
      )
    ).id;
    const invite = await call("POST", "/api/invites", ada, {
      level: "member",
      email: "mo@northwind.test",
    });
    const id = ((await invite.json()) as { id: string }).id;
    mo = await signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, {
        name: "Mo Member",
        email: "mo@northwind.test",
        password: PASSWORD,
      }),
    );
    // The project's Accept rule names Ada alone (teams item 7).
    const rule = await call("PATCH", `/api/projects/${project}/settings`, ada, {
      accept_rule: [ada.principal],
    });
    expect(rule.status, await rule.clone().text()).toBe(200);
    await builtInReview("card_done", "Export a week's entries as CSV", "src/csv.ts");
    expect(
      (await call("POST", "/api/cards/card_done/opened", ada, { filesShown: ["src/csv.ts"] }))
        .status,
    ).toBe(200);
    const accepted = await call("POST", "/api/cards/card_done/accept", ada, {});
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await browser?.close();
    await server?.close();
    db?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  });

  it(
    "disables Revert for a Member the rule does not name, saying who may, and the server refuses that revert",
    {
      timeout: 60_000,
    },
    async () => {
      // The review desk's verdict, computed from the recorded rule.
      const desk = (await (await call("GET", "/api/cards/card_done/review", mo)).json()) as {
        revert?: { may: boolean; who?: { name: string }[] };
      };
      expect(desk.revert).toMatchObject({ may: false, who: [{ name: "Ada Admin" }] });

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/#/signin`);
      await page.getByLabel("Email").fill("mo@northwind.test");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.locator("[data-account]").waitFor({ state: "attached" });
      await page.goto(`${base}/#/card/card_done`);
      await page.locator(".cv-h .ttl").waitFor();
      await page.locator(".cv-h [data-issue-more]").click();
      const item = page.locator('.ia-menu [data-ia="revert"]');
      await item.waitFor();
      expect(await item.isDisabled()).toBe(true);
      expect(await page.locator("#ia-why-revert").innerText()).toBe(
        "Only Ada Admin can revert it: the Accept rule names them.",
      );
      await ctx.close();

      // The route refuses Mo through the access table, and nothing changes.
      const head = git("rev-parse", "main");
      const refused = await call("POST", "/api/cards/card_done/revert", mo, {
        reason: "Not wanted",
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { permission?: string }).permission).toBe("accept");
      expect(git("rev-parse", "main")).toBe(head);
      expect((await store.getCard("card_done"))?.status).toBe("done");

      // Ada, whom the rule names, reverts it.
      const reverted = await call("POST", "/api/cards/card_done/revert", ada, {
        reason: "Not wanted",
      });
      expect(reverted.status, await reverted.clone().text()).toBe(200);
      expect(git("rev-parse", "main")).not.toBe(head);
      expect((await store.getCard("card_done"))?.status).toBe("ready");
    },
  );
});
