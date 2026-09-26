import {
  chmodSync,
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
import { CardStore, EventLog, exportLedger, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, userConfigError } from "../src/config.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { Access, recordLevelChange } from "../src/team/access.js";
import {
  CredentialStore,
  backupCredentials,
  restoreCredentials,
} from "../src/team/credential_store.js";
import { Identity } from "../src/team/identity.js";
import { checkPassword } from "../src/team/passwords.js";
import { requester } from "../src/team/requester.js";
import { newSetupTokenCommand, recordSwitchToSolo, soloStartBlocked } from "../src/team/serve.js";
import { type IdentitySettings, bindHost, identitySettings } from "../src/team/settings.js";

/**
 * B4.10, Team setup — who a request is (teams §2.1, §2.3; NEW-teams-1, -3).
 * Real SQLite ledgers, real files (modes checked) and a real HTTP server.
 */

const PASSWORD = "correct horse battery staple";
const mode = (path: string) => statSync(path).mode & 0o777;

let root: string;
let db: DatabaseSync;
let log: EventLog;
let dir: string;
let clock: number;
const now = () => clock;
const LIST = () => join(root, "common.txt");

function newIdentity(overrides: Partial<IdentitySettings> = {}): Identity {
  return new Identity({
    db,
    log,
    dir,
    now,
    passwordList: LIST(),
    settings: identitySettings({ mode: "team", workspace: "Northwind", ...overrides }),
  });
}

/** A level change as the server records it (the access module's route). */
function changeLevel(
  by: string,
  principal: string,
  level: "admin" | "member" | "stakeholder" | "viewer",
) {
  const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
  return recordLevelChange(log, access, { by, principal, level });
}

/** Every event of `type`, payload and private part. */
async function events(type: string) {
  return (await log.getEvents(1, 10_000)).filter((e) => e.type === type);
}

/** The first Admin, from the setup token, and their session. */
async function firstAdmin(identity: Identity) {
  identity.ensureSetupToken();
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  const made = await identity.presentSetupToken(
    token,
    { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
    "10.0.0.1",
  );
  if (!made.ok) throw new Error(made.error);
  return made;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-team-id-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  dir = join(root, "identity");
  clock = Date.parse("2026-09-25T09:00:00Z");
  // A tiny fixture list stands in for the bundled one (the real list is pending approval).
  writeFileSync(LIST(), "passwordpassword1\nqwertyuiopasdfgh\n");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TEAM-9: passwords", () => {
  const person = { name: "Dana Stakeholder", email: "dana@northwind.test" };
  const opts = () => ({ ...person, workspace: "Northwind", listPath: LIST() });

  it("refuses short, personal, workspace and listed passwords, naming the rule", () => {
    expect(checkPassword("short one", opts())).toMatchObject({ ok: false, rule: "length" });
    expect(checkPassword("my name is dana, really", opts())).toMatchObject({
      ok: false,
      rule: "name",
    });
    expect(checkPassword("xx dana@northwind.test xx", opts())).toMatchObject({
      ok: false,
      rule: "email",
    });
    expect(checkPassword("i work at NORTHWIND inc", opts())).toMatchObject({
      ok: false,
      rule: "workspace",
    });
    expect(checkPassword("QWERTYuiopasdfgh", opts())).toMatchObject({ ok: false, rule: "common" });
  });

  it("has no composition rules: a long lower-case phrase passes", () => {
    expect(checkPassword(PASSWORD, opts())).toEqual({ ok: true });
  });

  it("never looks a password up online", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    checkPassword(PASSWORD, opts());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reports the bundled list as missing rather than refusing everything", () => {
    const missing = checkPassword(PASSWORD, { ...opts(), listPath: join(root, "absent.txt") });
    expect(missing).toEqual({ ok: true, listMissing: true });
  });
});

