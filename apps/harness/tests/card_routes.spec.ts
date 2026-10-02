import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_ROUTES } from "../src/card_routes.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * NAM-03 (FINDINGS_C1; CLAUDE.md's strangler fig): the dashboard server's own
 * `/api/cards/:id` routes live in one module with one routing style — a table
 * of method, path and handler — instead of inline in the server's 2,500-line
 * closure. These tests pin each route's answers over HTTP against a real
 * server on real SQLite and a real git repository (DEFINITION_OF_DONE §2A),
 * so the move changes no behaviour: they were written, and passed, before
 * the routes moved.
 */

type Server = { port: number; close: () => Promise<void> };

describe("the /api/cards/:id routes (NAM-03: one module, one routing style)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  let server: Server;
  let base: string;
  let write: Record<string, string>;
  let project: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sek-card-routes-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "chore: empty"], { cwd: dir });
    mkdirSync(join(dir, ".sekhemet"), { recursive: true });
    db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    store = new CardStore(db, log);
    project = (await store.ensureProject({ name: "Chronicle", rootPath: dir })).id;
    await store.createCard({
      id: "card_a",
      tier: "task",
      title: "Record every change",
      status: "ready",
      projectId: project,
      scopeFiles: ["a.ts"],
      acceptanceCriteria: ["Each change is one entry."],
    });
    await store.createCard({
      id: "card_b",
      tier: "task",
      title: "Verify the chain",
      status: "ready",
      projectId: project,
      scopeFiles: ["b.ts"],
    });
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
      cardStore: store,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 1000,
    });
    base = `http://127.0.0.1:${server.port}`;
    write = await pageWriteHeaders(base);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    return {
      status: r.status,
      body: (await r.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = write) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      body: (await r.json().catch(() => null)) as Record<string, unknown>,
    };
  };

  it("GET an issue: its presentation, attempts, criteria sources, dependencies and AI state", async () => {
    const r = await get("/api/cards/card_a");
    expect(r.status).toBe(200);
    expect((r.body.card as { id: string }).id).toBe("card_a");
    expect(r.body.attempts).toEqual([]);
    expect(Array.isArray(r.body.dependencies)).toBe(true);
    expect(Array.isArray(r.body.ai)).toBe(true);
    expect(r.body).toHaveProperty("acceptance");
    expect(await get("/api/cards/nope")).toEqual({ status: 404, body: { error: "No issue nope" } });
  });

  it("GET transcript, traces, attempts and messages of an issue that has not run", async () => {
    expect(await get("/api/cards/card_a/transcript")).toEqual({
      status: 200,
      body: { attempt: 0, attempts: 0, file: null, live: false, steps: [] },
    });
    expect(await get("/api/cards/nope/transcript")).toEqual({
      status: 404,
      body: { error: "No issue nope" },
    });
    const traces = await get("/api/cards/card_a/traces");
    expect(traces.status).toBe(200);
    expect(Array.isArray(traces.body.spans)).toBe(true);
    expect(await get("/api/cards/card_a/attempts")).toEqual({
      status: 200,
      body: { attempts: [], evidence: [] },
    });
    expect(await get("/api/cards/card_a/messages")).toEqual({
      status: 200,
      body: { messages: [] },
    });
  });

  it("GET review and readiness, and an unknown issue is no issue", async () => {
    const desk = await get("/api/cards/card_a/review");
    expect(desk.status).toBe(200);
    expect(Array.isArray(desk.body.threads)).toBe(true);
    expect(desk.body.requireResolvedThreads).toBe(false);
    expect(await get("/api/cards/nope/review")).toEqual({
      status: 404,
      body: { error: "No issue nope" },
    });
    const ready = await get("/api/cards/card_a/readiness");
    expect(ready.status).toBe(200);
    expect(Array.isArray(ready.body.readiness)).toBe(true);
    expect(await get("/api/cards/nope/readiness")).toEqual({
      status: 404,
      body: { error: "No such issue." },
    });
  });

  it("GET explain: the issue's own lines, and 404 for an unknown one", async () => {
    const r = await get("/api/cards/card_a/explain");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.lines)).toBe(true);
    expect((await get("/api/cards/nope/explain")).status).toBe(404);
  });

  it("POST triage: refused without the page's headers, a reason required, park and unpark", async () => {
    expect((await post("/api/cards/card_b/park", { reason: "x" }, {})).status).toBe(403);
    expect(await post("/api/cards/nope/park", { reason: "x" })).toEqual({
      status: 404,
      body: { error: "No issue nope" },
    });
    expect(await post("/api/cards/card_b/return", {})).toEqual({
      status: 400,
      body: { error: "Request changes needs a reason: it is what the Agent is told next" },
    });
    expect(await post("/api/cards/card_b/park", { reason: "waiting on a vendor" })).toEqual({
      status: 200,
      body: { ok: true, status: "parked" },
    });
    expect(await post("/api/cards/card_b/unpark", {})).toEqual({
      status: 200,
      body: { ok: true, status: "ready" },
    });
    expect(await post("/api/cards/card_b/opened", { filesShown: ["b.ts"] })).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("POST commands: each refusal in words, a message recorded, a reorder placed", async () => {
    expect((await post("/api/cards/card_a/message", { text: "hi" }, {})).status).toBe(403);
    expect(await post("/api/cards/nope/abort", {})).toEqual({
      status: 404,
      body: { error: "No issue nope" },
    });
    expect(await post("/api/cards/card_a/message", { text: "  " })).toEqual({
      status: 400,
      body: { error: "A message needs text" },
    });
    expect(await post("/api/cards/card_a/message", { text: "Use the shared hasher." })).toEqual({
      status: 200,
      body: { ok: true },
    });
    const messages = await get("/api/cards/card_a/messages");
    expect((messages.body.messages as { text: string }[]).map((m) => m.text)).toEqual([
      "Use the shared hasher.",
    ]);
    expect(await post("/api/cards/card_a/rewind", {})).toEqual({
      status: 400,
      body: { error: "A step number is required" },
    });
    expect(await post("/api/cards/card_a/override", { toStatus: "done" })).toEqual({
      status: 400,
      body: { error: "An override needs toStatus and a reason" },
    });
    const bogus = await post("/api/cards/card_a/override", { toStatus: "nowhere", reason: "x" });
    expect(bogus.status).toBe(400);
    expect(String(bogus.body.error)).toMatch(/^'nowhere' is not an issue state/);
    expect(await post("/api/cards/card_a/reroute", {})).toEqual({
      status: 400,
      body: { error: "Name an executor or a planner" },
    });
    const reorder = await post("/api/cards/card_a/reorder", { afterCardId: "card_b" });
    expect(reorder.status).toBe(200);
    expect(typeof reorder.body.orderKey).toBe("string");
  });

  it("a project's own POST is still the server's: status checked in words", async () => {
    expect(await post(`/api/projects/${project}`, { status: "sleeping" })).toEqual({
      status: 400,
      body: { error: "status must be active, paused or archived" },
    });
  });

  it("a method a route does not take falls through, as before the move", async () => {
    const seen: Record<string, number> = {};
    for (const path of [
      "/api/cards/card_a/traces",
      "/api/cards/card_a/readiness",
      "/api/cards/card_a/messages",
      "/api/cards/card_a/review",
      "/api/cards/card_a",
    ])
      seen[`POST ${path}`] = (await post(path, {})).status;
    seen["GET /api/cards/card_a/park"] = (await fetch(`${base}/api/cards/card_a/park`)).status;
    seen["GET /api/cards/card_a/abort"] = (await fetch(`${base}/api/cards/card_a/abort`)).status;
    // Pinned on the inline routes before the move: nothing else takes these.
    expect(seen).toEqual({
      "POST /api/cards/card_a/traces": 404,
      "POST /api/cards/card_a/readiness": 404,
      "POST /api/cards/card_a/messages": 404,
      "POST /api/cards/card_a/review": 404,
      "POST /api/cards/card_a": 404,
      "GET /api/cards/card_a/park": 404,
      "GET /api/cards/card_a/abort": 404,
    });
  });

  it("NAM-03: one table holds the routes, and the server's closure holds none of them", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
    expect(src).not.toMatch(/\^\/api\/cards\/\(/);
    const paths = CARD_ROUTES.map((r) => `${r.method ?? "*"} ${r.path.source}`);
    for (const want of [
      "transcript",
      "traces",
      "review",
      "readiness",
      "explain",
      "messages",
      "attempts",
      "accept|return",
      "abort|rewind",
    ]) {
      expect(
        paths.some((p) => p.includes(want)),
        want,
      ).toBe(true);
    }
    for (const r of CARD_ROUTES) {
      expect(r.path.source.replace(/\\\//g, "/").startsWith("^/api/cards/")).toBe(true);
      expect(r.path.source.endsWith("$")).toBe(true);
      expect(typeof r.handle).toBe("function");
    }
  });
});
