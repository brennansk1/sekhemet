import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";

// HELD OUT (measurement T11, MS-T7-8): never shown to the Planner, Seshat or
// the Worker. Project-level checks of Chronicle's specification that no
// card's acceptance test makes over HTTP. DRAFT until a person confirms it.

describe("held out: chronicle as a whole", () => {
  let dir: string;
  let dbPath: string;
  const servers: { port: number; close: () => Promise<void> }[] = [];
  const start = async () => {
    const s = await startServer({ dbPath, port: 0 });
    servers.push(s);
    return s;
  };
  const post = (port: number, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chronicle-held-out-"));
    dbPath = join(dir, "c.db");
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaying an idempotency key over HTTP returns the original event and appends nothing", async () => {
    const s = await start();
    const first = (await (
      await post(s.port, { type: "pay", payload: { n: 1 }, idempotencyKey: "k-1" })
    ).json()) as { id: string };
    const again = (await (
      await post(s.port, { type: "pay", payload: { n: 2 }, idempotencyKey: "k-1" })
    ).json()) as { id: string };
    expect(again.id).toBe(first.id);
    const audit = (await (await fetch(`http://127.0.0.1:${s.port}/audit`)).json()) as {
      totalEvents: number;
    };
    expect(audit.totalEvents).toBe(1);
  });

  it("survives a restart: the chain continues where it stopped and still audits clean", async () => {
    const a = await start();
    await post(a.port, { type: "a", payload: 1 });
    await post(a.port, { type: "b", payload: 2 });
    await a.close();
    servers.splice(servers.indexOf(a), 1);
    const b = await start();
    const third = (await (await post(b.port, { type: "c", payload: 3 })).json()) as {
      sequenceNumber: number;
    };
    expect(third.sequenceNumber).toBe(3);
    const audit = (await (await fetch(`http://127.0.0.1:${b.port}/audit`)).json()) as {
      valid: boolean;
      totalEvents: number;
    };
    expect(audit).toMatchObject({ valid: true, totalEvents: 3 });
  });

  it("catches a rewritten link in the chain, not only a changed payload", async () => {
    const s = await start();
    for (let i = 0; i < 3; i++) await post(s.port, { type: "t", payload: { i } });
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE chronicle_events SET previous_hash = ? WHERE sequence_number = 2").run(
      "0".repeat(64),
    );
    db.close();
    const audit = (await (await fetch(`http://127.0.0.1:${s.port}/audit`)).json()) as {
      valid: boolean;
      corruptedAtSequence: number;
    };
    expect(audit.valid).toBe(false);
    expect(audit.corruptedAtSequence).toBe(2);
  });
});