describe("TEAM-11: the credential store", () => {
  it("is a 0600 file in a 0700 directory, outside events.db, and widened modes are corrected", async () => {
    const identity = newIdentity();
    await firstAdmin(identity);
    const file = join(dir, "credentials.json");
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    new CredentialStore(dir);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it("keeps hashes out of the event log and out of every export", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    const pat = identity.createToken(admin.principal, { name: "laptop cli" });
    if (!pat.ok) throw new Error(pat.error);
    const store = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as {
      passwords: Record<string, { hash: string }>;
      tokens: Record<string, { hash: string }>;
    };
    const pwHash = store.passwords[admin.principal]?.hash ?? "";
    const tokenHash = Object.values(store.tokens)[0]?.hash ?? "";
    expect(pwHash).toMatch(/^scrypt\$/);
    const exported = exportLedger(db, { includePrivate: true });
    for (const secret of [pwHash, tokenHash, pat.token, PASSWORD]) {
      expect(exported).not.toContain(secret);
    }
    expect((await events("token/created")).length).toBe(1);
    expect((await events("password/changed")).length).toBe(1);
  });

  it("goes into a backup at 0600 and is restored with it", async () => {
    const identity = newIdentity();
    await firstAdmin(identity);
    const backup = join(root, "backup.db");
    const copied = backupCredentials(dir, backup);
    expect(copied && mode(copied)).toBe(0o600);
    rmSync(join(dir, "credentials.json"));
    expect(restoreCredentials(dir, backup)).toBe(true);
    expect(mode(join(dir, "credentials.json"))).toBe(0o600);
    const signIn = await newIdentity().signIn("ada@northwind.test", PASSWORD, "10.0.0.1");
    expect(signIn.ok).toBe(true);
  });
});

describe("TEAM-2, TEAM-31, TEAM-3: the setup token", () => {
  it("writes a 0600 token file, prints only its path, and creates the first Admin once", async () => {
    const identity = newIdentity();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const written = identity.ensureSetupToken();
    const path = join(dir, "setup-token");
    expect(written.path).toBe(path);
    expect(mode(path)).toBe(0o600);
    const token = readFileSync(path, "utf8").trim();
    const printed = logSpy.mock.calls.flat().join("\n");
    logSpy.mockRestore();
    expect(printed).toContain(path);
    expect(printed).not.toContain(token);

    // Nobody signs in before an Admin exists.
    expect(await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.1")).toMatchObject({
      ok: false,
      status: 403,
    });

    const made = await identity.presentSetupToken(
      token,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.0.0.1",
    );
    expect(made).toMatchObject({ ok: true, level: "admin" });
    expect(identity.hasAdmin()).toBe(true);
    expect(existsSync(path)).toBe(false);
    const joined = await events("member/joined");
    expect(joined[0]?.payload).toMatchObject({ level: "admin", via: "setup", pending: false });
    // Names and emails never on the chain.
    expect(JSON.stringify(joined[0]?.payload)).not.toContain("ada@");

    // Single use.
    const again = await identity.presentSetupToken(
      token,
      { name: "Eve", email: "eve@northwind.test", password: PASSWORD },
      "10.0.0.2",
    );
    expect(again.ok).toBe(false);
  });

  it("refuses a token older than 24 hours", async () => {
    const identity = newIdentity();
    identity.ensureSetupToken();
    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    clock += 24 * 3600_000 + 1;
    const late = await identity.presentSetupToken(
      token,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.0.0.1",
    );
    expect(late).toMatchObject({ ok: false, status: 403 });
    expect(identity.hasAdmin()).toBe(false);
  });

  it("--new-setup-token voids the old token, and writes nothing once an Admin exists", async () => {
    const identity = newIdentity();
    identity.ensureSetupToken();
    const old = readFileSync(join(dir, "setup-token"), "utf8").trim();
    const fresh = identity.newSetupToken();
    expect(fresh.ok).toBe(true);
    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    expect(token).not.toBe(old);
    const stale = await identity.presentSetupToken(
      old,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.0.0.1",
    );
    expect(stale.ok).toBe(false);
    clock += 1000; // past the back-off the failed attempt started
    const made = await identity.presentSetupToken(
      token,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.0.0.1",
    );
    expect(made.ok).toBe(true);
    const before = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(identity.newSetupToken()).toMatchObject({ ok: false });
    expect(existsSync(join(dir, "setup-token"))).toBe(false);
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(before);
  });

  it("`serve --new-setup-token` exits non-zero and writes nothing once an Admin exists", async () => {
    const settings = identitySettings({ mode: "team", workspace: "Northwind" });
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(newSetupTokenCommand(db, log, root, { dir, settings })).toBe(0);
    expect(mode(join(dir, "setup-token"))).toBe(0o600);
    await firstAdmin(newIdentity());
    const before = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(newSetupTokenCommand(db, log, root, { dir, settings })).toBe(1);
    expect(existsSync(join(dir, "setup-token"))).toBe(false);
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(before);
    quiet.mockRestore();
    errors.mockRestore();
  });

  it("TEAM-3: a Solo install switched to Team keeps its log and its principal becomes the first Admin", async () => {
    const solo = log.ensureLocalPerson({ name: "Sol O" });
    await log.append({ actor: "human", type: "note/test", payload: { n: 1 } });
    const before = await log.getEvents(1, 1000);
    const identity = newIdentity();
    const made = await firstAdmin(identity);
    expect(made.principal).toBe(solo);
    const after = await log.getEvents(1, 1000);
    expect(after.slice(0, before.length)).toEqual(before);
    expect((await log.verifyHashChain()).valid).toBe(true);
  });
});

