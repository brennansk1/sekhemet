import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

describe("@sekhemet/harness Dashboard Server", () => {
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let serverInstance: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);

    // Seed test cards
    await cardStore.createCard({
      id: "card_ui_1",
      tier: "feature",
      title: "Basalt Theme Virtual Kanban",
      status: "in_progress",
      scopeFiles: ["packages/ui/src/canvas.ts"],
    });

    await cardStore.createCard({
      id: "card_ui_2",
      tier: "task",
      title: "Playwright visual gate verification",
      status: "ready",
      scopeFiles: ["tests/visual.spec.ts"],
    });

    // Start server on an ephemeral port (port 0)
    serverInstance = await startDashboardServer({
      db,
      log,
      boardService,
      port: 0,
    });
  });

  afterAll(async () => {
    await serverInstance.close();
  });

  it("serves HTML dashboard with Basalt styling tokens", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Sekhemet Dashboard");
    expect(html).toContain("#121214"); // Basalt background token
    expect(html).toContain("kanban-board");
  });

  it("serves /api/board with active cards and WIP limits", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/board`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cards: unknown[]; backpressureActive: boolean };

    expect(data.cards.length).toBe(2);
    expect(data.backpressureActive).toBe(false);
  });

  it("serves /api/events with cryptographic hash chain verification", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/events`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      events: unknown[];
      verification: { valid: boolean; totalEvents: number };
    };

    expect(data.events.length).toBeGreaterThanOrEqual(2);
    expect(data.verification.valid).toBe(true);
  });

  it("serves /api/doctor diagnostic reports", async () => {
    const res = await fetch(`http://127.0.0.1:${serverInstance.port}/api/doctor`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; checks: string[] };

    expect(data.ok).toBe(true);
    expect(data.checks.length).toBeGreaterThanOrEqual(4);
  });
});
