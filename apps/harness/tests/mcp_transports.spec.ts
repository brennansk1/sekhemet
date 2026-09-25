import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server as HttpServer, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpHub, loadMcpConfig, plannerToolsOf } from "../src/mcp_client.js";
import { setInvocationTrust } from "../src/workspace_trust.js";

/**
 * NEW-extensibility-3 on the official SDK's client: a Streamable HTTP server
 * (EXT-19, against a local test server built with the SDK's own server), and
 * the Worker offered only a server's `worker_tools` (EXT-21).
 */
beforeAll(() => setInvocationTrust(true));
afterAll(() => setInvocationTrust(false));

const dirs: string[] = [];
let http: HttpServer | undefined;
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  http?.closeAllConnections();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = undefined;
});

/** An MCP server over Streamable HTTP on a free local port, with two tools. */
async function httpMcpServer(): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  http = createServer(async (req, res) => {
    const sid = req.headers["mcp-session-id"];
    let transport = typeof sid === "string" ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport as StreamableHTTPServerTransport);
        },
      });
      const server = new Server({ name: "remote", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "lookup",
            description: "Look up a term",
            inputSchema: { type: "object", properties: { term: { type: "string" } } },
          },
          { name: "wipe", description: "Dangerous", inputSchema: { type: "object" } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => ({
        content: [
          { type: "text", text: `remote definition of ${String(r.params.arguments?.term)}` },
        ],
      }));
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http?.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

function projectWith(servers: Record<string, unknown>): string {
  const repo = mkdtempSync(join(tmpdir(), "mcp-t-"));
  dirs.push(repo);
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  return repo;
}

describe("EXT-19: a Streamable HTTP server declared in mcp.json", () => {
  it("is connected, its tools listed and callable", async () => {
    const url = await httpMcpServer();
    const repo = projectWith({ remote: { type: "http", url, tools: ["lookup"] } });
    expect(Object.keys(loadMcpConfig(repo))).toEqual(["remote"]);
    const hub = await McpHub.connect(repo);
    try {
      expect(hub.errors).toEqual([]);
      expect(hub.toolDefinitions().map((t) => t.name)).toEqual(["mcp__remote__lookup"]);
      expect(await hub.call("mcp__remote__lookup", { term: "WAL" })).toBe(
        "remote definition of WAL",
      );
    } finally {
      await hub.close();
    }
  });

  it("a server that is neither a command nor a URL is not loaded", () => {
    const repo = projectWith({ nothing: { tools: ["x"] }, bad: { url: "ftp://x" } });
    expect(Object.keys(loadMcpConfig(repo))).toEqual([]);
  });
});

describe("EXT-21: the Worker gets only a server's worker_tools", () => {
  it("offers the Worker no tool its server does not list in worker_tools", async () => {
    const url = await httpMcpServer();
    const repo = projectWith({
      listed: { type: "http", url, worker_tools: ["lookup"] },
      unlisted: { type: "http", url },
    });
    const hub = await McpHub.connect(repo);
    try {
      // The Researcher, the Planner and Seshat see every allowed tool.
      for (const role of ["researcher", "planner", "seshat"] as const)
        expect(
          hub
            .toolDefinitions(role)
            .map((t) => t.name)
            .sort(),
        ).toEqual([
          "mcp__listed__lookup",
          "mcp__listed__wipe",
          "mcp__unlisted__lookup",
          "mcp__unlisted__wipe",
        ]);
      expect(hub.toolDefinitions("worker").map((t) => t.name)).toEqual(["mcp__listed__lookup"]);
      // A call the Worker was not offered is refused, not forwarded.
      expect(await hub.call("mcp__listed__wipe", {}, "worker")).toMatch(/not offered/);
      expect(await hub.call("mcp__unlisted__lookup", { term: "x" }, "worker")).toMatch(
        /not offered/,
      );
      expect(await hub.call("mcp__listed__lookup", { term: "x" }, "worker")).toBe(
        "remote definition of x",
      );
    } finally {
      await hub.close();
    }
  });
});

describe("EXT-20: the Planner's share of an approved server's tools", () => {
  it("offers the Planner every allowed tool, called as the Planner; none without a server", async () => {
    const url = await httpMcpServer();
    const hub = await McpHub.connect(
      projectWith({ docs: { type: "http", url, tools: ["lookup"] } }),
    );
    try {
      const tools = plannerToolsOf(hub);
      expect(tools?.definitions.map((t) => t.name)).toEqual(["mcp__docs__lookup"]);
      expect(await tools?.call("mcp__docs__lookup", { term: "WAL" })).toBe(
        "remote definition of WAL",
      );
    } finally {
      await hub.close();
    }
    const none = await McpHub.connect(projectWith({}));
    expect(plannerToolsOf(none)).toBeUndefined();
  });
});
