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
 * NEW-teams-13, when a member leaves (teams §2.2 item 9a; DESIGN_GAPS_C1
 * b12; FINDINGS_C1 PRC-09; DEC-53 c15 is no), over HTTP on a real Team
 * server with real SQLite (DoD §2A):
 * - TEAM-49: *Remove* first lists what the person owns and leads, their
 *   seats in Accept rules, and the Agent work they started; an Admin's;
 * - TEAM-50: on confirmation the Agent work they started pauses (a running
 *   issue at its next step boundary, a queued one on hold), every issue
 *   keeps its assignee, and no one can assign them new work;
 * - TEAM-51: an Accept rule left with no current member keeps its issues
 *   in Review and refuses Accept with a sentence naming the rule — to
 *   everyone, the lead and Admins included (no fallback) — and a notice
 *   waits under *Needs you* in every Admin's Inbox until the rule is edited;
 * - TEAM-52: each of these is on the ledger.
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

/** Ada (Admin), Mo and Lee (Members); Lee leads Chronicle and is its Accept rule's only seat. */
async function team() {
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
  const lee = await join_(ada, "Lee Lead", "lee@northwind.test");
  const [chronicle, atlas] = await EventLog.actingFor(ada.principal, async () => [
    (await store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" })).id,
    (await store.ensureProject({ rootPath: join(root, "atlas"), name: "Atlas" })).id,
  ]);
  for (const [project, body] of [
    [chronicle, { accept_rule: [lee.principal], lead: lee.principal }],
    [atlas, { accept_rule: [lee.principal, mo.principal] }],
  ] as const) {
    const set = await call("PATCH", `/api/projects/${project}/settings`, ada, body);
    expect(set.status).toBe(200);
  }
  // Lee's issue waiting in Review, the Agent work Lee started (one running,
  // one queued), and an issue of Mo's.
  await store.createCard({
    id: "c_own",
    tier: "story",
    title: "Hash the chain",
    projectId: chronicle,
  });
  await store.changeOwner("c_own", lee.principal, ada.principal);
  await store.updateCardStatus("c_own", "review", "verified", "harness", { override: true });
  await store.createCard({
    id: "c_run",
    tier: "story",
    title: "Verify the chain",
    projectId: chronicle,
  });
  await store.delegateCard("c_run", { kind: "worker" }, lee.principal);
  await store.updateCardStatus("c_run", "in_progress", "started", "harness", { override: true });
  await store.createCard({
    id: "c_queued",
    tier: "story",
    title: "Export the ledger",
    projectId: chronicle,
    status: "ready",
  });
  await store.delegateCard("c_queued", { kind: "worker" }, lee.principal);
  await store.createCard({ id: "c_mo", tier: "story", title: "Import from CSV", projectId: atlas });
  return { ada, mo, lee, chronicle, atlas };
}

interface Summary {
  principal: string;
  name?: string;
  owns: { id: string; title: string }[];
  leads: { projects: { id: string; name: string }[] };
  acceptSeats: { project: string; name: string; emptied: boolean }[];
  agentWork: { id: string; title: string; running: boolean }[];
}

describe("TEAM-49: Remove first lists what the person leaves behind", () => {
  it("lists their issues, the projects they lead, their Accept-rule seats and the Agent work they started", async () => {
    const { ada, lee, chronicle, atlas } = await team();
    const res = await call("GET", `/api/members/${lee.principal}/removal`, ada);
    expect(res.status).toBe(200);
    const s = (await res.json()) as Summary;
    expect(s.name).toBe("Lee Lead");
    expect(s.owns.map((c) => c.id)).toEqual(["c_own"]);
    expect(s.leads.projects).toEqual([{ id: chronicle, name: "Chronicle" }]);
    expect(s.acceptSeats).toEqual([
      { project: chronicle, name: "Chronicle", emptied: true },
      { project: atlas, name: "Atlas", emptied: false },
    ]);
    expect(s.agentWork.map((c) => [c.id, c.running])).toEqual([
      ["c_run", true],
      ["c_queued", false],
    ]);
  });

  it("is an Admin's to see", async () => {
    const { mo, lee } = await team();
    expect((await call("GET", `/api/members/${lee.principal}/removal`, mo)).status).toBe(403);
  });
});

describe("TEAM-50 to TEAM-52: confirming the removal", () => {
  it("pauses the Agent work they started, keeps every assignee, and refuses new work for them", async () => {
    const { ada, mo, lee } = await team();
    const removed = await call("DELETE", `/api/members/${lee.principal}`, ada);
    expect(removed.status).toBe(200);
    // The running issue is asked to pause at its next step boundary.
    const pauses = await store.cardEvents("c_run", ["card/pause_requested"]);
    expect(pauses.at(-1)?.principal).toBe(ada.principal);
    // The queued one waits on hold, so nothing runs on their permissions.
    expect((await store.getCard("c_queued"))?.status).toBe("parked");
    // Each issue keeps its assignee; attribution is unchanged.
    expect((await store.getCard("c_own"))?.owner).toBe(lee.principal);
    expect((await store.getCard("c_run"))?.delegate).toEqual({ kind: "worker" });
    // No one can assign them new work.
    const assign = await call("PATCH", "/api/cards/c_mo", mo, { assignee: lee.principal });
    expect(assign.status).toBe(409);
    const words = ((await assign.json()) as { error: string }).error;
    expect(words).toBe(
      "Lee Lead is no longer a member of this workspace, so no new work can be assigned to them.",
    );
    expect((await store.getCard("c_mo"))?.owner).toBeUndefined();

    // TEAM-52: on the ledger.
    const settled = (await log.getEventsByTypes(["member/removal_settled"])).at(-1);
    expect(settled?.principal).toBe(ada.principal);
    expect(settled?.payload).toMatchObject({
      principal: lee.principal,
      owns: ["c_own"],
      paused: ["c_run"],
      held: ["c_queued"],
      emptiedRules: [expect.stringMatching(/^proj_/)],
    });
    const refused = (await log.getEventsByTypes(["member/assignment_refused"])).at(-1);
    expect(refused?.payload).toMatchObject({ principal: lee.principal, cardId: "c_mo" });
    expect(refused?.principal).toBe(mo.principal);
  });

  it("keeps an emptied rule's issues in Review and refuses Accept to everyone, naming the rule, until it is edited", async () => {
    const { ada, mo, lee, chronicle } = await team();
    expect((await call("DELETE", `/api/members/${lee.principal}`, ada)).status).toBe(200);
    const sentence =
      "Chronicle's Accept rule names no current member. The project lead or an Admin can edit it.";
    for (const who of [mo, ada]) {
      const res = await call("POST", "/api/cards/c_own/accept", who);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain(sentence);
    }
    expect((await store.getCard("c_own"))?.status).toBe("review");
    // Not "no rule set": the Admins are not the fallback (DEC-53 c15).
    expect(
      (
        (await (await call("GET", `/api/projects/${chronicle}/settings`, ada)).json()) as {
          settings: { accept_rule?: string[] };
        }
      ).settings.accept_rule,
    ).toEqual([lee.principal]);

    // A notice waits under Needs you in the Admin's Inbox, not in Mo's.
    type Inbox = {
      items: { id: string; reason: string; kind: string; title: string; link: string }[];
    };
    const inbox = (await (await call("GET", "/api/inbox?filter=inbox", ada)).json()) as Inbox;
    const notice = inbox.items.find((i) => i.kind === "accept_rule");
    expect(notice).toMatchObject({ reason: "needs_you", title: "Chronicle's Accept rule" });
    const moInbox = (await (await call("GET", "/api/inbox?filter=inbox", mo)).json()) as Inbox;
    expect(moInbox.items.find((i) => i.kind === "accept_rule")).toBeUndefined();

    // Edited by an Admin: the notice goes, and Mo's Accept is no longer refused on the rule.
    expect(
      (
        await call("PATCH", `/api/projects/${chronicle}/settings`, ada, {
          accept_rule: [mo.principal],
        })
      ).status,
    ).toBe(200);
    const after = (await (await call("GET", "/api/inbox?filter=inbox", ada)).json()) as Inbox;
    expect(after.items.find((i) => i.kind === "accept_rule")).toBeUndefined();
    const res = await call("POST", "/api/cards/c_own/accept", mo);
    expect(((await res.json()) as { error?: string }).error ?? "").not.toContain(sentence);
  });
});
