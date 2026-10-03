import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { ACTIONS } from "../src/team/access.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * C2a, the team-visual builder, over HTTP on a real Team server with real
 * SQLite (DoD §2A): Members' parts as the approved mockup draws them
 * (NEW-dashboard-19, DEC-51; FINDINGS TEAM-04).
 * - DB-N19-4: an Admin lists every outstanding invite — email, level,
 *   project, who sent it, expiry — and *Revoke* makes the link unusable at
 *   once; anyone else asking is refused, since an invite is a credential.
 * - DB-N19-3: `GET /api/members` carries *Can accept in* (the projects whose
 *   Accept rule names the person), the access levels from the same table the
 *   server checks, the AI teammates' facts and the sign-in settings in force.
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
  root = mkdtempSync(join(tmpdir(), "sek-tv-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  cfgDir = mkdtempSync(join(tmpdir(), "sek-tv-cfg-"));
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

async function invite(by: Person, body: Record<string, unknown>) {
  const res = await call("POST", "/api/invites", by, body);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; url: string; expires: string };
}

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
  const project = (
    await EventLog.actingFor(ada.principal, () =>
      store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
    )
  ).id;
  const { id } = await invite(ada, { level: "member", email: "mo@northwind.test" });
  const mo = await signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, {
      name: "Mo Member",
      email: "mo@northwind.test",
      password: PASSWORD,
    }),
  );
  return { ada, mo, project };
}

interface InviteRow {
  ref: string;
  email?: string;
  level: string;
  project?: string;
  projectName?: string;
  invitedBy?: string;
  expires: string;
}

describe("DB-N19-4: an Admin lists and revokes outstanding invites", () => {
  it("lists each outstanding invite with its email, level, project, sender and expiry; never a used one", async () => {
    const { ada, project } = await team();
    await invite(ada, { level: "stakeholder", email: "sam@northwind.test", project, days: 14 });
    await invite(ada, { level: "viewer" });
    const res = await call("GET", "/api/invites", ada);
    expect(res.status).toBe(200);
    const { invites } = (await res.json()) as { invites: InviteRow[] };
    // Mo's invite was used: it is not outstanding.
    expect(invites).toHaveLength(2);
    const sam = invites.find((i) => i.email === "sam@northwind.test");
    expect(sam).toMatchObject({
      level: "stakeholder",
      project,
      projectName: "Chronicle",
      invitedBy: "Ada Admin",
    });
    expect(sam?.ref).toMatch(/^inv_[0-9a-f]+$/);
    expect(Date.parse(sam?.expires ?? "") - Date.now()).toBeGreaterThan(13 * 86_400_000);
    const open = invites.find((i) => i.level === "viewer");
    expect(open?.email).toBeUndefined();
    // The link itself is a credential: the list never carries it.
    expect(JSON.stringify(invites)).not.toMatch(/"(id|url)"/);
  });

  it("Revoke makes the link unusable at once, and records the revocation without the email", async () => {
    const { ada } = await team();
    const made = await invite(ada, { level: "member", email: "lee@northwind.test" });
    expect((await call("GET", `/api/invites/${made.id}`, nobody)).status).toBe(200);
    const { invites } = (await (await call("GET", "/api/invites", ada)).json()) as {
      invites: InviteRow[];
    };
    const ref = invites.find((i) => i.email === "lee@northwind.test")?.ref ?? "";
    const revoked = await call("DELETE", `/api/invites/${ref}`, ada);
    expect(revoked.status).toBe(200);
    // Unusable at once: neither shown nor accepted.
    expect((await call("GET", `/api/invites/${made.id}`, nobody)).status).toBe(404);
    const accept = await call("POST", `/api/invites/${made.id}/accept`, nobody, {
      name: "Lee",
      email: "lee@northwind.test",
      password: PASSWORD,
    });
    // Not valid (404), or held back after that failed attempt (429, TEAM-34): no account either way.
    expect([404, 429]).toContain(accept.status);
    const joined = await log.getEventsByTypes(["member/joined"]);
    expect(joined).toHaveLength(2);
    const after = (await (await call("GET", "/api/invites", ada)).json()) as {
      invites: InviteRow[];
    };
    expect(after.invites.map((i) => i.ref)).not.toContain(ref);
    const events = await log.getEventsByTypes(["member/invite_revoked"]);
    expect(events.map((e) => e.payload)).toEqual([{ invite: ref }]);
    expect(events[0]?.principal).toBe(ada.principal);
    expect(JSON.stringify(events[0]?.payload)).not.toContain("lee@");
    // A second revoke finds nothing.
    expect((await call("DELETE", `/api/invites/${ref}`, ada)).status).toBe(404);
  });

  it("refuses anyone else who asks for the invites or tries to revoke one", async () => {
    const { ada, mo } = await team();
    await invite(ada, { level: "viewer", email: "vi@northwind.test" });
    const { invites } = (await (await call("GET", "/api/invites", ada)).json()) as {
      invites: InviteRow[];
    };
    const list = await call("GET", "/api/invites", mo);
    expect(list.status).toBe(403);
    expect(JSON.stringify(await list.json())).not.toContain("vi@");
    expect((await call("DELETE", `/api/invites/${invites[0]?.ref}`, mo)).status).toBe(403);
    expect((await call("GET", "/api/invites", nobody)).status).toBe(401);
  });
});

