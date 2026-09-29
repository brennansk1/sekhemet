import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Failure, Identity, SignedIn } from "./identity.js";
import { SESSION_COOKIE, parseCookies } from "./identity.js";
import { personEmail, personName } from "./members.js";
import { OIDC_STATE_COOKIE, type Sso, clearedOidcStateCookie, oidcStateCookie } from "./oidc.js";
import type { Passkeys } from "./passkeys.js";
import { type Requester, bindRequester, requester } from "./requester.js";
import { isLevel } from "./settings.js";

/**
 * The identity endpoints of teams §3: sign-in (`/api/session`,
 * `/api/setup`), invites, personal tokens, the Admin's member actions
 * (unlock, password reset, approve, level, remove), password-reset links,
 * passkeys and OIDC. Every write refuses a request without the
 * `X-Sekhemet-Action` header, so a cross-site form cannot post one.
 */
export interface IdentityRouteDeps {
  identity: Identity;
  passkeys?: Passkeys;
  sso?: Sso;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  /**
   * Solo's per-start mutation token (security item 37, SEC-25): handed to
   * the page by `GET /api/session` as `csrf`, the same field and header
   * (`X-Sekhemet-CSRF`) as a Team session's token, so the page sends it on
   * every write. No other site can read it: the server grants no CORS and
   * answers no other Host.
   */
  soloCsrf?: string;
  /**
   * What Members shows beside a person's level (DB-N9-16): their profile
   * label, per-project levels, last active and whether they are active now
   * or locked. Read from the access projection and the ledger.
   */
  memberFacts?: (principal: string) => MemberFacts;
  /**
   * A person's own per-project levels and the projects they lead, for the
   * page's level notes (DB-N9-17), and their profile label, which sets their
   * default page in the Team setup (dashboard §2.2.5, teams item 8).
   */
  sessionFacts?: (principal: string) => {
    projects: Record<string, { level?: string; lead?: boolean; releaseLead?: boolean }>;
    label?: string;
  };
}

/** Members' columns beyond the level (DB-N9-16). */
export interface MemberFacts {
  label?: string;
  projects?: Record<string, string>;
  lastActive?: string;
  active?: boolean;
  locked?: boolean;
}

const INVITE = /^\/api\/invites\/([A-Za-z0-9_-]+)$/;
const INVITE_ACCEPT = /^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/;
const RESET_LINK = /^\/api\/password-reset\/([A-Za-z0-9_-]+)$/;
// A level change (`/api/members/:id/level`) is the access module's route.
const MEMBER_ACTION = /^\/api\/members\/(p_[0-9a-z]+)\/(unlock|password-reset|approve)$/;
const MEMBER = /^\/api\/members\/(p_[0-9a-z]+)$/;
const TOKEN = /^\/api\/tokens\/(t_[0-9a-f]+)$/;
const SESSION_REF = /^\/api\/sessions\/(s_[0-9a-f]+)$/;

/** Endpoints reachable before signing in, in the Team setup. */
export function isPublicRoute(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (url === "/api/session") return true;
  if (url === "/api/setup" && m === "POST") return true;
  if (INVITE.test(url) && m === "GET") return true;
  if (INVITE_ACCEPT.test(url) && m === "POST") return true;
  if (RESET_LINK.test(url) && m === "POST") return true;
  if ((url === "/api/passkeys/signin/options" || url === "/api/passkeys/signin") && m === "POST")
    return true;
  if ((url === "/api/oidc/start" || url === "/api/oidc/callback") && m === "GET") return true;
  return false;
}

/**
 * Resolve who the request is, bind it for `requester(req)`, and in the
 * Team setup answer 401 (or 403) for a protected `/api/` endpoint when
 * nobody is signed in. Returns true when it answered.
 */
export function identityGate(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  identity: Identity,
  json: IdentityRouteDeps["json"],
): boolean {
  const { who, setCookie } = identity.resolve(req.headers, req.socket.remoteAddress, req.method);
  bindRequester(req, who);
  if (setCookie) res.setHeader("Set-Cookie", setCookie);
  if (identity.mode !== "team" || who.authenticated) return false;
  if (!url.startsWith("/api/") || isPublicRoute(req.method ?? "GET", url)) return false;
  json(res, who.status, {
    error: who.reason,
    ...(who.reason === "pending" ? { pending: true } : {}),
  });
  return true;
}

