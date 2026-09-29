import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEmail, sendEmail, validateEmail, writeEmail } from "../src/email.js";
import { startNotifier } from "../src/notify.js";
import { audienceFromAccess } from "../src/pm/audience.js";
import { startDashboardServer } from "../src/server.js";
import { Access } from "../src/team/access.js";
import { type InboxDeps, inboxNotifier } from "../src/team/inbox.js";
import { allMembers, personName } from "../src/team/members.js";
import { identitySettings } from "../src/team/settings.js";
import { type SmtpFixture, body, header, startSmtpFixture } from "./smtp_fixture.js";

/**
 * B4.11 close-out C2, teams TEAM-43 (the email half) and integrations item
 * 20: a watcher's notices go by email to the person's own address, one
 * message each, within their own notification budget — which posted project
 * updates count against — carrying no private part and nothing from a
 * project the person cannot see. The SMTP settings are the integration's, the
 * password a secret (security item 35) never logged. On a real Team server
 * with five people at four levels, and a real SMTP server in this process on
 * 127.0.0.1 that nodemailer talks to (DoD §2A; no network).
 */

const PASSWORD = "correct horse battery staple";
const SMTP_PASSWORD = "smtp-secret-9f3b27c1";

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let dir: string;
let cfgDir: string;
let base: string;
let smtp: SmtpFixture;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-email-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  cfgDir = mkdtempSync(join(tmpdir(), "sek-email-cfg-"));
  process.env.SEKHEMET_CONFIG_DIR = cfgDir;
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
  smtp = await startSmtpFixture();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await smtp.close();
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

async function start() {
  const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
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
      dir,
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  quiet.mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

const call = (method: string, path: string, who: Person, reqBody?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
    ...(reqBody === undefined ? {} : { body: JSON.stringify(reqBody) }),
  });

