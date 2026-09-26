import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { Identity } from "../src/team/identity.js";
import { Sso } from "../src/team/oidc.js";
import { Passkeys } from "../src/team/passkeys.js";
import { type OidcSettings, identitySettings } from "../src/team/settings.js";

/**
 * Passkeys and company SSO (teams item 12, NEW-teams-4, DEC-38): a
 * software authenticator against SimpleWebAuthn, and `openid-client`
 * against a local OIDC stub over real HTTP (TEAM-13, TEAM-14).
 */

const PASSWORD = "correct horse battery staple";
let root: string;
let db: DatabaseSync;
let log: EventLog;
let dir: string;

function identity(overrides = {}) {
  return new Identity({
    db,
    log,
    dir,
    passwordList: join(root, "list.txt"),
    settings: identitySettings({ mode: "team", workspace: "Northwind", ...overrides }),
  });
}

async function admin(id: Identity) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  id.ensureSetupToken();
  vi.mocked(console.log).mockRestore();
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  const made = await id.presentSetupToken(
    token,
    { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD },
    "10.0.0.1",
  );
  if (!made.ok) throw new Error(made.error);
  return made;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-team-sso-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------- passkeys

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** A platform authenticator in software: one ES256 key, "none" attestation. */
function softwareAuthenticator(rpID: string, origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  const rpIdHash = createHash("sha256").update(rpID).digest();
  let counter = 0;
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
  ]);
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(credentialId),
    register(challenge: string) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]), // UP | UV | AT
        u32(counter),
        Buffer.alloc(16),
        len,
        credentialId,
        Buffer.from(isoCBOR.encode(cose)),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", new Uint8Array(authData)],
        ]) as never,
      );
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", challenge)),
          attestationObject: b64u(attestationObject),
          transports: ["internal" as const],
        },
        clientExtensionResults: {},
      };
    },
    assert(challenge: string, key = privateKey) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), u32(counter)]);
      const cd = clientData("webauthn.get", challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(cd).digest()]),
        key,
      );
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}

describe("passkeys (DEC-38)", () => {
  it("a signed-in person registers a passkey and later signs in with it; a forged one is refused", async () => {
    const id = identity({ sources: ["accounts", "passkeys"], publicUrl: "http://localhost:4040" });
    const made = await admin(id);
    const passkeys = new Passkeys(id, db, log, "http://localhost:4040");
    const device = softwareAuthenticator("localhost", "http://localhost:4040");

    const regOptions = await passkeys.registrationOptions(made.principal);
    const registered = await passkeys.register(
      made.principal,
      device.register(regOptions.challenge),
    );
    expect(registered).toMatchObject({ ok: true });
    // The public key is in the credential store; the ledger names only a reference.
    const events = await log.getEvents(1, 1000);
    const reg = events.find((e) => e.type === "passkey/registered");
    expect(reg?.payload).toEqual({
      principal: made.principal,
      passkey: (registered as { passkey: string }).passkey,
    });
    expect(JSON.stringify(events)).not.toContain(device.id);

    // A challenge is good once.
    const replay = await passkeys.register(made.principal, device.register(regOptions.challenge));
    expect(replay.ok).toBe(false);

    const signInOptions = await passkeys.signInOptions();
    const signedIn = await passkeys.signIn(device.assert(signInOptions.challenge), "10.0.0.2");
    expect(signedIn).toMatchObject({ ok: true, principal: made.principal, level: "admin" });
    const started = (await log.getEvents(1, 1000)).filter((e) => e.type === "session/started");
    expect(started.at(-1)?.payload).toMatchObject({ method: "passkey" });

    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const forgedOptions = await passkeys.signInOptions();
    const forged = await passkeys.signIn(device.assert(forgedOptions.challenge, other), "10.0.0.3");
    expect(forged).toMatchObject({ ok: false, status: 401 });
  });
});

// ------------------------------------------------------------- OIDC stub

interface Stub {
  server: Server;
  issuer: string;
  /** The claims the next sign-in's ID token carries. */
  claims: Record<string, unknown>;
  /** A nonce the ID token carries instead of the one asked for (a replayed or forged token). */
  nonce?: string;
}

async function oidcStub(clientId: string): Promise<Stub> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as object),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const stub: Stub = { server: undefined as never, issuer: "", claims: {} };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const idToken = (nonce: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })));
    const payload = b64u(
      Buffer.from(
        JSON.stringify({
          iss: stub.issuer,
          aud: clientId,
          sub: `sub-${String(stub.claims.email)}`,
          iat: now,
          exp: now + 300,
          nonce: stub.nonce ?? nonce,
          ...stub.claims,
        }),
      ),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${b64u(signature)}`;
  };
  stub.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", stub.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, {
        issuer: stub.issuer,
        authorization_endpoint: `${stub.issuer}/authorize`,
        token_endpoint: `${stub.issuer}/token`,
        jwks_uri: `${stub.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/jwks") return send(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(8).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!entry || challenge !== entry.challenge)
        return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, {
        access_token: randomBytes(8).toString("hex"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken(entry.nonce),
      });
    }
    send(res, 404, {});
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const address = stub.server.address();
  stub.issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return stub;
}

