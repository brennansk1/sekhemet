import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createIngestHandler } from "../src/ingest.js";
import { EventStore } from "../src/store.js";

it("answers 404 for a source name longer than 32 characters and stores nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vanguard-witness-"));
  const store = new EventStore(join(dir, "events.db"));
  const server = createServer(createIngestHandler({ store, hmac: {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/ingest/${"a".repeat(33)}`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(store.count()).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