async function signedIn(res: Response): Promise<Person> {
  const b = (await res.json()) as { principal: string; csrf: string; error?: string };
  expect(res.status, b.error).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { principal: b.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": b.csrf } };
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

async function ok(who: Person, method: string, path: string, reqBody?: unknown) {
  const res = await call(method, path, who, reqBody);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  return data;
}

async function team() {
  await start();
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
  const issue = async (title: string, owner?: Person, projectId = project) => {
    const card = await asPerson(ada, () =>
      store.createCard({ tier: "task", title, status: "ready", projectId }, "human"),
    );
    if (owner)
      await asPerson(ada, () => store.changeOwner(card.id, owner.principal, ada.principal));
    return card.id;
  };
  return { ada, mo, lee, sam, vic, project, issue };
}

const comment = (who: Person, cardId: string, id: string, text: string, people?: string[]) =>
  asPerson(who, () =>
    store.recordEvent({
      type: "issue/commented",
      cardId,
      actor: "human",
      principal: who.principal,
      payload: { id, cardId, ...(people ? { people } : {}) },
      private: { text },
    }),
  );

const settingsFiles = () => {
  const repos = join(cfgDir, "repos");
  return existsSync(repos) ? readdirSync(repos).map((f) => join(repos, f)) : [];
};

describe("the email channel's settings (integrations item 20, security item 35)", () => {
  it("are an Admin's to connect; the password is a secret, never shown, logged or on the ledger", async () => {
    const t = await team();
    const cfg = {
      host: "127.0.0.1",
      port: smtp.port,
      user: "sekhemet",
      password: SMTP_PASSWORD,
      from: "sekhemet@northwind.test",
    };
    // integration.connect is an Admin's (teams item 6): a Member is refused.
    expect((await call("PUT", "/api/integrations/email", t.mo, cfg)).status).toBe(403);
    expect(
      (await call("PUT", "/api/integrations/email", t.ada, { ...cfg, from: "not an address" }))
        .status,
    ).toBe(400);
    const entry = await ok(t.ada, "PUT", "/api/integrations/email", cfg);
    expect(entry).toMatchObject({ id: "email", connected: true });
    expect(JSON.stringify(entry)).not.toContain(SMTP_PASSWORD);
    const listed = (await ok(t.ada, "GET", "/api/integrations")) as unknown as {
      id: string;
      connected: boolean;
    }[];
    expect(listed.find((e) => e.id === "email")).toMatchObject({ connected: true });
    expect(JSON.stringify(listed)).not.toContain(SMTP_PASSWORD);
    // Kept with the other integration secrets: a 0600 file when there is no keychain (SEC-27).
    const [file] = settingsFiles();
    expect(file && statSync(file).mode & 0o777).toBe(0o600);
    expect(readEmail(root)?.password).toBe(SMTP_PASSWORD);

    // Send a test: to the asker's own address, authenticated with the secret.
    const logged = vi.spyOn(console, "log");
    const errors = vi.spyOn(console, "error");
    const test = await ok(t.ada, "POST", "/api/integrations/email/test");
    expect(test).toMatchObject({ ok: true });
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]).toMatchObject({
      from: "sekhemet@northwind.test",
      to: ["ada@northwind.test"],
      auth: { user: "sekhemet", pass: SMTP_PASSWORD },
    });
    const printed = [...logged.mock.calls, ...errors.mock.calls].flat().map(String).join("\n");
    expect(printed).not.toContain(SMTP_PASSWORD);

    // The ledger records the send and the connection, never the password or an address.
    const rows = db
      .prepare("SELECT type, payload FROM events WHERE type IN ('pm/notify', 'harness/egress')")
      .all() as { type: string; payload: string }[];
    expect(rows.find((r) => r.type === "pm/notify")?.payload).toContain('"channel":"email"');
    expect(
      rows.find((r) => r.type === "harness/egress" && r.payload.includes("integration:email")),
    ).toBeDefined();
    for (const r of rows) {
      expect(r.payload).not.toContain(SMTP_PASSWORD);
      expect(r.payload).not.toContain("northwind.test");
    }
    await server?.close();
    server = undefined;
    for (const f of readdirSync(join(root, ".sekhemet"))) {
      if (!f.startsWith("events.db")) continue;
      expect(readFileSync(join(root, ".sekhemet", f)).includes(SMTP_PASSWORD)).toBe(false);
    }
  });

  it("refuses settings that are not a server and a sender", () => {
    expect(validateEmail({ host: "", port: 25, from: "a@b.test" })).toMatch(/server/);
    expect(validateEmail({ host: "smtp.example.test", port: 0, from: "a@b.test" })).toMatch(/port/);
    expect(validateEmail({ host: "smtp.example.test", port: 587, from: "nobody" })).toMatch(
      /sender/,
    );
    expect(validateEmail({ host: "smtp.example.test", port: 587, from: "a@b.test" })).toBe(
      undefined,
    );
  });
});

