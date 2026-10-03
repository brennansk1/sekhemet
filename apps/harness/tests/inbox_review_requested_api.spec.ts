import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * FINDINGS TEAM-01 (C2b) over HTTP on a real Team server with real SQLite
 * (DoD §2A): an Inbox row is under *Review requested* only while its issue
 * waits in In review. Once the issue leaves review — accepted, back in To
 * do, on hold, Won't do — the row is resolved to *Watching*, in the board's
 * column words, never left asking for a review that is over.
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let cfgDir: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;
const testUserConfig = process.env.SEKHEMET_USER_CONFIG;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-leave-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  cfgDir = mkdtempSync(join(tmpdir(), "sek-leave-cfg-"));
  process.env.SEKHEMET_CONFIG_DIR = cfgDir;
  process.env.SEKHEMET_USER_CONFIG = join(cfgDir, "config.toml");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: root,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
    identity: {
      dir: join(root, "identity"),
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  if (testUserConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
  else process.env.SEKHEMET_USER_CONFIG = testUserConfig;
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

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

async function join_(ada: Person, name: string, email: string): Promise<Person> {
  const made = await call("POST", "/api/invites", ada, { level: "member", email });
  const { id } = (await made.json()) as { id: string };
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

type Inbox = {
  items: {
    id: string;
    reason: string;
    cardId?: string;
    change?: { type: string; status?: string };
  }[];
};

async function reviewerSetup() {
  const token = readFileSync(join(root, "identity", "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const mo = await join_(ada, "Mo Member", "mo@northwind.test");
  const project = (
    await EventLog.actingFor(ada.principal, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  // Mo is the project's Accept rule: the person asked to review its issues.
  expect(
    (await call("PATCH", `/api/projects/${project}/settings`, ada, { accept_rule: [mo.principal] }))
      .status,
  ).toBe(200);
  return { ada, mo, project };
}

describe("TEAM-01: Review requested only while the issue waits in In review", () => {
  it("files the row under Review requested in review, and resolves it to Watching once the issue leaves", async () => {
    const { mo, project } = await reviewerSetup();
    for (const [id, to] of [
      ["c_done", "done"],
      ["c_back", "ready"],
      ["c_hold", "parked"],
      ["c_wont", "rejected"],
      ["c_wait", undefined],
    ] as const) {
      await store.createCard({
        id,
        tier: "story",
        title: `Issue ${id}`,
        projectId: project,
        status: "ready",
      });
      await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
      if (to) await store.updateCardStatus(id, to, "moved on", "harness", { override: true });
    }
    const inbox = (await (await call("GET", "/api/inbox?filter=inbox", mo)).json()) as Inbox;
    const reasonOf = (id: string) => inbox.items.find((i) => i.cardId === id)?.reason;
    expect(reasonOf("c_wait")).toBe("review_requested");
    for (const id of ["c_done", "c_back", "c_hold", "c_wont"])
      expect(reasonOf(id), id).toBe("watching");
  });
});
