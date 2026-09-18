import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { type McpContext, handleMcpRequest } from "../src/mcp.js";

describe("@sekhemet/harness MCP Server", () => {
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;
  let context: McpContext;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);
    context = { db, log, cardStore, boardService, repoPath: process.cwd() };

    await cardStore.createCard({
      id: "card_mcp_1",
      tier: "task",
      title: "MCP Integration Card",
      status: "ready",
      scopeFiles: ["src/mcp.ts"],
    });
  });

  it("handles initialize method and returns server capabilities", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      context,
    );

    expect(res.id).toBe(1);
    expect(res.result).toBeDefined();
    expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "sekhemet-mcp-server",
    );
  });

  it("handles tools/list and returns Sekhemet tool definitions", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      context,
    );

    expect(res.id).toBe(2);
    const tools = (res.result as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === "sekhemet_list_cards")).toBe(true);
    expect(tools.some((t) => t.name === "sekhemet_create_card")).toBe(true);
    expect(tools.some((t) => t.name === "sekhemet_get_events")).toBe(true);
  });

  it("handles tools/call for sekhemet_list_cards", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "sekhemet_list_cards",
          arguments: {},
        },
      },
      context,
    );

    expect(res.id).toBe(3);
    const content = (res.result as { content: [{ text: string }] }).content;
    expect(content[0].text).toContain("card_mcp_1");
  });

  it("handles tools/call for sekhemet_create_card", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "sekhemet_create_card",
          arguments: {
            title: "New Task from Cursor/Claude",
            tier: "task",
            scopeFiles: ["index.ts"],
          },
        },
      },
      context,
    );

    expect(res.id).toBe(4);
    const content = (res.result as { content: [{ text: string }] }).content;
    expect(content[0].text).toContain("New Task from Cursor/Claude");

    const cards = await cardStore.listCards();
    expect(cards.length).toBe(2);
  });
});