describe("TEAM-8, TEAM-33: invites", () => {
  it("GET shows the invite and consumes nothing; accept is single-use", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    const invite = identity.createInvite(admin.principal, { level: "member" });
    if (!invite.ok) throw new Error(invite.error);
    for (let i = 0; i < 3; i++) {
      expect(identity.showInvite(invite.id, "10.0.0.5")).toMatchObject({
        ok: true,
        workspace: "Northwind",
        level: "member",
        invitedBy: "Ada Admin",
      });
    }
    expect((await events("member/joined")).length).toBe(1);
    const joined = await identity.acceptInvite(
      invite.id,
      { name: "Mo Member", email: "mo@northwind.test", password: PASSWORD },
      "10.0.0.5",
    );
    expect(joined).toMatchObject({ ok: true, level: "member" });
    const second = await identity.acceptInvite(
      invite.id,
      { name: "Eve", email: "eve@northwind.test", password: PASSWORD },
      "10.0.0.6",
    );
    expect(second).toMatchObject({ ok: false });
    expect((await events("member/joined")).length).toBe(2);
  });

  it("refuses an expired invite and creates no account", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    const invite = identity.createInvite(admin.principal, { level: "viewer" });
    if (!invite.ok) throw new Error(invite.error);
    clock += 7 * 86_400_000 + 1;
    expect(identity.showInvite(invite.id, "10.0.0.5")).toMatchObject({ ok: false });
    const late = await identity.acceptInvite(
      invite.id,
      { name: "Vi", email: "vi@northwind.test", password: PASSWORD },
      "10.0.0.5",
    );
    expect(late.ok).toBe(false);
    expect((await events("member/joined")).length).toBe(1);
    const invited = await events("member/invited");
    expect(invited[0]?.payload).toMatchObject({ level: "viewer" });
    expect(JSON.stringify(invited[0]?.payload)).not.toContain(invite.id);
  });
});

describe("TEAM-10, TEAM-36: sessions", () => {
  it("issues a new session id at sign-in and ends idle and too-old sessions on the server", async () => {
    const identity = newIdentity({ idleMinutes: 60, absoluteHours: 24 });
    await firstAdmin(identity);
    const a = await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.1");
    const b = await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.1");
    if (!a.ok || !b.ok) throw new Error("sign-in failed");
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId.length).toBeGreaterThanOrEqual(22); // >= 128 bits, base64url

    expect(identity.session(a.sessionId)).toMatchObject({ ok: true });
    clock += 61 * 60_000;
    expect(identity.session(a.sessionId)).toMatchObject({ ok: false });
    const ended = (await events("session/ended")).map((e) => e.payload);
    expect(ended).toContainEqual(expect.objectContaining({ reason: "idle" }));

    // Kept active, the absolute limit still ends it.
    const c = await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.1");
    if (!c.ok) throw new Error("sign-in failed");
    for (let h = 0; h < 28; h++) {
      clock += 50 * 60_000;
      expect(identity.session(c.sessionId)).toMatchObject({ ok: true });
    }
    clock += 50 * 60_000;
    expect(identity.session(c.sessionId)).toMatchObject({ ok: false });
    expect((await events("session/ended")).map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ reason: "expired" }),
    );
  });

  it("ends a person's sessions when their level is lowered, their password reset, or they are removed; removal revokes tokens", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    const join = async (email: string) => {
      const invite = identity.createInvite(admin.principal, { level: "member" });
      if (!invite.ok) throw new Error(invite.error);
      const r = await identity.acceptInvite(
        invite.id,
        { name: email.split("@")[0] ?? "x", email, password: PASSWORD },
        "10.0.0.9",
      );
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    const mo = await join("mo@northwind.test");
    await changeLevel(admin.principal, mo.principal, "stakeholder");
    expect(identity.session(mo.sessionId)).toMatchObject({ ok: false });

    const pat = await join("pat@northwind.test");
    identity.issuePasswordReset(admin.principal, pat.principal);
    expect(identity.session(pat.sessionId)).toMatchObject({ ok: false });

    const rem = await join("rem@northwind.test");
    const tok = identity.createToken(rem.principal, { name: "cli" });
    if (!tok.ok) throw new Error(tok.error);
    identity.remove(admin.principal, rem.principal);
    expect(identity.session(rem.sessionId)).toMatchObject({ ok: false });
    expect(identity.authenticateToken(tok.token)).toMatchObject({ ok: false });
    expect((await events("token/revoked")).length).toBe(1);

    // A second process sees the ledger, not this one's memory: a lowered level
    // recorded by another writer still ends the session.
    const other = newIdentity();
    const zed = await join("zed@northwind.test");
    const fresh = await identity.signIn("zed@northwind.test", PASSWORD, "10.0.0.9");
    if (!fresh.ok) throw new Error(fresh.error);
    expect(other.member(zed.principal)?.level).toBe("member");
    await changeLevel(admin.principal, zed.principal, "viewer");
    expect(identity.session(fresh.sessionId)).toMatchObject({ ok: false });

    // Raising a level rotates the session id instead.
    const up = await join("up@northwind.test");
    await changeLevel(admin.principal, up.principal, "admin");
    const rotated = identity.session(up.sessionId);
    expect(rotated).toMatchObject({ ok: true, level: "admin" });
    if (!rotated.ok) throw new Error("rotated");
    expect(rotated.rotatedTo).toBeDefined();
    expect(identity.session(up.sessionId)).toMatchObject({ ok: false });
  });

  it("a password reset link is single-use and records issue and use", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    const reset = identity.issuePasswordReset(admin.principal, admin.principal);
    if (!reset.ok) throw new Error(reset.error);
    const newPassword = "another long passphrase here";
    expect(await identity.usePasswordReset(reset.id, newPassword, "10.0.0.1")).toMatchObject({
      ok: true,
    });
    expect((await identity.usePasswordReset(reset.id, newPassword, "10.0.0.1")).ok).toBe(false);
    expect((await identity.signIn("ada@northwind.test", newPassword, "10.0.0.1")).ok).toBe(true);
    expect((await events("password/reset_issued")).length).toBe(1);
    expect((await events("password/changed")).length).toBe(2);
  });
});

