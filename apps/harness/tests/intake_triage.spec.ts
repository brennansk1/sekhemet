import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { Access } from "../src/team/access.js";
import { untriagedIssues } from "../src/team/intake.js";
import { identitySettings } from "../src/team/settings.js";
import { pageWriteHeaders } from "./page_headers.js";

// Intake and triage on a real Team server over real SQLite and HTTP (DoD
// §2A; dashboard NEW-dashboard-10, §2.4.19; FINDINGS PRC-01):
// - DB-N10-1: a Stakeholder files from New issue through `issue.file`
//   (`POST /api/projects/:id/cards`), with the project lead as assignee;
// - DB-N10-2: an issue filed below Member, by an integration or by an import
//   waits in Triage (the board's `display.intake`), until a Member decides;
// - DB-N10-3: the four decisions, each `issue/triaged` with the Member's
//   principal, never `card/accepted`; below Member refused;
// - DB-N10-4: the lead's Inbox counts them under Needs you; Solo has none.
// No model is loaded.

const PASSWORD = "correct horse battery staple";
type Server = { port: number; close: () => Promise<void> };
interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };
interface BoardCard {
  id: string;
  status: string;
  owner?: string;
  blockedReason?: string;
  display?: { intake?: { from: string; by?: string; at: string } };
}

