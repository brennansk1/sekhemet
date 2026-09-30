import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { allowedHosts, hostAllowed, hostAllowlistWarning, sameOrigin } from "../src/web_guard.js";

/**
 * Security S3c on a real Solo server (SEC-24, SEC-25, SEC-26; DB-S3c-1,
 * DB-S3c-2; gap register B-1): a request whose Host is not this server's
 * (DNS rebinding) is refused before any route runs, GET included; a write
 * without the per-start token the page receives is refused with or without
 * an Origin; every page is served with a strict Content-Security-Policy and
 * may not be framed; the live streams check Host and Origin too.
 */

let root: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let server: { port: number; close: () => Promise<void> };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so the Host and Origin headers are exactly what a hostile page would send. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The first bytes of a streaming answer (SSE), then the connection is dropped. */
function head(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, headers }, (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: server.port,
      path: "/api/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
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
}

const own = () => `127.0.0.1:${server.port}`;
const REBOUND = "attacker.example:4100";

/** What the page does at load: `GET /api/session` hands it this server's token. */
async function pageToken(): Promise<string> {
  const r = await send("GET", "/api/session", { Host: own() });
  expect(r.status).toBe(200);
  const csrf = (JSON.parse(r.body) as { csrf?: unknown }).csrf;
  expect(typeof csrf).toBe("string");
  return csrf as string;
}

const accept = (headers: Record<string, string>) =>
  send(
    "POST",
    "/api/cards/h1/accept",
    { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...headers },
    "{}",
  );

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-hardening-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  await store.createCard({ id: "h1", tier: "story", title: "Guarded", status: "backlog" });
  await store.updateCardStatus("h1", "review", "verified", "harness", { override: true });
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: root,
    port: 0,
    streamIntervalMs: 10_000,
  });
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("DNS rebinding: the Host allowlist (SEC-24)", () => {
  it("refuses a board read whose Host is another name, and serves its own", async () => {
    const rebound = await send("GET", "/api/board", { Host: REBOUND });
    expect(rebound.status).toBe(421);
    expect(rebound.body).not.toContain("h1");
    expect((await send("GET", "/api/board", { Host: own() })).status).toBe(200);
    expect((await send("GET", "/api/board", { Host: `localhost:${server.port}` })).status).toBe(
      200,
    );
    expect((await send("GET", "/api/board", { Host: `[::1]:${server.port}` })).status).toBe(200);
  });

  it("refuses the page, the evidence and the session token to a rebound name", async () => {
    for (const path of ["/", "/api/session", "/api/cards/h1", "/app/app.js"]) {
      const r = await send("GET", path, { Host: REBOUND });
      expect(r.status, path).toBe(421);
    }
  });

  it("refuses Accept from a rebound name even with the page's token, and nothing moves", async () => {
    const token = await pageToken();
    const r = await accept({ Host: REBOUND, "X-Sekhemet-CSRF": token });
    expect(r.status).toBe(421);
    expect((await store.getCard("h1"))?.status).toBe("review");
  });

  it("refuses a Host that smuggles a loopback name", async () => {
    for (const host of ["evil@127.0.0.1", "127.0.0.1.attacker.example", "localhost."]) {
      const r = await send("GET", "/api/board", { Host: host });
      expect(r.status, host).toBe(421);
    }
    // No Host at all (HTTP/1.0, which may omit it): refused too.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let text = "";
      socket.on("data", (d: Buffer) => {
        text += d.toString();
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
      socket.write("GET /api/board HTTP/1.0\r\n\r\n");
    });
    expect(raw.split("\r\n")[0]).toMatch(/ 421 /);
  });

  it("refuses the live streams to a rebound name", async () => {
    expect(await head("/api/stream", { Host: REBOUND })).toBe(421);
    expect(await upgrade({ Host: REBOUND })).toBe(421);
  });
});

