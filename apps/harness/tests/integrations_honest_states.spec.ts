import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listIntegrations, readSettings, writeSettings } from "../src/integrations.js";
import { sendPush } from "../src/notify.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Loop wave 5, builder A (sweep 3, integrations): what Integrations says is
 * connected is what is connected (dashboard §2.11; integrations principle 1).
 * A real Solo server over an on-disk ledger, in a folder with no GitHub remote.
 */

/** A port on this machine that nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((resolve) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    }),
  );
  await new Promise((r) => s.close(r));
  return port;
}

describe("Integrations' honest states (loop wave 5, A1–A3)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let server: { port: number; close: () => Promise<void> };
  let base: string;

  const send = async (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const entry = async (id: string) =>
    ((await (await fetch(`${base}/api/integrations`)).json()) as Record<string, unknown>[]).find(
      (e) => e.id === id,
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "int-honest-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "int-honest-cfg-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    log = new EventLog(db);
    const cards = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(dir, { recursive: true, force: true });
  });

  it("A1: Jira and Linear are files only, never connected (dashboard §2.11)", async () => {
    const list = await listIntegrations(dir);
    for (const id of ["jira", "linear"]) {
      const e = list.find((x) => x.id === id);
      expect(e?.connected).toBe(false);
      expect(e?.detail).not.toMatch(/connected/i);
    }
  });

  it("A2: PR on Accept cannot be switched on without a GitHub connection; off always works", async () => {
    const on = await send("PUT", "/api/integrations/github-pr", { enabled: true });
    expect(on.status).toBe(409);
    expect(((await on.json()) as { error: string }).error).toMatch(/GitHub/);
    expect(readSettings(dir).githubPrOnAccept).toBeUndefined();
    // A setting an older version saved can always be turned off.
    writeSettings(dir, { githubPrOnAccept: true });
    const off = await send("PUT", "/api/integrations/github-pr", { enabled: false });
    expect(off.status).toBe(200);
    expect(readSettings(dir).githubPrOnAccept).toBe(false);
    expect(await entry("github-pr")).toMatchObject({ connected: false, enabled: false });
  });

  it("A3: push is not reported as delivering after its test send fails, until it is reconnected", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    expect(
      (await send("PUT", "/api/integrations/push", { kind: "ntfy", url, topic: "probe" })).status,
    ).toBe(200);
    expect((await entry("push"))?.lastSend).toBeUndefined();
    const test = (await (await send("POST", "/api/integrations/push/test")).json()) as {
      ok: boolean;
      error?: string;
    };
    expect(test.ok).toBe(false);
    const failed = await entry("push");
    expect(failed).toMatchObject({ connected: true, lastSend: { ok: false, kind: "test" } });
    expect(String((failed?.lastSend as { error?: string }).error)).toMatch(/ECONNREFUSED/);
    // The test's words say the server was not reached, never a policy refusal (A4).
    expect(test.error).not.toMatch(/network policy refused/);
    // W6 review (the spine): the outcome is the ledger's, never kept in the settings file.
    expect(readSettings(dir)).not.toHaveProperty("lastTest");
    const sent = (await log.getEventsByTypes(["pm/notify"])).at(-1) as {
      payload: Record<string, unknown>;
      private?: Record<string, unknown>;
    };
    expect(sent.payload).toMatchObject({ channel: "ntfy", kind: "test", ok: false });
    expect(String(sent.private?.error)).toMatch(/ECONNREFUSED/);
    expect(String(sent.private?.error)).not.toContain("probe");
    // Connecting again starts a fresh state: nothing is claimed until a send.
    expect(
      (await send("PUT", "/api/integrations/push", { kind: "ntfy", url, topic: "probe2" })).status,
    ).toBe(200);
    expect((await entry("push"))?.lastSend).toBeUndefined();
    expect((await send("DELETE", "/api/integrations/push")).status).toBe(200);
  });

  it("W6 review: a notice the notifier sends later is what push says, failed or delivered", async () => {
    const hits: string[] = [];
    const live = createHttpServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200).end("{}");
    });
    const port = await new Promise<number>((resolve) =>
      live.listen(0, "127.0.0.1", () => {
        const a = live.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );
    try {
      const url = `http://127.0.0.1:${port}`;
      expect(
        (await send("PUT", "/api/integrations/push", { kind: "ntfy", url, topic: "later" })).status,
      ).toBe(200);
      const notice = { event: "review" as const, title: "Ready for review", message: "x" };
      expect((await sendPush(dir, notice, { log })).ok).toBe(true);
      expect(hits).toHaveLength(1);
      expect(await entry("push")).toMatchObject({ lastSend: { ok: true, kind: "review" } });
      // The server goes away: the next notice fails, and the card says so.
      await new Promise((r) => live.close(r));
      expect((await sendPush(dir, notice, { log })).ok).toBe(false);
      expect(await entry("push")).toMatchObject({ lastSend: { ok: false, kind: "review" } });
    } finally {
      live.close();
      await send("DELETE", "/api/integrations/push");
    }
  });

  it("A3: an email test with no address to send to is not a delivery failure", async () => {
    expect(
      (
        await send("PUT", "/api/integrations/email", {
          host: "127.0.0.1",
          port: await closedPort(),
          from: "sekhemet@example.test",
        })
      ).status,
    ).toBe(200);
    const r = (await (await send("POST", "/api/integrations/email/test")).json()) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
    expect((await entry("email"))?.lastSend).toBeUndefined();
    // A send the ledger records as failed is what the entry reports.
    await log.append({
      actor: "harness",
      type: "pm/notify",
      payload: { channel: "email", kind: "test", ok: false },
      private: { error: "refused" },
    });
    expect(await entry("email")).toMatchObject({
      connected: true,
      lastSend: { ok: false, kind: "test", error: "refused" },
    });
    // Connecting again starts afresh; the earlier failure is not this connection's.
    expect(
      (
        await send("PUT", "/api/integrations/email", {
          host: "127.0.0.1",
          port: await closedPort(),
          from: "sekhemet@example.test",
        })
      ).status,
    ).toBe(200);
    expect((await entry("email"))?.lastSend).toBeUndefined();
    expect((await send("DELETE", "/api/integrations/email")).status).toBe(200);
    expect(await entry("email")).toMatchObject({ connected: false });
  });
});
