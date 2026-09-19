import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@sekhemet/models";

/**
 * MCP client (H11): Sekhemet's agents can use tools from MCP servers the
 * user configures, the way Claude Code and editors do.
 *
 * Servers are declared in `.sekhemet/mcp.json` (project) or
 * `~/.sekhemet/mcp.json` (user), in the common `mcpServers` shape:
 *   { "mcpServers": { "fs": { "command": "npx", "args": [...], "env": {...} } } }
 * Each runs as a stdio child speaking JSON-RPC 2.0 (MCP 2024-11-05). Tools
 * are exposed namespaced as `mcp__<server>__<tool>` so they never collide
 * with built-in tools, and each server may be limited to an allow-list of
 * tools (`"tools": ["search"]`) because a server's tools act with the
 * user's rights.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Only these tools are offered to agents (default: all the server lists). */
  tools?: string[];
  disabled?: boolean;
}

export function loadMcpConfig(repoPath: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const path of [
    join(homedir(), ".sekhemet", "mcp.json"),
    join(repoPath, ".sekhemet", "mcp.json"),
  ]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, McpServerConfig>;
      };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || typeof cfg.command !== "string") continue;
        out[name] = cfg; // project overrides user
      }
    } catch {
      // An unreadable file configures nothing.
    }
  }
  return out;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One connected server. */
export class McpConnection {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private dead: string | undefined;
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly timeoutMs = 30_000,
  ) {}

  async connect(): Promise<void> {
    this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    const failAll = (why: string) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${this.name} ${why}`));
      }
      this.pending.clear();
      this.dead = why;
    };
    this.child.on("exit", () => failAll("exited"));
    // A missing binary fails at spawn: report it now, not after the timeout.
    this.child.on("error", (err) => failAll(`could not start: ${err.message}`));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sekhemet", version: "0.2.0" },
    });
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {})) as { tools?: McpConnection["tools"] };
    const allow = this.cfg.tools;
    this.tools = (listed.tools ?? []).filter((t) => !allow || allow.includes(t.name));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id !== "number") continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      } catch {
        // Not JSON-RPC (a server printing logs to stdout); ignore the line.
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`MCP server ${this.name} ${this.dead}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name} ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  /** Call a tool; returns its text content (errors come back as text, prefixed). */
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.tools.some((t) => t.name === tool))
      return `[ERROR]: ${this.name} offers no tool ${tool}.`;
    const r = (await this.request("tools/call", { name: tool, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (r.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n");
    return r.isError ? `[ERROR]: ${text}` : text;
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = undefined;
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
            conn.close();
            hub.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
    );
    return hub;
  }

  /** Tool definitions for an agent, named mcp__<server>__<tool>. */
  toolDefinitions(): ToolDefinition[] {
    return [...this.conns.values()].flatMap((c) =>
      c.tools.map((t) => ({
        name: `mcp__${c.name}__${t.name}`,
        description: `[${c.name}] ${t.description ?? ""}`.slice(0, 600),
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      })),
    );
  }

  handles(toolName: string): boolean {
    return /^mcp__[A-Za-z0-9_-]+__/.test(toolName);
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const m = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(toolName);
    const conn = m ? this.conns.get(m[1] as string) : undefined;
    if (!m || !conn) return `[ERROR]: no MCP server for ${toolName}.`;
    try {
      return await conn.call(m[2] as string, args);
    } catch (err) {
      return `[ERROR]: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  close(): void {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
