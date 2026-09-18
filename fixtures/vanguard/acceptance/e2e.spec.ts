import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { signStripe } from "../src/hmac.js";

const SECRET = "whsec_e2e";
const NOW_S = 1_700_000_000;
const PAYLOAD = '{"id":"evt_42","type":"checkout.session.completed","amount":1999}';

/** Open an SSE stream and collect its text. */
function openStream(url: string): Promise<{ waitFor: (s: string) => Promise<string> }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let text = "";
      const waiters: { s: string; done: (t: string) => void }[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        for (const w of [...waiters]) {
          if (text.includes(w.s)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.done(text);
          }
        }
      });
      resolve({
        waitFor: (s) =>
          text.includes(s)
            ? Promise.resolve(text)
            : new Promise((done) => waiters.push({ s, done })),
      });
    }).on("error", reject);
  });
}

/** End-to-end tests for card_vang_8_e2e: ingest, verify, stream and replay. */
describe("vanguard daemon end to end", () => {
  let dir: string;
  let daemon: Daemon;
  let base: string;
  let target: Server;
  let targetUrl: string;
  let received: { headers: IncomingHttpHeaders; body: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vanguard-e2e-"));
    daemon = await startDaemon({
      dbPath: join(dir, "vanguard.db"),
      port: 0,
      hmac: { stripeSecret: SECRET },
      now: () => NOW_S * 1000,
    });
    base = `http://127.0.0.1:${daemon.port}`;

    received = [];
    target = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        body += c;
      });
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"received":true}');
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/webhook`;
  });

  afterEach(async () => {
    await daemon.close();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  function sendStripe(body: string, signature: string): Promise<Response> {
    return fetch(`${base}/ingest/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });
  }

  it("binds an ephemeral port on 127.0.0.1 and reports health", async () => {
    expect(daemon.port).toBeGreaterThan(0);
    const res = await fetch(`${base}/health`);
    expect([res.status, await res.json()]).toEqual([200, { status: "ok" }]);
  });

  it("streams a verified Stripe webhook to SSE listeners as it is ingested", async () => {
    const stream = await openStream(`${base}/events/stream`);
    await stream.waitFor(": connected\n\n");

    const res = await sendStripe(PAYLOAD, signStripe(SECRET, PAYLOAD, NOW_S));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 1, verification: "verified" });

    const text = await stream.waitFor('"bytes":65}\n\n');
    expect(text).toBe(
      ': connected\n\nid: 1\nevent: webhook\ndata: {"id":1,"source":"stripe","verification":"verified","bytes":65}\n\n',
    );
  });

  it("records a forged webhook as failed, streams it, and still lists it", async () => {
    const stream = await openStream(`${base}/events/stream`);
    await stream.waitFor(": connected\n\n");
    const forged = await sendStripe(PAYLOAD, signStripe("whsec_attacker", PAYLOAD, NOW_S));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({
      id: 1,
      verification: "failed",
      reason: "signature mismatch",
    });
    await stream.waitFor('"verification":"failed"');

    const list = (await (await fetch(`${base}/events`)).json()) as {
      id: number;
      verification: string;
    }[];
    expect(list.map((e) => [e.id, e.verification])).toEqual([[1, "failed"]]);
  });

  it("lists events newest first with metadata and byte counts", async () => {
    await sendStripe(PAYLOAD, signStripe(SECRET, PAYLOAD, NOW_S));
    await fetch(`${base}/ingest/shopify`, { method: "POST", body: "a=1" });
    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: 2,
        source: "shopify",
        method: "POST",
        path: "/ingest/shopify",
        verification: "unsigned",
        receivedAt: NOW_S * 1000,
        bytes: 3,
      },
      {
        id: 1,
        source: "stripe",
        method: "POST",
        path: "/ingest/stripe",
        verification: "verified",
        receivedAt: NOW_S * 1000,
        bytes: 65,
      },
    ]);
  });

  it("replays a stored webhook to the local app with identical body and signature", async () => {
    const signature = signStripe(SECRET, PAYLOAD, NOW_S);
    await sendStripe(PAYLOAD, signature);

    const res = await fetch(`${base}/events/1/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: targetUrl }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { eventId: number; status: number; responseBody: string };
    expect([result.eventId, result.status, result.responseBody]).toEqual([
      1,
      200,
      '{"received":true}',
    ]);
    expect(received.length).toBe(1);
    expect(received[0]?.body).toBe(PAYLOAD);
    expect(received[0]?.headers["stripe-signature"]).toBe(signature);
    expect(received[0]?.headers["x-vanguard-replay"]).toBe("1");
  });

  it("applies header overrides on replay", async () => {
    await sendStripe(PAYLOAD, signStripe(SECRET, PAYLOAD, NOW_S));
    await fetch(`${base}/events/1/replay`, {
      method: "POST",
      body: JSON.stringify({ to: targetUrl, headers: { "X-Debug": "on" } }),
    });
    expect(received[0]?.headers["x-debug"]).toBe("on");
  });

  it("answers 404 when replaying an unknown event and sends nothing", async () => {
    const res = await fetch(`${base}/events/99/replay`, {
      method: "POST",
      body: JSON.stringify({ to: targetUrl }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found: 99" });
    expect(received).toEqual([]);
  });

  it("answers 400 for a replay request without a target or with invalid JSON", async () => {
    await sendStripe(PAYLOAD, signStripe(SECRET, PAYLOAD, NOW_S));
    const noTarget = await fetch(`${base}/events/1/replay`, { method: "POST", body: "{}" });
    expect([noTarget.status, await noTarget.json()]).toEqual([400, { error: "missing to" }]);
    const badJson = await fetch(`${base}/events/1/replay`, { method: "POST", body: "{nope" });
    expect(badJson.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("answers 404 for an unknown route", async () => {
    const res = await fetch(`${base}/nope`);
    expect([res.status, await res.json()]).toEqual([404, { error: "not found" }]);
  });
});