describe("TEAM-34, TEAM-35: sign-in limits and refusal summaries", () => {
  it("backs off, locks the pair after 10 failures for 15 minutes, and locks the account at 100", async () => {
    const identity = newIdentity();
    await firstAdmin(identity);
    const fail = () => identity.signIn("ada@northwind.test", "wrong wrong wrong!!", "10.0.0.7");
    const first = await fail();
    expect(first).toMatchObject({ ok: false, status: 401 });
    // Back-off: an immediate retry is refused without checking the password.
    expect(await fail()).toMatchObject({ ok: false, status: 429 });
    for (let i = 1; i < 10; i++) {
      clock += 120_000;
      await fail();
    }
    clock += 120_000;
    expect(await fail()).toMatchObject({ ok: false, status: 429, reason: "pair_locked" });
    // Another address still reaches the account.
    expect((await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.8")).ok).toBe(true);
    clock += 15 * 60_000;
    expect((await identity.signIn("ada@northwind.test", PASSWORD, "10.0.0.7")).ok).toBe(true);

    // 100 consecutive failures, from many addresses, lock the account.
    for (let i = 0; i < 100; i++) {
      clock += 1000;
      await identity.signIn("ada@northwind.test", "wrong wrong wrong!!", `10.1.${i}.1`);
    }
    expect((await events("account/locked")).length).toBe(1);
    const locked = await identity.signIn("ada@northwind.test", PASSWORD, "10.2.0.1");
    expect(locked).toMatchObject({ ok: false, reason: "account_locked" });
  });

  it("writes one summary per account per 15-minute window and resumes the count after a restart", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    for (let i = 0; i < 60; i++) {
      clock += 1000;
      await identity.signIn("ada@northwind.test", "wrong wrong wrong!!", `10.3.${i}.1`);
    }
    // Unknown accounts summarise per address.
    await identity.signIn("nobody@northwind.test", "wrong wrong wrong!!", "10.9.9.9");
    clock += 1000;
    await identity.signIn("nobody2@northwind.test", "wrong wrong wrong!!", "10.9.9.9");
    clock += 15 * 60_000;
    identity.flushRefusals();
    const summaries = await events("session/refused");
    const forAda = summaries.filter((e) => e.principal === admin.principal);
    expect(forAda).toHaveLength(1);
    expect(forAda[0]?.payload).toMatchObject({ count: 60 });
    const unknown = summaries.filter((e) => e.principal === undefined);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.payload).toMatchObject({ count: 2 });
    expect(JSON.stringify(unknown[0]?.payload)).not.toContain("10.9.9.9");

    // Restart: a new process resumes at 60, so 40 more lock the account.
    await identity.close();
    const restarted = newIdentity();
    for (let i = 0; i < 40; i++) {
      clock += 1000;
      await restarted.signIn("ada@northwind.test", "wrong wrong wrong!!", `10.4.${i}.1`);
    }
    expect((await events("account/locked")).length).toBe(1);

    // An Admin unlocks it (a lock stops sign-in, not an Admin's other session or token).
    const unlocked = restarted.unlock(admin.principal, admin.principal);
    expect(unlocked.ok).toBe(true);
    expect((await events("account/unlocked")).length).toBe(1);
    expect((await restarted.signIn("ada@northwind.test", PASSWORD, "10.5.0.1")).ok).toBe(true);
  });

  it("limits setup-token and invite attempts per address", async () => {
    const identity = newIdentity();
    identity.ensureSetupToken();
    for (let i = 0; i < 10; i++) {
      clock += 120_000;
      await identity.presentSetupToken(
        "not-the-token",
        { name: "Eve", email: "eve@x.test", password: PASSWORD },
        "10.6.0.1",
      );
    }
    clock += 120_000;
    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    const blocked = await identity.presentSetupToken(
      token,
      { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
      "10.6.0.1",
    );
    expect(blocked).toMatchObject({ ok: false, status: 429 });

    for (let i = 0; i < 10; i++) {
      clock += 120_000;
      identity.showInvite(`guess-${i}`, "10.6.0.2");
    }
    clock += 120_000;
    expect(identity.showInvite("guess-x", "10.6.0.2")).toMatchObject({ ok: false, status: 429 });
  });
});

describe("TEAM-37: personal access tokens", () => {
  it("expire, never exceed a year, and act at the lower of scope and current level", async () => {
    const identity = newIdentity();
    const admin = await firstAdmin(identity);
    expect(identity.createToken(admin.principal, { name: "x", days: 400 })).toMatchObject({
      ok: false,
    });
    const scoped = identity.createToken(admin.principal, { name: "ci", level: "member" });
    const full = identity.createToken(admin.principal, { name: "full" });
    if (!scoped.ok || !full.ok) throw new Error("token");
    expect(identity.authenticateToken(scoped.token)).toMatchObject({ ok: true, level: "member" });
    expect(identity.authenticateToken(full.token)).toMatchObject({ ok: true, level: "admin" });
    // Used twice within an hour: recorded once.
    identity.authenticateToken(full.token);
    expect((await events("token/used")).length).toBe(2);

    // A second Admin first: the last one is never lowered.
    const invite = identity.createInvite(admin.principal, { level: "admin" });
    if (!invite.ok) throw new Error(invite.error);
    await identity.acceptInvite(
      invite.id,
      { name: "Bo", email: "bo@northwind.test", password: PASSWORD },
      "10.0.0.9",
    );
    await changeLevel(admin.principal, admin.principal, "viewer");
    expect(identity.authenticateToken(full.token)).toMatchObject({
      ok: true,
      level: "viewer",
      scope: "admin",
    });

    clock += 90 * 86_400_000 + 1;
    expect(identity.authenticateToken(full.token)).toMatchObject({ ok: false });
    expect(identity.authenticateToken("sekp_bogus_bogus")).toMatchObject({ ok: false });
  });
});

describe("TEAM-12, TEAM-38: the trusted proxy", () => {
  const settings = { sources: ["accounts", "proxy"] as const, trustedProxies: ["10.8.0.1"] };

  it("ignores the user header from an untrusted address and creates a new person pending", async () => {
    const identity = newIdentity({ ...settings, sources: [...settings.sources] });
    const admin = await firstAdmin(identity);
    const untrusted = identity.resolveHeaders(
      { "x-forwarded-email": "ada@northwind.test" },
      "10.8.0.2",
    );
    expect(untrusted).toMatchObject({ authenticated: false, status: 401 });
    const known = identity.resolveHeaders(
      { "x-forwarded-email": "ada@northwind.test" },
      "10.8.0.1",
    );
    expect(known).toMatchObject({ authenticated: true, principal: admin.principal, via: "proxy" });

    const stranger = identity.resolveHeaders(
      { "x-forwarded-email": "new@northwind.test" },
      "::ffff:10.8.0.1",
    );
    expect(stranger).toMatchObject({ authenticated: false, status: 403, reason: "pending" });
    const joined = (await events("member/joined")).at(-1);
    expect(joined?.payload).toMatchObject({ via: "proxy", pending: true });
    // The person the proxy vouched for joined as themselves (kernel rule 19).
    expect(joined?.principal).toBe(stranger.authenticated ? undefined : stranger.principal);

    if (stranger.authenticated || !stranger.principal) throw new Error("expected pending");
    identity.approve(admin.principal, stranger.principal, "member");
    expect(
      identity.resolveHeaders({ "x-forwarded-email": "new@northwind.test" }, "10.8.0.1"),
    ).toMatchObject({ authenticated: true, level: "member" });
  });

  it("joins a person with an invite for their email at the invite's level", async () => {
    const identity = newIdentity({ ...settings, sources: [...settings.sources] });
    const admin = await firstAdmin(identity);
    identity.createInvite(admin.principal, { level: "stakeholder", email: "sh@northwind.test" });
    expect(
      identity.resolveHeaders({ "x-forwarded-email": "SH@northwind.test" }, "10.8.0.1"),
    ).toMatchObject({ authenticated: true, level: "stakeholder" });
  });
});

describe("TEAM-1 and INT-26: Solo, and keys a repository cannot set", () => {
  it("Solo answers every request as the operating-system user's principal", () => {
    const identity = new Identity({
      db,
      log,
      dir,
      now,
      settings: identitySettings({ mode: "solo" }),
    });
    expect(identity.resolveHeaders({}, "127.0.0.1")).toEqual({
      authenticated: true,
      principal: log.localPrincipal(),
      level: "admin",
      via: "solo",
    });
    expect(bindHost("solo", undefined, identitySettings({ mode: "solo" }))).toBe("127.0.0.1");
    expect(() => bindHost("solo", "0.0.0.0", identitySettings({ mode: "solo" }))).toThrow(
      /loopback/,
    );
    expect(() => bindHost("team", "0.0.0.0", identitySettings({ mode: "team" }))).toThrow(
      /TLS|trusted_proxies/,
    );
    expect(
      bindHost("team", "0.0.0.0", identitySettings({ mode: "team", trustedProxies: ["10.0.0.1"] })),
    ).toBe("0.0.0.0");
  });

  it("ignores [identity], [team], [sessions], [tokens] and [queue] in a repository's config", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const hostile = [
      "[team]",
      'mode = "team"',
      'workspace = "Evil"',
      "[identity]",
      'trusted_proxies = ["0.0.0.0"]',
      'user_header = "x-evil"',
      "[sessions]",
      "idle_minutes = 99999",
      "[tokens]",
      "max_days = 99999",
      "[queue]",
      "agent_issues_per_person = 50",
      "",
    ].join("\n");
    writeFileSync(join(repo, ".sekhemet", "config.toml"), hostile);
    const userPath = join(root, "user.toml");
    writeFileSync(
      userPath,
      '[team]\nmode = "team"\nworkspace = "Northwind"\n[identity]\ntrusted_proxies = ["10.8.0.1"]\n[sessions]\nidle_minutes = 30\n',
    );
    const { config } = resolveConfig({ repoPath: repo, userConfigPath: userPath });
    expect(config.team).toEqual({ mode: "team", workspace: "Northwind" });
    expect(config.identity.trustedProxies).toEqual(["10.8.0.1"]);
    expect(config.identity.userHeader).toBe("x-forwarded-email");
    expect(config.sessions).toEqual({ idleMinutes: 30, absoluteHours: 24 });
    expect(config.tokens).toEqual({ defaultDays: 90, maxDays: 365 });
    expect(config.queue).toEqual({ agentIssuesPerPerson: 1 });
  });
});

