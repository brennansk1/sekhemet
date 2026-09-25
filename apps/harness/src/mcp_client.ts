import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@sekhemet/models";
import type { PlannerTools } from "@sekhemet/planner";
import { allowlistedEnv } from "@sekhemet/sandbox";
import { userPaths } from "./user_dir.js";
import { isTrusted } from "./workspace_trust.js";

/**
 * MCP client (H11, extensibility items 22-23): Sekhemet's agents can use
 * tools from MCP servers the user configures, the way Claude Code and editors
 * do, over the official SDK's transports (DEC-08).
 *
 * Servers are declared in `.sekhemet/mcp.json` (project) or
 * `~/.sekhemet/mcp.json` (user), in the common `mcpServers` shape:
 *   { "mcpServers": {
 *       "fs": { "command": "npx", "args": [...], "env": {...} },
 *       "docs": { "type": "http", "url": "https://...", "headers": {...} } } }
 * A `command` runs as a stdio child; a `url` is a Streamable HTTP server
 * (EXT-19). Tools are exposed namespaced as `mcp__<server>__<tool>` so they
 * never collide with built-in tools, and each server may be limited to an
 * allow-list of tools (`"tools": ["search"]`) because a server's tools act
 * with the user's rights. The Worker is offered only what a server lists in
 * `worker_tools` (EXT-21).
 */

export interface McpServerConfig {
  /** A stdio server: the command to start. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** A Streamable HTTP server (EXT-19): its endpoint, and headers sent with each request. */
  type?: "stdio" | "http";
  url?: string;
  headers?: Record<string, string>;
  /** Only these tools are offered to agents (default: all the server lists). */
  tools?: string[];
  /** The only tools the Worker is offered from this server (EXT-21; default none). */
  worker_tools?: string[];
  disabled?: boolean;
}

/** Who a tool list is for (extensibility item 23). */
export type McpRole = "researcher" | "planner" | "seshat" | "worker";

function httpUrl(cfg: McpServerConfig): URL | undefined {
  if (typeof cfg.url !== "string") return undefined;
  try {
    const u = new URL(cfg.url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

export function loadMcpConfig(repoPath: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const path of [
    // The person's own servers: their configuration, trusted.
    userPaths().mcp,
    // The repository's: inert until the person trusts this exact file (S9, SEC-28).
    ...(isTrusted(repoPath, join(".sekhemet", "mcp.json"))
      ? [join(repoPath, ".sekhemet", "mcp.json")]
      : []),
  ]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, McpServerConfig>;
      };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || !cfg || typeof cfg !== "object") continue;
        if (typeof cfg.command !== "string" && !httpUrl(cfg)) continue;
        out[name] = cfg; // project overrides user
      }
    } catch {
      // An unreadable file configures nothing.
    }
  }
  return out;
}

/** One connected server, through the SDK's client. */
export class McpConnection {
  private client: Client | undefined;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [];

  constructor(
    readonly name: string,
    readonly cfg: McpServerConfig,
    private readonly timeoutMs = 30_000,
  ) {}

  async connect(): Promise<void> {
    const url = httpUrl(this.cfg);
    // The SDK's own classes; its `Transport` type is declared without
    // exactOptionalPropertyTypes, which this workspace sets.
    const transport: Transport = (
      url
        ? new StreamableHTTPClientTransport(url, {
            ...(this.cfg.headers ? { requestInit: { headers: this.cfg.headers } } : {}),
          })
        : new StdioClientTransport({
            command: this.cfg.command as string,
            args: this.cfg.args ?? [],
            // EXT-18: the sandbox's allowlist and the server's declared env,
            // never the harness's whole environment (it holds endpoints and
            // credentials). The SDK adds only HOME, LOGNAME, PATH, SHELL, TERM
            // and USER, all inside the allowlist.
            env: allowlistedEnv(this.cfg.env ?? {}),
            stderr: "ignore",
          })
    ) as Transport;
    const client = new Client({ name: "sekhemet", version: "0.2.0" });
    this.client = client;
    // The SDK negotiates the protocol version (EXT-14's client side).
    await client.connect(transport, { timeout: this.timeoutMs });
    const listed = await client.listTools(undefined, { timeout: this.timeoutMs });
    const allow = this.cfg.tools;
    this.tools = (listed.tools ?? [])
      .filter((t) => !allow || allow.includes(t.name))
      .map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
  }

  /** The tools offered to a role: the Worker gets only `worker_tools` (EXT-21). */
  toolsFor(role: McpRole): McpConnection["tools"] {
    if (role !== "worker") return this.tools;
    const listed = this.cfg.worker_tools ?? [];
    return this.tools.filter((t) => listed.includes(t.name));
  }

  /** Call a tool; returns its text content (errors come back as text, prefixed). */
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.tools.some((t) => t.name === tool))
      return `[ERROR]: ${this.name} offers no tool ${tool}.`;
    if (!this.client) return `[ERROR]: MCP server ${this.name} is not connected.`;
    const r = (await this.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: this.timeoutMs,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (r.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n");
    return r.isError ? `[ERROR]: ${text}` : text;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}

/** All configured servers, connected, with their tools namespaced for agents. */
export class McpHub {
  private conns = new Map<string, McpConnection>();
  errors: string[] = [];

  static async connect(repoPath: string, config = loadMcpConfig(repoPath)): Promise<McpHub> {
    const hub = new McpHub();
    await Promise.all(
      Object.entries(config)
        .filter(([, c]) => !c.disabled)
        .map(async ([name, cfg]) => {
          const conn = new McpConnection(name, cfg);
          try {
            await conn.connect();
            hub.conns.set(name, conn);
          } catch (err) {
            await conn.close();
            hub.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
    );
    return hub;
  }

  /**
   * Tool definitions for a role, named mcp__<server>__<tool> (item 23): the
   * Researcher, the Planner and Seshat get every allowed tool; the Worker
   * only what a server lists in `worker_tools` (EXT-21).
   */
  toolDefinitions(role: McpRole = "researcher"): ToolDefinition[] {
    return [...this.conns.values()].flatMap((c) =>
      c.toolsFor(role).map((t) => ({
        name: `mcp__${c.name}__${t.name}`,
        description: `[${c.name}] ${t.description ?? ""}`.slice(0, 600),
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      })),
    );
  }

  handles(toolName: string): boolean {
    return /^mcp__[A-Za-z0-9_-]+__/.test(toolName);
  }

  /** Call a tool as a role; a tool the role was not offered is refused, never forwarded. */
  async call(
    toolName: string,
    args: Record<string, unknown>,
    role: McpRole = "researcher",
  ): Promise<string> {
    const m = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(toolName);
    const conn = m ? this.conns.get(m[1] as string) : undefined;
    if (!m || !conn) return `[ERROR]: no MCP server for ${toolName}.`;
    const tool = m[2] as string;
    if (role === "worker" && !conn.toolsFor(role).some((t) => t.name === tool))
      return `[ERROR]: ${toolName} is not offered to the Worker (not in ${conn.name}'s worker_tools).`;
    try {
      return await conn.call(tool, args);
    } catch (err) {
      return `[ERROR]: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async close(): Promise<void> {
    const conns = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(conns.map((c) => c.close()));
  }
}

/**
 * The Planner's share of the hub (EXT-20): every allowed tool of the
 * connected servers, called as the Planner; none when no server offers one.
 */
export function plannerToolsOf(hub: McpHub): PlannerTools | undefined {
  const definitions = hub.toolDefinitions("planner");
  if (definitions.length === 0) return undefined;
  return { definitions, call: (name, args) => hub.call(name, args, "planner") };
}
