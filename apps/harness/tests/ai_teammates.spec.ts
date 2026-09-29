import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { Access } from "../src/team/access.js";
import { agentRefusal, runnableByTheirPeople } from "../src/team/ai_teammates.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * B4.11, teams NEW-teams-5 and kernel NEW-kernel-10, on a real Team server
 * over a Team ledger with people signed in at four levels (DoD §2A): a
 * comment's `@Agent` and `@Seshat`, delegation, the AI's state within 10
 * seconds from the harness (TEAM-15), `on_behalf_of` and the Agent refusing
 * what its person could not do (TEAM-16, K-N10-1), a Stakeholder's or
 * Viewer's `@Agent` as a request in the owner's *Needs you* (TEAM-39), and a
 * Viewer's `@Seshat` answered with no proposal or suggestion (TEAM-40).
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let dir: string;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-ai-team-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(adapter: MockInferenceAdapter) {
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
    pmAdapter: () => adapter,
    identity: {
      dir,
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

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

async function firstAdmin(): Promise<Person> {
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  return signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
}

async function invited(by: Person, level: string, name: string, email: string) {
  const res = await call("POST", "/api/invites", by, { level, email });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

/** Lowering a level ends the person's sessions (teams item 14): they sign in again. */
const signIn = async (email: string) =>
  signedIn(await call("POST", "/api/session", nobody, { email, password: PASSWORD }));

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

interface AiState {
  who: string;
  state: string;
  waitingFor?: string;
  waitsOn?: string;
  requestedBy?: string;
  standing?: string;
}

/** Five people at four levels on one project, Chronicle, led by Lee. */
async function team(adapter = new MockInferenceAdapter("dirk-27b", [])) {
  await start(adapter);
  const ada = await firstAdmin();
  const project = (
    await asPerson(ada, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
  const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
  const sam = await invited(ada, "stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  await ok(ada, "PATCH", `/api/projects/${project}/settings`, { lead: lee.principal });
  const issue = async (title: string, owner: Person) => {
    const card = await asPerson(ada, () =>
      store.createCard({ tier: "task", title, status: "ready", projectId: project }),
    );
    await store.changeOwner(card.id, owner.principal, ada.principal);
    return card.id;
  };
  return { ada, mo, lee, sam, vic, project, issue, adapter };
}

describe("TEAM-15, TEAM-16, K-N10-1: a Member's @Agent and delegation", () => {
  it("delegates at once, shows the Agent queued, and the Agent's events are on the Member's behalf", async () => {
    const t = await team();
    const card = await t.issue("Search", t.mo);

    const began = Date.now();
    const posted = (await ok(t.mo, "POST", `/api/cards/${card}/comments`, {
      text: "@Agent please take this one",
    })) as { comment: { name: string; ai: string[] }; ai: AiState[] };
    // From the harness, never waiting for a model: well inside 10 seconds.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(posted.comment).toMatchObject({ name: "You", ai: ["agent"] });
    const agent = posted.ai.find((a) => a.who === "agent");
    expect(agent).toMatchObject({ state: "queued" });
    expect(agent?.standing).toMatch(/in queue, about \d+ minutes?/);

    // The issue is the Agent's, delegated by Mo, and the issue shows it.
    expect((await store.getCard(card))?.delegate).toEqual({ kind: "worker" });
    expect(store.delegatorOf(card)).toBe(t.mo.principal);
    const detail = (await ok(t.mo, "GET", `/api/cards/${card}`)) as { ai: AiState[] };
    expect(detail.ai.find((a) => a.who === "agent")?.state).toBe("queued");
    // Everyone who can see the issue reads the same state.
    const seen = (await ok(t.vic, "GET", `/api/cards/${card}/comments`)) as {
      comments: { name: string; text: string }[];
      ai: AiState[];
    };
    expect(seen.comments).toEqual([
      expect.objectContaining({ name: "Mo Member", text: "@Agent please take this one" }),
    ]);
    expect(seen.ai.find((a) => a.who === "agent")?.state).toBe("queued");

    // K-N10-1: the Agent's own events name Mo in on_behalf_of, never as principal.
    await store.recordDossierEntry({ cardId: card, kind: "question", text: "Which index?" });
    const row = db
      .prepare(
        "SELECT principal, on_behalf_of FROM events WHERE type = 'card/question' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { principal: string | null; on_behalf_of: string | null };
    expect(row).toEqual({ principal: null, on_behalf_of: t.mo.principal });

    // The comment's text is private, its author the principal.
    const ev = db
      .prepare("SELECT actor, principal, payload FROM events WHERE type = 'issue/commented'")
      .get() as { actor: string; principal: string; payload: string };
    expect(ev.actor).toBe("human");
    expect(ev.principal).toBe(t.mo.principal);
    expect(ev.payload).not.toContain("please take this one");
  });

  it("delegating from the assignee picker needs agent.start and shows the state the same way", async () => {
    const t = await team();
    const card = await t.issue("Maps", t.mo);
    const r = await call("PATCH", `/api/cards/${card}`, t.sam, { assignee: "worker" });
    const refusal = (await r.json()) as { permission: string; offer?: { to?: string } };
    expect(r.status).toBe(403);
    // Named as what it is, with the offer to ask the issue's owner (item 19a).
    expect(refusal.permission).toBe("agent.start");
    expect(refusal.offer?.to).toBe(t.mo.principal);
    await ok(t.lee, "PATCH", `/api/cards/${card}`, { assignee: "worker" });
    expect(store.delegatorOf(card)).toBe(t.lee.principal);
    const detail = (await ok(t.lee, "GET", `/api/cards/${card}`)) as { ai: AiState[] };
    expect(detail.ai.find((a) => a.who === "agent")?.state).toBe("queued");
    // A person lowered to Stakeholder on the project is refused the delegation by name.
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/level`, {
      level: "stakeholder",
      project: t.project,
    });
    const other = await t.issue("Routes", t.lee);
    const mo = await signIn("mo@northwind.test");
    const down = await call("PATCH", `/api/cards/${other}`, mo, { assignee: "worker" });
    expect(down.status).toBe(403);
    expect(((await down.json()) as { permission: string }).permission).toBe("agent.start");
    expect(store.delegatorOf(other)).toBeUndefined();
  });

  it("a Member's @Agent on a running issue reaches the Agent's next step", async () => {
    const t = await team();
    const card = await t.issue("Search", t.mo);
    await asPerson(t.mo, () => store.delegateCard(card, { kind: "worker" }, t.mo.principal));
    await store.updateCardStatus(card, "in_progress", "setup", "harness", { override: true });
    const posted = (await ok(t.mo, "POST", `/api/cards/${card}/comments`, {
      text: "@Agent use the trigram index",
    })) as { ai: AiState[] };
    expect(posted.ai.find((a) => a.who === "agent")?.state).toBe("working");
    const messages = (await ok(t.mo, "GET", `/api/cards/${card}/messages`)) as {
      messages: { text: string; principal: string }[];
    };
    expect(messages.messages).toEqual([
      expect.objectContaining({ text: "@Agent use the trigram index", principal: t.mo.principal }),
    ]);
  });
});

describe("TEAM-16: the Agent refuses what its person could not do", () => {
  it("does not run an issue for a person lowered below Member, and records the refusal naming them", async () => {
    const t = await team();
    const card = await t.issue("Search", t.mo);
    await ok(t.mo, "POST", `/api/cards/${card}/comments`, { text: "@Agent go" });
    const access = new Access({
      db,
      setup: "team",
      localPrincipal: () => log.localPrincipal(),
    });
    const ready = (await store.listCards({ status: "ready" })).filter((c) => c.id === card);
    expect(agentRefusal(access, store, ready[0] as never)).toBeUndefined();
    expect(await runnableByTheirPeople(ready, { access, store, log })).toHaveLength(1);

    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/level`, {
      level: "viewer",
      project: t.project,
    });
    const refused = agentRefusal(access, store, ready[0] as never);
    expect(refused?.person).toBe(t.mo.principal);
    expect(refused?.decision.message).toMatch(/You're a Viewer on Chronicle/);
    expect(await runnableByTheirPeople(ready, { access, store, log })).toEqual([]);
    const recorded = (await log.getEventsByTypes(["access/refused"])).at(-1);
    expect(recorded?.principal).toBe(t.mo.principal);
    expect(recorded?.payload).toMatchObject({ permission: "agent.start", level: "viewer" });

    // Solo's one person may always.
    const solo = new Access({ db, setup: "solo", localPrincipal: () => log.localPrincipal() });
    expect(agentRefusal(solo, store, ready[0] as never)).toBeUndefined();

    // While it stands, the refusal is recorded once, not on every queue pass.
    expect(await runnableByTheirPeople(ready, { access, store, log })).toEqual([]);
    expect(
      (await log.getEventsByTypes(["access/refused"])).filter((e) => e.cardId === card),
    ).toHaveLength(1);
  });

  it("holds an issue with no project to the workspace's one project, as the dashboard does", async () => {
    const t = await team();
    const loose = (
      await asPerson(t.ada, () =>
        store.createCard({ tier: "task", title: "Loose", status: "ready" }, "human"),
      )
    ).id;
    // An issue from a ledger older than projects carries none.
    db.prepare("UPDATE cards SET project_id = NULL WHERE id = ?").run(loose);
    await asPerson(t.mo, () => store.delegateCard(loose, { kind: "worker" }, t.mo.principal));
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/level`, {
      level: "viewer",
      project: t.project,
    });
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    const ready = (await store.listCards({ status: "ready" })).filter((c) => c.id === loose);
    expect(ready[0]?.projectId).toBeUndefined();
    expect(agentRefusal(access, store, ready[0] as never)?.person).toBe(t.mo.principal);
    expect(await runnableByTheirPeople(ready, { access, store, log })).toEqual([]);
  });
});

describe("TEAM-39: a Stakeholder's or Viewer's @Agent is a request to the owner", () => {
  it("starts nothing, waits in the owner's Needs you, and starts on the pressing Member's behalf", async () => {
    const t = await team();
    const card = await t.issue("Login", t.mo);

    const posted = (await ok(t.sam, "POST", `/api/cards/${card}/comments`, {
      text: "@Agent fix the login redirect",
    })) as { ai: AiState[]; request: { id: string; to: string } };
    expect((await store.getCard(card))?.delegate).toBeUndefined();
    expect(posted.request.to).toBe(t.mo.principal);
    expect(posted.ai.find((a) => a.who === "agent")).toMatchObject({
      state: "needs you",
      waitingFor: "start",
      waitsOn: "Mo Member",
      requestedBy: "you",
    });
    const recorded = (await log.getEventsByTypes(["agent/start_requested"])).at(-1);
    expect(recorded?.principal).toBe(t.sam.principal);
    expect(recorded?.payload).toMatchObject({ requested_by: t.sam.principal, to: t.mo.principal });
    expect(JSON.stringify(recorded?.payload)).not.toContain("login redirect");

    // In Mo's Needs you, naming Sam and what they asked; in no one else's.
    const mine = (await ok(t.mo, "GET", "/api/agent/requests")) as {
      requests: { requestedByName: string; ask: string; title: string }[];
    };
    expect(mine.requests).toEqual([
      expect.objectContaining({
        requestedByName: "Sam Stakeholder",
        ask: "@Agent fix the login redirect",
        title: "Login",
      }),
    ]);
    expect(((await ok(t.lee, "GET", "/api/agent/requests")) as { requests: [] }).requests).toEqual(
      [],
    );
    // Status's Needs you carries it for Mo, and for no one else.
    const status = (await ok(t.mo, "GET", `/api/status?project=${t.project}`)) as {
      facts: { agentRequests?: { requestedBy: string; ask: string }[] };
    };
    expect(status.facts.agentRequests).toEqual([
      expect.objectContaining({
        requestedBy: "Sam Stakeholder",
        ask: "@Agent fix the login redirect",
      }),
    ]);
    const leeStatus = (await ok(t.lee, "GET", `/api/status?project=${t.project}`)) as {
      facts: { agentRequests?: unknown[] };
    };
    expect(leeStatus.facts.agentRequests).toBeUndefined();

    // Sam cannot press Start; Lee, a Member, can — on Lee's behalf.
    const id = posted.request.id;
    const r = await call("POST", `/api/cards/${card}/agent-requests/${id}/start`, t.sam);
    expect(r.status).toBe(403);
    expect((await r.json()) as { permission: string }).toMatchObject({ permission: "agent.start" });
    const started = (await ok(t.lee, "POST", `/api/cards/${card}/agent-requests/${id}/start`)) as {
      ai: AiState[];
    };
    expect(started.ai.find((a) => a.who === "agent")?.state).toBe("queued");
    expect(store.delegatorOf(card)).toBe(t.lee.principal);
    expect((await log.getEventsByTypes(["agent/start_answered"])).at(-1)).toMatchObject({
      principal: t.lee.principal,
      payload: { id, answer: "started" },
    });
    // The issue's Activity names who asked and who started it (Team: names, never "You").
    const page = (await ok(t.mo, "GET", `/api/events?card=${card}&order=desc&limit=50`)) as {
      events: { type: string; principalName?: string }[];
    };
    const named = (type: string) => page.events.find((e) => e.type === type)?.principalName;
    expect(named("agent/start_requested")).toBe("Sam Stakeholder");
    expect(named("agent/start_answered")).toBe("Lee Lead");
    // Answered once: gone from Mo's Needs you, and a second press is refused.
    expect(((await ok(t.mo, "GET", "/api/agent/requests")) as { requests: [] }).requests).toEqual(
      [],
    );
    const again = await call("POST", `/api/cards/${card}/agent-requests/${id}/start`, t.mo);
    expect(again.status).toBe(409);
  });

  it("goes to the project lead when the owner cannot start the Agent, and a Viewer's too", async () => {
    const t = await team();
    const card = await t.issue("Billing", t.sam);
    const posted = (await ok(t.vic, "POST", `/api/cards/${card}/comments`, {
      text: "Could the @agent look at this?",
    })) as { request: { to: string; id: string } };
    expect(posted.request.to).toBe(t.lee.principal);
    const lees = (await ok(t.lee, "GET", "/api/agent/requests")) as {
      requests: { requestedByName: string }[];
    };
    expect(lees.requests.map((r) => r.requestedByName)).toEqual(["Vic Viewer"]);
    await ok(t.lee, "POST", `/api/cards/${card}/agent-requests/${posted.request.id}/decline`);
    expect((await store.getCard(card))?.delegate).toBeUndefined();
    expect((await log.getEventsByTypes(["agent/start_answered"])).at(-1)?.payload).toMatchObject({
      answer: "declined",
    });
  });
});

describe("TEAM-40: a Viewer's @Seshat is answered with no proposal or suggestion", () => {
  it("queues the question at once, answers it, and offers the Viewer nothing to apply", async () => {
    const adapter = new MockInferenceAdapter("dirk-27b", []);
    const t = await team(adapter);
    const card = await t.issue("Search", t.mo);
    const urgent = (cardId: string) => ({
      text: "It blocks the release, so it should be urgent.",
      toolCalls: [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: cardId, priority: 1, reason: "it blocks the release" },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
    adapter.enqueueResponse(urgent(card));
    const posted = (await ok(t.vic, "POST", `/api/cards/${card}/comments`, {
      text: "@Seshat should this be urgent?",
    })) as { ai: AiState[] };
    expect(["queued", "working"]).toContain(posted.ai.find((a) => a.who === "seshat")?.state);

    let comments: { by: string; text: string }[] = [];
    let ai: AiState[] = [];
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ({ comments, ai } = (await ok(t.vic, "GET", `/api/cards/${card}/comments`)) as {
        comments: { by: string; text: string }[];
        ai: AiState[];
      });
      if (comments.some((c) => c.by === "seshat")) break;
    }
    expect(comments.find((c) => c.by === "seshat")?.text).toMatch(/urgent/);
    expect(ai.find((a) => a.who === "seshat")?.state).toBe("done");
    // No proposal in the answer, no suggestion on the issue.
    const replies = (await log.getEventsByTypes(["pm/reply"])).map(
      (e) => e.payload as { proposals?: unknown[] },
    );
    expect(replies.flatMap((r) => r.proposals ?? [])).toEqual([]);
    expect(await store.suggestions.open(card)).toEqual([]);
    // Seshat's answer is the asker's: Mo reads Vic's question, not the answer.
    const mos = (await ok(t.mo, "GET", `/api/cards/${card}/comments`)) as {
      comments: { by: string }[];
    };
    expect(mos.comments.map((c) => c.by)).toEqual(["person"]);
  });

  it("a Member who is a Viewer on this project is offered none on its issues either", async () => {
    const adapter = new MockInferenceAdapter("dirk-27b", []);
    const t = await team(adapter);
    const card = await t.issue("Search", t.lee);
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/level`, {
      level: "viewer",
      project: t.project,
    });
    adapter.enqueueResponse({
      text: "I'd make it urgent.",
      toolCalls: [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: card, priority: 1, reason: "it blocks the release" },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
    const mo = await signIn("mo@northwind.test");
    await ok(mo, "POST", `/api/cards/${card}/comments`, { text: "@Seshat urgent?" });
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if ((await log.getEventsByTypes(["pm/reply"])).length) break;
    }
    const replies = (await log.getEventsByTypes(["pm/reply"])).map(
      (e) => e.payload as { proposals?: unknown[] },
    );
    expect(replies).toHaveLength(1);
    expect(replies.flatMap((r) => r.proposals ?? [])).toEqual([]);
    expect(await store.suggestions.open(card)).toEqual([]);
  });
});
