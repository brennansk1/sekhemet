import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOP_BY_HOP_HEADERS, buildReplayHeaders, replayEvent } from "../src/replay.js";
import { EventStore, type NewEvent } from "../src/store.js";
import type { WebhookEvent } from "../src/types.js";

const RAW = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0xff, 0x00]);

function newEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    source: "stripe",
    method: "POST",
    path: "/ingest/stripe",
    headers: {
      host: "127.0.0.1:4040",
      "content-length": "9",
      connection: "keep-alive",
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=abc",
    },
    body: RAW,
    receivedAt: 1,
    verification: "verified",
    ...overrides,
  };
}

describe("vanguard buildReplayHeaders", () => {
  const stored: WebhookEvent = { ...newEvent(), id: 7 };

  it("drops hop-by-hop headers and tags the replay with the event id", () => {
    expect(HOP_BY_HOP_HEADERS).toEqual([
      "host",
      "content-length",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]);
    expect(buildReplayHeaders(stored)).toEqual({
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=abc",
      "x-vanguard-replay": "7",
    });
  });

  it("applies overrides case-insensitively, replacing stored values", () => {
    expect(
      buildReplayHeaders(stored, { "Stripe-Signature": "t=2,v1=def", "X-Extra": "1" }),
    ).toEqual({
      "content-type": "application/json",
      "stripe-signature": "t=2,v1=def",
      "x-extra": "1",
      "x-vanguard-replay": "7",
    });
  });

  it("does not let an override remove the replay marker", () => {
    expect(
      buildReplayHeaders(stored, { "x-vanguard-replay": "spoofed" })["x-vanguard-replay"],
    ).toBe("7");
  });

  it("does not mutate the stored event's headers", () => {
    buildReplayHeaders(stored, { "content-type": "text/plain" });
    expect(stored.headers["content-type"]).toBe("application/json");
    expect(stored.headers.host).toBe("127.0.0.1:4040");
  });
});

describe("vanguard replayEvent over HTTP", () => {
  let dir: string;
  let store: EventStore;
  let target: Server;
  let targetUrl: string;
  let received: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }[];
  let respondWith: { status: number; body: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vanguard-replay-"));
    store = new EventStore(join(dir, "events.db"));
    received = [];
    respondWith = { status: 200, body: "ok" };
    target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        res.writeHead(respondWith.status, { "content-type": "text/plain" });
        res.end(respondWith.body);
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/webhook`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => target.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replays the exact bytes and headers to the target and captures the response", async () => {
    const { id } = store.insert(newEvent());
    const result = await replayEvent(store, { eventId: id, targetUrl });
    expect(result.eventId).toBe(id);
    expect(result.status).toBe(200);
    expect(result.responseBody).toBe("ok");

    expect(received.length).toBe(1);
    const req = received[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/api/webhook");
    expect(req?.body.equals(RAW)).toBe(true);
    expect(req?.headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["x-vanguard-replay"]).toBe(String(id));
    expect(req?.headers.host).toBe(new URL(targetUrl).host);
  });

  it("sends header overrides", async () => {
    const { id } = store.insert(newEvent());
    await replayEvent(store, {
      eventId: id,
      targetUrl,
      headerOverrides: { "Stripe-Signature": "t=9,v1=new" },
    });
    expect(received[0]?.headers["stripe-signature"]).toBe("t=9,v1=new");
  });

  it("measures duration with the injected clock", async () => {
    const { id } = store.insert(newEvent());
    const ticks = [1000, 1250];
    const result = await replayEvent(store, { eventId: id, targetUrl }, () => ticks.shift() ?? 0);
    expect(result.durationMs).toBe(250);
  });

  it("captures an error status from the target instead of throwing", async () => {
    respondWith = { status: 500, body: "boom" };
    const { id } = store.insert(newEvent());
    const result = await replayEvent(store, { eventId: id, targetUrl });
    expect([result.status, result.responseBody]).toEqual([500, "boom"]);
  });

  it("rejects an unknown event id without sending anything", async () => {
    await expect(replayEvent(store, { eventId: 404, targetUrl })).rejects.toThrow(
      "event not found: 404",
    );
    expect(received).toEqual([]);
  });

  it("rejects a non-HTTP target URL", async () => {
    const { id } = store.insert(newEvent());
    await expect(
      replayEvent(store, { eventId: id, targetUrl: "ftp://127.0.0.1/x" }),
    ).rejects.toThrow("unsupported protocol: ftp:");
    await expect(
      replayEvent(store, { eventId: id, targetUrl: "file:///etc/passwd" }),
    ).rejects.toThrow("unsupported protocol: file:");
    expect(received).toEqual([]);
  });
});
