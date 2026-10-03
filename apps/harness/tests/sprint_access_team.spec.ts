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
 * Who may plan, start and complete a sprint in the Team setup (dashboard
 * DB-N11-1, -2; teams item 6, TEAM-58; DEC-57): a sprint is one project's,
 * so the person's level on that project decides — a Member there may, a
 * Stakeholder or No access there may not, whatever their workspace level.
 * A real Team server over a real SQLite ledger, people signed in (DoD §2A).
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-sprint-team-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-sprint-team-cfg-"));
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  db.close();
  rmSync(root, { recursive: true, force: true });
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

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

async function team() {
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
  const token = readFileSync(join(root, "identity", "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const invited = async (level: string, name: string, email: string) => {
    const id = ((await ok(ada, "POST", "/api/invites", { level, email })) as { id: string }).id;
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  };
  const project = (
    await EventLog.actingFor(ada.principal, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  // A workspace of two projects (DEC-57): no request falls back to an only project.
  await EventLog.actingFor(ada.principal, () =>
    store.ensureProject({ rootPath: join(root, "ledger"), name: "Ledger" }),
  );
  const mo = await invited("member", "Mo Member", "mo@northwind.test");
  const sam = await invited("stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const emails = new Map([
    [mo.principal, "mo@northwind.test"],
    [sam.principal, "sam@northwind.test"],
  ]);
  /** A level change ends the person's sessions: they sign in again at the new level. */
  const level = async (who: Person, to: string): Promise<Person> => {
    await ok(ada, "POST", `/api/members/${who.principal}/level`, { level: to, project });
    return signedIn(
      await call("POST", "/api/session", nobody, {
        email: emails.get(who.principal),
        password: PASSWORD,
      }),
    );
  };
  const sprint = async (name: string) =>
    (
      (await ok(ada, "POST", "/api/cycles", {
        name,
        startsOn: "2026-10-05",
        endsOn: "2026-10-16",
        projectId: project,
      })) as { cycle: { id: string } }
    ).cycle.id;
  return { ada, mo, sam, project, level, sprint };
}

const plan = (project: string, name = "Sprint 9") => ({
  name,
  startsOn: "2026-11-02",
  endsOn: "2026-11-13",
  projectId: project,
});

describe("a sprint's project decides who may plan, start and complete it (DB-N11-1, -2; TEAM-58)", () => {
  it("a workspace Member who is a Stakeholder on the project is refused every sprint write there, and nothing is recorded", async () => {
    const t = await team();
    const s = await t.sprint("Sprint 4");
    const mo = await t.level(t.mo, "stakeholder");
    const before = (await log.getEventsByTypes(["cycle/created", "cycle/started"])).length;
    for (const [method, path, body] of [
      ["POST", "/api/cycles", plan(t.project)],
      ["PATCH", `/api/cycles/${s}`, { goal: "Ship it" }],
      ["POST", `/api/cycles/${s}/start`, {}],
    ] as const) {
      const res = await call(method, path, mo, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    await ok(t.ada, "POST", `/api/cycles/${s}/start`, {});
    const complete = await call("POST", `/api/cycles/${s}/complete`, mo, { carryTo: "backlog" });
    expect(complete.status).toBe(403);
    expect((await log.getEventsByTypes(["cycle/completed"])).length).toBe(0);
    expect((await log.getEventsByTypes(["cycle/created", "cycle/started"])).length).toBe(
      before + 1,
    );
  });

  it("No access on the project refuses them too", async () => {
    const t = await team();
    const s = await t.sprint("Sprint 4");
    const mo = await t.level(t.mo, "none");
    expect((await call("POST", "/api/cycles", mo, plan(t.project))).status).toBe(403);
    expect((await call("POST", `/api/cycles/${s}/start`, mo, {})).status).toBe(403);
  });

  it("a workspace Stakeholder who is a Member on the project may plan, start and complete its sprints", async () => {
    const t = await team();
    expect((await call("POST", "/api/cycles", t.sam, plan(t.project))).status).toBe(403);
    const sam = await t.level(t.sam, "member");
    const made = (await ok(sam, "POST", "/api/cycles", plan(t.project))) as {
      cycle: { id: string };
    };
    await ok(sam, "POST", `/api/cycles/${made.cycle.id}/start`, {});
    await ok(sam, "POST", `/api/cycles/${made.cycle.id}/complete`, { carryTo: "backlog" });
    const [done] = await log.getEventsByTypes(["cycle/completed"]);
    expect(done?.principal).toBe(t.sam.principal);
  });
});
