import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { Presence } from "../src/team/presence.js";
import { identitySettings } from "../src/team/settings.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * B4.11, teams NEW-teams-9 (item 26; TEAM-26) and dashboard DB-N9-20, on a
 * real Team server with people signed in at different levels (DoD §2A):
 * people viewing the same issue see each other's avatars within 5 seconds,
 * a card someone is dragging shows theirs, and a member active in the last
 * 5 minutes is known — all in memory over the live stream, and nothing
 * about it is ever written to the event log.
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;
const aborts: AbortController[] = [];

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-presence-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-presence-cfg-"));
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
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
    pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    identity: {
      dir: join(root, "identity"),
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

const call = async (method: string, path: string, who: Person, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(await pageWriteHeaders(base)),
      ...who.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function signedIn(res: Response): Promise<Person> {
  const body = (await res.json()) as { principal: string; csrf: string; error?: string };
  expect(res.status, body.error).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
}

async function invited(by: Person, level: string, name: string, email: string) {
  const res = await call("POST", "/api/invites", by, { level, email });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

/** A person's live stream, read frame by frame. */
async function streamOf(who: Person) {
  const controller = new AbortController();
  aborts.push(controller);
  const res = await fetch(`${base}/api/stream`, {
    headers: who.headers,
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    /** The next `presence` frame whose data satisfies `until`, within 5 s. */
    async presence(until: (d: PresenceFrame) => boolean): Promise<PresenceFrame> {
      const deadline = Date.now() + 5000;
      for (;;) {
        for (;;) {
          const m = /event: presence\ndata: (.*)\n\n/.exec(text);
          if (!m) break;
          text = text.slice((m.index ?? 0) + m[0].length);
          const d = JSON.parse(m[1] as string) as PresenceFrame;
          if (until(d)) return d;
        }
        if (Date.now() > deadline) throw new Error("no presence frame within 5 s");
        const next = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
          ),
        ]);
        if (next.value) text += decoder.decode(next.value);
      }
    },
  };
}

interface Face {
  principal: string;
  name: string;
  initials: string;
}
interface PresenceFrame {
  issues: Record<string, Face[]>;
  dragging: Record<string, Face[]>;
}

async function team() {
  await start();
  const token = readFileSync(join(root, "identity", "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const project = (
    await EventLog.actingFor(ada.principal, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
  const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  const card = (
    await EventLog.actingFor(ada.principal, () =>
      store.createCard({ tier: "task", title: "Login", status: "ready", projectId: project }),
    )
  ).id;
  return { ada, mo, lee, vic, project, card };
}

describe("TEAM-26, DB-N9-20: people viewing the same issue see each other within 5 seconds", () => {
  it("pushes each viewer's avatar to the others over the stream, and writes nothing to the event log", async () => {
    const t = await team();
    const before = (await log.getLastEvent())?.seq;
    const mo = await streamOf(t.mo);

    const opened = Date.now();
    const lee = (await ok(t.lee, "POST", "/api/presence", { tab: "lee-1", issue: t.card })) as {
      viewers: Face[];
    };
    expect(lee.viewers.map((v) => v.name)).toEqual(["Lee Lead"]);
    const seen = await mo.presence((d) => (d.issues[t.card] ?? []).length > 0);
    expect(Date.now() - opened).toBeLessThan(5000);
    expect(seen.issues[t.card]).toEqual([
      { principal: t.lee.principal, name: "Lee Lead", initials: "LL" },
    ]);

    // Mo opens it too: the reply names both, and a Viewer reads the same.
    const both = (await ok(t.mo, "POST", "/api/presence", { tab: "mo-1", issue: t.card })) as {
      viewers: Face[];
    };
    expect(both.viewers.map((v) => v.name)).toEqual(["Lee Lead", "Mo Member"]);
    const read = (await ok(t.vic, "GET", `/api/presence?issue=${t.card}`)) as {
      viewers: Face[];
      active: string[];
    };
    expect(read.viewers.map((v) => v.initials)).toEqual(["LL", "MM"]);
    // Active in the last 5 minutes: whoever announced themselves.
    expect(read.active.sort()).toEqual([t.lee.principal, t.mo.principal].sort());

    // A second tab of the same person is one avatar; leaving in one tab keeps the other.
    await ok(t.lee, "POST", "/api/presence", { tab: "lee-2", issue: t.card });
    await ok(t.lee, "POST", "/api/presence", { tab: "lee-1", issue: null });
    const still = (await ok(t.vic, "GET", `/api/presence?issue=${t.card}`)) as { viewers: Face[] };
    expect(still.viewers.map((v) => v.name)).toEqual(["Lee Lead", "Mo Member"]);
    await ok(t.lee, "POST", "/api/presence", { tab: "lee-2", issue: null });
    const left = await mo.presence((d) =>
      (d.issues[t.card] ?? []).every((f) => f.principal !== t.lee.principal),
    );
    expect(left.issues[t.card]?.map((f) => f.name)).toEqual(["Mo Member"]);

    // Nothing about presence is on the ledger. The only entries since are
    // Smart Swap's once-per-5-minutes record that a person is using the
    // dashboard at all (models rule 20e, `session/active`, written for any
    // request): no issue, no tab, no drag.
    const since = await log.getEvents((before ?? 0) + 1, 1000);
    expect([...new Set(since.map((e) => e.type))]).toEqual(["session/active"]);
    for (const e of since) expect(e.payload).toEqual({ via: "session" });
    expect(new Set(since.map((e) => e.principal)).size).toBe(since.length);
    expect(JSON.stringify(since)).not.toContain(t.card);
  });

  it("a card someone is dragging shows their avatar to the others", async () => {
    const t = await team();
    const vic = await streamOf(t.vic);
    await ok(t.mo, "POST", "/api/presence", { tab: "mo-b", dragging: t.card });
    const moving = await vic.presence((d) => (d.dragging[t.card] ?? []).length > 0);
    expect(moving.dragging[t.card]).toEqual([
      { principal: t.mo.principal, name: "Mo Member", initials: "MM" },
    ]);
    await ok(t.mo, "POST", "/api/presence", { tab: "mo-b", dragging: null });
    const dropped = await vic.presence((d) => !d.dragging[t.card]);
    expect(dropped.dragging).toEqual({});
  });

  it("refuses an issue that is not there, a malformed tab, and a write from outside the page", async () => {
    const t = await team();
    expect((await call("POST", "/api/presence", t.mo, { tab: "x", issue: "nope" })).status).toBe(
      404,
    );
    expect(
      (await call("POST", "/api/presence", t.mo, { tab: "<script>", issue: t.card })).status,
    ).toBe(400);
    const outside = await fetch(`${base}/api/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: t.mo.headers.Cookie as string },
      body: JSON.stringify({ tab: "x", issue: t.card }),
    });
    expect(outside.status).toBeGreaterThanOrEqual(400);
    const read = (await ok(t.vic, "GET", `/api/presence?issue=${t.card}`)) as { viewers: Face[] };
    expect(read.viewers).toEqual([]);
  });
});

describe("Solo has no presence (teams item 1)", () => {
  it("records nothing and pushes no presence frame", async () => {
    db.close();
    db = new DatabaseSync(join(root, ".sekhemet", "solo.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
    const card = (await store.createCard({ tier: "task", title: "Solo work", status: "ready" })).id;
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
      identity: { dir: join(root, "solo-identity"), settings: identitySettings({ mode: "solo" }) },
    });
    vi.mocked(console.log).mockRestore();
    base = `http://127.0.0.1:${server.port}`;
    const controller = new AbortController();
    aborts.push(controller);
    const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    void (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          text += new TextDecoder().decode(next.value);
        }
      } catch {
        // Aborted at the end.
      }
    })();
    const posted = await call("POST", "/api/presence", nobody, { tab: "solo1", issue: card });
    expect(posted.status).toBe(200);
    const read = (await (await call("GET", `/api/presence?issue=${card}`, nobody)).json()) as {
      viewers: unknown[];
      active: unknown[];
    };
    expect(read).toEqual({ viewers: [], active: [] });
    await new Promise((r) => setTimeout(r, 200));
    expect(text).not.toContain("event: presence");
  });
});

describe("the presence record, in memory", () => {
  it("forgets a tab that stopped announcing itself, and a person inactive for 5 minutes", () => {
    let now = 1_000_000;
    const p = new Presence({ ttlMs: 60_000, activeMs: 300_000, now: () => now });
    expect(p.announce("p_a", "t1", { issue: "c1" })).toBe(true);
    expect(p.announce("p_a", "t1", { issue: "c1" })).toBe(false);
    expect(p.announce("p_b", "t2", { issue: "c1", dragging: "c2" })).toBe(true);
    expect(p.viewers("c1")).toEqual(["p_a", "p_b"]);
    expect(p.dragging()).toEqual({ c2: ["p_b"] });
    now += 30_000;
    p.announce("p_b", "t2", { issue: "c1" });
    now += 45_000;
    // t1 went quiet for 75 s: gone; t2 announced 45 s ago: still there.
    expect(p.sweep()).toBe(true);
    expect(p.viewers("c1")).toEqual(["p_b"]);
    expect(p.active()).toEqual(["p_a", "p_b"]);
    now += 300_000;
    p.sweep();
    expect(p.viewers("c1")).toEqual([]);
    expect(p.active()).toEqual([]);
  });
});
