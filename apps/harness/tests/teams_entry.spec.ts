import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type Place, freePort, place, runCli, spawnCli, writeFile } from "./support/cli_spawn.js";
import { type SeededBoard, openContext, seedBoard } from "./support/dashboard_seed.js";

// Teams through its doors (C2d, FINDINGS_C1 TST-01): Solo's `serve` spawned
// and probed from outside (TEAM-1); a Team `serve` spawned, its credential
// routes driven over HTTP, then `backup` and `export` run from the command
// line (TEAM-11); the people picker in Chromium (TEAM-17); a suggestion
// dismissed over HTTP (TEAM-19). Real SQLite, real git, no model loaded.

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

async function workspace(p: Place): Promise<string> {
  git(p.repo, "init", "-q", "-b", "main");
  writeFile(p.repo, "src/a.ts", "export const a = 0;\n");
  writeFile(p.repo, ".gitignore", ".sekhemet/\n");
  git(p.repo, "add", "-A");
  git(p.repo, "commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(p.repo);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "task",
    title: "Write a",
    status: "ready",
    scopeFiles: ["src/a.ts"],
  });
  db.close();
  return p.repo;
}

/** This machine's first address that is not loopback, if it has one. */
function outsideAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return undefined;
}

const reachable = (host: string, port: number) =>
  new Promise<boolean>((ok) => {
    const s = createConnection({ host, port });
    s.once("connect", () => {
      s.destroy();
      ok(true);
    });
    s.once("error", () => ok(false));
    s.setTimeout(2000, () => {
      s.destroy();
      ok(false);
    });
  });

describe("Solo binds loopback only and is the operating-system user (TEAM-1)", () => {
  it(
    "TEAM-1: Solo serve binds loopback only, shows no sign-in, and records every write as the local person's principal",
    { timeout: 120_000 },
    async () => {
      const p = place();
      const repo = await workspace(p);
      const port = await freePort();
      // Asked for every address, Solo refuses: loopback only.
      const wide = await runCli(["serve", "--port", String(port), "--host", "0.0.0.0"], p, {
        timeoutMs: 30_000,
      });
      expect(wide.code).not.toBe(0);
      expect(wide.out).toMatch(/loopback/i);
      const s = spawnCli(["serve", "--port", String(port)], p);
      const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/)) as RegExpMatchArray;
      const bound = Number(new URL(url as string).port);
      expect(await reachable("127.0.0.1", bound)).toBe(true);
      const outside = outsideAddress();
      if (outside) expect(await reachable(outside, bound)).toBe(false);
      // No sign-in: the session is already the local person, an Admin, and the board answers.
      const { db: readDb, log: readLog } = openLocalLedger(repo);
      const local = readLog.localPrincipal();
      readDb.close();
      const session = (await (await fetch(`${url}/api/session`)).json()) as {
        mode?: string;
        principal?: string;
        level?: string;
      };
      expect(session).toMatchObject({ mode: "solo", principal: local, level: "admin" });
      expect((await fetch(`${url}/api/board`)).status).toBe(200);
      // A write from the dashboard is recorded as that person, with no sign-in.
      const before = (() => {
        const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
        const n = (db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
        db.close();
        return n;
      })();
      const patch = await fetch(`${url}/api/cards/c1`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(await pageWriteHeaders(url as string)) },
        body: JSON.stringify({ priority: 2 }),
      });
      expect(patch.status).toBe(200);
      await s.stop();
      const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
      const written = db
        .prepare("SELECT type, principal FROM events WHERE seq > ? AND actor = 'human'")
        .all(before) as { type: string; principal: string | null }[];
      db.close();
      expect(written.length).toBeGreaterThan(0);
      for (const e of written) expect(e.principal, e.type).toBe(local);
    },
  );
});

