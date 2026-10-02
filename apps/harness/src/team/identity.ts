import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
import { CredentialStore, writePrivateFile } from "./credential_store.js";
import { type RefusalReason, SignInLimits } from "./limits.js";
import {
  type MemberState,
  allMembers,
  hasAdmin,
  memberOf,
  personByEmail,
  personEmail,
  personName,
  sessionEventsSince,
} from "./members.js";
import { checkPassword, dummyHash, hashPassword, verifyPassword } from "./passwords.js";
import { type Requester, UNAUTHENTICATED } from "./requester.js";
import {
  type IdentitySettings,
  type Level,
  isLevel,
  isTrustedProxy,
  levelRank,
  lowerLevel,
  normalAddress,
} from "./settings.js";

/**
 * Identity for the Team setup (teams §2.1, §2.3; NEW-teams-1, NEW-teams-3):
 * the setup token, invites, local accounts and their sessions, the sign-in
 * limits, personal access tokens, password resets and the trusted proxy.
 * Credentials live in the credential store; the event log records only that
 * they were created, used, reset or revoked (TEAM-11). Names and emails go
 * only in the private part of `person/created` (kernel rule 19).
 */

export const SESSION_COOKIE = "__Host-sekhemet_session";
export const SETUP_TOKEN_FILE = "setup-token";
export const SETUP_TOKEN_HOURS = 24;
export const RESET_LINK_HOURS = 24;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type Failure = {
  ok: false;
  status: number;
  error: string;
  reason?: string;
  rule?: string;
  retryAfterMs?: number;
};

export type SignedIn = {
  ok: true;
  principal: string;
  level: Level;
  sessionId: string;
  csrf: string;
  cookie: string;
};

export type SessionCheck =
  | { ok: true; principal: string; level: Level; csrf: string; ref: string; rotatedTo?: string }
  | { ok: false; reason: string };

interface Session {
  ref: string;
  principal: string;
  level: Level;
  createdAt: number;
  lastSeen: number;
  seq: number;
  csrf: string;
}

export interface PersonDetails {
  name: string;
  email: string;
  password: string;
}

