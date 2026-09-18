import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import type { CardStore, CardTier, EventLog } from "@sekhemet/kernel";
import { runDoctor } from "./index.js";

export interface McpContext {
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  boardService: BoardService;
  repoPath: string;
}

export interface McpRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const MCP_TOOLS = [
  {
    name: "sekhemet_list_cards",
    description: "List cards on the Sekhemet kanban board filtered by status or tier",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (ready, in_progress, verify, review, done)",
        },
        tier: {
          type: "string",
          description: "Filter by tier (initiative, epic, feature, story, task)",
        },
      },
    },
  },
  {
    name: "sekhemet_create_card",
    description: "Create a new task or story card on the Sekhemet kanban board",
    inputSchema: {
      type: "object",
      required: ["title", "tier"],
      properties: {
        title: { type: "string", description: "Clear, actionable title of the card" },
        tier: {
          type: "string",
          enum: ["feature", "story", "task", "spike"],
          description: "Card tier",
        },
        scopeFiles: {
          type: "array",
          items: { type: "string" },
          description: "Files declared in scope (max 3)",
        },
        stepBudget: { type: "number", description: "Step budget (default: 50)" },
      },
    },
  },
  {
    name: "sekhemet_get_events",
    description:
      "Get the append-only cryptographic event log and SHA-256 hash chain verification status",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to retrieve (default: 50)" },
      },
    },
  },
  {
    name: "sekhemet_doctor",
    description: "Run Sekhemet system diagnostics (memory, inference socket, git worktree, gates)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handleMcpRequest(
  req: McpRpcRequest,
  ctx: McpContext,
): Promise<McpRpcResponse> {
  const { id, method, params = {} } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "sekhemet-mcp-server",
          version: "0.1.0",
        },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (name === "sekhemet_list_cards") {
      const cards = await ctx.cardStore.listCards({
        status: args.status as never,
        tier: args.tier as never,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(cards, null, 2),
            },
          ],
        },
      };
    }

    if (name === "sekhemet_create_card") {
      const card = await ctx.cardStore.createCard({
        title: args.title as string,
        tier: (args.tier as CardTier) || "task",
        scopeFiles: (args.scopeFiles as string[]) || [],
        stepBudget: (args.stepBudget as number) || 50,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Created card ${card.id}: ${card.title} [status: ${card.status}]`,
            },
          ],
        },
      };
    }

    if (name === "sekhemet_get_events") {
      const limit = (args.limit as number) || 50;
      const events = await ctx.log.getEvents(1, limit);
      const verification = await ctx.log.verifyHashChain();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ verification, events }, null, 2),
            },
          ],
        },
      };
    }

    if (name === "sekhemet_doctor") {
      const report = runDoctor();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(report, null, 2),
            },
          ],
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Tool not found: ${name}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function runMcpStdioServer(ctx: McpContext): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed) as McpRpcRequest;
      const response = await handleMcpRequest(parsed, ctx);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      const errResponse: McpRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        },
      };
      process.stdout.write(`${JSON.stringify(errResponse)}\n`);
    }
  });
}
