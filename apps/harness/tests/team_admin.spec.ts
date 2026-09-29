import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { CONTROL_RULES } from "@sekhemet/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { ACTIONS } from "../src/team/access.js";
import { identitySettings } from "../src/team/settings.js";

/**
 * B4.11 T5, teams NEW-teams-10 (TEAM-27, TEAM-44) and dashboard DB-N9-16,
 * on a real Team server with people signed in at four levels (DoD §2A): the
 * audit log read from the event log, filterable, exportable and refused
 * below Admin; a change to the user `config.toml` made outside Sekhemet,
 * recorded at the next start by its keys and never its values; Members with
 * level, per-project levels, profile label and last active, its actions an
 * Admin's; and the live stream's `append` frames reaching only the people
 * who can see what they carry.
 */

const PASSWORD = "correct horse battery staple";

let root: string;
let cfgDir: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;
const aborts: AbortController[] = [];
let pmAdapter: MockInferenceAdapter;
// vitest.config.ts points every test at a user config that does not exist.
const testUserConfig = process.env.SEKHEMET_USER_CONFIG;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-admin-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  cfgDir = mkdtempSync(join(tmpdir(), "sek-admin-cfg-"));
  process.env.SEKHEMET_CONFIG_DIR = cfgDir;
  process.env.SEKHEMET_USER_CONFIG = join(cfgDir, "config.toml");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
  pmAdapter = new MockInferenceAdapter("dirk-27b", []);
});

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  if (testUserConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
  else process.env.SEKHEMET_USER_CONFIG = testUserConfig;
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
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
    streamIntervalMs: 50,
    pressureLevel: () => 1,
    pmAdapter: () => pmAdapter,
    identity: {
      dir: join(root, "identity"),
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

/** A Solo server over its own ledger (TEAM-44 holds in both setups). */
async function startSolo(dbPath: string) {
  const soloDb = new DatabaseSync(dbPath);
  initSchema(soloDb);
  const soloLog = new EventLog(soloDb);
  const soloStore = new CardStore(soloDb, soloLog);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const solo = await startDashboardServer({
    db: soloDb,
    log: soloLog,
    boardService: new BoardServiceImpl(soloStore),
    cardStore: soloStore,
    repoPath: root,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
    identity: { dir: join(root, "solo-identity"), settings: identitySettings({ mode: "solo" }) },
  });
  vi.mocked(console.log).mockRestore();
  return { db: soloDb, close: solo.close };
}

async function restart() {
  await server?.close();
  server = undefined;
  await start();
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
  const sam = await invited(ada, "stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  return { ada, mo, sam, vic, project };
}

interface AuditEntry {
  seq: number;
  at: string;
  type: string;
  category: string;
  action: string;
  actor: { principal?: string; name: string; ai?: boolean; onBehalfOf?: { name: string } };
  target: string;
  project?: string;
}

describe("TEAM-27: the audit log, an Admin's read of the event log", () => {
  it("lists every sign-in, refusal summary, lock, level change, invite, token, password reset, model change and configuration change, filterable and exportable", async () => {
    const t = await team();
    // A refusal summary: a wrong password, then the right one, closes the window.
    expect(
      (
        await call("POST", "/api/session", nobody, {
          email: "mo@northwind.test",
          password: "not the password at all",
        })
      ).status,
    ).toBe(401);
    await new Promise((r) => setTimeout(r, 400));
    await signedIn(
      await call("POST", "/api/session", nobody, {
        email: "mo@northwind.test",
        password: PASSWORD,
      }),
    );
    // A lock the sign-in limits recorded, and the Admin's unlock.
    await log.append({
      actor: "harness",
      type: "account/locked",
      payload: { principal: t.sam.principal },
    });
    await ok(t.ada, "POST", `/api/members/${t.sam.principal}/unlock`);
    // Level changes: the workspace level and one project's.
    await ok(t.ada, "POST", `/api/members/${t.vic.principal}/level`, { level: "stakeholder" });
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/level`, {
      level: "admin",
      project: t.project,
    });
    // A token and a password reset.
    await ok(t.mo, "POST", "/api/tokens", { name: "laptop cli secret name", days: 7 });
    await ok(t.ada, "POST", `/api/members/${t.vic.principal}/password-reset`);
    // A model change, as Configuration records it.
    await EventLog.actingFor(t.ada.principal, () =>
      log.append({
        actor: "human",
        type: "models/assigned",
        principal: t.ada.principal,
        payload: {
          role: "worker",
          model: "cyber-tiel-35b",
          scope: "default",
          qualification: "qualified",
        },
      }),
    );
    // A configuration change: a project setting, and config.toml changed outside.
    await ok(t.ada, "PATCH", `/api/projects/${t.project}/settings`, { lead: t.mo.principal });

    const all = (await ok(t.ada, "GET", "/api/audit?limit=500")) as { entries: AuditEntry[] };
    const types = new Set(all.entries.map((e) => e.type));
    for (const type of [
      "session/started",
      "session/refused",
      "account/locked",
      "account/unlocked",
      "member/level_changed",
      "member/invited",
      "member/joined",
      "token/created",
      "password/reset_issued",
      "models/assigned",
      "project/settings_changed",
    ])
      expect(types, type).toContain(type);
    // Newest first; nothing that is not an audit action (issues, presence, the PM).
    expect(all.entries.map((e) => e.seq)).toEqual(
      [...all.entries.map((e) => e.seq)].sort((a, b) => b - a),
    );
    expect(types).not.toContain("session/active");
    expect(types).not.toContain("project/created");
    // Actor, action and target in words; the private parts never.
    const override = all.entries.find(
      (e) => e.type === "member/level_changed" && e.project === t.project,
    );
    expect(override).toMatchObject({
      actor: { principal: t.ada.principal, name: "Ada Admin" },
      action: "Level changed to Admin",
      target: "Mo Member on Chronicle",
      category: "level",
    });
    expect(all.entries.find((e) => e.type === "models/assigned")?.action).toBe(
      "Coding model set to cyber-tiel-35b",
    );
    const text = JSON.stringify(all);
    expect(text).not.toContain("laptop cli secret name");
    expect(text).not.toContain("@northwind.test");

    // Filters: by person (actor or target), by action and by project.
    const mo = (await ok(t.ada, "GET", `/api/audit?person=${t.mo.principal}`)) as {
      entries: AuditEntry[];
    };
    expect(mo.entries.length).toBeGreaterThan(0);
    for (const e of mo.entries)
      expect(e.actor.principal === t.mo.principal || JSON.stringify(e).includes("Mo Member")).toBe(
        true,
      );
    const signIns = (await ok(t.ada, "GET", "/api/audit?action=sign_in")) as {
      entries: AuditEntry[];
    };
    expect(signIns.entries.length).toBeGreaterThan(0);
    expect(new Set(signIns.entries.map((e) => e.category))).toEqual(new Set(["sign_in"]));
    const onChronicle = (await ok(t.ada, "GET", `/api/audit?project=${t.project}`)) as {
      entries: AuditEntry[];
    };
    expect(new Set(onChronicle.entries.map((e) => e.type))).toEqual(
      new Set(["member/level_changed", "project/settings_changed"]),
    );

    // Export as CSV and as JSON, the same filters applying.
    const csv = await call("GET", "/api/audit?format=csv&action=level", t.ada);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="audit-.*\.csv"/);
    const rows = (await csv.text()).trim().split("\r\n");
    expect(rows[0]).toBe("time,actor,on_behalf_of,action,target,project,event,seq");
    expect(rows.some((r) => r.includes("Level changed to Admin"))).toBe(true);
    const json = await call("GET", "/api/audit?format=json&action=token", t.ada);
    expect(json.headers.get("content-disposition")).toMatch(
      /attachment; filename="audit-.*\.json"/,
    );
    const exported = (await json.json()) as { entries: AuditEntry[] };
    expect(exported.entries.map((e) => e.type)).toEqual(["token/created"]);
  });

  it("refuses the audit log to anyone but an Admin, naming the level, and records the refusal", async () => {
    const t = await team();
    for (const who of [t.mo, t.sam, t.vic]) {
      const res = await call("GET", "/api/audit", who);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; permission: string; needs: string };
      expect(body.permission).toBe("audit.view");
      expect(body.needs).toBe("admin");
      expect(body.error).toMatch(/An Admin can open the audit view/);
    }
    const csv = await call("GET", "/api/audit?format=csv", t.mo);
    expect(csv.status).toBe(403);
    const refused = db
      .prepare(
        "SELECT principal FROM events WHERE type = 'access/refused' AND json_extract(payload, '$.permission') = 'audit.view'",
      )
      .all() as { principal: string }[];
    expect(new Set(refused.map((r) => r.principal))).toEqual(
      new Set([t.mo.principal, t.sam.principal, t.vic.principal]),
    );
  });

  it("names an AI teammate with the person it works for", async () => {
    const t = await team();
    await log.append({
      actor: "worker",
      type: "models/assigned",
      onBehalfOf: t.mo.principal,
      payload: { role: "reviewer", model: "rev-9b", scope: "default", qualification: "qualified" },
    });
    const all = (await ok(t.ada, "GET", "/api/audit?action=model")) as { entries: AuditEntry[] };
    expect(all.entries[0]?.actor).toMatchObject({
      name: "Agent",
      ai: true,
      onBehalfOf: { name: "Mo Member" },
    });
  });
});

describe("TEAM-44: a change to config.toml made outside Sekhemet", () => {
  it("is recorded at the next start by its keys, never its values, and only when something changed", async () => {
    writeFileSync(
      join(cfgDir, "config.toml"),
      '[review]\nreview_minutes_per_day = 45\n\n[sessions]\nidle_minutes = 60\n\n[notify]\nntfy_topic = "first-private-topic-value"\n',
    );
    await start();
    const outside = () =>
      db
        .prepare(
          "SELECT payload, principal FROM events WHERE type = 'config/changed_outside' ORDER BY seq",
        )
        .all() as { payload: string; principal: string | null }[];
    // Never recorded before: every key is new to the log.
    expect(outside()).toHaveLength(1);
    expect(JSON.parse(outside()[0]?.payload ?? "{}").keys).toEqual([
      "notify.ntfy_topic",
      "review.review_minutes_per_day",
      "sessions.idle_minutes",
    ]);

    // Unchanged: nothing more.
    await restart();
    expect(outside()).toHaveLength(1);

    // One value edited, one key added and one removed, by hand.
    writeFileSync(
      join(cfgDir, "config.toml"),
      '[review]\nreview_minutes_per_day = 45\n\n[sessions]\nidle_minutes = 30\nabsolute_hours = 12\n\n[notify]\nntfy_topic = "second-private-topic-value"\n',
    );
    await restart();
    expect(outside()).toHaveLength(2);
    const second = JSON.parse(outside()[1]?.payload ?? "{}") as {
      keys: string[];
      state: Record<string, string>;
    };
    expect(second.keys).toEqual([
      "notify.ntfy_topic",
      "sessions.absolute_hours",
      "sessions.idle_minutes",
    ]);
    // No value, in the payload or anywhere on the ledger.
    const ledger = JSON.stringify(db.prepare("SELECT payload FROM events").all()).concat(
      JSON.stringify(db.prepare("SELECT body FROM event_private").all()),
    );
    for (const value of ["first-private-topic-value", "second-private-topic-value", "45", "30"])
      expect(ledger.includes(`"${value}"`) || ledger.includes(`:${value}`), value).toBe(false);
    // The recorded state is keyed digests, which name no value either.
    for (const digest of Object.values(second.state))
      expect(digest).toMatch(/^[A-Za-z0-9_-]{22,}$/);

    // A key removed by hand is a change too.
    writeFileSync(join(cfgDir, "config.toml"), "[review]\nreview_minutes_per_day = 45\n");
    await restart();
    expect(JSON.parse(outside()[2]?.payload ?? "{}").keys).toEqual([
      "notify.ntfy_topic",
      "sessions.absolute_hours",
      "sessions.idle_minutes",
    ]);
  });

  it("keeps its digest key beside the credential store, never in it, so Solo still starts", async () => {
    writeFileSync(join(cfgDir, "config.toml"), "[review]\nreview_minutes_per_day = 45\n");
    const dbPath = join(root, "solo.db");
    const first = await startSolo(dbPath);
    const types = first.db.prepare("SELECT type FROM events WHERE type LIKE 'config/%'").all() as {
      type: string;
    }[];
    expect(types).toEqual([{ type: "config/changed_outside" }]);
    await first.close();
    first.db.close();
    const key = join(root, "solo-identity", "config-audit.key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "solo-identity", "credentials.json"))).toBe(false);
    // The second Solo start is not refused as a Team install, and records nothing new.
    const second = await startSolo(dbPath);
    expect(
      (
        second.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'config/%'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    await second.close();
    second.db.close();
  });

  it("records Sekhemet's own write with the person who made it, so the next start sees no outside change", async () => {
    writeFileSync(join(cfgDir, "config.toml"), "[review]\nreview_minutes_per_day = 45\n");
    const t = await team();
    const folder = mkdtempSync(join(tmpdir(), "sek-admin-models-"));
    try {
      await ok(t.ada, "POST", "/api/config/models/folders", { path: folder });
      const changed = db
        .prepare("SELECT principal, payload FROM events WHERE type = 'config/changed'")
        .all() as { principal: string; payload: string }[];
      expect(changed).toHaveLength(1);
      expect(changed[0]?.principal).toBe(t.ada.principal);
      expect(JSON.parse(changed[0]?.payload ?? "{}").keys).toEqual(["models.folders"]);
      expect(changed[0]?.payload).not.toContain(folder);
      await restart();
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'config/changed_outside'").get(),
      ).toEqual({ n: 1 });
      const ada = await signedIn(
        await call("POST", "/api/session", nobody, {
          email: "ada@northwind.test",
          password: PASSWORD,
        }),
      );
      const audit = (await ok(ada, "GET", "/api/audit?action=configuration")) as {
        entries: AuditEntry[];
      };
      expect(audit.entries[0]).toMatchObject({
        type: "config/changed",
        action: "Configuration changed",
        actor: { name: "Ada Admin" },
        target: "models.folders",
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("writes nothing when there is no user config and none was ever recorded", async () => {
    await start();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'config/%'").get()).toEqual(
      { n: 0 },
    );
    expect(existsSync(join(root, "identity", "config-audit.key"))).toBe(false);
  });

  it("reaches the audit log as a configuration change", async () => {
    writeFileSync(join(cfgDir, "config.toml"), "[review]\nreview_minutes_per_day = 45\n");
    const t = await team();
    const cfg = (await ok(t.ada, "GET", "/api/audit?action=configuration")) as {
      entries: AuditEntry[];
    };
    expect(cfg.entries.find((e) => e.type === "config/changed_outside")).toMatchObject({
      action: "Configuration changed outside Sekhemet",
      target: "review.review_minutes_per_day",
      actor: { name: "Sekhemet" },
    });
  });
});

interface MemberOut {
  principal: string;
  level: string;
  name?: string;
  email?: string;
  label?: string;
  projects?: Record<string, string>;
  lastActive?: string;
  locked?: boolean;
  pending?: boolean;
}

describe("DB-N9-16: Members, with the Admin's actions", () => {
  it("lists each person with level, per-project levels, profile label and last active; emails for an Admin", async () => {
    const t = await team();
    await ok(t.ada, "POST", `/api/members/${t.vic.principal}/level`, {
      level: "member",
      project: t.project,
    });
    const set = await ok(t.ada, "POST", `/api/members/${t.mo.principal}/label`, {
      label: "Developer",
    });
    expect(set).toMatchObject({ principal: t.mo.principal, label: "Developer" });
    const byAdmin = (await ok(t.ada, "GET", "/api/members")) as { members: MemberOut[] };
    const vic = byAdmin.members.find((m) => m.principal === t.vic.principal);
    expect(vic).toMatchObject({
      level: "viewer",
      name: "Vic Viewer",
      email: "vic@northwind.test",
      projects: { [t.project]: "member" },
    });
    expect(Date.parse(vic?.lastActive ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(byAdmin.members.find((m) => m.principal === t.mo.principal)?.label).toBe("Developer");

    // Others read the same table, without anyone's email.
    const byViewer = (await ok(t.vic, "GET", "/api/members")) as { members: MemberOut[] };
    expect(byViewer.members.map((m) => m.principal).sort()).toEqual(
      byAdmin.members.map((m) => m.principal).sort(),
    );
    expect(byViewer.members.find((m) => m.principal === t.mo.principal)?.label).toBe("Developer");
    expect(JSON.stringify(byViewer)).not.toContain("@northwind.test");

    // A label is an Admin's to change: a Member is refused, naming the level.
    const refused = await call("POST", `/api/members/${t.vic.principal}/label`, t.mo, {
      label: "Designer",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { needs: string }).needs).toBe("admin");
    const labels = db
      .prepare("SELECT principal, payload FROM events WHERE type = 'member/label_changed'")
      .all() as { principal: string; payload: string }[];
    expect(labels).toEqual([
      {
        principal: t.ada.principal,
        payload: JSON.stringify({ principal: t.mo.principal, label: "Developer" }),
      },
    ]);
    // Clearing it is recorded too; a label too long is refused.
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/label`, { label: null });
    expect(
      (
        await call("POST", `/api/members/${t.mo.principal}/label`, t.ada, {
          label: "x".repeat(81),
        })
      ).status,
    ).toBe(400);
  });

  it("tells the page the person's own project levels and the projects they lead (DB-N9-17)", async () => {
    const t = await team();
    await ok(t.ada, "POST", `/api/members/${t.sam.principal}/level`, {
      level: "member",
      project: t.project,
    });
    await ok(t.ada, "PATCH", `/api/projects/${t.project}/settings`, { lead: t.mo.principal });
    await ok(t.ada, "POST", `/api/members/${t.mo.principal}/label`, { label: "Developer" });
    const sam = (await ok(t.sam, "GET", "/api/session")) as {
      level: string;
      projects: Record<string, { level?: string; lead?: boolean }>;
    };
    expect(sam.level).toBe("stakeholder");
    expect(sam.projects).toEqual({ [t.project]: { level: "member" } });
    const mo = (await ok(t.mo, "GET", "/api/session")) as {
      projects: Record<string, { level?: string; lead?: boolean }>;
      label?: string;
    };
    expect(mo.projects).toEqual({ [t.project]: { lead: true } });
    // The profile label sets the default page (dashboard §2.2.5).
    expect(mo.label).toBe("Developer");
    expect(sam).not.toHaveProperty("label");
  });

  it("holds the page's action table equal to the server's", () => {
    expect(CONTROL_RULES).toEqual(ACTIONS);
  });
});

describe("the Team stream reaches only what its person can see", () => {
  it("sends an append frame to a member and nothing to a person removed while their stream was open", async () => {
    const t = await team();
    const rex = await invited(t.ada, "member", "Rex Removed", "rex@northwind.test");
    const open = async (who: Person) => {
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
      let ended = false;
      void (async () => {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              ended = true;
              return;
            }
            text += decoder.decode(next.value);
          }
        } catch {
          ended = true;
        }
      })();
      return { text: () => text, ended: () => ended };
    };
    const mo = await open(t.mo);
    const gone = await open(rex);
    await new Promise((r) => setTimeout(r, 200));
    const before = gone.text().length;
    await ok(t.ada, "DELETE", `/api/members/${rex.principal}`);
    // An invite's email is private: it reaches no one's stream.
    await ok(t.ada, "POST", "/api/invites", { level: "viewer", email: "zed@northwind.test" });
    const card = (
      await EventLog.actingFor(t.ada.principal, () =>
        store.createCard({
          tier: "task",
          title: "Rotate the signing keys",
          status: "ready",
          projectId: t.project,
        }),
      )
    ).id;
    const deadline = Date.now() + 5000;
    while (!mo.text().includes(card) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(mo.text()).toContain("event: append");
    expect(mo.text()).toContain("Rotate the signing keys");
    expect(mo.text()).toContain("member/invited");
    expect(mo.text()).not.toContain("zed@northwind.test");
    expect(gone.ended()).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const after = gone.text().slice(before);
    expect(after).not.toContain(card);
    expect(after).not.toContain("Rotate the signing keys");
    expect(after).not.toContain("event: append");
  });

  it("carries a person's Seshat conversation, and an @Seshat comment's text, to that person alone (PM-N9-8, teams §3)", async () => {
    const t = await team();
    const card = (
      await EventLog.actingFor(t.ada.principal, () =>
        store.createCard({
          tier: "task",
          title: "Estimate the payroll export",
          status: "ready",
          projectId: t.project,
        }),
      )
    ).id;
    const mo = await openStream(t.mo);
    const vic = await openStream(t.vic);
    await new Promise((r) => setTimeout(r, 200));
    pmAdapter.enqueueResponse({
      text: "Only the estimate's hours, Mo.",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
    await ok(t.mo, "POST", `/api/cards/${card}/comments`, {
      text: "@Seshat is Sam's salary in this estimate?",
    });
    const deadline = Date.now() + 5000;
    while (!vic.text().includes("pm/reply") && Date.now() < deadline) {
      if ((await log.getEventsByTypes(["pm/reply"])).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Let the pump carry the reply before reading what each stream got.
    await new Promise((r) => setTimeout(r, 400));
    expect(vic.text()).toContain("issue/commented");
    expect(vic.text()).not.toContain("salary");
    expect(vic.text()).not.toContain("Only the estimate's hours");
    expect(mo.text()).toContain("pm/message");

    // The question is the comment's free text: in the erasable private part,
    // never the hashed payload (teams §3, kernel rule 33).
    const [message] = await log.getEventsByTypes(["pm/message"]);
    expect(JSON.stringify(message?.payload)).not.toContain("salary");
    expect(message?.private?.text).toBe("@Seshat is Sam's salary in this estimate?");
    // Mo still reads their own question in Seshat's thread.
    const thread = (await ok(t.mo, "GET", "/api/pm/thread")) as {
      messages: { role: string; text: string }[];
    };
    expect(thread.messages.find((m) => m.role === "user")?.text).toBe(
      "@Seshat is Sam's salary in this estimate?",
    );

    // GET /api/events gives a Viewer no event's private part (T5).
    const all = await call("GET", "/api/events", t.vic);
    const body = await all.text();
    expect(all.status).toBe(200);
    expect(body).not.toContain("salary");
    expect(body).not.toContain("ada@northwind.test");
    expect(body).not.toContain('"private"');
  });
});

async function openStream(who: Person) {
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
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        text += decoder.decode(next.value);
      }
    } catch {
      // Aborted at the end of the test.
    }
  })();
  return { text: () => text };
}