describe("intake and triage on a Team server (NEW-dashboard-10)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  let server: Server;
  let base: string;
  let ada: Person;
  let lee: Person;
  let mo: Person;
  let sam: Person;
  let val: Person;
  let project = "";

  const call = (method: string, path: string, who: Person, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async <T>(path: string, who: Person): Promise<T> =>
    (await (await call("GET", path, who)).json()) as T;
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
  const board = async (who: Person) =>
    (await read<{ cards: BoardCard[] }>(`/api/board?project=${project}`, who)).cards;
  const intakeOf = async (id: string) =>
    (await board(lee)).find((c) => c.id === id)?.display?.intake;
  const file = async (who: Person, body: Record<string, unknown>) => {
    const res = await call("POST", `/api/projects/${project}/cards`, who, body);
    return { status: res.status, body: (await res.json()) as { card: BoardCard; error?: string } };
  };
  const triage = (who: Person, id: string, body: Record<string, unknown>) =>
    call("POST", `/api/cards/${id}/triage`, who, body);
  const events = (type: string, cardId: string) =>
    db
      .prepare("SELECT principal, payload FROM events WHERE type = ? AND card_id = ?")
      .all(type, cardId) as { principal: string | null; payload: string }[];
  const triageItem = async (who: Person) =>
    (
      await read<{ items: { kind: string; count: number; link: string; title: string }[] }>(
        "/api/inbox",
        who,
      )
    ).items.find((i) => i.kind === "triage");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-intake-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "cfg"));
    vi.stubEnv("SEKHEMET_USER_CONFIG", join(dir, "cfg", "config.toml"));
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db, { setup: "team" });
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
    mkdirSync(join(dir, "app"));
    project = (
      await EventLog.actingFor(ada.principal, () =>
        store.ensureProject({ rootPath: join(dir, "app"), name: "Lending" }),
      )
    ).id;
    lee = await join_("member", "Lee Lead", "lee@northwind.test");
    mo = await join_("member", "Mo Member", "mo@northwind.test");
    sam = await join_("stakeholder", "Sam Stake", "sam@northwind.test");
    val = await join_("viewer", "Val View", "val@northwind.test");
    const lead = await call("PATCH", `/api/projects/${project}/settings`, ada, {
      lead: lee.principal,
    });
    expect(lead.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let filedBySam = "";

  it("a Stakeholder files an issue through issue.file, with the project lead as its assignee (DB-N10-1)", async () => {
    const { status, body } = await file(sam, {
      title: "Overdue loans are not flagged",
      description: "The list shows them as ordinary loans.",
      type: "bug",
      reproduction: { happened: "No flag", expected: "A red Overdue flag" },
      // Below Member, these are not the filer's to set: ignored.
      cycleId: "cycle_x",
      priority: 1,
    });
    expect(status, body.error).toBe(201);
    filedBySam = body.card.id;
    const card = await store.getCard(filedBySam);
    expect(card?.status).toBe("backlog");
    expect(card?.owner).toBe(lee.principal);
    expect(card?.change).toBe("fix");
    expect(card?.spec).toContain("The list shows them as ordinary loans.");
    expect(card?.spec).toContain("A red Overdue flag");
    expect(card?.cycleId ?? null).toBeNull();
    expect(card?.priority).toBe(0);
    // The person who filed it is on the ledger.
    expect(events("card/created", filedBySam)[0]?.principal).toBe(sam.principal);
  });

  it("a Viewer cannot file (issue.file is a Stakeholder's)", async () => {
    expect((await file(val, { title: "A Viewer's idea" })).status).toBe(403);
  });

  it("the issue waits in Triage with who filed it; a Member's own does not (DB-N10-2)", async () => {
    expect(await intakeOf(filedBySam)).toMatchObject({ from: "stakeholder", by: "Sam Stake" });
    const mine = await file(mo, { title: "Paginate the loans list", type: "story" });
    expect(mine.status).toBe(201);
    expect(await intakeOf(mine.body.card.id)).toBeUndefined();
    // A Member's filing is the Member's own (kernel K-N6-1: a card records an
    // owner; the filer outside triage, C5).
    expect((await store.getCard(mine.body.card.id))?.owner).toBe(mo.principal);
  });

  it("an integration's issue and an imported one wait in Triage too", async () => {
    const synced = await store.createCard(
      { tier: "task", title: "Crash on empty due date", status: "backlog", projectId: project },
      "github",
    );
    const imported = await EventLog.actingFor(mo.principal, async () => {
      const c = await store.createCard(
        {
          tier: "task",
          title: "Renewals from the old tracker",
          status: "backlog",
          projectId: project,
        },
        "human",
      );
      await store.recordEvent({
        type: "card/imported",
        cardId: c.id,
        actor: "human",
        payload: { id: c.id, proposal: "prop_import1" },
      });
      return c;
    });
    expect(await intakeOf(synced.id)).toMatchObject({ from: "integration", by: "GitHub" });
    expect(await intakeOf(imported.id)).toMatchObject({ from: "import" });
  });

  it("the project lead's Inbox counts them under Needs you; no one else's does (DB-N10-4)", async () => {
    const item = await triageItem(lee);
    expect(item).toMatchObject({ kind: "triage", count: 3 });
    expect(item?.link).toBe("#/board/triage");
    expect(await triageItem(mo)).toBeUndefined();
  });

  it("below Member, triage is refused", async () => {
    const res = await triage(sam, filedBySam, { decision: "accept" });
    expect(res.status).toBe(403);
    expect(events("issue/triaged", filedBySam)).toEqual([]);
  });

  it("Accept into Backlog keeps the issue in Backlog, records issue/triaged and never card/accepted (DB-N10-3)", async () => {
    const res = await triage(mo, filedBySam, { decision: "accept" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await store.getCard(filedBySam))?.status).toBe("backlog");
    const recorded = events("issue/triaged", filedBySam);
    expect(recorded.map((e) => [e.principal, JSON.parse(e.payload)])).toEqual([
      [mo.principal, { cardId: filedBySam, decision: "accept" }],
    ]);
    expect(events("card/accepted", filedBySam)).toEqual([]);
    expect(await intakeOf(filedBySam)).toBeUndefined();
    expect((await triageItem(lee))?.count).toBe(2);
    // Triaged once, it is not waiting any more.
    expect((await triage(mo, filedBySam, { decision: "accept" })).status).toBe(409);
  });

  it("Decline needs a reason and moves the issue to Won't do", async () => {
    const { body } = await file(sam, { title: "Make the logo bigger" });
    const id = body.card.id;
    expect((await triage(mo, id, { decision: "decline" })).status).toBe(400);
    expect((await triage(mo, id, { decision: "decline", reason: "Out of scope" })).status).toBe(
      200,
    );
    expect((await store.getCard(id))?.status).toBe("rejected");
    const [e] = events("issue/triaged", id);
    expect(JSON.parse(e?.payload ?? "{}")).toEqual({ cardId: id, decision: "decline" });
    // The reason is in the erasable private part, never the hashed payload.
    expect(e?.payload).not.toContain("Out of scope");
  });

  it("Duplicate of moves the issue to Won't do with the link", async () => {
    const { body } = await file(sam, { title: "Overdue loans have no flag" });
    const id = body.card.id;
    expect((await triage(mo, id, { decision: "duplicate", duplicateOf: id })).status).toBe(400);
    expect((await triage(mo, id, { decision: "duplicate", duplicateOf: filedBySam })).status).toBe(
      200,
    );
    const card = await store.getCard(id);
    expect(card?.status).toBe("rejected");
    expect(card?.blockedReason).toBe(`Duplicate of ${filedBySam}`);
    expect(JSON.parse(events("issue/triaged", id)[0]?.payload ?? "{}")).toEqual({
      cardId: id,
      decision: "duplicate",
      duplicateOf: filedBySam,
    });
  });

  it("Snooze hides the issue until its time, after which it waits again", async () => {
    const { body } = await file(sam, { title: "Email reminders before the due date" });
    const id = body.card.id;
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await triage(mo, id, { decision: "snooze", until: past })).status).toBe(400);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect((await triage(mo, id, { decision: "snooze", until })).status).toBe(200);
    expect(await intakeOf(id)).toBeUndefined();
    const deps = {
      log,
      cardStore: store,
      access: new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() }),
      projectOf: () => project,
    };
    const later = await untriagedIssues(deps, { now: Date.parse(until) + 1 });
    expect(later.has(id)).toBe(true);
  });
});

describe("Solo has no Triage (DB-N10-4)", () => {
  it("an issue filed on a Solo server carries no intake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-intake-solo-"));
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    mkdirSync(join(dir, "app"));
    const project = (await store.ensureProject({ rootPath: join(dir, "app"), name: "Solo" })).id;
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
      const res = await fetch(`${base}/api/projects/${project}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ title: "Solo's own issue" }),
      });
      expect(res.status).toBe(201);
      const cards = ((await (await fetch(`${base}/api/board`)).json()) as { cards: BoardCard[] })
        .cards;
      expect(cards.length).toBe(1);
      expect(cards[0]?.display?.intake).toBeUndefined();
    } finally {
      await server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