/** Walk the provider's redirect the way a browser would, and return the callback's query. */
async function throughProvider(start: URL): Promise<URLSearchParams> {
  const res = await fetch(start, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`no redirect from the provider (${res.status})`);
  return new URL(location).searchParams;
}

/** One sign-in by a browser that keeps its state cookie: the provider's answer, back. */
async function signInThrough(sso: Sso) {
  const { url, state } = await sso.begin();
  return sso.callback(await throughProvider(url), state);
}

describe("company SSO (OIDC, DEC-38)", () => {
  let stub: Stub;
  const clientId = "sekhemet-test";
  const redirect = "http://127.0.0.1:1/api/oidc/callback";
  const oidc = (overrides: Partial<OidcSettings> = {}): OidcSettings => ({
    issuer: stub.issuer,
    clientId,
    claim: "groups",
    levels: { engineering: "member", leads: "admin" },
    strict: true,
    levelsManagedBy: "sekhemet",
    ...overrides,
  });

  beforeEach(async () => {
    stub = await oidcStub(clientId);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("uses PKCE, maps the claim to a level, and never creates the first Admin", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    const sso = new Sso(id, oidc(), redirect);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    const start = await sso.begin();
    expect(start.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.url.searchParams.get("code_challenge")).toBeTruthy();
    // No Admin yet: the first SSO sign-in creates nobody.
    const early = await sso.callback(await throughProvider(start.url), start.state);
    expect(early).toMatchObject({ ok: false, status: 403 });

    await admin(id);
    const signedIn = await signInThrough(sso);
    expect(signedIn).toMatchObject({ ok: true, level: "member" });
    const joined = (await log.getEvents(1, 1000)).filter((e) => e.type === "member/joined");
    expect(joined.at(-1)?.payload).toMatchObject({ via: "oidc", level: "member", pending: false });
    // The person joined as themselves (kernel rule 19).
    expect(joined.at(-1)?.principal).toBe((signedIn as { principal: string }).principal);
  });

  it("TEAM-13: strict mode refuses a claim that maps to no level, naming the mapping", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    stub.claims = { email: "x@northwind.test", email_verified: true, groups: ["marketing"] };
    const refused = await signInThrough(sso);
    expect(refused).toMatchObject({ ok: false, status: 403, reason: "unmapped_claim" });
    expect((refused as { error: string }).error).toMatch(
      /groups.*marketing.*\[identity\.oidc\] levels/,
    );
    const joined = (await log.getEvents(1, 1000)).filter((e) => e.type === "member/joined");
    expect(joined).toHaveLength(1);

    // Not strict: the person joins pending and can do nothing until approved.
    const lenient = new Sso(id, oidc({ strict: false }), redirect);
    const pending = await signInThrough(lenient);
    expect(pending).toMatchObject({ ok: false, status: 403, reason: "pending" });
  });

  it("TEAM-14: levels managed in Sekhemet are never changed by a claim; managed by the provider, they follow it", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    const sso = new Sso(id, oidc(), redirect);
    const first = await signInThrough(sso);
    if (!first.ok) throw new Error(first.error);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["leads"] };
    const again = await signInThrough(sso);
    expect(again).toMatchObject({ ok: true, level: "member" });
    expect((await log.getEvents(1, 1000)).some((e) => e.type === "member/level_changed")).toBe(
      false,
    );

    const byProvider = new Sso(id, oidc({ levelsManagedBy: "provider" }), redirect);
    const raised = await signInThrough(byProvider);
    expect(raised).toMatchObject({ ok: true, level: "admin" });
    // The change the provider made is recorded as that person's.
    const changed = (await log.getEventsByTypes(["member/level_changed"])).at(-1);
    expect(changed?.principal).toBe(first.principal);
  });

  it("a callback with a state it never issued is refused", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    const params = await throughProvider(await sso.start());
    params.set("state", "forged");
    expect(await sso.callback(params, "forged")).toMatchObject({ ok: false, status: 400 });
  });

  it("M2: refuses an email the provider did not say it verified", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    for (const verified of [false, undefined, "true"]) {
      stub.claims = {
        email: "eng@northwind.test",
        groups: ["engineering"],
        ...(verified === undefined ? {} : { email_verified: verified }),
      };
      expect(await signInThrough(sso)).toMatchObject({ ok: false, status: 403 });
    }
    expect((await log.getEventsByTypes(["member/joined"])).length).toBe(1);
  });

  it("M2: binds the provider's subject, and refuses the same email under another", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    const first = await signInThrough(sso);
    expect(first).toMatchObject({ ok: true });
    stub.claims = { ...stub.claims, sub: "someone-else" };
    expect(await signInThrough(sso)).toMatchObject({
      ok: false,
      status: 403,
      reason: "subject_mismatch",
    });
    // The bound subject still signs in, whatever email it now carries.
    stub.claims = {
      email: "eng@renamed.test",
      email_verified: true,
      groups: ["engineering"],
      sub: "sub-eng@northwind.test",
    };
    expect(await signInThrough(sso)).toMatchObject({
      ok: true,
      principal: (first as { principal: string }).principal,
    });
  });

  it("M7: refuses an ID token whose nonce is not the one this sign-in asked for", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    stub.nonce = "a-nonce-from-another-sign-in";
    expect(await signInThrough(sso)).toMatchObject({ ok: false, status: 401 });
  });

  it("M1: refuses a removed member, who needs a new invite", async () => {
    const id = identity({ sources: ["accounts", "oidc"] });
    const made = await admin(id);
    const sso = new Sso(id, oidc(), redirect);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    const first = await signInThrough(sso);
    if (!first.ok) throw new Error(first.error);
    expect(id.remove(made.principal, first.principal)).toEqual({ ok: true });
    expect(await signInThrough(sso)).toMatchObject({ ok: false, status: 403, reason: "removed" });
    const joined = (await log.getEventsByTypes(["member/joined"])).filter(
      (e) => (e.payload as { principal: string }).principal === first.principal,
    );
    expect(joined).toHaveLength(1);
  });

  it("the server's /api/oidc/start redirects to the provider with PKCE", async () => {
    const cardStore = new CardStore(db, log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      identity: {
        dir,
        passwordList: join(root, "list.txt"),
        settings: identitySettings({
          mode: "team",
          sources: ["accounts", "oidc"],
          publicUrl: "http://127.0.0.1:4040",
          oidc: oidc(),
        }),
      },
    });
    vi.mocked(console.log).mockRestore();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/oidc/start`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin).toBe(stub.issuer);
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:4040/api/oidc/callback",
      );
      // The browser that started it carries a short-lived state cookie.
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(res.headers.get("set-cookie")).toMatch(
        /^__Host-sekhemet_oidc=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
      );
      expect(cookie.split("=")[1]).toBe(location.searchParams.get("state"));
    } finally {
      await server.close();
    }
  });

  it("M2, M7 over HTTP: the callback needs this browser's state cookie, and a state is good once", async () => {
    const cardStore = new CardStore(db, log);
    const id = identity({ sources: ["accounts", "oidc"] });
    await admin(id);
    stub.claims = { email: "eng@northwind.test", email_verified: true, groups: ["engineering"] };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cardStore),
      cardStore,
      repoPath: root,
      port: 0,
      identity: {
        dir,
        passwordList: join(root, "list.txt"),
        settings: identitySettings({
          mode: "team",
          sources: ["accounts", "oidc"],
          publicUrl: "http://127.0.0.1:4040",
          oidc: oidc({ displayName: "Northwind SSO" }),
        }),
      },
    });
    vi.mocked(console.log).mockRestore();
    const base = `http://127.0.0.1:${server.port}`;
    const begin = async () => {
      const res = await fetch(`${base}/api/oidc/start`, { redirect: "manual" });
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const query = await throughProvider(new URL(res.headers.get("location") ?? ""));
      return { cookie, query: query.toString() };
    };
    const callback = (query: string, cookie?: string) =>
      fetch(`${base}/api/oidc/callback?${query}`, {
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
      });
    try {
      const session = await fetch(`${base}/api/session`);
      expect(await session.json()).toMatchObject({ signedIn: false });
      // No cookie, or another browser's: a login forced on someone is refused.
      const a = await begin();
      const b = await begin();
      expect((await callback(a.query)).status).toBe(400);
      expect((await callback(a.query, b.cookie)).status).toBe(400);
      // This browser's own cookie signs in.
      const ok = await callback(a.query, a.cookie);
      expect(ok.status).toBe(302);
      const cookies = ok.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("__Host-sekhemet_session="))).toBe(true);
      expect(cookies.some((c) => /^__Host-sekhemet_oidc=;.*Max-Age=0/.test(c))).toBe(true);
      // The same state again (a replayed redirect) is refused.
      expect((await callback(a.query, a.cookie)).status).toBe(400);
      // Who am I: my own name and email, the workspace, the company's sign-in.
      const mine = cookies.find((c) => c.startsWith("__Host-sekhemet_session="))?.split(";")[0];
      const me = await fetch(`${base}/api/session`, { headers: { Cookie: mine ?? "" } });
      expect(await me.json()).toMatchObject({
        signedIn: true,
        email: "eng@northwind.test",
        workspace: "Sekhemet",
        company: "Northwind SSO",
      });
    } finally {
      await server.close();
    }
  });
});
