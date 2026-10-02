import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type StatusFacts, forecastWords, requirementsWords } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { standupBody } from "../src/pm/agent.js";
import { buildSnapshot } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";
import { userPaths } from "../src/user_dir.js";
import { soloPersonName } from "../src/workspaces.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * C2a, the status-shell builder's server half, over HTTP against real
 * servers on real SQLite files (DEFINITION_OF_DONE §2A):
 * - DEC-57's workspace list (runtime item 23c, RUN-84..86; kernel K-N12-1):
 *   `GET`, `POST` and `DELETE /api/workspaces`, Solo's whole list and a
 *   Team server's own entry alone;
 * - SHL-02: Solo's person is named from git's `user.name`, never a principal;
 * - STA-01: Status and Seshat's /status say one forecast and one count of
 *   requirements done; STA-02: Status is about the project the page asks
 *   for, and Needs you follows the Accept rule (`mayAccept`, `accepters`).
 * No model is loaded.
 */

type Server = { port: number; close: () => Promise<void> };

const workspacesFile = () => userPaths().workspaces;

describe("Solo: the workspace list, the person's name and Status's facts", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: Server;
  let base: string;
  let headers: Record<string, string>;
  let chronicle: string;
  let storefront: string;

  beforeAll(async () => {
    rmSync(workspacesFile(), { force: true });
    dir = mkdtempSync(join(tmpdir(), "sek-status-shell-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir });
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    chronicle = (await store.ensureProject({ name: "Chronicle", rootPath: dir })).id;
    storefront = (await store.ensureProject({ name: "Storefront", rootPath: join(dir, "shop") }))
      .id;
    await store.createCard({
      tier: "task",
      title: "Hasher",
      status: "ready",
      projectId: chronicle,
    });
    await store.createCard({ tier: "task", title: "Cart", status: "ready", projectId: storefront });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
    });
    base = `http://127.0.0.1:${server.port}`;
    headers = { ...(await pageWriteHeaders(base)), "Content-Type": "application/json" };
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it("SHL-02: names Solo's person from git's user.name, never a principal", async () => {
    const s = await get("/api/session");
    expect(s.body.name).toBe("Ada Lovelace");
    expect(soloPersonName(undefined, "ada")).toBe("ada");
    expect(soloPersonName("  ", "")).toBeUndefined();
  });

  it("RUN-84, RUN-85: writes its own entry at start and lists the machine's workspaces, the current one marked", async () => {
    const r = await get("/api/workspaces");
    expect(r.status).toBe(200);
    const id = log.workspaceId();
    expect(id).toMatch(/^ws_[0-9a-f]{12}$/);
    expect(r.body.current).toBe(id);
    expect(r.body.complete).toBe(true);
    const own = (r.body.workspaces as Record<string, unknown>[]).find((w) => w.id === id);
    expect(own).toMatchObject({
      id,
      address: base,
      setup: "solo",
      folder: dir,
      // Each project's root as the store keeps it (its real path).
      projectRoots: store
        .listProjects()
        .map((p) => p.rootPath)
        .sort(),
    });
    expect(typeof own?.name).toBe("string");
    const file = JSON.parse(readFileSync(workspacesFile(), "utf8")) as { workspaces: unknown[] };
    expect(file.workspaces.some((w) => (w as { id: string }).id === id)).toBe(true);
  });

  it("RUN-85: Add a workspace by address and Remove it; the current one is never removed", async () => {
    const before = log.lastSeq();
    expect((await send("POST", "/api/workspaces", { address: "javascript:alert(1)" })).status).toBe(
      400,
    );
    const added = await send("POST", "/api/workspaces", { address: "http://10.0.0.7:7420/" });
    expect(added.status).toBe(200);
    const entry = added.body.workspace as { id: string; address: string; name: string };
    expect(entry).toMatchObject({ address: "http://10.0.0.7:7420", name: "10.0.0.7:7420" });
    const listed = (await get("/api/workspaces")).body.workspaces as { id: string }[];
    expect(listed.map((w) => w.id)).toContain(entry.id);
    expect((await send("DELETE", `/api/workspaces/${entry.id}`)).status).toBe(200);
    expect(
      ((await get("/api/workspaces")).body.workspaces as { id: string }[]).map((w) => w.id),
    ).not.toContain(entry.id);
    expect((await send("DELETE", `/api/workspaces/${log.workspaceId()}`)).status).toBe(409);
    // A convenience, like bookmarks: it records nothing on the ledger.
    expect(log.lastSeq()).toBe(before);
  });

  it("RUN-86: an unreadable list changes nothing else, and the server's own entry comes back", async () => {
    writeFileSync(workspacesFile(), "{not json");
    const before = log.lastSeq();
    const r = await get("/api/workspaces");
    expect(r.status).toBe(200);
    expect((r.body.workspaces as { id: string }[]).map((w) => w.id)).toEqual([log.workspaceId()]);
    expect((await get("/api/board")).status).toBe(200);
    expect(log.lastSeq()).toBe(before);
  });

  it("STA-02: Status is about the project the page asks for, and Solo's person may accept", async () => {
    const facts = (await get(`/api/status?project=${storefront}`)).body.facts as StatusFacts;
    expect(facts.project).toEqual({ id: storefront, name: "Storefront" });
    expect(facts.mayAccept).toBe(true);
    expect(facts.forecast.remaining).toBe(1);
  });

  it("STA-01: Seshat's /status says Status's forecast and requirements done in the same words", async () => {
    const facts = (await get(`/api/status?project=${chronicle}`)).body.facts as StatusFacts;
    const snap = await buildSnapshot(dir, store, new PmStore(log), "stand-in");
    const said = standupBody(snap);
    // One project would be the whole workspace: the server reads the forecast the same way.
    const all = (await get("/api/status")).body.facts as StatusFacts | undefined;
    expect(all?.project ?? null).toBeNull();
    expect(said).toContain(`Forecast: ${forecastWords(all?.forecast, Date.now()).value}.`);
    expect(facts.forecast.minimum).toBe(5);
    expect(said).not.toMatch(/day\(s\)/);
    const map = (await get(`/api/story-map/${chronicle}`)).body as {
      slices?: Parameters<typeof requirementsWords>[0];
    };
    if (map.slices?.length) expect(said).toContain(requirementsWords(map.slices).value);
  });
});

describe("Team: the workspace list is the server's own, and Needs you follows the Accept rule", () => {
  let root: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: Server;
  let base: string;
  const PASSWORD = "correct horse battery staple";

  interface Person {
    principal: string;
    headers: Record<string, string>;
  }
  const nobody: Person = { principal: "", headers: {} };
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

  let ada: Person;
  let mo: Person;
  let project: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sek-status-shell-team-"));
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
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
      identity: {
        dir: join(root, "identity"),
        passwordList: join(root, "list.txt"),
        settings: identitySettings({ mode: "team", workspace: "Northwind" }),
      },
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    const token = readFileSync(join(root, "identity", "setup-token"), "utf8").trim();
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
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
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
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("RUN-85: answers its own entry alone, and refuses Add and Remove", async () => {
    const r = await call("GET", "/api/workspaces", mo);
    const body = (await r.json()) as { current: string; complete: boolean; workspaces: unknown[] };
    expect(r.status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.workspaces).toEqual([
      expect.objectContaining({ id: body.current, name: "Northwind", setup: "team" }),
    ]);
    expect((await call("POST", "/api/workspaces", ada, { address: "http://x.test" })).status).toBe(
      403,
    );
    expect((await call("DELETE", `/api/workspaces/${body.current}`, ada)).status).toBe(403);
  });

  it("STA-02: with no Accept rule the Admins accept; a Member is told who", async () => {
    const asMo = (await (await call("GET", `/api/status?project=${project}`, mo)).json()) as {
      facts: StatusFacts;
    };
    expect(asMo.facts.mayAccept).toBe(false);
    expect(asMo.facts.accepters).toEqual(["Ada Admin"]);
    const asAda = (await (await call("GET", `/api/status?project=${project}`, ada)).json()) as {
      facts: StatusFacts;
    };
    expect(asAda.facts.mayAccept).toBe(true);
  });
});
