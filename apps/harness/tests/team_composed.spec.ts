import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { Access } from "../src/team/access.js";
import { type IdentitySettings, identitySettings } from "../src/team/settings.js";

/**
 * B4.10, the Team setup composed end to end (teams §2.2, §2.3): a real
 * server over a Team ledger (`EventLog` `setup: "team"`, so a person's event
 * without a principal is refused, kernel K-N2-1), the setup token, invites,
 * password sessions with CSRF, scoped personal tokens, the trusted proxy and
 * passkeys — every request resolved by the server itself, no test seam.
 */

const PASSWORD = "correct horse battery staple";
const PUBLIC = "http://localhost:4040";

let root: string;
let db: DatabaseSync;
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-team-e2e-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  // A run the server would launch starts an empty script, never a Worker.
  writeFileSync(join(root, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(root, "noop.mjs");
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
  dir = join(root, "identity");
  writeFileSync(join(root, "list.txt"), "passwordpassword1\n");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(overrides: Partial<IdentitySettings> = {}, adapter?: MockInferenceAdapter) {
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
    pmAdapter: () =>
      adapter ??
      new MockInferenceAdapter("dirk-27b", [
        {
          text: "Noted.",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        },
      ]),
    identity: {
      dir,
      passwordList: join(root, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind", ...overrides }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
  return base;
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

async function firstAdmin(): Promise<Person> {
  const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
  return signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
}

async function invite(by: Person, level: string, email: string, project?: string) {
  const res = await call("POST", "/api/invites", by, {
    level,
    email,
    ...(project ? { project } : {}),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function invited(
  by: Person,
  level: string,
  name: string,
  email: string,
  project?: string,
): Promise<Person> {
  const id = await invite(by, level, email, project);
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

async function tokenOf(who: Person, level: string): Promise<Person> {
  const res = await call("POST", "/api/tokens", who, { name: `${level} token`, level });
  const body = (await res.json()) as { token: string; error?: string };
  expect(res.status, body.error).toBe(200);
  return { principal: who.principal, headers: { Authorization: `Bearer ${body.token}` } };
}

const mark = () =>
  (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;

/** The person's events since `seq`: every one a person caused, with its principal. */
const personEvents = (since: number) =>
  db
    .prepare(
      "SELECT type, actor, principal FROM events WHERE seq > ? AND actor IN ('human', 'mcp') ORDER BY seq",
    )
    .all(since) as { type: string; actor: string; principal: string | null }[];

/** A write that must succeed, every event it records naming `who` (B1). */
async function write(who: Person, method: string, path: string, body?: unknown) {
  const before = mark();
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(400);
  const events = personEvents(before);
  expect(events.length, `${method} ${path} recorded nothing`).toBeGreaterThan(0);
  for (const e of events) expect(e.principal, `${method} ${path}: ${e.type}`).toBe(who.principal);
  return data;
}

async function refused(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  const data = (await res.json()) as Record<string, unknown>;
  expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBe(403);
  return data;
}

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

describe("B1: in the Team setup every write names the person who asked", () => {
  it("records the signed-in person on every event of every write, whether by session, token or proxy", async () => {
    const adapter = new MockInferenceAdapter("dirk-27b", []);
    await start({ sources: ["accounts", "proxy"], trustedProxies: ["127.0.0.1"] }, adapter);
    const ada = await firstAdmin();
    const project = (
      await asPerson(ada, () =>
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");

    const created = await write(mo, "POST", `/api/projects/${project}/cards`, { title: "Search" });
    const card = (created.card as { id: string }).id;
    await write(mo, "PATCH", `/api/cards/${card}`, { title: "Search, fast", priority: 2 });
    const second = await write(mo, "POST", `/api/projects/${project}/cards`, { title: "Maps" });
    await write(mo, "POST", `/api/cards/${card}/reorder`, {
      afterCardId: (second.card as { id: string }).id,
    });
    await write(mo, "POST", "/api/cycles", {
      name: "Sprint 1",
      startsOn: "2026-10-01",
      endsOn: "2026-10-14",
    });

    // Seshat's proposal, applied by the Member (pm_api, pm/apply).
    adapter.enqueueResponse({
      text: "I suggest making it urgent.",
      toolCalls: [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: card, priority: 4, reason: "it blocks the API" },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
    await write(mo, "POST", "/api/pm/messages", { text: "What's next?" });
    let proposal: string | undefined;
    for (let i = 0; i < 100 && !proposal; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const thread = (await (await call("GET", "/api/pm/thread", mo)).json()) as {
        messages: { proposals?: { id: string }[] }[];
      };
      proposal = thread.messages.flatMap((m) => m.proposals ?? [])[0]?.id;
    }
    expect(proposal).toBeDefined();
    await write(mo, "POST", `/api/pm/proposals/${proposal}/apply`);

    const question = await store.runs.requestDecision({
      cardId: card,
      kind: "clarify",
      question: "Which index?",
      context: "",
      options: ["trigram", "prefix"],
    });
    await write(mo, "POST", `/api/decisions/${question.id}`, { option: 0 });
    await write(mo, "POST", `/api/cards/${card}/split`, {
      parts: [{ title: "Index" }, { title: "Query" }],
    });

    // A personal token and the trusted proxy name their person too.
    const moToken = await tokenOf(mo, "member");
    await write(moToken, "POST", `/api/projects/${project}/cards`, { title: "From CI" });
    const proxied = await invite(ada, "member", "pat@northwind.test");
    expect(proxied).toBeTruthy();
    const pat: Person = { principal: "", headers: { "X-Forwarded-Email": "pat@northwind.test" } };
    const who = (await (await call("GET", "/api/session", pat)).json()) as { principal: string };
    pat.principal = who.principal;
    expect(pat.principal).toMatch(/^p_/);
    await write(pat, "POST", `/api/projects/${project}/cards`, { title: "From the proxy" });

    // The Admin's own writes, explicit ones included.
    await write(ada, "PATCH", `/api/projects/${project}/settings`, { lead: mo.principal });
    await write(ada, "POST", `/api/members/${mo.principal}/level`, { level: "member", project });
    await write(ada, "POST", `/api/projects/${project}`, { status: "paused" });

    // Nothing a person caused was recorded without them.
    const unnamed = db
      .prepare("SELECT type FROM events WHERE actor IN ('human', 'mcp') AND principal IS NULL")
      .all();
    expect(unnamed).toEqual([]);
  });
});

describe("B2: a token's scope is a ceiling everywhere", () => {
  it("refuses a Viewer-scoped token of an Admin each Member and Admin action, however it is reached", async () => {
    await start({ sources: ["accounts", "passkeys"], publicUrl: PUBLIC });
    const ada = await firstAdmin();
    const project = (
      await asPerson(ada, () =>
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
    const card = (
      await asPerson(ada, () =>
        store.createCard({ tier: "task", title: "Search", status: "ready", projectId: project }),
      )
    ).id;
    // Ada is named in the Accept rule: the rule still needs a Member at least.
    await write(ada, "PATCH", `/api/projects/${project}/settings`, {
      accept_rule: [ada.principal],
    });
    const viewer = await tokenOf(ada, "viewer");
    const member = await tokenOf(ada, "member");
    const permission = await store.runs.requestDecision({
      cardId: card,
      kind: "permission",
      question: "Allow npm install?",
      context: "",
      options: ["deny", "allow"],
    });

    const before = mark();
    for (const [method, path, body] of [
      ["POST", `/api/members/${mo.principal}/level`, { level: "viewer" }],
      ["POST", `/api/members/${mo.principal}/level`, { level: "viewer", project }],
      ["PATCH", `/api/projects/${project}/settings`, { require_resolved_threads: true }],
      ["POST", `/api/cards/${card}/accept`, {}],
      ["POST", `/api/cards/${card}/override`, { toStatus: "done", reason: "ship it" }],
      ["POST", `/api/decisions/${permission.id}`, { option: 1 }],
      ["POST", "/api/learning/rules/rule_1/approve", { reach: "project" }],
      ["POST", `/api/cards/${card}/park`, { reason: "later" }],
    ] as const) {
      const r = await refused(viewer, method, path, body);
      expect(r.level, path).toBe("viewer");
    }
    // A Member-scoped token of an Admin does no Admin's work.
    await refused(member, "POST", `/api/members/${mo.principal}/level`, { level: "viewer" });
    // A passkey is registered in a session, never with a token.
    expect((await call("POST", "/api/passkeys/register/options", member)).status).toBe(403);
    // Nothing changed; each refusal is recorded against the token's person.
    const events = db
      .prepare("SELECT type, principal FROM events WHERE seq > ? AND type != 'token/used'")
      .all(before) as { type: string; principal: string }[];
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(["access/refused"]));
    expect(new Set(events.map((e) => e.principal))).toEqual(new Set([ada.principal]));
    // The same Admin, in their session, may.
    await write(ada, "POST", `/api/members/${mo.principal}/level`, { level: "viewer", project });
  });
});

describe("M3, M4, M5: project invites, overrides and the effective Accept rule", () => {
  it("M3: a project invite joins at Viewer workspace-wide, at the invited level on that project", async () => {
    await start();
    const ada = await firstAdmin();
    const [chronicle, atlas] = await asPerson(ada, async () => [
      (await store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" })).id,
      (await store.ensureProject({ rootPath: join(root, "atlas"), name: "Atlas" })).id,
    ]);
    const kim = await invited(ada, "member", "Kim", "kim@northwind.test", chronicle);
    const me = (await (await call("GET", "/api/session", kim)).json()) as { level: string };
    expect(me.level).toBe("viewer");
    const joined = (await log.getEventsByTypes(["member/joined"])).at(-1);
    expect(joined?.payload).toMatchObject({ principal: kim.principal, level: "viewer" });
    const override = (await log.getEventsByTypes(["member/level_changed"])).at(-1);
    expect(override?.payload).toEqual({
      principal: kim.principal,
      level: "member",
      project: chronicle,
    });
    const [here, there] = await asPerson(ada, async () => [
      (await store.createCard({ tier: "task", title: "A", status: "ready", projectId: chronicle }))
        .id,
      (await store.createCard({ tier: "task", title: "B", status: "ready", projectId: atlas })).id,
    ]);
    await write(kim, "POST", `/api/cards/${here}/park`, { reason: "later" });
    await refused(kim, "POST", `/api/cards/${there}/park`, { reason: "later" });
  });

  it("M4: an override names the person who asked, never another in the body", async () => {
    await start();
    const ada = await firstAdmin();
    const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
    const project = (
      await asPerson(ada, () =>
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    const card = (
      await asPerson(ada, () =>
        store.createCard({ tier: "task", title: "Search", status: "ready", projectId: project }),
      )
    ).id;
    // Ready to Review skips Verify: an override, taken by the person who asked.
    await write(ada, "POST", `/api/cards/${card}/override`, {
      toStatus: "review",
      reason: "verified by hand",
      principal: mo.principal,
    });
    const event = (await log.getEventsByTypes(["card/override"])).at(-1);
    expect(event?.principal).toBe(ada.principal);
    expect(event?.payload).toMatchObject({ principal: ada.principal });
  });

  it("M5: with no Accept rule, the project lead accepts, else the Admins; the refusal says who", async () => {
    // A Solo install switched to Team: its person becomes the first Admin (TEAM-3).
    const solo = log.ensureLocalPerson({ email: "ada@northwind.test", name: "Ada Admin" });
    await start();
    const ada = await firstAdmin();
    expect(ada.principal).toBe(solo);
    const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
    const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
    const [led, unled] = await asPerson(ada, async () => [
      (await store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" })).id,
      (await store.ensureProject({ rootPath: join(root, "atlas"), name: "Atlas" })).id,
    ]);
    await write(ada, "PATCH", `/api/projects/${led}/settings`, { lead: lee.principal });
    const access = new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() });
    expect(access.acceptHolders(led)).toEqual([lee.principal]);
    expect(access.acceptHolders(unled)).toEqual([ada.principal]);
    // A card with no project: the workspace default, the Admins.
    expect(access.acceptHolders(undefined)).toEqual([ada.principal]);
    expect(access.can(lee.principal, "accept", led)).toBe(true);
    expect(access.can(ada.principal, "accept", led)).toBe(false);
    expect(access.can(ada.principal, "accept", unled)).toBe(true);

    const [onLed, onUnled] = await asPerson(ada, async () => [
      (await store.createCard({ tier: "task", title: "A", status: "ready", projectId: led })).id,
      (await store.createCard({ tier: "task", title: "B", status: "ready", projectId: unled })).id,
    ]);
    const r1 = await refused(mo, "POST", `/api/cards/${onLed}/accept`);
    expect(String(r1.error)).toContain("No Accept rule set yet; Lee Lead can accept");
    const r2 = await refused(mo, "POST", `/api/cards/${onUnled}/accept`);
    expect(String(r2.error)).toContain("No Accept rule set yet; an Admin can accept");
  });
});

describe("minors: the last Admin, a lead's overrides, the live stream's origin", () => {
  it("keeps the last Admin: they cannot lower or remove themselves", async () => {
    await start();
    const ada = await firstAdmin();
    const lowered = await call("POST", `/api/members/${ada.principal}/level`, ada, {
      level: "member",
    });
    expect(lowered.status).toBe(409);
    expect(String(((await lowered.json()) as { error: string }).error)).toMatch(/last Admin/);
    const removed = await call("DELETE", `/api/members/${ada.principal}`, ada);
    expect(removed.status).toBe(409);
    expect(await log.getEventsByTypes(["member/level_changed", "member/removed"])).toEqual([]);
    // With a second Admin, the first may step down.
    const bo = await invited(ada, "admin", "Bo Admin", "bo@northwind.test");
    expect(bo.principal).toMatch(/^p_/);
    expect(
      (await call("POST", `/api/members/${ada.principal}/level`, ada, { level: "member" })).status,
    ).toBe(200);
  });

  it("a lead sets no override above their own level", async () => {
    await start();
    const ada = await firstAdmin();
    const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
    const vi2 = await invited(ada, "viewer", "Val Viewer", "val@northwind.test");
    const project = (
      await asPerson(ada, () =>
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    await write(ada, "PATCH", `/api/projects/${project}/settings`, { lead: lee.principal });
    await refused(lee, "POST", `/api/members/${vi2.principal}/level`, { level: "admin", project });
    await write(lee, "POST", `/api/members/${vi2.principal}/level`, { level: "member", project });
  });

  it("opens the live stream to the page's own origin only", async () => {
    // A Team server behind its TLS proxy names the host people use (security item 37).
    await start({ publicUrl: "https://sekhemet.northwind.test" });
    const ada = await firstAdmin();
    const upgrade = (origin: string, host?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/ws`, {
          headers: {
            ...ada.headers,
            ...(host ? { Host: host } : {}),
            Origin: origin,
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
    expect(await upgrade("http://evil.test")).toBe(403);
    expect(await upgrade(base)).toBe(101);
    // A Team server behind its TLS proxy: the page's own host, never another.
    const own = "sekhemet.northwind.test";
    expect(await upgrade(`https://${own}`, own)).toBe(101);
    expect(await upgrade("https://evil.test", own)).toBe(403);
    // A name the server does not answer to is a rebound page's (SEC-24).
    expect(await upgrade("https://evil.test", "evil.test")).toBe(421);
  });

  it("W1 review: a signed-in write from another loopback port is another site's, as in Solo", async () => {
    await start();
    const ada = await firstAdmin();
    const project = (
      await asPerson(ada, () =>
        store.ensureProject({ rootPath: join(root, "chronicle"), name: "Chronicle" }),
      )
    ).id;
    const patch = (origin?: string) =>
      fetch(`${base}/api/projects/${project}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Sekhemet-Action": "1",
          ...ada.headers,
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ lead: ada.principal }),
      });
    const before = mark();
    expect((await patch("http://127.0.0.1:3000")).status).toBe(403);
    expect((await patch("http://localhost:3000")).status).toBe(403);
    // Nothing was written (the sign-in's own activity mark aside).
    expect(personEvents(before).filter((e) => !e.type.startsWith("session/"))).toEqual([]);
    // The page's own origin, and a program that sends none, still write.
    expect((await patch(base)).status).toBeLessThan(400);
    expect((await patch()).status).toBeLessThan(400);
  });

  it("answers only the names it serves: loopback and its public URL's host (SEC-24)", async () => {
    await start({ publicUrl: "https://sekhemet.northwind.test" });
    const ada = await firstAdmin();
    const read = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/board`, { headers: { ...ada.headers, Host: host } });
        req.on("response", (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        });
        req.on("error", reject);
        req.end();
      });
    expect(await read("sekhemet.northwind.test")).toBe(200);
    expect(await read("attacker.example")).toBe(421);
    // The Team setup keeps its own CSRF: a session's write without its token is refused.
    const res = await fetch(`${base}/api/members/${ada.principal}/label`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        Cookie: ada.headers.Cookie ?? "",
      },
      body: JSON.stringify({ label: "Lead" }),
    });
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------------- passkeys over HTTP

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
    register(challenge: string) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]),
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
    assert(challenge: string) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), u32(counter)]);
      const cd = clientData("webauthn.get", challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(cd).digest()]),
        privateKey,
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

describe("M7: passkeys through the server's own routes", () => {
  it("registers in a session, signs in, and refuses a replayed challenge, another origin and another RP ID", async () => {
    await start({ sources: ["accounts", "passkeys"], publicUrl: PUBLIC });
    const ada = await firstAdmin();
    const options = async (path: string, who: Person) => {
      const res = await call("POST", path, who);
      expect(res.status).toBe(200);
      return ((await res.json()) as { challenge: string }).challenge;
    };

    // Another origin and another relying party are refused at registration.
    for (const device of [
      softwareAuthenticator("localhost", "http://evil.test"),
      softwareAuthenticator("evil.test", PUBLIC),
    ]) {
      const challenge = await options("/api/passkeys/register/options", ada);
      const res = await call("POST", "/api/passkeys/register", ada, device.register(challenge));
      expect(res.status).toBe(400);
    }
    expect(await log.getEventsByTypes(["passkey/registered"])).toEqual([]);

    const device = softwareAuthenticator("localhost", PUBLIC);
    const challenge = await options("/api/passkeys/register/options", ada);
    const registered = await write(
      ada,
      "POST",
      "/api/passkeys/register",
      device.register(challenge),
    );
    expect(String(registered.passkey)).toMatch(/^pk_/);
    // The registration challenge was good once.
    const again = await call("POST", "/api/passkeys/register", ada, device.register(challenge));
    expect(again.status).toBe(400);

    // Sign in with it; the sign-in challenge is good once too.
    const signInChallenge = await options("/api/passkeys/signin/options", nobody);
    const first = await call(
      "POST",
      "/api/passkeys/signin",
      nobody,
      device.assert(signInChallenge),
    );
    const session = await signedIn(first);
    expect(session.principal).toBe(ada.principal);
    const replay = await call(
      "POST",
      "/api/passkeys/signin",
      nobody,
      device.assert(signInChallenge),
    );
    expect(replay.status).toBe(401);
  });
});
