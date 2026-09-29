import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, type EventRecord, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remindersFor } from "../src/notify.js";
import { startDashboardServer } from "../src/server.js";
import { setProjectHealth, updateClockStart } from "../src/team/health.js";
import { identitySettings } from "../src/team/settings.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * B4.11 T6 (teams NEW-teams-11: TEAM-28, -29, -30, -45; dashboard DB-N9-2,
 * -3), on a real Team server over a Team ledger with five people signed in at
 * four levels (DoD §2A): health set by the project lead with their name and
 * date, never by a model; a release's target date set by a person and read
 * as the target against the forecast range on Status and Projects; *Update
 * missing* counted from the current release's start; and the per-person
 * cap's reason on a queued issue. Solo is the one person, with health and
 * the update optional (TEAM-45).
 */

const PASSWORD = "correct horse battery staple";
const DAY = 86_400_000;

let root: string;
let db: DatabaseSync | undefined;
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

function open(setup: "solo" | "team") {
  root = mkdtempSync(join(tmpdir(), "sek-health-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-health-cfg-"));
  process.env.SEKHEMET_USER_CONFIG = join(root, "none.toml");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup });
  store = new CardStore(db, log);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
}

beforeEach(() => {
  root = "";
  db = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = undefined;
  for (const k of ["SEKHEMET_CLI", "SEKHEMET_CONFIG_DIR", "SEKHEMET_USER_CONFIG"])
    Reflect.deleteProperty(process.env, k);
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function start(setup: "solo" | "team") {
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await startDashboardServer({
    db: db as DatabaseSync,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: root,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
    pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    ...(setup === "team"
      ? {
          identity: {
            dir,
            passwordList: join(root, "list.txt"),
            settings: identitySettings({ mode: "team", workspace: "Northwind" }),
          },
        }
      : {}),
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

/** Signs in again: a session ends after its idle time, which a jump of days passes. */
const again = (email: string) =>
  call("POST", "/api/session", nobody, { email, password: PASSWORD }).then(signedIn);

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

interface Facts {
  canSetHealth: boolean;
  healthWritable: boolean;
  health: { value: string; by: string; at: string } | null;
  release: { id: string; name: string } | null;
  target: { release: string; date: string; by: string; at: string } | null;
  canSetTarget: boolean;
  updateMissing: boolean;
}
const facts = async (who: Person, project: string) =>
  ((await ok(who, "GET", `/api/status?project=${project}`)) as { facts: Facts }).facts;

/** Five people at four levels on one project, Chronicle, led by Lee, with two releases. */
async function team() {
  open("team");
  await start("team");
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
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
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
  return { ada, mo, lee, sam, vic, project, first, second };
}

describe("TEAM-28, DB-N9-2: the project lead sets health; it shows with their name and date", () => {
  it("records the lead's call, and refuses everyone else — a Member, an Admin, a Stakeholder, a Viewer", async () => {
    const t = await team();
    // No one has set it: the server records it, and only the lead is offered it.
    expect(await facts(t.lee, t.project)).toMatchObject({
      health: null,
      healthWritable: true,
      canSetHealth: true,
    });
    expect((await facts(t.mo, t.project)).canSetHealth).toBe(false);
    expect((await facts(t.ada, t.project)).canSetHealth).toBe(false);

    for (const who of [t.mo, t.ada, t.sam, t.vic]) {
      const res = await call("POST", `/api/projects/${t.project}/health`, who, {
        health: "on_track",
      });
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(403);
      expect(body.error).toMatch(
        /The project lead or a Member who leads a release can set this project's health\./,
      );
    }
    expect(await log.getEventsByTypes(["project/health_set"])).toEqual([]);

    const bad = await call("POST", `/api/projects/${t.project}/health`, t.lee, { health: "fine" });
    expect(bad.status).toBe(400);

    const set = await ok(t.lee, "POST", `/api/projects/${t.project}/health`, {
      health: "at_risk",
    });
    expect(set.health).toMatchObject({ value: "at_risk", by: "you" });
    const recorded = (await log.getEventsByTypes(["project/health_set"])).at(-1);
    expect(recorded).toMatchObject({
      actor: "human",
      principal: t.lee.principal,
      payload: { project: t.project, health: "at_risk" },
    });

    // Everyone who can see the project reads it with the lead's name and the date.
    const seen = await facts(t.vic, t.project);
    expect(seen.health).toEqual({ value: "at_risk", by: "Lee Lead", at: recorded?.createdAt });
    expect(seen.canSetHealth).toBe(false);
    const overview = (await ok(t.sam, "GET", "/api/projects/overview")) as {
      overview: { projects: { id: string; health: unknown }[] };
    };
    expect(overview.overview.projects.find((p) => p.id === t.project)?.health).toEqual({
      value: "at_risk",
      by: "Lee Lead",
      at: recorded?.createdAt,
    });
  });

  it("with no lead named, no one sets it, and the refusal says an Admin names one", async () => {
    const t = await team();
    const other = (
      await asPerson(t.ada, () =>
        store.ensureProject({ rootPath: join(root, "billing"), name: "Billing" }),
      )
    ).id;
    const res = await call("POST", `/api/projects/${other}/health`, t.ada, { health: "on_track" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /none is named yet: an Admin names one/,
    );
  });

  it("a model never sets it: the only writer takes a person, and a model's event is never read as health", async () => {
    open("solo");
    const p = await store.ensureProject({ rootPath: join(root, "p"), name: "P" });
    await expect(
      setProjectHealth(log, { project: p.id, health: "at_risk", principal: "" }),
    ).rejects.toThrow(/set by a person/);
    // An event a non-person appends is never read as health.
    await log.append({
      actor: "manager",
      type: "project/health_set",
      payload: { project: p.id, health: "off_track" },
    });
    await start("solo");
    const f = await facts(nobody, p.id);
    expect(f.health).toBeNull();
  });
});

describe("DB-N9-3: a release's target date, set by a person, is the target against the forecast", () => {
  it("the lead or an Admin sets the current release's date; Status and Projects read it; a Member cannot", async () => {
    const t = await team();
    const lead = await facts(t.lee, t.project);
    expect(lead).toMatchObject({
      release: { id: t.first, name: "Walking skeleton" },
      target: null,
      canSetTarget: true,
    });
    expect((await facts(t.mo, t.project)).canSetTarget).toBe(false);
    expect((await facts(t.ada, t.project)).canSetTarget).toBe(true);

    const refused = await call("POST", `/api/slices/${t.first}/target`, t.mo, {
      date: "2026-11-20",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /An Admin or the project lead can set a release's target date\./,
    );
    const stake = await call("POST", `/api/slices/${t.first}/target`, t.sam, {
      date: "2026-11-20",
    });
    expect(stake.status).toBe(403);
    expect(
      (await call("POST", `/api/slices/${t.first}/target`, t.lee, { date: "2026-02-30" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/slices/SLICE-99/target", t.ada, { date: "2026-11-20" })).status,
    ).toBe(404);

    await ok(t.lee, "POST", `/api/slices/${t.first}/target`, { date: "2026-11-20" });
    const recorded = (await log.getEventsByTypes(["release/target_set"])).at(-1);
    expect(recorded).toMatchObject({
      actor: "human",
      principal: t.lee.principal,
      payload: { sliceId: t.first, projectId: t.project, target: "2026-11-20" },
    });
    expect((await facts(t.vic, t.project)).target).toEqual({
      release: t.first,
      date: "2026-11-20",
      by: "Lee Lead",
      at: recorded?.createdAt,
    });
    const overview = (await ok(t.vic, "GET", "/api/projects/overview")) as {
      overview: { projects: { id: string; target: string | null }[] };
    };
    expect(overview.overview.projects.find((p) => p.id === t.project)?.target).toBe("2026-11-20");

    // An Admin changes it; then clears it.
    await ok(t.ada, "POST", `/api/slices/${t.first}/target`, { date: "2026-12-04" });
    expect((await facts(t.mo, t.project)).target).toMatchObject({
      date: "2026-12-04",
      by: "Ada Admin",
    });
    await ok(t.ada, "POST", `/api/slices/${t.first}/target`, { date: null });
    expect((await facts(t.mo, t.project)).target).toBeNull();

    // A later release's target is not the current release's.
    await ok(t.lee, "POST", `/api/slices/${t.second}/target`, { date: "2027-01-15" });
    expect((await facts(t.mo, t.project)).target).toBeNull();
    // Once the first release is accepted, the second is current, with its own date.
    await asPerson(t.lee, () =>
      log.append({
        actor: "human",
        type: "slice/accepted",
        payload: { projectId: t.project, sliceId: t.first, completesProject: false },
        principal: t.lee.principal,
      }),
    );
    expect(await facts(t.mo, t.project)).toMatchObject({
      release: { id: t.second, name: "Search" },
      target: { release: t.second, date: "2027-01-15", by: "Lee Lead" },
    });
  });
});

describe("TEAM-29: Update missing, counted from the last update or the current release's start", () => {
  const ev = (type: string, payload: Record<string, unknown>, at: number, actor = "human") =>
    ({
      seq: 0,
      type,
      actor,
      payload,
      createdAt: new Date(at).toISOString(),
    }) as unknown as EventRecord;

  it("the clock starts at the last update; else when the current release began; else at the project's creation", () => {
    const t0 = Date.parse("2026-09-01T09:00:00.000Z");
    const created = ev("project/created", { id: "proj_a" }, t0, "system");
    const first = ev("slice/created", { sliceId: "SLICE-1", projectId: "proj_a" }, t0 + DAY);
    const accepted = ev(
      "slice/accepted",
      { sliceId: "SLICE-1", projectId: "proj_a", completesProject: false },
      t0 + 10 * DAY,
    );
    const update = ev("project/update_posted", { project: "proj_a" }, t0 + 12 * DAY);
    const other = ev("project/update_posted", { project: "proj_b" }, t0 + 20 * DAY);
    expect(updateClockStart([created], "proj_a")).toBe(t0);
    expect(updateClockStart([created, first], "proj_a")).toBe(t0 + DAY);
    expect(updateClockStart([created, first, accepted], "proj_a")).toBe(t0 + 10 * DAY);
    expect(updateClockStart([created, first, accepted, update, other], "proj_a")).toBe(
      t0 + 12 * DAY,
    );
    expect(updateClockStart([other], "proj_a")).toBeUndefined();
  });

  it("the lead alone sees it on Status, and gets the reminder, 7 days after the release began", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-09-01T09:00:00.000Z");
    vi.setSystemTime(t0);
    const t = await team();
    // The first release is accepted ten days on: the second release starts then.
    vi.setSystemTime(t0 + 10 * DAY);
    await asPerson(t.lee, () =>
      log.append({
        actor: "human",
        type: "slice/accepted",
        payload: { projectId: t.project, sliceId: t.first, completesProject: false },
        principal: t.lee.principal,
      }),
    );
    // Six days into the second release: not missing, though the project is 16 days old.
    vi.setSystemTime(t0 + 16 * DAY);
    let lee = await again("lee@northwind.test");
    expect((await facts(lee, t.project)).updateMissing).toBe(false);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const due = async (ms: number) =>
      (
        await remindersFor(log, t.lee.principal, { day: day(ms), now: new Date(ms), setup: "team" })
      ).filter((r) => r.key.startsWith("reminder-update-"));
    expect(await due(t0 + 16 * DAY)).toEqual([]);
    // Seven days into it: the lead is told, and no one else.
    vi.setSystemTime(t0 + 17 * DAY + 60_000);
    lee = await again("lee@northwind.test");
    expect((await facts(lee, t.project)).updateMissing).toBe(true);
    expect((await facts(await again("mo@northwind.test"), t.project)).updateMissing).toBe(false);
    expect((await facts(await again("ada@northwind.test"), t.project)).updateMissing).toBe(false);
    const [reminder] = await due(t0 + 17 * DAY + 60_000);
    // By the project's name, and why the clock started: no update was ever posted.
    expect(reminder?.message).toBe(
      "Chronicle: no project update posted since the release started 7 days ago.",
    );
    // The lead posts an update: the clock starts again.
    await ok(lee, "POST", `/api/projects/${t.project}/update`, { text: "Status\nOn it." });
    expect((await facts(lee, t.project)).updateMissing).toBe(false);
    expect(await due(t0 + 17 * DAY + 120_000)).toEqual([]);
  });
});

describe("TEAM-45: in Solo health and the update are optional", () => {
  it("never shows Update missing or No health set, and the one person may still set health", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-09-01T09:00:00.000Z");
    vi.setSystemTime(t0);
    open("solo");
    const p = await store.ensureProject({ rootPath: join(root, "p"), name: "Chronicle" });
    await start("solo");
    vi.setSystemTime(t0 + 30 * DAY);
    const before = await facts(nobody, p.id);
    expect(before).toMatchObject({ updateMissing: false, health: null, canSetHealth: true });
    const reminders = await remindersFor(log, log.localPrincipal(), {
      day: "2026-10-01",
      now: new Date(t0 + 30 * DAY),
      setup: "solo",
    });
    expect(reminders.filter((r) => r.key.startsWith("reminder-update-"))).toEqual([]);
    await ok(nobody, "POST", `/api/projects/${p.id}/health`, { health: "on_track" });
    expect((await facts(nobody, p.id)).health).toMatchObject({ value: "on_track", by: "you" });
    expect(
      ((await log.getEventsByTypes(["project/health_set"])).at(-1) as EventRecord).principal,
    ).toBe(log.localPrincipal());
  });
});
