import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSIONS,
  type McpContext,
  ParseErrorStdioServerTransport,
  createMcpServer,
} from "../src/mcp.js";

/**
 * extensibility item 21 (NEW-extensibility-3): the harness's MCP server is the
 * official SDK's `Server`, and its stdio transport is the SDK's framing wrapped
 * so that a line it cannot parse is answered, not dropped (EXT-15).
 */
let root: string;
let db: DatabaseSync;
let ctx: McpContext;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-mcp-sdk-"));
  mkdirSync(join(root, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  ctx = { db, log, cardStore, boardService: new BoardServiceImpl(cardStore), repoPath: root };
  await cardStore.createCard({ id: "card_sdk", tier: "task", title: "SDK", status: "backlog" });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("item 21: the MCP server is built on the official SDK", () => {
  it("is the SDK's Server, and an SDK client completes the handshake and calls a tool", async () => {
    const server = createMcpServer(ctx);
    expect(server).toBeInstanceOf(Server);
    for (const v of MCP_PROTOCOL_VERSIONS) expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(v);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "probe", version: "1" });
    await client.connect(clientSide);
    try {
      expect(client.getServerVersion()?.name).toBe("sekhemet-mcp-server");
      expect(client.getServerCapabilities()).toEqual({ tools: {} });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("sekhemet_ask_seshat");
      const res = (await client.callTool({ name: "sekhemet_list_cards", arguments: {} })) as {
        content: { text: string }[];
      };
      expect(res.content[0]?.text).toContain("card_sdk");
    } finally {
      await client.close();
    }
  });
});

describe("EXT-15 through the stdio wrapper: an unparseable line is answered", () => {
  it("replies -32700 (and -32600) with id null, then serves the next line through the SDK's framing", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        buf = buf.slice(nl + 1);
      }
    });
    const server = createMcpServer(ctx);
    await server.connect(new ParseErrorStdioServerTransport(stdin, stdout));
    stdin.write("{not json\n");
    stdin.write('{"foo":1}\n');
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
    await expect.poll(() => lines.length).toBe(3);
    expect(lines[0]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    // JSON that is not a JSON-RPC message is an invalid request, also answered.
    expect(lines[1]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(lines[2]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    await server.close();
  });
});