describe("FINDINGS TEAM-05: an invite for a malformed address or a member is refused", () => {
  it("refuses an address that is not an email, saying what one looks like, and records nothing", async () => {
    const { ada } = await team();
    const before = (await log.getEventsByTypes(["member/invited"])).length;
    const res = await call("POST", "/api/invites", ada, { level: "viewer", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "not-an-email is not an email address. An invite's address looks like name@example.com.",
    );
    expect(await log.getEventsByTypes(["member/invited"])).toHaveLength(before);
  });

  it("refuses an address that already belongs to a member, and names no one else", async () => {
    const { ada } = await team();
    const res = await call("POST", "/api/invites", ada, {
      level: "member",
      email: "MO@northwind.test",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "MO@northwind.test already belongs to a member of this workspace. Change their level on Members instead.",
    );
    // An invite with no address, or a new one, is still made.
    expect((await call("POST", "/api/invites", ada, { level: "viewer" })).status).toBe(200);
    expect(
      (await call("POST", "/api/invites", ada, { level: "viewer", email: "vi@northwind.test" }))
        .status,
    ).toBe(200);
  });
});

interface MembersBody {
  members: { principal: string; acceptIn?: string[] }[];
  levels: { level: string; allows: string[] }[];
  ai: { agentIssuesPerPerson: number; autoApply: { project: string; properties: string[] }[] };
  signIn: {
    sso: boolean;
    passkeys: boolean;
    passwords: boolean;
    minPasswordLength: number;
    openSignup: string[];
    idleMinutes: number;
    absoluteHours: number;
  };
}

describe("DB-N19-3: Members' parts from the server", () => {
  it("names the projects each person can accept in, from the project's Accept rule", async () => {
    const { ada, mo, project } = await team();
    const before = (await (await call("GET", "/api/members", mo)).json()) as MembersBody;
    // No rule set: the Admins accept (DEC-42).
    expect(before.members.find((m) => m.principal === ada.principal)?.acceptIn).toEqual([project]);
    expect(before.members.find((m) => m.principal === mo.principal)?.acceptIn ?? []).toEqual([]);
    const set = await call("PATCH", `/api/projects/${project}/settings`, ada, {
      accept_rule: [mo.principal],
    });
    expect(set.status).toBe(200);
    const after = (await (await call("GET", "/api/members", mo)).json()) as MembersBody;
    expect(after.members.find((m) => m.principal === mo.principal)?.acceptIn).toEqual([project]);
    expect(after.members.find((m) => m.principal === ada.principal)?.acceptIn ?? []).toEqual([]);
  });

  it("gives the access levels from the same table the server checks", async () => {
    const { mo } = await team();
    const body = (await (await call("GET", "/api/members", mo)).json()) as MembersBody;
    expect(body.levels.map((l) => l.level)).toEqual(["admin", "member", "stakeholder", "viewer"]);
    // Each level lists what it newly allows, in the table's own words.
    for (const l of body.levels) {
      const own = Object.values(ACTIONS)
        .filter((a) => a.level === l.level && !("acceptRule" in a && a.acceptRule === "only"))
        .map((a) => a.does);
      expect(l.allows).toEqual(own);
    }
  });

  it("gives the AI teammates' facts and the sign-in settings in force", async () => {
    const { mo } = await team();
    const body = (await (await call("GET", "/api/members", mo)).json()) as MembersBody;
    expect(body.ai.agentIssuesPerPerson).toBeGreaterThanOrEqual(1);
    expect(body.ai.autoApply).toEqual([]);
    expect(body.signIn).toEqual({
      sso: false,
      passkeys: false,
      passwords: true,
      minPasswordLength: 15,
      openSignup: [],
      idleMinutes: 60,
      absoluteHours: 24,
    });
  });
});