describe("TEAM-43, the email half: each watcher at their own address, within their own budget", () => {
  it("one message each, 3 a day, a posted update counts, the 4th is held, the digest holds only unread items", async () => {
    const t = await team();
    await ok(t.ada, "PUT", "/api/integrations/email", {
      host: "127.0.0.1",
      port: smtp.port,
      user: "sekhemet",
      password: SMTP_PASSWORD,
      from: "sekhemet@northwind.test",
    });
    const card = await t.issue("Login", t.mo);
    // Another project Mo does not watch: nothing of it reaches his mail.
    const atlas = (
      await asPerson(t.ada, () =>
        store.ensureProject({ rootPath: join(root, "atlas"), name: "Atlas" }),
      )
    ).id;
    const secret = await t.issue("Atlas launch codes", t.lee, atlas);
    const people = () =>
      allMembers(db).flatMap((m) => {
        const name = personName(db, m.principal);
        return name ? [{ principal: m.principal, name }] : [];
      });
    await server?.close();
    server = undefined;
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    const deps: InboxDeps = {
      cardStore: store,
      log,
      access,
      audience: audienceFromAccess(() => access, db),
      projectOf: (c) => c.projectId ?? undefined,
      people,
    };
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const notifier = await startNotifier(log, root, {
      intervalMs: 60_000,
      now: () => now,
      recipient: t.ada.principal,
      setup: "team",
      inbox: inboxNotifier(deps),
    });
    await comment(t.sam, card, "cmt_one", "one private remark", [t.vic.principal]);
    await comment(t.sam, card, "cmt_two", "two private remark");
    await comment(t.sam, card, "cmt_three", "three private remark");
    await comment(t.sam, secret, "cmt_atlas", "atlas private remark");
    await notifier.tick();

    // Every message goes to one person, at their own address.
    for (const m of smtp.mails) {
      expect(m.to).toHaveLength(1);
      expect(m.auth).toEqual({ user: "sekhemet", pass: SMTP_PASSWORD });
    }
    const mailTo = (address: string, subject?: string) =>
      smtp.mails.filter(
        (m) => m.to[0] === address && (subject === undefined || header(m, "Subject") === subject),
      );
    const lines = (address: string, subject: string) =>
      mailTo(address, subject).map((m) => body(m).split(/\r?\n/)[0]);
    expect(lines("mo@northwind.test", "Login")).toEqual([
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
    ]);
    expect(lines("vic@northwind.test", "Login")).toEqual([
      "Sam Stakeholder mentioned you.",
      "Sam Stakeholder commented.",
      "Sam Stakeholder commented.",
    ]);
    // A personal message names no one else, holds no comment text (a private
    // part), and nothing of a project the person does not watch.
    for (const m of mailTo("mo@northwind.test")) {
      expect(m.data).not.toMatch(/For |Vic Viewer|Ada Admin|private remark|Atlas/);
    }
    expect(mailTo("lee@northwind.test", "Atlas launch codes")).toHaveLength(1);
    expect(body(mailTo("lee@northwind.test", "Atlas launch codes")[0])).not.toMatch(
      /private remark/,
    );

    // Ada posts a project update: Mo is past his 3, so it is held for him.
    await asPerson(t.ada, () =>
      log.append({
        actor: "human",
        type: "project/update_posted",
        principal: t.ada.principal,
        payload: { project: t.project },
        private: { text: "All on track, privately." },
      }),
    );
    await notifier.tick();
    expect(mailTo("mo@northwind.test", "Chronicle")).toHaveLength(0);
    const held = await log.getEventsByTypes(["pm/notice_held"]);
    expect(
      held
        .filter((e) => (e.payload as { to?: string }).to === t.mo.principal)
        .map((e) => e.payload),
    ).toEqual([expect.objectContaining({ kind: "project_update" })]);
    // The lead had room: the update reached him, without its text.
    expect(lines("lee@northwind.test", "Chronicle")).toEqual([
      "Ada Admin posted a project update.",
    ]);
    expect(mailTo("lee@northwind.test", "Chronicle")[0]?.data).not.toContain("privately");

    // A fourth comment: held for Mo, so the day's digest carries it — his alone.
    await comment(t.sam, card, "cmt_four", "four private remark");
    await notifier.tick();
    const digests = mailTo("mo@northwind.test", "1 unread in your Inbox");
    expect(digests).toHaveLength(1);
    expect(body(digests[0])).toMatch(/^Login: Sam Stakeholder commented\./);
    expect(digests[0]?.data).not.toMatch(/For |private remark/);

    // Each send is on the ledger as `pm/notify` on the email channel, naming the principal only.
    const sent = (await log.getEventsByTypes(["pm/notify"])).map(
      (e) => e.payload as { channel: string; to?: string; ok: boolean },
    );
    expect(sent.filter((p) => p.channel === "email" && p.to === t.mo.principal)).toHaveLength(4);
    expect(sent.every((p) => p.ok)).toBe(true);
    notifier.stop();
  });

  it("the install's person gets the daily standup at their own address, once a day", async () => {
    const t = await team();
    await ok(t.ada, "PUT", "/api/integrations/email", {
      host: "127.0.0.1",
      port: smtp.port,
      from: "sekhemet@northwind.test",
    });
    await server?.close();
    server = undefined;
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const notifier = await startNotifier(log, root, {
      intervalMs: 60_000,
      now: () => now,
      recipient: t.ada.principal,
      setup: "team",
      standup: async () => "Two issues wait for review.",
    });
    await notifier.tick();
    await notifier.tick();
    const standups = smtp.mails.filter((m) => header(m, "Subject") === "Standup");
    expect(standups.map((m) => m.to)).toEqual([["ada@northwind.test"]]);
    expect(body(standups[0])).toMatch(/^Two issues wait for review\./);
    notifier.stop();
  });

  it("a person with no recorded address is not emailed; the others are", async () => {
    const t = await team();
    await ok(t.ada, "PUT", "/api/integrations/email", {
      host: "127.0.0.1",
      port: smtp.port,
      from: "sekhemet@northwind.test",
    });
    const card = await t.issue("Search", t.mo);
    await server?.close();
    server = undefined;
    // Mo's details are erased (kernel rule 34): his `person/created` names no address.
    const created = (await log.getEventsByTypes(["person/created"])).filter(
      (e) => (e.principal ?? (e.payload as { principal?: string }).principal) === t.mo.principal,
    );
    expect(created.length).toBeGreaterThan(0);
    // Rule 34: an Accept holder erases — Ada, as the server's access decides.
    await new EventLog(db, { setup: "team", mayAccept: (p) => p === t.ada.principal }).erase({
      eventIds: created.map((e) => e.id),
      reason: "erasure",
      principal: t.ada.principal,
    });
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    const notifier = await startNotifier(log, root, {
      intervalMs: 60_000,
      recipient: t.ada.principal,
      setup: "team",
      inbox: inboxNotifier({
        cardStore: store,
        log,
        access,
        audience: audienceFromAccess(() => access, db),
        projectOf: (c) => c.projectId ?? undefined,
        people: () => [],
      }),
    });
    await comment(t.sam, card, "cmt_s1", "hello");
    await notifier.tick();
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(["ada@northwind.test"]);
    expect(smtp.mails[0]?.auth).toBeUndefined();
    notifier.stop();
  });
});