describe("the per-start mutation token (SEC-25, DB-S3c-1)", () => {
  it("refuses Accept with no token and no Origin, and nothing moves", async () => {
    const r = await accept({ Host: own() });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ error: "csrf" });
    // W1 finding: Solo has no sign-in, so its refusal carries a Solo sentence
    // for the page and for any client of the API (DEC-31).
    const message = JSON.parse(r.body).message;
    expect(message).toMatch(/reload the page/i);
    expect(message).not.toMatch(/sign in|session|token|csrf/i);
    expect((await store.getCard("h1"))?.status).toBe("review");
  });

  it("refuses a wrong token, and a right one from a foreign origin", async () => {
    const token = await pageToken();
    expect((await accept({ Host: own(), "X-Sekhemet-CSRF": `${token}x` })).status).toBe(403);
    const foreign = await accept({
      Host: own(),
      "X-Sekhemet-CSRF": token,
      Origin: "http://127.0.0.1:3000",
    });
    expect(foreign.status).toBe(403);
    expect((await store.getCard("h1"))?.status).toBe("review");
  });

  it("refuses every write method without the token, whatever the route", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await send(method, "/api/no-such-route", {
        Host: own(),
        "X-Sekhemet-Action": "1",
      });
      expect(r.status, method).toBe(403);
    }
  });

  it("lets the page's own write through: its token, its own origin", async () => {
    const token = await pageToken();
    const r = await send(
      "POST",
      "/api/cards/h1/opened",
      {
        Host: own(),
        Origin: `http://${own()}`,
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        "X-Sekhemet-CSRF": token,
      },
      JSON.stringify({ files: [] }),
    );
    expect(r.status, r.body).not.toBe(403);
    expect(r.status).not.toBe(421);
  });

  it("refuses the page's token from a foreign origin at the guard, whatever the route", async () => {
    // W1 review: the Origin rule is the guard's, not each route's, so a route
    // that forgets it is still covered.
    const token = await pageToken();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await send(method, "/api/no-such-route", {
        Host: own(),
        Origin: "http://127.0.0.1:3000",
        "X-Sekhemet-Action": "1",
        "X-Sekhemet-CSRF": token,
      });
      expect(r.status, method).toBe(403);
      expect(JSON.parse(r.body), method).toMatchObject({ error: "csrf", refused: "origin" });
      expect(JSON.parse(r.body).message, method).toMatch(/another page/i);
      expect(JSON.parse(r.body).message, method).not.toMatch(/sign in|session|token|csrf/i);
    }
  });

  it("the session answer, which carries the token, is never cached", async () => {
    const r = await send("GET", "/api/session", { Host: own() });
    expect(r.status).toBe(200);
    expect(String(r.headers["cache-control"])).toMatch(/no-store/);
  });

  it("mints a new token for each start, so an old page's token stops working", async () => {
    const first = await pageToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await server.close();
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store),
      cardStore: store,
      repoPath: root,
      port: 0,
      streamIntervalMs: 10_000,
    });
    expect(await pageToken()).not.toBe(first);
    expect((await accept({ Host: own(), "X-Sekhemet-CSRF": first })).status).toBe(403);
  });
});

