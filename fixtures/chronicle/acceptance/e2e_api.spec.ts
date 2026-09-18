import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";

/** End-to-end acceptance tests for card_chron_api over real HTTP. */
describe("chronicle api", () => {
  let dir: string;
  let dbPath: string;
  let server: { port: number; close: () => Promise<void> };
  const url = (path: string): string => `http://127.0.0.1:${server.port}${path}`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "chronicle-api-"));
    dbPath = join(dir, "c.db");
    // Port 0 asks the OS for a free port, so tests never collide.
    server = await startServer({ dbPath, port: 0 });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports health", async () => {
    const res = await fetch(url("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("appends an event and retrieves it by id", async () => {
    const created = await fetch(url("/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "order.created", payload: { total: 10 } }),
    });
    expect(created.status).toBe(201);
    const event = (await created.json()) as { id: string; sequenceNumber: number };
    expect(event.sequenceNumber).toBe(1);

    const fetched = await fetch(url(`/events/${event.id}`));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ id: event.id, type: "order.created" });
  });

  it("returns 404 for an unknown event id", async () => {
    const res = await fetch(url("/events/does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("returns 400 with a descriptive message for invalid JSON", async () => {
    const res = await fetch(url("/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("runs the full workflow: five appends audit clean, a tamper makes the audit fail", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url("/events"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "order.created", payload: { i } }),
      });
      expect(res.status).toBe(201);
    }

    const clean = (await (await fetch(url("/audit"))).json()) as {
      valid: boolean;
      totalEvents: number;
    };
    expect(clean).toMatchObject({ valid: true, totalEvents: 5 });

    // Tamper with the database directly, as an attacker with disk access would.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE chronicle_events SET payload_json = ? WHERE sequence_number = 3").run(
      JSON.stringify({ i: 999 }),
    );
    db.close();

    const tampered = (await (await fetch(url("/audit"))).json()) as {
      valid: boolean;
      corruptedAtSequence: number;
    };
    expect(tampered.valid).toBe(false);
    expect(tampered.corruptedAtSequence).toBe(3);
  });
});