/** One of this machine's own addresses that is not loopback, when it has one. */
const ownAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && !a.internal && a.family === "IPv4")?.address;

describe("the SMTP password never crosses a network in the clear (security item 35)", () => {
  // A server that is not on this machine's loopback, offering no STARTTLS (as
  // one would when an on-path attacker strips the capability): nodemailer must
  // refuse to log in rather than send the password in plain text. The fixture
  // listens on this machine's own address, so nothing leaves the host.
  it.skipIf(!ownAddress)(
    "a server off loopback that offers no STARTTLS gets no login",
    async () => {
      const remote = await startSmtpFixture({ host: ownAddress as string });
      const userConfig = process.env.SEKHEMET_USER_CONFIG;
      try {
        // The network policy lets the server through, so TLS is what is tested.
        writeFileSync(join(cfgDir, "config.toml"), '[network]\nmode = "open"\n');
        process.env.SEKHEMET_USER_CONFIG = join(cfgDir, "config.toml");
        writeEmail(root, {
          host: ownAddress as string,
          port: remote.port,
          user: "sekhemet",
          password: SMTP_PASSWORD,
          from: "sekhemet@northwind.test",
        });
        const sent = await sendEmail(
          root,
          { event: "test", title: "Test", message: "A test notice" },
          "ada@northwind.test",
          { log, timeoutMs: 5_000 },
        );
        expect(sent.ok).toBe(false);
        expect(sent.error ?? "").not.toContain(SMTP_PASSWORD);
        expect(remote.transcript.some((l) => /^AUTH\b/i.test(l))).toBe(false);
        const wire = remote.transcript.join("\n");
        expect(wire).not.toContain(SMTP_PASSWORD);
        expect(wire).not.toContain(Buffer.from(SMTP_PASSWORD).toString("base64"));
        expect(remote.mails).toHaveLength(0);
        // It reached the server and was refused there, not by the network policy.
        expect(remote.transcript.some((l) => /^EHLO\b/i.test(l))).toBe(true);
        expect(sent.error).toMatch(/TLS/);
      } finally {
        if (userConfig === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
        else process.env.SEKHEMET_USER_CONFIG = userConfig;
        await remote.close();
      }
    },
  );

  it("a server on this machine's loopback may take the login without TLS", async () => {
    writeEmail(root, {
      host: "127.0.0.1",
      port: smtp.port,
      user: "sekhemet",
      password: SMTP_PASSWORD,
      from: "sekhemet@northwind.test",
    });
    const sent = await sendEmail(
      root,
      { event: "test", title: "Test", message: "A test notice" },
      "ada@northwind.test",
      { log, timeoutMs: 5_000 },
    );
    expect(sent).toMatchObject({ ok: true });
    expect(smtp.mails[0]?.auth).toEqual({ user: "sekhemet", pass: SMTP_PASSWORD });
  });
});