export interface IdentityOptions {
  db: DatabaseSync;
  log: EventLog;
  settings: IdentitySettings;
  /** The credential store's directory (0700). */
  dir: string;
  now?: () => number;
  /** The common-password list; the bundled one by default. */
  passwordList?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ref = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;
const secret = () => randomBytes(32).toString("base64url");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * A refusal said to a person over HTTP (the Sign in page, the CLI): no
 * model reads it, so it is not an observation (context CX-M1-13).
 */
function failure(status: number, error: string, extra: Partial<Failure> = {}): Failure {
  return { ok: false, status, error, ...extra };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class Identity {
  private storeInstance: CredentialStore | undefined;
  private readonly dir: string;
  public readonly limits: SignInLimits;
  public readonly settings: IdentitySettings;
  public readonly db: DatabaseSync;
  private readonly log: EventLog;
  private readonly now: () => number;
  private readonly passwordList: string | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly tokenUsed = new Map<string, number>();

  constructor(options: IdentityOptions) {
    this.db = options.db;
    this.log = options.log;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.passwordList = options.passwordList;
    this.dir = options.dir;
    this.limits = new SignInLimits(this.db, this.log, this.now);
  }

  /** The credential store, opened (and its modes corrected) on first use: Solo never touches it. */
  public get store(): CredentialStore {
    this.storeInstance ??= new CredentialStore(this.dir);
    return this.storeInstance;
  }

  public get mode(): "solo" | "team" {
    return this.settings.mode;
  }

  public get setupTokenPath(): string {
    return join(this.dir, SETUP_TOKEN_FILE);
  }

  public hasAdmin(): boolean {
    return hasAdmin(this.db);
  }

  public member(principal: string): MemberState | undefined {
    return memberOf(this.db, principal);
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private checkPolicy(details: { name?: string; email?: string }, password: string) {
    return checkPassword(password, {
      ...(details.name ? { name: details.name } : {}),
      ...(details.email ? { email: details.email } : {}),
      workspace: this.settings.workspace,
      ...(this.passwordList ? { listPath: this.passwordList } : {}),
    });
  }

  private limited(subject: string, address: string): Failure | undefined {
    const verdict = this.limits.check(subject, address);
    if (verdict.allowed) return undefined;
    if (verdict.reason === "account_locked") {
      return failure(
        403,
        "This account is locked after too many failed sign-ins; an Admin can unlock it.",
        {
          reason: "account_locked",
        },
      );
    }
    return failure(429, "Too many attempts; wait and try again.", {
      reason: verdict.reason,
      ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}),
    });
  }

  private failAttempt(subject: string, address: string, reason: RefusalReason): void {
    this.limits.fail(subject, address, reason);
  }

  /** A person record, created when the email names none yet; names stay private. */
  private personFor(details: { name?: string; email: string }, preferred?: string): string {
    // An email already recorded keeps its person, so sign-in by email finds one principal.
    const existing = personByEmail(this.db, details.email);
    if (existing) return existing;
    const principal = preferred ?? `p_${randomBytes(12).toString("hex")}`;
    const personal: Record<string, string> = { email: details.email.trim() };
    if (details.name?.trim()) personal.name = details.name.trim();
    this.log.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal },
      principal,
      private: personal,
    });
    return principal;
  }

  // ---------------------------------------------------------------- setup

  /** The Solo install's recorded person, when it is not a member yet (TEAM-3). */
  private soloPrincipal(): string | undefined {
    const row = this.db
      .prepare(
        "SELECT principal FROM events WHERE type = 'person/created' AND principal IS NOT NULL AND json_extract(payload, '$.local') = 1 ORDER BY seq DESC LIMIT 1",
      )
      .get() as { principal: string } | undefined;
    if (!row) return undefined;
    return memberOf(this.db, row.principal) ? undefined : row.principal;
  }

  private writeSetupToken(): string {
    const token = `seks_${secret()}`;
    this.store.update((f) => {
      f.setupToken = {
        hash: sha256(token),
        createdAt: this.iso(),
        expires: this.iso(SETUP_TOKEN_HOURS * HOUR),
      };
    });
    writePrivateFile(this.setupTokenPath, `${token}\n`);
    return this.setupTokenPath;
  }

  /**
   * On a Team start with no Admin (TEAM-2): write the one-time setup token
   * to a 0600 file, unless a live one is already there, and print only the
   * file's path — never the token, so container logs never hold it.
   */
  public ensureSetupToken(): { path?: string; written: boolean; expired?: boolean } {
    if (this.mode !== "team" || this.hasAdmin()) return { written: false };
    const current = this.store.read().setupToken;
    if (current && existsSync(this.setupTokenPath)) {
      if (Date.parse(current.expires) <= this.now()) {
        console.log(
          "The setup token has expired. Run `sekhemet serve --new-setup-token` to write a new one.",
        );
        return { path: this.setupTokenPath, written: false, expired: true };
      }
      console.log(
        `Setup token: ${this.setupTokenPath} (sign in with it to create the first Admin).`,
      );
      return { path: this.setupTokenPath, written: false };
    }
    const path = this.writeSetupToken();
    console.log(
      `Setup token written to ${path} (mode 0600, valid ${SETUP_TOKEN_HOURS} hours); sign in with it to create the first Admin.`,
    );
    return { path, written: true };
  }

  /** `serve --new-setup-token` (TEAM-31): a new token voiding the old, only while no Admin exists. */
  public newSetupToken(): { ok: true; path: string } | Failure {
    if (this.hasAdmin()) {
      return failure(409, "An Admin exists: the setup token is spent, and no new one is written.");
    }
    return { ok: true, path: this.writeSetupToken() };
  }

  /** Present the setup token: creates the first Admin and voids the token (TEAM-2). */
  public async presentSetupToken(
    token: string,
    details: PersonDetails,
    rawAddress: string,
  ): Promise<SignedIn | Failure> {
    const address = normalAddress(rawAddress);
    if (this.hasAdmin()) return failure(403, "The setup token is spent: an Admin exists.");
    const limited = this.limited("setup", address);
    if (limited) return limited;
    const stored = this.store.read().setupToken;
    if (!stored || !sameHash(sha256(String(token).trim()), stored.hash)) {
      this.failAttempt("setup", address, "bad_setup_token");
      return failure(403, "That is not the setup token.");
    }
    if (Date.parse(stored.expires) <= this.now()) {
      return failure(
        403,
        "The setup token is more than 24 hours old. Run `sekhemet serve --new-setup-token` for a new one.",
        { reason: "expired" },
      );
    }
    const refused = this.detailsProblem(details);
    if (refused) return refused;
    const hash = await hashPassword(details.password);
    // Re-checked after the await: two presentations cannot both succeed.
    const again = this.store.read().setupToken;
    if (this.hasAdmin() || !again || again.hash !== stored.hash) {
      return failure(403, "The setup token is spent.");
    }
    const principal = this.personFor(details, this.soloPrincipal());
    this.store.update((f) => {
      f.passwords[principal] = { hash, setAt: this.iso() };
      f.setupToken = undefined;
    });
    rmSync(this.setupTokenPath, { force: true });
    this.log.appendNow({
      actor: "human",
      type: "member/joined",
      payload: { principal, level: "admin", via: "setup", pending: false },
      principal,
    });
    this.log.appendNow({
      actor: "human",
      type: "password/changed",
      payload: { principal, via: "setup" },
      principal,
    });
    this.limits.succeed("setup", address);
    return this.startSession(principal, "admin", "setup");
  }

  private detailsProblem(details: Partial<PersonDetails>): Failure | undefined {
    const email = typeof details.email === "string" ? details.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return failure(400, "An email address is needed.");
    if (typeof details.name !== "string" || !details.name.trim()) {
      return failure(400, "A name is needed.");
    }
    const check = this.checkPolicy(
      { name: details.name, email },
      typeof details.password === "string" ? details.password : "",
    );
    if (!check.ok) return failure(400, check.message, { rule: check.rule });
    return undefined;
  }

  // ---------------------------------------------------------------- sessions

  private startSession(principal: string, level: Level, method: string): SignedIn {
    const sessionId = secret();
    const csrf = secret();
    const sessionRef = ref("s");
    this.log.appendNow({
      actor: "human",
      type: "session/started",
      payload: { session: sessionRef, method },
      principal,
    });
    const t = this.now();
    this.sessions.set(sha256(sessionId), {
      ref: sessionRef,
      principal,
      level,
      createdAt: t,
      lastSeen: t,
      seq: this.log.lastSeq(),
      csrf,
    });
    return { ok: true, principal, level, sessionId, csrf, cookie: this.cookie(sessionId) };
  }

  /** The session cookie (TEAM-10): `__Host-`, Secure, HttpOnly, SameSite=Strict. */
  public cookie(sessionId: string): string {
    return `${SESSION_COOKIE}=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${this.settings.absoluteHours * 3600}`;
  }

  public clearedCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  /** Start a session for a person another method authenticated (passkey, OIDC). */
  public signInAs(principal: string, method: "passkey" | "oidc"): SignedIn | Failure {
    const member = memberOf(this.db, principal);
    if (!member || member.removed) return failure(401, "No such member.");
    if (member.pending)
      return failure(403, "An Admin has not approved this account yet.", { reason: "pending" });
    if (this.limits.accountLocked(principal)) {
      return failure(403, "This account is locked; an Admin can unlock it.", {
        reason: "account_locked",
      });
    }
    this.limits.succeed(`acct:${principal}`, "");
    return this.startSession(principal, member.level, method);
  }

  private endSession(key: string, session: Session, reason: string): void {
    this.sessions.delete(key);
    this.log.appendNow({
      actor: reason === "signed_out" ? "human" : "harness",
      type: "session/ended",
      payload: { session: session.ref, reason },
      principal: session.principal,
    });
  }

  private endSessionsOf(principal: string, reason: string): void {
    for (const [key, s] of [...this.sessions]) {
      if (s.principal === principal) this.endSession(key, s, reason);
    }
  }

  /**
   * A session by its id (TEAM-10, TEAM-36): ended when idle or too old, or
   * when the ledger holds a newer lowered level, removal or password reset
   * for the person; a raised level issues a new id (`rotatedTo`).
   */
  public session(sessionId: string): SessionCheck {
    const key = sha256(sessionId);
    const s = this.sessions.get(key);
    if (!s) return { ok: false, reason: "unknown" };
    const t = this.now();
    if (t - s.createdAt >= this.settings.absoluteHours * HOUR) {
      this.endSession(key, s, "expired");
      return { ok: false, reason: "expired" };
    }
    if (t - s.lastSeen >= this.settings.idleMinutes * 60_000) {
      this.endSession(key, s, "idle");
      return { ok: false, reason: "idle" };
    }
    let rotate = false;
    for (const ev of sessionEventsSince(this.db, s.principal, s.seq)) {
      const reason =
        ev.type === "member/removed"
          ? "removed"
          : ev.type === "password/reset_issued"
            ? "password_reset"
            : ev.type === "password/changed"
              ? "password_changed"
              : isLevel(ev.level) && levelRank(ev.level) < levelRank(s.level)
                ? "level_lowered"
                : undefined;
      if (reason) {
        this.endSession(key, s, reason);
        return { ok: false, reason };
      }
      rotate = true;
    }
    const member = memberOf(this.db, s.principal);
    if (!member || member.removed || member.pending) {
      this.endSession(key, s, "removed");
      return { ok: false, reason: "removed" };
    }
    s.lastSeen = t;
    s.level = member.level;
    s.seq = this.log.lastSeq();
    if (!rotate)
      return { ok: true, principal: s.principal, level: s.level, csrf: s.csrf, ref: s.ref };
    // A change of level: a new session id (TEAM-10); the old one stops working.
    const next = secret();
    this.sessions.delete(key);
    this.sessions.set(sha256(next), s);
    return {
      ok: true,
      principal: s.principal,
      level: s.level,
      csrf: s.csrf,
      ref: s.ref,
      rotatedTo: next,
    };
  }

  /** End idle and too-old sessions on the server, with no request to notice them. */
  public sweep(): void {
    const t = this.now();
    for (const [key, s] of [...this.sessions]) {
      if (t - s.createdAt >= this.settings.absoluteHours * HOUR) this.endSession(key, s, "expired");
      else if (t - s.lastSeen >= this.settings.idleMinutes * 60_000)
        this.endSession(key, s, "idle");
    }
  }

  public signOut(sessionId: string): boolean {
    const key = sha256(sessionId);
    const s = this.sessions.get(key);
    if (!s) return false;
    this.endSession(key, s, "signed_out");
    return true;
  }

  // ---------------------------------------------------------------- sign-in

  /** Email and password (teams item 11), under the limits of item 14a. */
  public async signIn(
    email: string,
    password: string,
    rawAddress: string,
  ): Promise<SignedIn | Failure> {
    const address = normalAddress(rawAddress);
    if (this.mode !== "team") return failure(409, "Solo has no sign-in.");
    if (!this.hasAdmin()) {
      return failure(403, "No Admin exists yet: the first Admin signs in with the setup token.", {
        reason: "no_admin",
      });
    }
    if (!this.settings.sources.includes("accounts")) {
      return failure(403, "Local accounts are off on this server.");
    }
    const principal = typeof email === "string" ? personByEmail(this.db, email) : undefined;
    const subject = principal ? `acct:${principal}` : `addr:${address}`;
    const limited = this.limited(subject, address);
    if (limited) return limited;
    const stored = principal ? this.store.read().passwords[principal]?.hash : undefined;
    const valid = await verifyPassword(String(password ?? ""), stored ?? (await dummyHash()));
    const member = principal ? memberOf(this.db, principal) : undefined;
    if (!valid || !stored || !principal || !member || member.removed) {
      this.failAttempt(subject, address, principal ? "bad_credentials" : "unknown_account");
      return failure(401, "The email or password is wrong.", { reason: "bad_credentials" });
    }
    if (member.pending) {
      return failure(403, "An Admin has not approved this account yet.", { reason: "pending" });
    }
    this.limits.succeed(subject, address);
    return this.startSession(principal, member.level, "password");
  }

  /** Write every refusal summary whose window has ended (the server calls this on a timer). */
  public flushRefusals(): void {
    this.limits.flush();
  }

  /** Shutdown: every open summary is written, so a restart resumes the counts (TEAM-35). */
  public async close(): Promise<void> {
    this.limits.flush(true);
  }

  // ---------------------------------------------------------------- admin

  private requireAdmin(actor: string, action: string): Failure | undefined {
    const m = memberOf(this.db, actor);
    if (!m || m.removed || m.pending || m.level !== "admin") {
      return failure(403, `Only an Admin can ${action}. An Admin can grant it.`, {
        reason: "forbidden",
      });
    }
    return undefined;
  }

  private target(principal: string): MemberState | Failure {
    const m = memberOf(this.db, principal);
    if (!m || m.removed) return failure(404, "No such member.");
    return m;
  }

  public members(): (MemberState & { name?: string; email?: string })[] {
    return allMembers(this.db)
      .filter((m) => !m.removed)
      .map((m) => {
        const name = personName(this.db, m.principal);
        const email = personEmail(this.db, m.principal);
        return { ...m, ...(name ? { name } : {}), ...(email ? { email } : {}) };
      });
  }

  public approve(actor: string, principal: string, level?: Level): { ok: true } | Failure {
    const denied = this.requireAdmin(actor, "approve people");
    if (denied) return denied;
    const m = this.target(principal);
    if (!("principal" in m)) return m;
    this.log.appendNow({
      actor: "human",
      type: "member/approved",
      payload: { principal, ...(level ? { level } : {}) },
      principal: actor,
    });
    return { ok: true };
  }

  /** Removal ends every session and revokes every personal access token (TEAM-36). */
  public remove(actor: string, principal: string): { ok: true } | Failure {
    const denied = this.requireAdmin(actor, "remove members");
    if (denied) return denied;
    const m = this.target(principal);
    if (!("principal" in m)) return m;
    const admins = allMembers(this.db).filter(
      (x) => x.level === "admin" && !x.pending && !x.removed,
    );
    if (m.level === "admin" && admins.every((x) => x.principal === principal)) {
      return failure(409, "This is the last Admin: name another Admin before removing this one.", {
        reason: "last_admin",
      });
    }
    const tokens = this.store.update((f) => {
      const mine = Object.entries(f.tokens).filter(([, t]) => t.principal === principal);
      for (const [id] of mine) delete f.tokens[id];
      delete f.passwords[principal];
      delete f.passkeys[principal];
      return mine.map(([id]) => id);
    });
    for (const token of tokens) {
      this.log.appendNow({
        actor: "human",
        type: "token/revoked",
        payload: { token, reason: "member_removed" },
        principal: actor,
      });
    }
    this.log.appendNow({
      actor: "human",
      type: "member/removed",
      payload: { principal },
      principal: actor,
    });
    this.endSessionsOf(principal, "removed");
    return { ok: true };
  }

  public unlock(actor: string, principal: string): { ok: true } | Failure {
    const denied = this.requireAdmin(actor, "unlock accounts");
    if (denied) return denied;
    const m = this.target(principal);
    if (!("principal" in m)) return m;
    this.limits.unlocked(principal);
    this.log.appendNow({
      actor: "human",
      type: "account/unlocked",
      payload: { principal },
      principal: actor,
    });
    return { ok: true };
  }

  /** A single-use reset link an Admin issues (teams item 11); the person's sessions end. */
  public issuePasswordReset(
    actor: string,
    principal: string,
  ): { ok: true; id: string; expires: string } | Failure {
    const denied = this.requireAdmin(actor, "reset passwords");
    if (denied) return denied;
    const m = this.target(principal);
    if (!("principal" in m)) return m;
    const id = secret();
    const expires = this.iso(RESET_LINK_HOURS * HOUR);
    this.store.update((f) => {
      for (const [h, r] of Object.entries(f.resets))
        if (r.principal === principal) delete f.resets[h];
      f.resets[sha256(id)] = { ref: ref("r"), principal, expires };
    });
    this.log.appendNow({
      actor: "human",
      type: "password/reset_issued",
      payload: { principal, expires },
      principal: actor,
    });
    this.endSessionsOf(principal, "password_reset");
    return { ok: true, id, expires };
  }

  public async usePasswordReset(
    id: string,
    password: string,
    rawAddress: string,
  ): Promise<{ ok: true } | Failure> {
    const address = normalAddress(rawAddress);
    const key = sha256(String(id));
    const entry = this.store.read().resets[key];
    const subject = entry ? `reset:${entry.ref}` : "reset:?";
    const limited = this.limited(subject, address);
    if (limited) return limited;
    if (!entry?.principal) {
      this.failAttempt(subject, address, "bad_reset_link");
      return failure(404, "That reset link is not valid.");
    }
    if (Date.parse(entry.expires) <= this.now())
      return failure(410, "That reset link has expired.");
    const principal = entry.principal;
    const name = personName(this.db, principal);
    const email = personEmail(this.db, principal);
    const check = this.checkPolicy(
      { ...(name ? { name } : {}), ...(email ? { email } : {}) },
      password,
    );
    if (!check.ok) return failure(400, check.message, { rule: check.rule });
    const hash = await hashPassword(password);
    const used = this.store.update((f) => {
      if (!f.resets[key]) return true;
      delete f.resets[key];
      f.passwords[principal] = { hash, setAt: this.iso() };
      return false;
    });
    if (used) return failure(404, "That reset link was already used.");
    this.log.appendNow({
      actor: "human",
      type: "password/changed",
      payload: { principal, via: "reset" },
      principal,
    });
    this.endSessionsOf(principal, "password_changed");
    this.limits.succeed(subject, address);
    return { ok: true };
  }

  // ---------------------------------------------------------------- invites

  public createInvite(
    actor: string,
    input: { level: Level; project?: string; email?: string; days?: number },
  ): { ok: true; id: string; ref: string; expires: string } | Failure {
    const denied = this.requireAdmin(actor, "invite people");
    if (denied) return denied;
    if (!isLevel(input.level))
      return failure(400, "An invite carries a level: admin, member, stakeholder or viewer.");
    const days = input.days ?? this.settings.inviteTtlDays;
    if (!Number.isFinite(days) || days <= 0 || days > 30) {
      return failure(400, "An invite expires within 30 days.");
    }
    const id = secret();
    const inviteRef = ref("inv");
    const expires = this.iso(days * DAY);
    this.store.update((f) => {
      f.invites[sha256(id)] = { ref: inviteRef, expires };
    });
    const email = input.email?.trim();
    this.log.appendNow({
      actor: "human",
      type: "member/invited",
      payload: {
        invite: inviteRef,
        level: input.level,
        expires,
        ...(input.project ? { project: input.project } : {}),
      },
      principal: actor,
      ...(email ? { private: { email } } : {}),
    });
    return { ok: true, id, ref: inviteRef, expires };
  }

  private inviteRecord(
    inviteRef: string,
  ): { level: Level; project?: string; expires: string; by?: string; used: boolean } | undefined {
    const row = this.db
      .prepare(
        "SELECT payload, principal FROM events WHERE type = 'member/invited' AND json_extract(payload, '$.invite') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(inviteRef) as { payload: string; principal: string | null } | undefined;
    if (!row) return undefined;
    const p = JSON.parse(row.payload) as { level: string; project?: string; expires: string };
    if (!isLevel(p.level)) return undefined;
    const used = this.db
      .prepare(
        "SELECT 1 AS u FROM events WHERE type = 'member/joined' AND json_extract(payload, '$.invite') = ? LIMIT 1",
      )
      .get(inviteRef) as { u: number } | undefined;
    return {
      level: p.level,
      expires: p.expires,
      used: used !== undefined,
      ...(p.project ? { project: p.project } : {}),
      ...(row.principal ? { by: row.principal } : {}),
    };
  }

  private inviteById(id: string, address: string) {
    const entry = this.store.read().invites[sha256(String(id))];
    const subject = entry ? `invite:${entry.ref}` : "invite:?";
    const limited = this.limited(subject, address);
    if (limited) return { failure: limited };
    const record = entry ? this.inviteRecord(entry.ref) : undefined;
    if (!entry || !record) {
      this.failAttempt(subject, address, "bad_invite");
      return { failure: failure(404, "That invite link is not valid.") };
    }
    if (record.used) return { failure: failure(410, "That invite was already used.") };
    if (Date.parse(record.expires) <= this.now()) {
      return { failure: failure(410, "That invite has expired; ask an Admin for a new one.") };
    }
    return { entry, record, subject };
  }

  /**
   * `GET /api/invites` (dashboard DB-N19-4, teams item 10): the outstanding
   * invites — not used, not expired, not revoked — for an Admin, newest
   * first. Each by its opaque reference: the link is a credential, held only
   * as a hash, so the list can never carry it.
   */
  public listInvites(actor: string):
    | {
        ok: true;
        invites: {
          ref: string;
          level: Level;
          expires: string;
          project?: string;
          email?: string;
          invitedBy?: string;
        }[];
      }
    | Failure {
    const denied = this.requireAdmin(actor, "see the outstanding invites");
    if (denied) return denied;
    const out = [];
    for (const entry of Object.values(this.store.read().invites)) {
      const record = this.inviteRecord(entry.ref);
      if (!record || record.used || Date.parse(record.expires) <= this.now()) continue;
      const email = (
        this.db
          .prepare(
            `SELECT json_extract(p.body, '$.email') AS email FROM events e
               JOIN event_private p ON p.event_id = e.id
              WHERE e.type = 'member/invited' AND json_extract(e.payload, '$.invite') = ?
              LIMIT 1`,
          )
          .get(entry.ref) as { email: string | null } | undefined
      )?.email;
      const by = record.by ? personName(this.db, record.by) : undefined;
      out.push({
        ref: entry.ref,
        level: record.level,
        expires: record.expires,
        ...(record.project ? { project: record.project } : {}),
        ...(email ? { email } : {}),
        ...(by ? { invitedBy: by } : {}),
      });
    }
    out.sort((a, b) => b.expires.localeCompare(a.expires));
    return { ok: true, invites: out };
  }

  /**
   * `DELETE /api/invites/:ref` (DB-N19-4): the link stops working at once —
   * its hash leaves the credential store, so neither showing nor accepting it
   * finds anything — and `member/invite_revoked` records who revoked which.
   */
  public revokeInvite(actor: string, inviteRef: string): { ok: true } | Failure {
    const denied = this.requireAdmin(actor, "revoke invites");
    if (denied) return denied;
    const removed = this.store.update((f) => {
      const hit = Object.entries(f.invites).find(([, e]) => e.ref === inviteRef);
      if (!hit) return false;
      delete f.invites[hit[0]];
      return true;
    });
    if (!removed) return failure(404, "No such outstanding invite.");
    this.log.appendNow({
      actor: "human",
      type: "member/invite_revoked",
      payload: { invite: inviteRef },
      principal: actor,
    });
    return { ok: true };
  }

  /** `GET /api/invites/:id` (TEAM-33): shows the invite, consumes nothing. */
  public showInvite(
    id: string,
    rawAddress: string,
  ):
    | {
        ok: true;
        workspace: string;
        level: Level;
        project?: string;
        invitedBy?: string;
        expires: string;
      }
    | Failure {
    const found = this.inviteById(id, normalAddress(rawAddress));
    if ("failure" in found) return found.failure as Failure;
    const by = found.record.by ? personName(this.db, found.record.by) : undefined;
    return {
      ok: true,
      workspace: this.settings.workspace,
      level: found.record.level,
      expires: found.record.expires,
      ...(found.record.project ? { project: found.record.project } : {}),
      ...(by ? { invitedBy: by } : {}),
    };
  }

  /** `POST /api/invites/:id/accept` (TEAM-8, TEAM-33): the only way an invite creates an account. */
  public async acceptInvite(
    id: string,
    details: PersonDetails,
    rawAddress: string,
  ): Promise<SignedIn | Failure> {
    const address = normalAddress(rawAddress);
    const found = this.inviteById(id, address);
    if ("failure" in found) return found.failure as Failure;
    const refused = this.detailsProblem(details);
    if (refused) return refused;
    const known = personByEmail(this.db, details.email);
    if (known && memberOf(this.db, known) && !memberOf(this.db, known)?.removed) {
      return failure(409, "That email already belongs to a member; sign in instead.");
    }
    const hash = await hashPassword(details.password);
    // Re-checked after the await: an invite is used once, however fast two accepts race.
    const record = this.inviteRecord(found.entry.ref);
    if (!record || record.used) return failure(410, "That invite was already used.");
    const principal = this.personFor(details);
    this.store.update((f) => {
      delete f.invites[sha256(String(id))];
      f.passwords[principal] = { hash, setAt: this.iso() };
    });
    const level = this.join(principal, record.level, "invite", found.entry.ref, record.project);
    this.log.appendNow({
      actor: "human",
      type: "password/changed",
      payload: { principal, via: "invite" },
      principal,
    });
    this.limits.succeed(found.subject, address);
    return this.startSession(principal, level, "invite");
  }

  /**
   * Record a person joining, as themselves (kernel rule 19). An invite to one
   * project joins at Viewer across the workspace, with that project's level
   * set to the invited one (teams item 10, item 6's override).
   */
  private join(
    principal: string,
    level: Level,
    via: "invite" | "proxy" | "signup" | "oidc",
    invite?: string,
    project?: string,
    pending = false,
  ): Level {
    const workspace: Level = project ? "viewer" : level;
    this.log.appendNow({
      actor: via === "invite" ? "human" : "harness",
      type: "member/joined",
      payload: {
        principal,
        level: workspace,
        via,
        pending,
        ...(invite ? { invite } : {}),
        ...(project ? { project } : {}),
      },
      principal,
    });
    if (project && level !== workspace) {
      // The Admin who sent the invite set this level for the project.
      const by = invite ? this.inviteRecord(invite)?.by : undefined;
      this.log.appendNow({
        actor: "harness",
        type: "member/level_changed",
        payload: { principal, level, project },
        principal: by ?? principal,
      });
    }
    return workspace;
  }

  /** An open invite addressed to `email`, for the proxy (TEAM-38). */
  private inviteForEmail(
    email: string,
  ): { ref: string; level: Level; project?: string } | undefined {
    const rows = this.db
      .prepare(
        `SELECT json_extract(e.payload, '$.invite') AS ref FROM events e
           JOIN event_private p ON p.event_id = e.id
          WHERE e.type = 'member/invited' AND lower(json_extract(p.body, '$.email')) = lower(?)
          ORDER BY e.seq DESC`,
      )
      .all(email.trim()) as { ref: string }[];
    for (const row of rows) {
      const record = this.inviteRecord(row.ref);
      if (record && !record.used && Date.parse(record.expires) > this.now()) {
        return {
          ref: row.ref,
          level: record.level,
          ...(record.project ? { project: record.project } : {}),
        };
      }
    }
    return undefined;
  }

  /**
   * A person the identity provider (OIDC) vouched for, joined when new
   * (TEAM-13, TEAM-14): used by the SSO routes. `subject` is the provider's
   * `iss` and `sub`: bound to the principal at the first sign-in, so the same
   * email under another subject is refused. A removed member is refused; an
   * Admin invites them again.
   */
  public joinFromProvider(
    email: string,
    name: string | undefined,
    level: Level | undefined,
    managedByProvider: boolean,
    subject?: { iss: string; sub: string },
  ): { ok: true; principal: string } | Failure {
    if (!this.hasAdmin()) {
      return failure(
        403,
        "The first Admin is created with the setup token, never by a first SSO sign-in.",
      );
    }
    const key = subject ? `${subject.iss} ${subject.sub}` : undefined;
    const bound = key ? this.store.read().subjects[key] : undefined;
    const existing = bound ?? personByEmail(this.db, email);
    if (existing && key && !bound) {
      const other = Object.entries(this.store.read().subjects).find(
        ([k, p]) => p === existing && k.startsWith(`${subject?.iss} `),
      );
      if (other) {
        return failure(
          403,
          "That email belongs to a person who signs in as another account at the identity provider.",
          { reason: "subject_mismatch" },
        );
      }
    }
    const member = existing ? memberOf(this.db, existing) : undefined;
    if (existing && member?.removed) {
      return failure(403, "This account was removed; an Admin can invite you again.", {
        reason: "removed",
      });
    }
    const bind = (principal: string) => {
      if (key && !bound) {
        this.store.update((f) => {
          f.subjects[key] = principal;
        });
      }
    };
    if (existing && member) {
      bind(existing);
      if (managedByProvider && level && level !== member.level && !member.pending) {
        this.log.appendNow({
          actor: "harness",
          type: "member/level_changed",
          payload: { principal: existing, level },
          principal: existing,
        });
        if (levelRank(level) < levelRank(member.level)) {
          this.endSessionsOf(existing, "level_lowered");
        }
      }
      return { ok: true, principal: existing };
    }
    const principal = this.personFor({ email, ...(name ? { name } : {}) });
    const invite = this.inviteForEmail(email);
    if (invite) {
      this.store.update((f) => {
        for (const [h, e] of Object.entries(f.invites))
          if (e.ref === invite.ref) delete f.invites[h];
      });
      this.join(principal, invite.level, "invite", invite.ref, invite.project);
    } else {
      this.join(principal, level ?? "viewer", "oidc", undefined, undefined, level === undefined);
    }
    bind(principal);
    return { ok: true, principal };
  }

  // ---------------------------------------------------------------- tokens

  /** A personal access token (teams item 15): shown once, scoped no higher than its owner. */
  public createToken(
    principal: string,
    input: { name: string; level?: Level; days?: number },
    /** The level the request acts at (a token's scope): a token never mints a stronger one. */
    ceiling?: Level,
  ): { ok: true; id: string; token: string; expires: string; level: Level } | Failure {
    const member = memberOf(this.db, principal);
    if (!member || member.removed || member.pending)
      return failure(403, "Only a member can create tokens.");
    const top = ceiling ? lowerLevel(ceiling, member.level) : member.level;
    const level = input.level ?? top;
    if (!isLevel(level)) return failure(400, "A token's scope is a level.");
    if (levelRank(level) > levelRank(top)) {
      return failure(403, `A token's scope cannot be above your level (${top}).`);
    }
    const days = input.days ?? this.settings.tokenDefaultDays;
    const max = Math.min(this.settings.tokenMaxDays, 365);
    if (!Number.isFinite(days) || days <= 0 || days > max) {
      return failure(400, `A token expires within ${max} days.`);
    }
    const id = ref("t");
    const value = secret();
    const expires = this.iso(days * DAY);
    this.store.update((f) => {
      f.tokens[id] = { principal, hash: sha256(value), level, expires, createdAt: this.iso() };
    });
    const name = typeof input.name === "string" ? input.name.trim() : "";
    this.log.appendNow({
      actor: "human",
      type: "token/created",
      payload: { token: id, level, expires },
      principal,
      ...(name ? { private: { name } } : {}),
    });
    return { ok: true, id, token: `sekp_${id}_${value}`, expires, level };
  }

  public revokeToken(principal: string, id: string): { ok: true } | Failure {
    const removed = this.store.update((f) => {
      const t = f.tokens[id];
      if (!t || t.principal !== principal) return false;
      delete f.tokens[id];
      return true;
    });
    if (!removed) return failure(404, "No such token of yours.");
    this.log.appendNow({
      actor: "human",
      type: "token/revoked",
      payload: { token: id },
      principal,
    });
    return { ok: true };
  }

  /** A token in use (TEAM-37): refused after expiry; acts at the lower of scope and current level. */
  public authenticateToken(
    token: string,
  ):
    | { ok: true; principal: string; level: Level; scope: Level; token: string }
    | { ok: false; reason: string } {
    const m = /^sekp_(t_[0-9a-f]+)_([A-Za-z0-9_-]+)$/.exec(String(token).trim());
    if (!m?.[1] || !m[2]) return { ok: false, reason: "malformed" };
    const id = m[1];
    const entry = this.store.read().tokens[id];
    if (!entry || !sameHash(sha256(m[2]), entry.hash)) return { ok: false, reason: "unknown" };
    if (Date.parse(entry.expires) <= this.now()) return { ok: false, reason: "expired" };
    const member = memberOf(this.db, entry.principal);
    if (!member || member.removed || member.pending) return { ok: false, reason: "not_a_member" };
    if (!isLevel(entry.level)) return { ok: false, reason: "unknown" };
    const t = this.now();
    const last = this.tokenUsed.get(id) ?? this.lastTokenUse(id);
    if (last === undefined || t - last >= HOUR) {
      this.tokenUsed.set(id, t);
      this.log.appendNow({
        actor: "human",
        type: "token/used",
        payload: { token: id },
        principal: entry.principal,
      });
    }
    return {
      ok: true,
      principal: entry.principal,
      level: lowerLevel(entry.level, member.level),
      scope: entry.level,
      token: id,
    };
  }

  private lastTokenUse(id: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT created_at AS at FROM events WHERE type = 'token/used' AND json_extract(payload, '$.token') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { at: string } | undefined;
    return row ? Date.parse(row.at) : undefined;
  }

  // ---------------------------------------------------------------- resolution

  /** The proxy's person (TEAM-38): known, joined by an invite for their email, or created pending. */
  private proxyPerson(email: string): Requester {
    if (!this.hasAdmin()) {
      return { authenticated: false, status: 403, reason: "No Admin exists yet." };
    }
    let principal = personByEmail(this.db, email);
    let member = principal ? memberOf(this.db, principal) : undefined;
    if (!principal || !member) {
      principal ??= this.personFor({ email });
      const invite = this.inviteForEmail(email);
      if (invite) {
        this.store.update((f) => {
          for (const [h, e] of Object.entries(f.invites))
            if (e.ref === invite.ref) delete f.invites[h];
        });
        this.join(principal, invite.level, "invite", invite.ref, invite.project);
      } else {
        this.join(principal, "viewer", "proxy", undefined, undefined, true);
      }
      member = memberOf(this.db, principal);
    }
    if (!member || member.removed) {
      return { authenticated: false, status: 403, reason: "removed", principal };
    }
    if (member.pending) {
      return { authenticated: false, status: 403, reason: "pending", principal };
    }
    return { authenticated: true, principal, level: member.level, via: "proxy" };
  }

  /**
   * Resolve a request's identity from its headers and source address, with
   * the Set-Cookie a rotated session needs. The server calls this once per
   * request and binds the result (`bindRequester`).
   */
  public resolve(
    headers: Record<string, string | string[] | undefined>,
    rawAddress: string | undefined,
    method = "GET",
  ): { who: Requester; setCookie?: string } {
    if (this.mode === "solo") {
      return {
        who: {
          authenticated: true,
          principal: this.log.localPrincipal(),
          level: "admin",
          via: "solo",
        },
      };
    }
    const header = (name: string) => {
      const v = headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const unsafe = !SAFE_METHODS.has(method.toUpperCase());

    const auth = header("authorization");
    if (auth?.startsWith("Bearer ")) {
      const t = this.authenticateToken(auth.slice(7));
      if (!t.ok) {
        return { who: { authenticated: false, status: 401, reason: "That token is not valid." } };
      }
      return {
        who: {
          authenticated: true,
          principal: t.principal,
          level: t.level,
          via: "token",
          scope: t.scope,
        },
      };
    }

    if (this.settings.sources.includes("proxy")) {
      const user = header(this.settings.userHeader)?.trim();
      // TEAM-12: the header counts only from a trusted proxy; from anyone else it is ignored.
      if (user && isTrustedProxy(rawAddress, this.settings.trustedProxies)) {
        const who = this.proxyPerson(user);
        if (who.authenticated && unsafe && header("x-sekhemet-action") !== "1") {
          return {
            who: { authenticated: false, status: 403, reason: "csrf", principal: who.principal },
          };
        }
        return { who };
      }
    }

    const cookie = parseCookies(header("cookie"))[SESSION_COOKIE];
    if (cookie) {
      const s = this.session(cookie);
      if (s.ok) {
        const setCookie = s.rotatedTo ? this.cookie(s.rotatedTo) : undefined;
        // Sekhemet's own CSRF check (teams item 13): a cookie mutation carries the session's token.
        if (unsafe) {
          const presented = header("x-sekhemet-csrf") ?? "";
          const a = Buffer.from(presented);
          const b = Buffer.from(s.csrf);
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return {
              who: { authenticated: false, status: 403, reason: "csrf", principal: s.principal },
              ...(setCookie ? { setCookie } : {}),
            };
          }
        }
        return {
          who: { authenticated: true, principal: s.principal, level: s.level, via: "session" },
          ...(setCookie ? { setCookie } : {}),
        };
      }
    }
    return { who: UNAUTHENTICATED };
  }

  /** `resolve` without the rotated cookie: who these headers are. */
  public resolveHeaders(
    headers: Record<string, string | string[] | undefined>,
    address: string | undefined,
    method = "GET",
  ): Requester {
    return this.resolve(headers, address, method).who;
  }

  /**
   * A person's own sessions (`GET /api/sessions`): an opaque reference, when
   * it started and was last seen, and whether it is `sessionId`'s — never a
   * session id.
   */
  public sessionsOf(
    principal: string,
    sessionId?: string,
  ): { ref: string; created: string; lastSeen: string; current: boolean }[] {
    const mine = sessionId ? sha256(sessionId) : undefined;
    return [...this.sessions]
      .filter(([, s]) => s.principal === principal)
      .map(([key, s]) => ({
        ref: s.ref,
        created: new Date(s.createdAt).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
        current: key === mine,
      }));
  }

  /** End one of a person's own sessions by its reference (`DELETE /api/sessions/:ref`). */
  public revokeSession(principal: string, sessionRef: string): { ok: true } | Failure {
    for (const [key, s] of [...this.sessions]) {
      if (s.ref === sessionRef && s.principal === principal) {
        this.endSession(key, s, "revoked");
        return { ok: true };
      }
    }
    return failure(404, "No such session of yours.");
  }

  /** A person's own tokens (`GET /api/tokens`): no secret and no hash. */
  public tokensOf(
    principal: string,
  ): { id: string; name: string; level: string; expires: string }[] {
    const names = new Map(
      (
        this.db
          .prepare(
            `SELECT json_extract(e.payload, '$.token') AS id, json_extract(p.body, '$.name') AS name
               FROM events e LEFT JOIN event_private p ON p.event_id = e.id
              WHERE e.type = 'token/created' AND e.principal = ?`,
          )
          .all(principal) as { id: string; name: string | null }[]
      ).map((r) => [r.id, r.name ?? ""]),
    );
    return Object.entries(this.store.read().tokens)
      .filter(([, t]) => t.principal === principal)
      .map(([id, t]) => ({ id, name: names.get(id) ?? "", level: t.level, expires: t.expires }));
  }

  /** The CSRF token of a signed-in session, for `GET /api/session`. */
  public csrfOf(sessionId: string): string | undefined {
    return this.sessions.get(sha256(sessionId))?.csrf;
  }
}
