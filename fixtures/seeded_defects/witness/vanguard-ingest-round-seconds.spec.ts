import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { signStripe } from "../src/hmac.js";
import { createIngestHandler } from "../src/ingest.js";
import { EventStore } from "../src/store.js";

it("floors the receive time to seconds, so 300.6 s after signing is still within tolerance", async () => {
  const signedAt = 1_700_000_000;
  const body = '{"type":"invoice.paid"}';
  const dir = mkdtempSync(join(tmpdir(), "vanguard-witness-"));
  const store = new EventStore(join(dir, "events.db"));
  const handler = createIngestHandler({
    store,
    hmac: { stripeSecret: "whsec_w" },
    now: () => (signedAt + 300) * 1000 + 600,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/ingest/stripe`, {
      method: "POST",
      headers: { "stripe-signature": signStripe("whsec_w", body, signedAt) },
      body,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 1, verification: "verified" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