describe("headers on every page (SEC-26, DB-S3c-2)", () => {
  const PAGES = ["/", "/index.html", "/invite/abc123", "/password-reset/abc123"];

  it("sends a strict policy, no framing, no referrer and a permissions policy", async () => {
    for (const path of PAGES) {
      const r = await send("GET", path, { Host: own() });
      expect(r.status, path).toBe(200);
      expect(String(r.headers["content-type"])).toContain("text/html");
      const csp = String(r.headers["content-security-policy"]);
      const directives = new Map(
        csp.split(";").map((d) => {
          const [name = "", ...values] = d.trim().split(/\s+/);
          return [name, values] as const;
        }),
      );
      expect(directives.get("default-src"), path).toEqual(["'self'"]);
      expect(directives.get("script-src"), path).toEqual(["'self'"]);
      expect(directives.get("frame-ancestors"), path).toEqual(["'none'"]);
      expect(directives.get("object-src"), path).toEqual(["'none'"]);
      expect(directives.get("base-uri"), path).toEqual(["'none'"]);
      expect(csp).not.toContain("unsafe-eval");
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
      expect(String(r.headers["permissions-policy"]), path).toContain("camera=()");
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  it("allows the page's own inline style by its hash, and the page has no inline script", async () => {
    const r = await send("GET", "/", { Host: own() });
    const csp = String(r.headers["content-security-policy"]);
    const styles = [...r.body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
    expect(styles.length).toBeGreaterThan(0);
    for (const css of styles) {
      const hash = createHash("sha256").update(css, "utf8").digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    // Every script has a src; no element carries an inline handler.
    for (const m of r.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/\bsrc=/);
      expect((m[2] ?? "").trim()).toBe("");
    }
    expect(r.body).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("sends the framing and referrer rules on the API and static files too", async () => {
    for (const path of ["/api/board", "/app/app.js", "/tokens.css", "/favicon.svg"]) {
      const r = await send("GET", path, { Host: own() });
      expect(r.status, path).toBe(200);
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(String(r.headers["content-security-policy"]), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
    }
  });
});

describe("the live streams check Origin", () => {
  it("refuses the event stream to another origin, even another loopback port", async () => {
    expect(await head("/api/stream", { Host: own(), Origin: "https://evil.example" })).toBe(403);
    expect(await head("/api/stream", { Host: own(), Origin: "http://127.0.0.1:3000" })).toBe(403);
    expect(await head("/api/stream", { Host: own(), Origin: `http://${own()}` })).toBe(200);
    expect(await head("/api/stream", { Host: own() })).toBe(200);
  });

  it("refuses the WebSocket to another origin, even another loopback port", async () => {
    expect(await upgrade({ Host: own(), Origin: "http://127.0.0.1:3000" })).toBe(403);
    expect(await upgrade({ Host: own(), Origin: `http://${own()}` })).toBe(101);
  });
});

describe("the allowlist's rules", () => {
  it("warns at start when a Team server off loopback has no public URL to answer to", () => {
    expect(hostAllowlistWarning({ bindHost: "127.0.0.1" })).toBeUndefined();
    expect(
      hostAllowlistWarning({ bindHost: "0.0.0.0", publicUrl: "https://sekhemet.northwind.test" }),
    ).toBeUndefined();
    for (const bindHost of ["0.0.0.0", "10.0.0.5"]) {
      const warning = hostAllowlistWarning({ bindHost });
      expect(warning, bindHost).toMatch(/public_url/);
      expect(warning, bindHost).toMatch(/421|refuse/i);
    }
  });

  it("names loopback, the bound address and the public URL's host", () => {
    const solo = allowedHosts({ bindHost: "127.0.0.1" });
    expect(hostAllowed("127.0.0.1:4100", solo)).toBe(true);
    expect(hostAllowed("LOCALHOST:4100", solo)).toBe(true);
    expect(hostAllowed("[::1]:4100", solo)).toBe(true);
    expect(hostAllowed("sekhemet.northwind.test", solo)).toBe(false);
    expect(hostAllowed(undefined, solo)).toBe(false);
    const team = allowedHosts({
      bindHost: "10.0.0.5",
      publicUrl: "https://Sekhemet.Northwind.test",
    });
    expect(hostAllowed("sekhemet.northwind.test", team)).toBe(true);
    expect(hostAllowed("10.0.0.5:4100", team)).toBe(true);
    expect(hostAllowed("attacker.example", team)).toBe(false);
  });

  it("treats an Origin as the page's own only when it names the request's host", () => {
    expect(sameOrigin(undefined, "127.0.0.1:4100")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:4100", "127.0.0.1:4100")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:3000", "127.0.0.1:4100")).toBe(false);
    expect(sameOrigin("null", "127.0.0.1:4100")).toBe(false);
    expect(sameOrigin("https://own.test", "own.test")).toBe(true);
  });
});

describe("one failing request does not stop the dashboard (W1 review)", () => {
  it("answers 500 for a handler that throws, and keeps serving", async () => {
    await server.close();
    const failing = new BoardServiceImpl(store);
    failing.getBoardState = async () => {
      throw new Error("the board could not be read");
    };
    server = await startDashboardServer({
      db,
      log,
      boardService: failing,
      cardStore: store,
      repoPath: root,
      port: 0,
      streamIntervalMs: 10_000,
    });
    const r = await send("GET", "/api/board", { Host: own() });
    expect(r.status).toBe(500);
    // The person reads that something failed, not the internals.
    expect(JSON.parse(r.body)).toMatchObject({ error: expect.any(String) });
    expect(r.body).not.toContain("could not be read");
    expect((await send("GET", "/api/session", { Host: own() })).status).toBe(200);
  });
});
