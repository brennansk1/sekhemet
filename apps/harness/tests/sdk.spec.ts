import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SekhemetClient,
  SekhemetError,
  type StreamMessage,
  daemonUrl,
} from "../../../packages/sdk/src/index.js";
import { startDashboardServer } from "../src/server.js";

describe("@sekhemet/sdk against a running server (H13)", () => {
  let server: { port: number; close: () => Promise<void> };
  let cards: CardStore;
  let client: SekhemetClient;
  const repo = mkdtempSync(join(tmpdir(), "sdk-"));

  beforeAll(async () => {
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sdk-cfg-"));
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    cards = new CardStore(db, log);
    await cards.createCard({ id: "card_sdk", tier: "task", title: "SDK card", status: "backlog" });
    server = await startDashboardServer({
      db,
      log,
      cardStore: cards,
      boardService: new BoardServiceImpl(cards),
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
    });
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "daemon.json"),
      JSON.stringify({ pid: process.pid, port: server.port }),
    );
    client = new SekhemetClient({ repoPath: repo });
  });
  afterAll(async () => server.close());

  it("finds the daemon from the project's PID file", () => {
    expect(daemonUrl(repo)).toBe(`http://127.0.0.1:${server.port}`);
    expect(client.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("reads the board, a card and the ledger", async () => {
    const board = await client.board();
    expect(JSON.stringify(board)).toContain("card_sdk");
    const one = await client.card("card_sdk");
    expect(JSON.stringify(one)).toContain("SDK card");
    const events = await client.events({ card: "card_sdk" });
    const list = Array.isArray(events) ? events : events.events;
    expect(list.some((e) => e.type === "card/created")).toBe(true);
  });

  it("writes with the action header, and surfaces server errors as SekhemetError", async () => {
    await client.updateCard("card_sdk", { priority: 1 });
    expect((await cards.getCard("card_sdk"))?.priority).toBe(1);
    await expect(client.card("card_nope")).rejects.toBeInstanceOf(SekhemetError);
    await expect(client.card("card_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("talks to Seshat", async () => {
    await client.pm.send("What is blocking the SDK card?");
    expect(JSON.stringify(await client.pm.thread())).toContain("What is blocking the SDK card?");
  });

  it("streams ledger appends over WebSocket", async () => {
    const got: StreamMessage[] = [];
    const close = client.stream((m) => got.push(m));
    await new Promise((r) => setTimeout(r, 200));
    await cards.createCard({ id: "card_streamed", tier: "task", title: "Live", status: "backlog" });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !JSON.stringify(got).includes("card_streamed")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    close();
    const append = got.find(
      (m) => m.event === "append" && JSON.stringify(m.data).includes("card_streamed"),
    );
    expect(append).toBeDefined();
  });
});
