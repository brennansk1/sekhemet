import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signGithub, signStripe } from "../src/hmac.js";
import { type IngestOptions, createIngestHandler, verifyForSource } from "../src/ingest.js";
import { EventStore } from "../src/store.js";
import type { WebhookEvent } from "../src/types.js";

const STRIPE_SECRET = "whsec_ingest";
const GITHUB_SECRET = "gh_ingest";
const NOW_S = 1_700_000_000;
const BODY = '{"type":"invoice.paid","amount":4200}';

describe("vanguard verifyForSource", () => {
  const hmac = { stripeSecret: STRIPE_SECRET, githubSecret: GITHUB_SECRET };

  it("uses the Stripe scheme for the stripe source when a secret is configured", () => {
    const headers = { "stripe-signature": signStripe(STRIPE_SECRET, BODY, NOW_S) };
    expect(verifyForSource("stripe", headers, Buffer.from(BODY), hmac, NOW_S)).toEqual({
      status: "verified",
      scheme: "stripe",
    });
  });

  it("uses the GitHub scheme for the github source", () => {
    const headers = { "x-hub-signature-256": signGithub("wrong", BODY) };
    expect(verifyForSource("github", headers, Buffer.from(BODY), hmac, NOW_S)).toEqual({
      status: "failed",
      scheme: "github",
      reason: "signature mismatch",
    });
  });

  it("returns unsigned for other sources and for providers without a secret", () => {
    const unsigned = { status: "unsigned", scheme: "none" };
    expect(verifyForSource("shopify", {}, Buffer.from(BODY), hmac, NOW_S)).toEqual(unsigned);
    expect(verifyForSource("stripe", {}, Buffer.from(BODY), {}, NOW_S)).toEqual(unsigned);
  });

  it("applies the configured tolerance", () => {
    const headers = { "stripe-signature": signStripe(STRIPE_SECRET, BODY, NOW_S) };
    const strict = { stripeSecret: STRIPE_SECRET, toleranceSeconds: 10 };
    expect(verifyForSource("stripe", headers, Buffer.from(BODY), strict, NOW_S + 11).reason).toBe(
      "timestamp outside tolerance",
    );
  });
});

describe("vanguard ingest handler over HTTP", () => {
  let dir: string;
  let store: EventStore;
  let server: Server;
  let base: string;
  let seen: WebhookEvent[];

  async function start(overrides: Partial<IngestOptions> = {}): Promise<void> {
    const handler = createIngestHandler({
      store,
      hmac: { stripeSecret: STRIPE_SECRET, githubSecret: GITHUB_SECRET },
      now: () => NOW_S * 1000,
      maxBodyBytes: 64,
      onEvent: (e) => seen.push(e),
      ...overrides,
    });
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vanguard-ingest-"));
    store = new EventStore(join(dir, "events.db"));
    seen = [];
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a signed Stripe webhook with 202 and stores it verbatim", async () => {
    await start();
    const res = await fetch(`${base}/ingest/stripe?attempt=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signStripe(STRIPE_SECRET, BODY, NOW_S),
      },
      body: BODY,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 1, verification: "verified" });

    const stored = store.get(1);
    expect(stored?.source).toBe("stripe");
    expect(stored?.method).toBe("POST");
    expect(stored?.path).toBe("/ingest/stripe?attempt=1");
    expect(stored?.body.toString()).toBe(BODY);
    expect(stored?.headers["stripe-signature"]).toBe(signStripe(STRIPE_SECRET, BODY, NOW_S));
    expect(stored?.headers["content-type"]).toBe("application/json");
    expect(stored?.receivedAt).toBe(NOW_S * 1000);
    expect(seen.map((e) => e.id)).toEqual([1]);
  });

  it("stores a tampered Stripe webhook as failed and answers 401", async () => {
    await start();
    const res = await fetch(`${base}/ingest/stripe`, {
      method: "POST",
      headers: { "stripe-signature": signStripe(STRIPE_SECRET, BODY, NOW_S) },
      body: BODY.replace("4200", "4201"),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      id: 1,
      verification: "failed",
      reason: "signature mismatch",
    });
    expect(store.get(1)?.verification).toBe("failed");
  });

  it("verifies a GitHub webhook and accepts an unsigned source", async () => {
    await start();
    const gh = await fetch(`${base}/ingest/github`, {
      method: "POST",
      headers: { "x-hub-signature-256": signGithub(GITHUB_SECRET, BODY) },
      body: BODY,
    });
    expect(await gh.json()).toEqual({ id: 1, verification: "verified" });
    const shop = await fetch(`${base}/ingest/shopify`, { method: "POST", body: "x=1" });
    expect(shop.status).toBe(202);
    expect(await shop.json()).toEqual({ id: 2, verification: "unsigned" });
  });

  it("rejects a stale Stripe timestamp using the injected clock", async () => {
    await start({ now: () => (NOW_S + 3600) * 1000 });
    const res = await fetch(`${base}/ingest/stripe`, {
      method: "POST",
      headers: { "stripe-signature": signStripe(STRIPE_SECRET, BODY, NOW_S) },
      body: BODY,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("timestamp outside tolerance");
  });

  it("answers 413 for a body over the limit and stores nothing", async () => {
    await start();
    const res = await fetch(`${base}/ingest/shopify`, { method: "POST", body: "x".repeat(65) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    expect(store.count()).toBe(0);
    expect(seen).toEqual([]);
  });

  it("accepts a body exactly at the limit", async () => {
    await start();
    const res = await fetch(`${base}/ingest/shopify`, { method: "POST", body: "x".repeat(64) });
    expect(res.status).toBe(202);
    expect(store.get(1)?.body.length).toBe(64);
  });

  it("answers 405 with an Allow header for a non-POST method", async () => {
    await start();
    const res = await fetch(`${base}/ingest/stripe`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(store.count()).toBe(0);
  });

  it("answers 404 for unknown paths and invalid source names", async () => {
    await start();
    for (const path of ["/", "/ingest/", "/ingest/Bad_Source", "/ingest/a/b", "/other"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(store.count()).toBe(0);
  });
});