describe("the endpoints (teams §3) on a real server", () => {
  let server: { port: number; close: () => Promise<void> } | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(overrides: Partial<IdentitySettings> = {}) {
    const cardStore = new CardStore(db, log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      identity: {
        dir,
        now,
        passwordList: LIST(),
        settings: identitySettings({ mode: "team", workspace: "Northwind", ...overrides }),
      },
    });
    vi.mocked(console.log).mockRestore();
    return `http://127.0.0.1:${server.port}`;
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...headers },
      body: JSON.stringify(body),
    });
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  it("signs in with the setup token, invites, accepts, signs in, and protects the rest with 401", async () => {
    const base = await start();
    expect((await fetch(`${base}/api/board`)).status).toBe(401);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);

    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    const setup = await post(`${base}/api/setup`, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    });
    expect(setup.status).toBe(200);
    const setCookie = setup.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-sekhemet_session=/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    const { csrf } = (await setup.json()) as { csrf: string };
    const cookie = cookieOf(setup);

    const me = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    expect(await me.json()).toMatchObject({ mode: "team", signedIn: true, level: "admin" });
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: cookie } })).status).toBe(200);

    // A cookie mutation without the session's CSRF token is refused.
    expect(
      (await post(`${base}/api/invites`, { level: "member" }, { Cookie: cookie })).status,
    ).toBe(403);
    const inv = await post(
      `${base}/api/invites`,
      { level: "member" },
      { Cookie: cookie, "X-Sekhemet-CSRF": csrf },
    );
    expect(inv.status).toBe(200);
    const { id } = (await inv.json()) as { id: string };

    const shown = await fetch(`${base}/api/invites/${id}`);
    expect(await shown.json()).toMatchObject({ workspace: "Northwind", level: "member" });
    const accepted = await post(`${base}/api/invites/${id}/accept`, {
      name: "Mo Member",
      email: "mo@northwind.test",
      password: PASSWORD,
    });
    expect(accepted.status).toBe(200);
    expect(
      (
        await post(`${base}/api/invites/${id}/accept`, {
          name: "Eve",
          email: "eve@northwind.test",
          password: PASSWORD,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    // The member signs in with a password; a weak one is refused with its rule.
    const signIn = await post(`${base}/api/session`, {
      email: "mo@northwind.test",
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const moCookie = cookieOf(signIn);
    const moCsrf = ((await signIn.json()) as { csrf: string }).csrf;
    expect(
      (
        await post(
          `${base}/api/invites`,
          { level: "member" },
          { Cookie: moCookie, "X-Sekhemet-CSRF": moCsrf },
        )
      ).status,
    ).toBe(403);

    // A personal token for the CLI: bearer, no CSRF needed.
    const tok = await post(
      `${base}/api/tokens`,
      { name: "cli", level: "viewer" },
      { Cookie: moCookie, "X-Sekhemet-CSRF": moCsrf },
    );
    const { token: pat, id: tokenId } = (await tok.json()) as { token: string; id: string };
    const viaToken = await fetch(`${base}/api/session`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    // A viewer-scoped token mints nothing stronger than itself.
    const stronger = await post(
      `${base}/api/tokens`,
      { name: "more", level: "member" },
      { Authorization: `Bearer ${pat}` },
    );
    expect(stronger.status).toBe(403);
    expect(await viaToken.json()).toMatchObject({ signedIn: true, level: "viewer", via: "token" });
    const revoked = await fetch(`${base}/api/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Cookie: moCookie, "X-Sekhemet-CSRF": moCsrf, "X-Sekhemet-Action": "1" },
    });
    expect(revoked.status).toBe(200);
    expect(
      (await fetch(`${base}/api/board`, { headers: { Authorization: `Bearer ${pat}` } })).status,
    ).toBe(401);

    // Sign out ends the session.
    const out = await fetch(`${base}/api/session`, {
      method: "DELETE",
      headers: { Cookie: moCookie, "X-Sekhemet-CSRF": moCsrf, "X-Sekhemet-Action": "1" },
    });
    expect(out.status).toBe(200);
    expect((await fetch(`${base}/api/board`, { headers: { Cookie: moCookie } })).status).toBe(401);

    // The Admin unlocks and resets a member.
    const members = (await (
      await fetch(`${base}/api/members`, { headers: { Cookie: cookie } })
    ).json()) as { members: { principal: string; level: string }[] };
    const mo = members.members.find((m) => m.level === "member");
    expect(mo).toBeDefined();
    const adminHeaders = { Cookie: cookie, "X-Sekhemet-CSRF": csrf };
    // The Admin's own token scoped to Member cannot do an Admin's work.
    const memberScoped = (await (
      await post(`${base}/api/tokens`, { name: "ci", level: "member" }, adminHeaders)
    ).json()) as { token: string };
    expect(
      (
        await post(
          `${base}/api/invites`,
          { level: "viewer" },
          { Authorization: `Bearer ${memberScoped.token}` },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(`${base}/api/members/${mo?.principal}/unlock`, {}, adminHeaders)).status,
    ).toBe(200);
    const reset = await post(
      `${base}/api/members/${mo?.principal}/password-reset`,
      {},
      adminHeaders,
    );
    expect(reset.status).toBe(200);
    const { id: resetId } = (await reset.json()) as { id: string };
    expect(
      (
        await post(`${base}/api/password-reset/${resetId}`, {
          password: "a brand new long passphrase",
        })
      ).status,
    ).toBe(200);
  });

  it("lists the person's own tokens and sessions, ends one session, and says who is signed in", async () => {
    const base = await start();
    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    const setup = await post(`${base}/api/setup`, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    });
    const { csrf } = (await setup.json()) as { csrf: string };
    const headers = { Cookie: cookieOf(setup), "X-Sekhemet-CSRF": csrf };
    const other = await post(`${base}/api/session`, {
      email: "ada@northwind.test",
      password: PASSWORD,
    });
    expect(other.status).toBe(200);

    const me = (await (await fetch(`${base}/api/session`, { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(me).toMatchObject({
      name: "Ada Admin",
      email: "ada@northwind.test",
      workspace: "Northwind",
    });
    expect(me.company).toBeUndefined();

    const made = (await (
      await post(`${base}/api/tokens`, { name: "laptop cli", level: "member" }, headers)
    ).json()) as { id: string; token: string };
    const tokens = (await (await fetch(`${base}/api/tokens`, { headers })).json()) as {
      tokens: Record<string, unknown>[];
    };
    expect(tokens.tokens).toEqual([
      { id: made.id, name: "laptop cli", level: "member", expires: expect.any(String) },
    ]);
    expect(JSON.stringify(tokens)).not.toContain(made.token.split("_").at(-1));

    const listed = (await (await fetch(`${base}/api/sessions`, { headers })).json()) as {
      sessions: { ref: string; created: string; lastSeen: string; current: boolean }[];
    };
    expect(listed.sessions).toHaveLength(2);
    expect(listed.sessions.filter((x) => x.current)).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(cookieOf(setup).split("=")[1]);
    const theOther = listed.sessions.find((x) => !x.current);
    const ended = await fetch(`${base}/api/sessions/${theOther?.ref}`, {
      method: "DELETE",
      headers: { ...headers, "X-Sekhemet-Action": "1" },
    });
    expect(ended.status).toBe(200);
    expect(
      (await fetch(`${base}/api/board`, { headers: { Cookie: cookieOf(other) } })).status,
    ).toBe(401);
    const last = (await events("session/ended")).at(-1);
    expect(last?.payload).toMatchObject({ session: theOther?.ref, reason: "revoked" });
  });

  it("serves the page at an invite link and a password-reset link", async () => {
    const base = await start();
    for (const path of ["/invite/abc_DEF-123", "/password-reset/abc_DEF-123"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
    }
  });

  it("the resolver binds each request: requester(req) inside the server", async () => {
    // requester() without a server-bound request is unauthenticated.
    const fake = {} as Parameters<typeof requester>[0];
    expect(requester(fake)).toMatchObject({ authenticated: false, status: 401 });
  });

  it("TEAM-12 over HTTP: a user header from an untrusted address answers 401", async () => {
    const base = await start({ sources: ["accounts", "proxy"], trustedProxies: ["10.99.0.1"] });
    const res = await fetch(`${base}/api/board`, {
      headers: { "X-Forwarded-Email": "ada@northwind.test" },
    });
    expect(res.status).toBe(401);
  });
});

describe("M6: a Team install never falls back to Solo by accident", () => {
  it("refuses to start in Solo once the ledger has a member or the credential store exists, until a switch back is recorded", async () => {
    const cardStore = new CardStore(db, log);
    const solo = () =>
      startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(cardStore),
        cardStore,
        repoPath: root,
        port: 0,
        identity: { dir, settings: identitySettings({ mode: "solo" }) },
      });
    expect(soloStartBlocked(db, dir)).toBeUndefined();

    // A credential store alone is enough: Solo would make every request an Admin.
    const identity = newIdentity();
    vi.spyOn(console, "log").mockImplementation(() => {});
    identity.ensureSetupToken();
    vi.mocked(console.log).mockRestore();
    expect(soloStartBlocked(db, dir)).toMatch(/\[team\] mode = "team"/);
    await expect(solo()).rejects.toThrow(/will not start in Solo/);

    await firstAdmin(identity);
    await expect(solo()).rejects.toThrow(/--switch-to-solo/);
    recordSwitchToSolo(log);
    const switched = (await events("setup/switched")).at(-1);
    expect(switched?.payload).toEqual({ to: "solo" });
    expect(switched?.principal).toBe(log.localPrincipal());
    expect(soloStartBlocked(db, dir)).toBeUndefined();
    const server = await solo();
    await server.close();

    // A member who joins after the switch back needs another.
    identity.createInvite(identity.members()[0]?.principal ?? "", { level: "viewer" });
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal: "p_late1",
      payload: { principal: "p_late1", level: "viewer", via: "invite", pending: false },
    });
    expect(soloStartBlocked(db, dir)).toMatch(/will not start in Solo/);
  });

  it("treats an unreadable or malformed user config as an error, never as Solo", () => {
    const path = join(root, "user-config.toml");
    const saved = process.env.SEKHEMET_USER_CONFIG;
    process.env.SEKHEMET_USER_CONFIG = path;
    try {
      expect(userConfigError()).toBeUndefined();
      writeFileSync(path, '[team]\nmode = "team"\n');
      expect(userConfigError()).toBeUndefined();
      expect(openLocalLedger(root).log.appendNow).toBeDefined();
      writeFileSync(path, "[team\nmode = team = solo\n");
      expect(userConfigError()).toMatch(/user-config\.toml/);
      expect(() => openLocalLedger(root)).toThrow(/user config/);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
      else process.env.SEKHEMET_USER_CONFIG = saved;
    }
  });

  it("opens a Team install's ledger in the Team setup, so a person's event without a principal is refused", () => {
    const path = join(root, "user-config.toml");
    const saved = process.env.SEKHEMET_USER_CONFIG;
    process.env.SEKHEMET_USER_CONFIG = path;
    writeFileSync(path, '[team]\nmode = "team"\n');
    try {
      const opened = openLocalLedger(root);
      expect(() => opened.log.appendNow({ actor: "human", type: "x/y", payload: {} })).toThrow(
        /principal/,
      );
      opened.db.close();
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
      else process.env.SEKHEMET_USER_CONFIG = saved;
    }
  });
});
