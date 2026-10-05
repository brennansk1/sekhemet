import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { HIT_END, HIT_START } from "@sekhemet/ui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";
import { pageWriteHeaders } from "./page_headers.js";

// Full-text search on a real Team server over real SQLite and HTTP (DoD
// §2A; dashboard NEW-dashboard-12, §2.4.21; FINDINGS PRC-04; DEC-51):
// - DB-N12-1: free words match title, key, description, acceptance criteria
//   and comment text, Done and Won't do issues included, across every
//   project the person can see (`GET /api/search?q=`), from an FTS5 index in
//   the built-in node:sqlite kept current from the ledger;
// - DB-N12-2: a project taken from the person is never searched, and text a
//   `ledger/erased` event erased is never returned;
// - DB-N12-3: on a board of 10,000 issues an answer comes at p75 ≤ 200 ms.
// No model is loaded.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };
interface Hit {
  id: string;
  title: string;
  status: string;
  field: string;
  snippet: string;
  project?: { id: string; name: string };
}

describe("full-text search across a workspace's projects (NEW-dashboard-12)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: Server;
  let base: string;
  let ada: Person;
  let mo: Person;
  let alpha = "";
  let beta = "";
  let a1 = "";
  let a2 = "";
  let b1 = "";

  const call = (method: string, path: string, who: Person, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const search = async (q: string, who: Person): Promise<Hit[]> => {
    const res = await call("GET", `/api/search?q=${encodeURIComponent(q)}`, who);
    expect(res.status).toBe(200);
    return ((await res.json()) as { hits: Hit[] }).hits;
  };
  async function signedIn(res: Response): Promise<Person> {
    const body = (await res.json()) as { principal: string; csrf: string; error?: string };
    expect(res.status, body.error).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
  }
  async function join_(level: string, name: string, email: string) {
    const res = await call("POST", "/api/invites", ada, { level, email });
    const id = ((await res.json()) as { id: string }).id;
    return signedIn(
      await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-fts-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(dir, "cfg", "config.toml"));
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    // The Admin erases (kernel rule 34 needs an Accept-holder).
    log = new EventLog(db, { setup: "team", mayAccept: (p) => p === ada?.principal });
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
    for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
    [alpha, beta] = await EventLog.actingFor(ada.principal, async () => [
      (await store.ensureProject({ rootPath: join(dir, "alpha"), name: "Alpha" })).id,
      (await store.ensureProject({ rootPath: join(dir, "beta"), name: "Beta" })).id,
    ]);
    mo = await join_("member", "Mo Member", "mo@northwind.test");
    // TEAM-58: Beta is taken from Mo.
    const off = await call("POST", `/api/members/${mo.principal}/level`, ada, {
      level: "none",
      project: beta,
    });
    expect(off.status, await off.clone().text()).toBe(200);
    // A level change ends the person's sessions: Mo signs in again.
    mo = await signedIn(
      await call("POST", "/api/session", nobody, {
        email: "mo@northwind.test",
        password: PASSWORD,
      }),
    );
    const made = (input: Record<string, unknown>) =>
      EventLog.actingFor(ada.principal, () =>
        store.createCard({ tier: "task", status: "backlog", ...input } as never, "human"),
      );
    a1 = (
      await made({
        title: "Export loans as CSV",
        spec: "Include the overdue column for each borrower.",
        acceptanceCriteria: ["The file opens in a spreadsheet"],
        projectId: alpha,
      })
    ).id;
    a2 = (await made({ title: "Round totals per line", projectId: alpha })).id;
    b1 = (await made({ title: "Overdue penalties", spec: "Charge overdue fees.", projectId: beta }))
      .id;
    // a1 is Done and a2 Won't do: a search still finds them. (Done is set on
    // the projection only: reaching it legally takes a run and an accept.)
    db.prepare("UPDATE cards SET status = 'done' WHERE id = ?").run(a1);
    await EventLog.actingFor(ada.principal, () =>
      new BoardServiceImpl(store).transitionCard({
        cardId: a2,
        fromStatus: "backlog",
        toStatus: "rejected",
        actor: "human",
        reason: "rejected: not now",
      }),
    );
    const commented = await call("POST", `/api/cards/${a2}/comments`, ada, {
      text: "The penalty fee rounds the wrong way on refunds.",
    });
    expect(commented.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the description, across the projects the person can see only (DB-N12-1, -2)", async () => {
    const adas = await search("overdue", ada);
    expect(adas.map((h) => h.id).sort()).toEqual([a1, b1].sort());
    const mos = await search("overdue", mo);
    expect(mos.map((h) => [h.id, h.field, h.status, h.project?.name])).toEqual([
      [a1, "description", "done", "Alpha"],
    ]);
    expect(mos[0]?.snippet).toContain(`${HIT_START}overdue${HIT_END}`);
  });

  it("matches the acceptance criteria, the key, and a word's beginning", async () => {
    expect((await search("spreadsheet", mo)).map((h) => [h.id, h.field])).toEqual([
      [a1, "criteria"],
    ]);
    const key = a1.replace(/^card_/, "");
    expect((await search(key, mo)).map((h) => h.id)).toEqual([a1]);
    expect((await search("spreadsh", mo)).map((h) => h.id)).toEqual([a1]);
  });

  it("matches a comment on a Won't do issue", async () => {
    const hits = await search("penalty refunds", mo);
    expect(hits.map((h) => [h.id, h.field, h.status])).toEqual([[a2, "comment", "rejected"]]);
  });

  it("stays current as issues are filed and changed", async () => {
    const res = await call("POST", `/api/projects/${alpha}/cards`, ada, {
      title: "Renew a loan from the phone",
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { card: { id: string } }).card.id;
    expect((await search("phone", mo)).map((h) => h.id)).toEqual([id]);
    await EventLog.actingFor(ada.principal, () =>
      store.updateCard(id, { title: "Renew a loan from the tablet" }, "human"),
    );
    expect(await search("phone", mo)).toEqual([]);
    expect((await search("tablet", mo)).map((h) => h.id)).toEqual([id]);
  });

  it("never returns text a ledger/erased event erased (DB-N12-2)", async () => {
    const comment = db
      .prepare("SELECT id FROM events WHERE type = 'issue/commented' AND card_id = ?")
      .get(a2) as { id: string };
    await log.erase({ eventIds: [comment.id], reason: "erasure", principal: ada.principal });
    expect(await search("penalty", ada)).toEqual([]);
    expect(await search("refunds", mo)).toEqual([]);
  });

  it("answers nothing for a query of no words, and refuses no one's punctuation", async () => {
    expect(await search("", mo)).toEqual([]);
    expect(await search('"*) OR (', mo)).toEqual([]);
  });
});

describe("a search on 10,000 issues (DB-N12-3)", () => {
  it("answers at p75 within 200 ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-fts-10k-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    // The seed is not what is measured: kernel rule 38's `synchronous = FULL`
    // (C4, K-N11-1) costs every one of its 10,000 appends a full sync, which
    // took the seed past the test's time on its own. The search below runs
    // on the same ledger; the durability mode does not touch a read.
    db.exec(
      "PRAGMA synchronous = NORMAL; PRAGMA fullfsync = OFF; PRAGMA checkpoint_fullfsync = OFF",
    );
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const words = ["loan", "borrower", "invoice", "overdue", "renewal", "catalog", "fine", "hold"];
    for (let i = 0; i < 10_000; i++) {
      const w = words[i % words.length] as string;
      const v = words[(i * 7) % words.length] as string;
      await store.createCard(
        {
          tier: "task",
          title: `${w} issue ${i}`,
          status: i % 5 === 0 ? "ready" : "backlog",
          spec: `When the ${v} screen opens, item ${i} shows its ${w} history.`,
          acceptanceCriteria: [`The ${v} list keeps item ${i}`],
        },
        "planner",
      );
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 10_000,
      pressureLevel: () => 1,
    });
    vi.mocked(console.log).mockRestore();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = await pageWriteHeaders(base);
      // The first search builds the index from the ledger; it is not the measure.
      await fetch(`${base}/api/search?q=loan`, { headers });
      const queries = ["overdue", "borrower history", "renewal", "item 4242", "catalog list"];
      const took: number[] = [];
      for (let round = 0; round < 4; round++) {
        for (const q of queries) {
          const t = performance.now();
          const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { headers });
          const body = (await res.json()) as { hits: Hit[] };
          took.push(performance.now() - t);
          expect(body.hits.length).toBeGreaterThan(0);
        }
      }
      took.sort((a, b) => a - b);
      const p75 = took[Math.ceil(took.length * 0.75) - 1] as number;
      expect(p75).toBeLessThanOrEqual(200);
    } finally {
      await server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