describe("the credential store, from the routes to the backup (TEAM-11)", () => {
  it(
    "TEAM-11: credentials created, used and revoked are recorded without the credential or its hash; the hash is only in the 0600 store, in the backup and in no export",
    { timeout: 180_000 },
    async () => {
      const p = place();
      const repo = await workspace(p);
      const team = join(p.root, "team.toml");
      writeFileSync(team, '[team]\nmode = "team"\nworkspace = "Northwind"\n');
      const env = { SEKHEMET_USER_CONFIG: team };
      const s = spawnCli(["serve", "--port", String(await freePort())], p, { env });
      const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000)) as RegExpMatchArray;
      const tokenFile = (s.out().match(/Setup token written to (\S+?setup-token)/) ??
        [])[1] as string;
      expect(tokenFile).toBeTruthy();
      const PASSWORD = "correct horse battery staple, kept";
      const call = (
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) =>
        fetch(`${url}${path}`, {
          method,
          headers: { "content-type": "application/json", "X-Sekhemet-Action": "1", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      // Created: the first Admin's password, through the setup token.
      const setup = await call(
        "POST",
        "/api/setup",
        {},
        {
          token: readFileSync(tokenFile, "utf8").trim(),
          name: "Ada Admin",
          email: "ada@northwind.test",
          password: PASSWORD,
        },
      );
      expect(setup.status).toBe(200);
      const signed = (await setup.json()) as { csrf: string };
      const ada = {
        Cookie: (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
        "X-Sekhemet-CSRF": signed.csrf,
      };
      // Created: a personal token; used: a request with it; revoked.
      const made = await call("POST", "/api/tokens", ada, { name: "laptop cli" });
      expect(made.status).toBe(200);
      const pat = (await made.json()) as { id: string; token: string };
      const used = await fetch(`${url}/api/session`, {
        headers: { Authorization: `Bearer ${pat.token}` },
      });
      expect(await used.json()).toMatchObject({ signedIn: true, via: "token", level: "admin" });
      expect((await call("DELETE", `/api/tokens/${pat.id}`, ada)).status).toBe(200);
      await s.stop();
      // The store: 0600, beside the workspace's identity, never inside events.db.
      const storeDir = tokenFile.replace(/\/setup-token$/, "");
      const storeFile = join(storeDir, "credentials.json");
      expect(statSync(storeFile).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(readFileSync(storeFile, "utf8")) as {
        passwords: Record<string, { hash: string }>;
        tokens: Record<string, { hash: string }>;
      };
      const secrets = [
        ...Object.values(stored.passwords).map((x) => x.hash),
        ...Object.values(stored.tokens).map((x) => x.hash),
        pat.token,
        PASSWORD,
      ].filter(Boolean);
      expect(secrets.length).toBeGreaterThanOrEqual(3);
      // The events say what happened, and carry none of it.
      const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
      const rows = db.prepare("SELECT type, payload FROM events").all() as {
        type: string;
        payload: string;
      }[];
      db.close();
      const types = rows.map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["token/created", "token/revoked"]));
      const ledgerText = rows.map((r) => r.payload).join("\n");
      const raw = readFileSync(join(repo, ".sekhemet", "events.db")).toString("latin1");
      for (const secret of secrets) {
        expect(ledgerText).not.toContain(secret);
        expect(raw).not.toContain(secret);
      }
      // In every backup, at 0600.
      const backup = await runCli(["backup"], p, { env, timeoutMs: 60_000 });
      expect(backup.code).toBe(0);
      const backups = join(p.home, ".sekhemet", "backups");
      const files = readdirSync(backups, { recursive: true, encoding: "utf8" });
      const kept = files.filter((f) => /credentials/.test(f));
      expect(kept.length).toBeGreaterThan(0);
      for (const f of kept)
        if (statSync(join(backups, f)).isFile())
          expect(statSync(join(backups, f)).mode & 0o777).toBe(0o600);
      // In no export.
      const exported = await runCli(["export", "--ledger"], p, { env, timeoutMs: 60_000 });
      expect(exported.code).toBe(0);
      expect(exported.out.length).toBeGreaterThan(0);
      for (const secret of secrets) expect(exported.out).not.toContain(secret);
    },
  );
});

describe("the people picker in Chromium (TEAM-17)", () => {
  let seed: SeededBoard;
  let server: { port: number; close: () => Promise<void> };
  let browser: Browser;

  beforeAll(async () => {
    seed = await seedBoard("sek-teams-picker-");
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    seed?.cleanup();
  });

  it(
    "TEAM-17: the assignee picker lists the people under Members, and the Agent and Seshat apart under AI teammates with the AI badge",
    { timeout: 60_000 },
    async () => {
      const { page } = await openContext(browser, 1440, { project: seed.project });
      await page.goto(`http://127.0.0.1:${server.port}/#/board`);
      await page.locator("#tile-card_bk1").focus();
      await page.keyboard.press("Shift+A");
      const menu = page.locator(".picker-menu");
      await menu.waitFor();
      const rows = await menu.locator("[role=option]").evaluateAll((os) =>
        os.map((o) => {
          // The group heading drawn above the first option of its group.
          let h: Element | null = o.previousElementSibling;
          while (h && h.getAttribute("role") === "option") h = h.previousElementSibling;
          return {
            label:
              (o.querySelector(".pl-t, .pl") as HTMLElement | null)?.innerText.split("\n")[0] ?? "",
            group: h?.textContent?.trim() ?? "",
            badge: o.querySelector(".ai-badge") !== null,
            disabled: o.getAttribute("aria-disabled") === "true",
          };
        }),
      );
      const agent = rows.find((r) => /^Agent/.test(r.label));
      const seshat = rows.find((r) => /^Seshat/.test(r.label));
      expect(agent).toMatchObject({ group: "AI teammates", badge: true, disabled: false });
      expect(seshat).toMatchObject({ group: "AI teammates", badge: true, disabled: true });
      const people = rows.filter((r) => r.group === "Members");
      expect(people.length).toBeGreaterThan(0);
      for (const person of people) expect(person.badge).toBe(false);
      // The AI teammates are never listed among the people.
      expect(people.some((r) => /^(Agent|Seshat)/.test(r.label))).toBe(false);
      await page.context().close();
    },
  );
});

describe("a dismissed suggestion over HTTP (TEAM-19)", () => {
  let seed: SeededBoard;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  /** What Seshat proposes next: the same labels as before, or another value. */
  let labels = ["bug"];

  beforeAll(async () => {
    seed = await seedBoard("sek-teams-dismiss-");
    const seshat = (): LocalInferenceAdapter => ({
      modelId: "seshat-stand-in",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
      generate: async () => ({
        text: "Here is what I found.",
        toolCalls: [
          {
            id: "1",
            name: "propose_update_card",
            arguments: { card_id: "card_td1", labels, reason: "it crashes on load" },
          } as ToolCall,
        ],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
    });
    server = await startDashboardServer({
      db: seed.db,
      log: seed.log,
      boardService: new BoardServiceImpl(seed.store),
      cardStore: seed.store,
      repoPath: seed.dir,
      port: 0,
      streamIntervalMs: 100,
      pressureLevel: () => 1,
      pmAdapter: seshat,
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    seed?.cleanup();
  });

  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify(body),
    });
  const replies = async () =>
    (
      (await (await fetch(`${base}/api/pm/thread`)).json()) as {
        messages: { role: string; state?: string }[];
      }
    ).messages.filter((m) => m.role === "pm" && m.state === "done").length;
  /** The person asks Seshat; resolves once the reply is recorded. */
  async function ask(text: string): Promise<void> {
    const n = await replies();
    expect((await post("/api/pm/messages", { text, context: { cardId: "card_td1" } })).status).toBe(
      200,
    );
    await expect.poll(replies, { timeout: 15_000 }).toBeGreaterThan(n);
  }
  const open = async () =>
    (
      (await (await fetch(`${base}/api/cards/card_td1/suggestions`)).json()) as {
        suggestions: { id: string; kind: string; value: unknown; state?: string }[];
      }
    ).suggestions.filter((x) => (x.state ?? "open") === "open");

  it(
    "TEAM-19: a dismissed suggestion is not proposed again on that issue; another value still is",
    { timeout: 60_000 },
    async () => {
      await ask("Triage this one");
      const [first] = await open();
      expect(first).toMatchObject({ kind: "label" });
      expect((await post(`/api/suggestions/${first?.id}/dismiss`, {})).status).toBe(200);
      expect(await open()).toEqual([]);
      // The same change, asked again: not proposed.
      await ask("Triage it again");
      expect(await open()).toEqual([]);
      // The same property with another value is a different change: proposed.
      labels = ["performance"];
      await ask("And now?");
      const again = await open();
      expect(again.length).toBe(1);
      expect(again[0]).toMatchObject({ kind: "label" });
      expect(JSON.stringify(again[0]?.value)).toContain("performance");
    },
  );
});