const actionHeader = (req: IncomingMessage) => req.headers["x-sekhemet-action"] === "1";
const address = (req: IncomingMessage) => req.socket.remoteAddress ?? "";
const text = (v: unknown) => (typeof v === "string" ? v : "");

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  return parseCookies(Array.isArray(raw) ? raw[0] : raw)[name];
}

const sessionCookie = (req: IncomingMessage) => cookieOf(req, SESSION_COOKIE);

function signedInBody(result: SignedIn) {
  return { principal: result.principal, level: result.level, csrf: result.csrf };
}

export async function handleIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  query: URLSearchParams,
  deps: IdentityRouteDeps,
): Promise<boolean> {
  const { identity, json } = deps;
  const method = (req.method ?? "GET").toUpperCase();
  const who: Requester = requester(req);
  const refuse = (r: Failure) => {
    if (r.retryAfterMs !== undefined)
      res.setHeader("Retry-After", Math.ceil(r.retryAfterMs / 1000));
    json(res, r.status, {
      error: r.error,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.rule ? { rule: r.rule } : {}),
    });
  };
  const signedIn = (r: SignedIn | Failure) => {
    if (!r.ok) return refuse(r);
    res.setHeader("Set-Cookie", r.cookie);
    json(res, 200, signedInBody(r));
  };
  const needsAction = () => {
    if (method !== "GET" && !actionHeader(req)) {
      json(res, 403, { error: "This request needs the X-Sekhemet-Action header." });
      return true;
    }
    return false;
  };
  const body = async () => {
    try {
      return await deps.readJsonBody(req);
    } catch {
      return undefined;
    }
  };

  const known =
    url === "/api/session" ||
    url === "/api/setup" ||
    url === "/api/invites" ||
    INVITE.test(url) ||
    INVITE_ACCEPT.test(url) ||
    url === "/api/tokens" ||
    TOKEN.test(url) ||
    url === "/api/sessions" ||
    SESSION_REF.test(url) ||
    url === "/api/members" ||
    MEMBER.test(url) ||
    MEMBER_ACTION.test(url) ||
    RESET_LINK.test(url) ||
    url.startsWith("/api/passkeys/") ||
    url.startsWith("/api/oidc/");
  if (!known) return false;

  // Solo has one person and no sign-in (TEAM-1): only "who am I" answers.
  if (identity.mode === "solo") {
    if (url === "/api/session" && method === "GET" && who.authenticated) {
      json(res, 200, {
        mode: "solo",
        signedIn: true,
        signIn: false,
        principal: who.principal,
        level: who.level,
        ...(deps.soloCsrf ? { csrf: deps.soloCsrf } : {}),
      });
    } else {
      json(res, 409, { error: "Solo has no accounts: switch to the Team setup in Configuration." });
    }
    return true;
  }

  if (needsAction()) return true;

  if (url === "/api/session") {
    if (method === "GET") {
      if (!who.authenticated) {
        json(res, 200, {
          mode: "team",
          signedIn: false,
          setupNeeded: !identity.hasAdmin(),
          sources: identity.settings.sources,
        });
        return true;
      }
      const cookie = sessionCookie(req);
      const csrf = who.via === "session" && cookie ? identity.csrfOf(cookie) : undefined;
      // The person's own name and email only; the company's name when OIDC is on.
      const name = personName(identity.db, who.principal);
      const email = personEmail(identity.db, who.principal);
      json(res, 200, {
        mode: "team",
        signedIn: true,
        principal: who.principal,
        level: who.level,
        via: who.via,
        workspace: identity.settings.workspace,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(deps.sso ? { company: deps.sso.displayName } : {}),
        ...(csrf ? { csrf } : {}),
        ...(deps.sessionFacts ? deps.sessionFacts(who.principal) : {}),
      });
      return true;
    }
    if (method === "POST") {
      const b = await body();
      signedIn(await identity.signIn(text(b?.email), text(b?.password), address(req)));
      return true;
    }
    if (method === "DELETE") {
      const cookie = sessionCookie(req);
      if (!who.authenticated || who.via !== "session" || !cookie) {
        json(res, 401, { error: "No session to end." });
        return true;
      }
      identity.signOut(cookie);
      res.setHeader("Set-Cookie", identity.clearedCookie());
      json(res, 200, { signedOut: true });
      return true;
    }
  }

  if (url === "/api/setup" && method === "POST") {
    const b = await body();
    signedIn(
      await identity.presentSetupToken(
        text(b?.token),
        { name: text(b?.name), email: text(b?.email), password: text(b?.password) },
        address(req),
      ),
    );
    return true;
  }

  const invite = INVITE.exec(url);
  if (invite?.[1] && method === "GET") {
    const shown = identity.showInvite(invite[1], address(req));
    if (!shown.ok) refuse(shown);
    else {
      const { ok: _ok, ...rest } = shown;
      json(res, 200, rest);
    }
    return true;
  }
  const accept = INVITE_ACCEPT.exec(url);
  if (accept?.[1] && method === "POST") {
    const b = await body();
    signedIn(
      await identity.acceptInvite(
        accept[1],
        { name: text(b?.name), email: text(b?.email), password: text(b?.password) },
        address(req),
      ),
    );
    return true;
  }
  const reset = RESET_LINK.exec(url);
  if (reset?.[1] && method === "POST") {
    const b = await body();
    const r = await identity.usePasswordReset(reset[1], text(b?.password), address(req));
    if (!r.ok) refuse(r);
    else json(res, 200, { changed: true });
    return true;
  }

  if (url === "/api/passkeys/signin/options" && method === "POST") {
    if (!deps.passkeys) {
      json(res, 404, { error: "Passkeys are off on this server." });
      return true;
    }
    json(res, 200, await deps.passkeys.signInOptions());
    return true;
  }
  if (url === "/api/passkeys/signin" && method === "POST") {
    if (!deps.passkeys) {
      json(res, 404, { error: "Passkeys are off on this server." });
      return true;
    }
    const b = await body();
    signedIn(await deps.passkeys.signIn(b as unknown as AuthenticationResponseJSON, address(req)));
    return true;
  }
  if (url === "/api/oidc/start" && method === "GET") {
    if (!deps.sso) {
      json(res, 404, { error: "Company sign-in is off on this server." });
      return true;
    }
    try {
      const { url: location, state } = await deps.sso.begin();
      res.writeHead(302, { Location: location.href, "Set-Cookie": oidcStateCookie(state) });
      res.end();
    } catch (err) {
      json(res, 502, {
        error: `The identity provider could not be reached: ${(err as Error).message}`,
      });
    }
    return true;
  }
  if (url === "/api/oidc/callback" && method === "GET") {
    if (!deps.sso) {
      json(res, 404, { error: "Company sign-in is off on this server." });
      return true;
    }
    const r = await deps.sso.callback(query, cookieOf(req, OIDC_STATE_COOKIE));
    if (!r.ok) {
      res.setHeader("Set-Cookie", clearedOidcStateCookie());
      refuse(r);
      return true;
    }
    res.writeHead(302, { "Set-Cookie": [r.cookie, clearedOidcStateCookie()], Location: "/" });
    res.end();
    return true;
  }

  // Everything below needs a signed-in person (the gate has answered 401 already).
  if (!who.authenticated) {
    json(res, 401, { error: who.reason });
    return true;
  }
  const actor = who.principal;
  const done = (r: { ok: true } | Failure, body: unknown = { ok: true }) =>
    r.ok ? json(res, 200, body) : refuse(r);
  /** Admin actions go by the level the request acts at: a token scoped lower cannot do them. */
  const notAdmin = (action: string) => {
    if (who.level === "admin") return false;
    json(res, 403, {
      error: `Only an Admin can ${action}. An Admin can grant it.`,
      reason: "forbidden",
    });
    return true;
  };

  /** A new credential is added in a signed-in session, never with a token (B2). */
  const notInSession = () => {
    if (who.via !== "token") return false;
    json(res, 403, {
      error: "A passkey is added while signed in on the Sign in page, not with a token.",
      reason: "forbidden",
    });
    return true;
  };
  if (url === "/api/passkeys/register/options" && method === "POST") {
    if (!deps.passkeys) json(res, 404, { error: "Passkeys are off on this server." });
    else if (!notInSession()) json(res, 200, await deps.passkeys.registrationOptions(actor));
    return true;
  }
  if (url === "/api/passkeys/register" && method === "POST") {
    if (!deps.passkeys) {
      json(res, 404, { error: "Passkeys are off on this server." });
      return true;
    }
    if (notInSession()) return true;
    const b = await body();
    const r = await deps.passkeys.register(actor, b as unknown as RegistrationResponseJSON);
    done(r, r.ok ? { passkey: r.passkey } : undefined);
    return true;
  }

  if (url === "/api/invites" && method === "POST") {
    if (notAdmin("invite people")) return true;
    const b = await body();
    const level = b?.level;
    if (!isLevel(level)) {
      json(res, 400, { error: "An invite carries a level: admin, member, stakeholder or viewer." });
      return true;
    }
    const r = identity.createInvite(actor, {
      level,
      ...(typeof b?.project === "string" ? { project: b.project } : {}),
      ...(typeof b?.email === "string" ? { email: b.email } : {}),
      ...(typeof b?.days === "number" ? { days: b.days } : {}),
    });
    done(r, r.ok ? { id: r.id, url: `/invite/${r.id}`, expires: r.expires } : undefined);
    return true;
  }

  if (url === "/api/tokens" && method === "POST") {
    const b = await body();
    const r = identity.createToken(
      actor,
      {
        name: text(b?.name),
        ...(isLevel(b?.level) ? { level: b.level } : {}),
        ...(typeof b?.days === "number" ? { days: b.days } : {}),
      },
      who.level,
    );
    done(r, r.ok ? { id: r.id, token: r.token, expires: r.expires, level: r.level } : undefined);
    return true;
  }
  if (url === "/api/tokens" && method === "GET") {
    json(res, 200, { tokens: identity.tokensOf(actor) });
    return true;
  }
  const token = TOKEN.exec(url);
  if (token?.[1] && method === "DELETE") {
    done(identity.revokeToken(actor, token[1]));
    return true;
  }
  if (url === "/api/sessions" && method === "GET") {
    json(res, 200, { sessions: identity.sessionsOf(actor, sessionCookie(req)) });
    return true;
  }
  const sessionRef = SESSION_REF.exec(url);
  if (sessionRef?.[1] && method === "DELETE") {
    done(identity.revokeSession(actor, sessionRef[1]));
    return true;
  }

  if (url === "/api/members" && method === "GET") {
    const admin = who.level === "admin";
    json(res, 200, {
      members: identity.members().map((m) => ({
        principal: m.principal,
        level: m.level,
        pending: m.pending,
        ...(m.name ? { name: m.name } : {}),
        // Emails are personal: the Admin who manages members sees them.
        ...(admin && m.email ? { email: m.email } : {}),
        ...(deps.memberFacts ? deps.memberFacts(m.principal) : {}),
      })),
      // The Admin's actions show only for an Admin (DB-N9-16).
      canManage: admin,
    });
    return true;
  }
  const member = MEMBER.exec(url);
  if (member?.[1] && method === "DELETE") {
    if (notAdmin("remove members")) return true;
    done(identity.remove(actor, member[1]));
    return true;
  }
  const action = MEMBER_ACTION.exec(url);
  if (action?.[1] && method === "POST") {
    const target = action[1];
    if (notAdmin(action[2] === "approve" ? "approve people" : `${action[2]} members' accounts`))
      return true;
    if (action[2] === "unlock") done(identity.unlock(actor, target));
    else if (action[2] === "password-reset") {
      const r = identity.issuePasswordReset(actor, target);
      done(r, r.ok ? { id: r.id, url: `/password-reset/${r.id}`, expires: r.expires } : undefined);
    } else {
      const b = await body();
      done(identity.approve(actor, target, isLevel(b?.level) ? b.level : undefined));
    }
    return true;
  }

  json(res, 405, { error: "Method not allowed." });
  return true;
}
