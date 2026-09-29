import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * Close-out C3, the partial rows B4.11 left, on a real Team server over a
 * Team ledger with people signed in at four levels (DoD §2A):
 * - teams item 28, DB-N9-2: a release records its lead, named by the project
 *   lead or an Admin, and a Member who leads a release not yet accepted may
 *   set the project's health;
 * - teams item 30, TEAM-30, dashboard §2.16: an Admin sets the per-person
 *   Agent cap from Configuration (`PUT /api/config/queue`), recorded as the
 *   Admin's configuration change, and the queue reads it at once;
 * - teams items 19 and 31, dashboard §2.2.3: each issue the Agent is on
 *   carries its state for the board's tiles, and the viewer's own place in
 *   the Team queue — "Priya's issue is running; yours starts next" where
 *   that is true for them (`GET /api/agent/states`).
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let db: DatabaseSync | undefined;
let log: EventLog;
let store: CardStore;
let dir: string;
let base: string;
let userConfig: string;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = "";
  db = undefined;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const k of ["SEKHEMET_CLI", "SEKHEMET_CONFIG_DIR", "SEKHEMET_USER_CONFIG"])
    Reflect.deleteProperty(process.env, k);
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
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

async function invited(by: Person, level: string, name: string, email: string) {
  const res = await call("POST", "/api/invites", by, { level, email });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

async function refused(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
}

interface Facts {
  canSetHealth: boolean;
  release: { id: string; name: string; lead?: { principal: string; name: string } } | null;
  canSetReleaseLead?: boolean;
  releaseLeadChoices?: { principal: string; name: string }[];
}
const facts = async (who: Person, project: string) =>
  ((await ok(who, "GET", `/api/status?project=${project}`)) as { facts: Facts }).facts;

/** Six people at four levels on Chronicle, led by Lee, with two releases; and a second project. */
async function team() {
  root = mkdtempSync(join(tmpdir(), "sek-c3-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-c3-cfg-"));
  userConfig = join(root, "user-config.toml");
  process.env.SEKHEMET_USER_CONFIG = userConfig;
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  dir = join(root, "identity");
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
    userConfigPath: userConfig,
    pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    identity: {
      dir,
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const project = (
    await asPerson(ada, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  const other = (
    await asPerson(ada, () =>
      store.ensureProject({ rootPath: join(root, "billing"), name: "Billing" }),
    )
  ).id;
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
  const mia = await invited(ada, "member", "Mia Member", "mia@northwind.test");
  const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
  const sam = await invited(ada, "stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  await ok(ada, "PATCH", `/api/projects/${project}/settings`, { lead: lee.principal });
  const first = await store.slices.create(
    { projectId: project, title: "Walking skeleton", appetite: { cards: 3 } },
    ada.principal,
  );
  const second = await store.slices.create(
    { projectId: project, title: "Search", appetite: { cards: 4 } },
    ada.principal,
  );
  return { ada, mo, mia, lee, sam, vic, project, other, first, second };
}

const HEALTH_REFUSAL =
  /The project lead or a Member who leads a release can set this project's health\./;

describe("teams item 28, DB-N9-2: a Member who leads a release sets the project's health", () => {
  it("the project lead or an Admin names a release's lead; that Member may then set health", async () => {
    const t = await team();
    // Before: only the lead; Mo is refused with who can.
    const before = await refused(t.mo, "POST", `/api/projects/${t.project}/health`, {
      health: "at_risk",
    });
    expect(before.status).toBe(403);
    expect(before.error).toMatch(HEALTH_REFUSAL);
    expect((await facts(t.mo, t.project)).canSetHealth).toBe(false);

    // Naming a release's lead is the project lead's or an Admin's.
    const byMember = await refused(t.mo, "POST", `/api/slices/${t.first}/lead`, {
      lead: t.mo.principal,
    });
    expect(byMember.status).toBe(403);
    expect(byMember.error).toMatch(/An Admin or the project lead can name a release's lead\./);
    expect((await facts(t.lee, t.project)).canSetReleaseLead).toBe(true);
    expect((await facts(t.ada, t.project)).canSetReleaseLead).toBe(true);
    expect((await facts(t.mo, t.project)).canSetReleaseLead).toBe(false);
    // The choices are the project's Members and Admins, by name; never below Member.
    const choices = (await facts(t.lee, t.project)).releaseLeadChoices?.map((c) => c.name) ?? [];
    expect(choices).toEqual(
      expect.arrayContaining(["Ada Admin", "Mo Member", "Mia Member", "Lee Lead"]),
    );
    expect(choices).not.toContain("Sam Stakeholder");
    expect(choices).not.toContain("Vic Viewer");

    // A Stakeholder cannot lead a release; nor someone outside the workspace; an unknown release is 404.
    const stake = await refused(t.lee, "POST", `/api/slices/${t.first}/lead`, {
      lead: t.sam.principal,
    });
    expect(stake.status).toBe(400);
    expect(stake.error).toMatch(/Sam Stakeholder is a Stakeholder on Chronicle/);
    expect(
      (await refused(t.lee, "POST", `/api/slices/${t.first}/lead`, { lead: "x" })).status,
    ).toBe(400);
    expect(
      (await refused(t.ada, "POST", "/api/slices/SLICE-99/lead", { lead: t.mo.principal })).status,
    ).toBe(404);
    expect(await log.getEventsByTypes(["release/lead_set"])).toEqual([]);

    const named = await ok(t.lee, "POST", `/api/slices/${t.first}/lead`, { lead: t.mo.principal });
    expect(named.lead).toEqual({ release: t.first, principal: t.mo.principal, name: "Mo Member" });
    const recorded = (await log.getEventsByTypes(["release/lead_set"])).at(-1);
    expect(recorded).toMatchObject({
      actor: "human",
      principal: t.lee.principal,
      payload: { sliceId: t.first, projectId: t.project, lead: t.mo.principal },
    });

    // The audit log lists it, filtered by the release's project (teams item 27).
    const audit = (await ok(t.ada, "GET", `/api/audit?project=${t.project}&action=level`)) as {
      entries: { type: string; action: string; target: string }[];
    };
    expect(audit.entries.find((e) => e.type === "release/lead_set")).toMatchObject({
      action: "Release lead named",
      // DEC-31: the release by its name, never its internal id.
      target: "Mo Member for Walking skeleton on Chronicle",
    });

    // Everyone who can see the project reads the current release's lead by name.
    expect((await facts(t.vic, t.project)).release?.lead).toEqual({
      principal: t.mo.principal,
      name: "Mo Member",
    });
    expect((await facts(t.mo, t.project)).canSetHealth).toBe(true);
    // The page's level notes know it too (GET /api/session).
    const session = (await ok(t.mo, "GET", "/api/session")) as {
      projects?: Record<string, { releaseLead?: boolean }>;
    };
    expect(session.projects?.[t.project]?.releaseLead).toBe(true);

    await ok(t.mo, "POST", `/api/projects/${t.project}/health`, { health: "at_risk" });
    expect((await log.getEventsByTypes(["project/health_set"])).at(-1)).toMatchObject({
      principal: t.mo.principal,
      payload: { project: t.project, health: "at_risk" },
    });
    // Another Member who leads no release is still refused; so is Mo on another project.
    expect(
      (await refused(t.mia, "POST", `/api/projects/${t.project}/health`, { health: "on_track" }))
        .status,
    ).toBe(403);
    expect(
      (await refused(t.mo, "POST", `/api/projects/${t.other}/health`, { health: "on_track" }))
        .status,
    ).toBe(403);
  });

  it("a release's lead holds it while the release is open; cleared, or accepted, they no longer do", async () => {
    const t = await team();
    await ok(t.ada, "POST", `/api/slices/${t.first}/lead`, { lead: t.mo.principal });
    expect((await facts(t.mo, t.project)).canSetHealth).toBe(true);
    await ok(t.ada, "POST", `/api/slices/${t.first}/lead`, { lead: null });
    expect((await log.getEventsByTypes(["release/lead_set"])).at(-1)?.payload).toEqual({
      sliceId: t.first,
      projectId: t.project,
    });
    expect((await facts(t.mo, t.project)).canSetHealth).toBe(false);
    expect((await facts(t.mo, t.project)).release?.lead).toBeUndefined();

    // Mo leads the first release; once a person accepts it, Mo leads no open release.
    await ok(t.lee, "POST", `/api/slices/${t.first}/lead`, { lead: t.mo.principal });
    await asPerson(t.lee, () =>
      log.append({
        actor: "human",
        type: "slice/accepted",
        payload: { projectId: t.project, sliceId: t.first, completesProject: false },
        principal: t.lee.principal,
      }),
    );
    const after = await refused(t.mo, "POST", `/api/projects/${t.project}/health`, {
      health: "off_track",
    });
    expect(after.status).toBe(403);
    expect(after.error).toMatch(HEALTH_REFUSAL);
    // The second release is current now, with no lead of its own.
    const f = await facts(t.mo, t.project);
    expect(f.release?.id).toBe(t.second);
    expect(f.release?.lead).toBeUndefined();

    // A release's lead lowered below Member on the project no longer holds it.
    await ok(t.lee, "POST", `/api/slices/${t.second}/lead`, { lead: t.mia.principal });
    expect((await facts(t.mia, t.project)).canSetHealth).toBe(true);
    await ok(t.ada, "POST", `/api/members/${t.mia.principal}/level`, {
      level: "viewer",
      project: t.project,
    });
    // A lowered level ends the person's sessions: Mia signs in again.
    const mia = await signedIn(
      await call("POST", "/api/session", nobody, {
        email: "mia@northwind.test",
        password: PASSWORD,
      }),
    );
    expect(
      (await refused(mia, "POST", `/api/projects/${t.project}/health`, { health: "at_risk" }))
        .status,
    ).toBe(403);
    expect((await facts(mia, t.project)).canSetHealth).toBe(false);
  });
});

describe("TEAM-30, dashboard §2.16: an Admin sets the per-person Agent cap in Configuration", () => {
  it("writes [queue] agent_issues_per_person, records the Admin's change, and the queue reads it", async () => {
    const t = await team();
    // Mo has one Agent issue running and another waiting: at the default cap of 1 it waits.
    await asPerson(t.mo, async () => {
      await store.createCard({
        id: "card_run",
        tier: "task",
        title: "Running",
        status: "in_progress",
        projectId: t.project,
      });
      await store.delegateCard("card_run", { kind: "worker" }, t.mo.principal);
      await store.createCard({
        id: "card_wait",
        tier: "task",
        title: "Waiting",
        status: "ready",
        projectId: t.project,
      });
      await store.delegateCard("card_wait", { kind: "worker" }, t.mo.principal);
    });
    const standing = async () =>
      (
        (await ok(t.ada, "GET", "/api/queue/standing")) as {
          entries: { cardId: string; capped?: { cap: number } }[];
        }
      ).entries.find((e) => e.cardId === "card_wait");
    expect((await standing())?.capped).toEqual({ cap: 1, running: 1 });

    // The repository's own file cannot set the cap (teams item 30: an
    // Admin's): the queue reads it from the user config only, and
    // Configuration never names the project file as where it came from.
    writeFileSync(join(root, ".sekhemet", "config.toml"), "[queue]\nagent_issues_per_person = 4\n");
    expect((await standing())?.capped).toEqual({ cap: 1, running: 1 });
    const unset = (await ok(t.vic, "GET", "/api/config")) as {
      config: { queue: { agentIssuesPerPerson: number } };
      sources: Record<string, string>;
    };
    expect(unset.config.queue.agentIssuesPerPerson).toBe(1);
    expect(unset.sources["queue.agent_issues_per_person"]).toBeUndefined();

    // Below Admin: refused with who can, and nothing written.
    for (const who of [t.lee, t.mo, t.sam, t.vic]) {
      const r = await refused(who, "PUT", "/api/config/queue", { agentIssuesPerPerson: 2 });
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/An Admin can set the queue's caps\./);
    }
    // Not a whole number of at least 1: refused beside the field.
    for (const bad of [0, -1, 1.5, "two", null]) {
      const r = await refused(t.ada, "PUT", "/api/config/queue", { agentIssuesPerPerson: bad });
      expect(r.status).toBe(400);
      expect(r.error).toBe("Agent issues per person is a whole number, 1 or more.");
    }
    expect(await log.getEventsByTypes(["config/changed"])).toEqual([]);

    writeFileSync(userConfig, '# mine\n[network]\nmode = "offline"\n');
    const saved = await ok(t.ada, "PUT", "/api/config/queue", { agentIssuesPerPerson: 2 });
    expect(saved).toEqual({ agentIssuesPerPerson: 2 });
    const text = readFileSync(userConfig, "utf8");
    expect(text).toContain('# mine\n[network]\nmode = "offline"\n');
    expect(text).toMatch(/\[queue\]\nagent_issues_per_person = 2\n/);
    const change = (await log.getEventsByTypes(["config/changed"])).at(-1);
    expect(change?.principal).toBe(t.ada.principal);
    expect((change?.payload as { keys: string[] }).keys).toContain("queue.agent_issues_per_person");
    // Configuration reads it with its source, and the queue applies it at once.
    const cfg = (await ok(t.vic, "GET", "/api/config")) as {
      config: { queue: { agentIssuesPerPerson: number } };
      sources: Record<string, string>;
    };
    expect(cfg.config.queue.agentIssuesPerPerson).toBe(2);
    expect(cfg.sources["queue.agent_issues_per_person"]).toBe("user");
    expect((await standing())?.capped).toBeUndefined();

    // A second change rewrites the one key in place.
    await ok(t.ada, "PUT", "/api/config/queue", { agentIssuesPerPerson: 3 });
    const again = readFileSync(userConfig, "utf8");
    expect(again.match(/agent_issues_per_person/g)).toHaveLength(1);
    expect(again).toContain("agent_issues_per_person = 3");
  });
});

describe("teams items 19 and 31: the Agent's state per issue, and where the viewer stands", () => {
  it("gives each visible issue the Agent is on its state, and the viewer's place in the queue", async () => {
    const t = await team();
    // Lee's issue runs; Mo's waits next; Mia's after it; Billing's is Ada's alone.
    await ok(t.ada, "POST", `/api/members/${t.vic.principal}/level`, {
      level: "viewer",
      project: t.project,
    });
    await asPerson(t.lee, async () => {
      await store.createCard({
        id: "card_lee",
        tier: "task",
        title: "Lee's",
        status: "in_progress",
        projectId: t.project,
        stepBudget: 40,
      });
      await store.delegateCard("card_lee", { kind: "worker" }, t.lee.principal);
    });
    for (const [id, who] of [
      ["card_mo", t.mo],
      ["card_mia", t.mia],
    ] as const) {
      await asPerson(who, async () => {
        await store.createCard({
          id,
          tier: "task",
          title: id,
          status: "ready",
          projectId: t.project,
        });
        await store.delegateCard(id, { kind: "worker" }, who.principal);
      });
    }
    await asPerson(t.lee, () =>
      store.createCard({
        id: "card_plain",
        tier: "task",
        title: "Nobody's",
        status: "backlog",
        projectId: t.project,
      }),
    );
    // Sam asks the Agent on an issue: it waits on its owner, Lee.
    await asPerson(t.lee, () =>
      store.createCard({
        id: "card_ask",
        tier: "task",
        title: "Asked",
        status: "backlog",
        projectId: t.project,
        owner: t.lee.principal,
      }),
    );
    await ok(t.sam, "POST", "/api/cards/card_ask/comments", { text: "@Agent please start" });

    type States = {
      states: { cardId: string; ai: { who: string; state: string; standing?: string }[] }[];
      queue: { cardId: string; place: number; message: string; runningFor?: string } | null;
    };
    const mo = (await ok(t.mo, "GET", "/api/agent/states")) as States;
    const by = (id: string) => mo.states.find((s) => s.cardId === id)?.ai;
    expect(by("card_lee")).toEqual([{ who: "agent", state: "working", step: 1, of: 40 }]);
    expect(by("card_mo")?.[0]).toMatchObject({ who: "agent", state: "queued" });
    expect(by("card_mo")?.[0]?.standing).toMatch(/^Next in queue, about \d+ minutes?$/);
    expect(by("card_ask")?.[0]).toMatchObject({
      who: "agent",
      state: "needs you",
      waitingFor: "start",
    });
    // An issue the Agent is not on has no state.
    expect(by("card_plain")).toBeUndefined();
    // Mo's own issue is next, while Lee's runs.
    expect(mo.queue).toMatchObject({ cardId: "card_mo", place: 1, runningFor: "Lee Lead" });

    // Mia is second.
    const mia = (await ok(t.mia, "GET", "/api/agent/states")) as States;
    expect(mia.queue).toMatchObject({ cardId: "card_mia", place: 2 });
    expect(mia.queue?.message).toMatch(/^2nd in queue, about \d+ minutes?$/);
    expect(mia.queue?.runningFor).toBeUndefined();

    // Lee has nothing waiting; a Viewer of Chronicle reads its states, none of their own.
    expect(((await ok(t.lee, "GET", "/api/agent/states")) as States).queue).toBeNull();
    const vic = (await ok(t.vic, "GET", "/api/agent/states")) as States;
    expect(vic.states.map((s) => s.cardId).sort()).toEqual([
      "card_ask",
      "card_lee",
      "card_mia",
      "card_mo",
    ]);
    expect(vic.queue).toBeNull();
  });
});
