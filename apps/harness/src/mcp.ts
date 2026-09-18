import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import type { CardStore, CardTier, EventLog } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { runDoctor } from "./doctor.js";
import { LearningStore } from "./learning/store.js";
import { capabilityReport } from "./pm/capability.js";
import { PmStore } from "./pm/store.js";

export interface McpContext {
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  boardService: BoardService;
  repoPath: string;
}

export interface McpRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

type ToolHandler = (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const str = { type: "string" } as const;
const TIERS = ["initiative", "epic", "feature", "story", "task"];
const TEAM_FIELDS = [
  "priority",
  "estimate",
  "labels",
  "epicId",
  "cycleId",
  "assignee",
  "dueDate",
  "title",
  "spec",
];

/**
 * The MCP tools: what an external agent (Claude Code, an IDE) can do with a
 * Sekhemet project. Accepting a card is deliberately absent: the harness
 * verifies, a person accepts.
 */
const MCP_TOOLS: McpTool[] = [
  {
    name: "sekhemet_list_cards",
    description: "List cards, optionally by status or tier.",
    inputSchema: {
      type: "object",
      properties: { status: str, tier: { type: "string", enum: TIERS } },
    },
    handler: async (a, ctx) =>
      ctx.cardStore.listCards({
        ...(typeof a.status === "string" ? { status: a.status as never } : {}),
        ...(typeof a.tier === "string" ? { tier: a.tier as never } : {}),
      }),
  },
  {
    name: "sekhemet_get_card",
    description: "One card with its latest evidence (gates, failures, diff stats).",
    inputSchema: { type: "object", properties: { card_id: str }, required: ["card_id"] },
    handler: async (a, ctx) => {
      const id = String(a.card_id ?? "");
      const card = await ctx.cardStore.getCard(id);
      if (!card) throw new Error(`No card ${id}`);
      const evPath = join(ctx.repoPath, ".sekhemet", "evidence", `latest-${id}.json`);
      let evidence: unknown;
      try {
        const e = JSON.parse(readFileSync(evPath, "utf8")) as Record<string, unknown>;
        const { diff: _diff, ...rest } = e;
        evidence = rest;
      } catch {
        evidence = undefined;
      }
      return { card, ...(evidence ? { evidence } : {}) };
    },
  },
  {
    name: "sekhemet_create_card",
    description: "Create a card in Backlog. Keep it to at most 3 files and 200 changed lines.",
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        tier: { type: "string", enum: TIERS },
        spec: str,
        scopeFiles: { type: "array", items: str },
        acceptanceCriteria: { type: "array", items: str },
        priority: { type: "number" },
        estimate: { type: "number" },
        labels: { type: "array", items: str },
      },
      required: ["title"],
    },
    handler: async (a, ctx) => {
      const tier = TIERS.includes(String(a.tier)) ? (a.tier as CardTier) : "task";
      const card = await ctx.cardStore.createCard(
        {
          title: String(a.title),
          tier,
          status: "backlog",
          ...(typeof a.spec === "string" ? { spec: a.spec } : {}),
          ...(Array.isArray(a.scopeFiles) ? { scopeFiles: a.scopeFiles as string[] } : {}),
          ...(Array.isArray(a.acceptanceCriteria)
            ? { acceptanceCriteria: a.acceptanceCriteria as string[] }
            : {}),
          ...(typeof a.priority === "number" ? { priority: a.priority } : {}),
          ...(typeof a.estimate === "number" ? { estimate: a.estimate } : {}),
          ...(Array.isArray(a.labels) ? { labels: a.labels as string[] } : {}),
        },
        "mcp",
      );
      return `Created ${card.id}: ${card.title} [${card.status}]`;
    },
  },
  {
    name: "sekhemet_update_card",
    description:
      "Change a card's team fields (priority 0-4, estimate, labels, epic, cycle, assignee, due date, title, spec).",
    inputSchema: {
      type: "object",
      properties: { card_id: str, fields: { type: "object" } },
      required: ["card_id", "fields"],
    },
    handler: async (a, ctx) => {
      const fields = (a.fields ?? {}) as Record<string, unknown>;
      const patch = Object.fromEntries(
        Object.entries(fields).filter(([k]) => TEAM_FIELDS.includes(k)),
      );
      if (Object.keys(patch).length === 0)
        throw new Error(`Editable fields: ${TEAM_FIELDS.join(", ")}`);
      return ctx.cardStore.updateCard(String(a.card_id), patch as never, "mcp");
    },
  },
  {
    name: "sekhemet_move_card",
    description:
      "Move a card to ready, backlog or parked (with a reason). Accepting is a human action.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: str,
        to: { type: "string", enum: ["ready", "backlog", "parked"] },
        reason: str,
      },
      required: ["card_id", "to"],
    },
    handler: async (a, ctx) => {
      const card = await ctx.cardStore.getCard(String(a.card_id));
      if (!card) throw new Error(`No card ${String(a.card_id)}`);
      await ctx.boardService.transitionCard({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: a.to as never,
        actor: "mcp",
        reason: typeof a.reason === "string" ? a.reason : "moved via MCP",
      });
      return `Moved ${card.id} to ${String(a.to)}`;
    },
  },
  {
    name: "sekhemet_run_gates",
    description: "Run the project's declared gates, in a card's worktree when given.",
    inputSchema: { type: "object", properties: { card_id: str } },
    handler: async (a, ctx) => {
      const id = typeof a.card_id === "string" ? a.card_id : undefined;
      const wt = id ? join(ctx.repoPath, ".sekhemet", "worktrees", id) : undefined;
      const cwd = wt && existsSync(wt) ? wt : ctx.repoPath;
      const cfg = loadGatesConfig(ctx.repoPath);
      const runner = new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: ctx.repoPath,
        expectedConfigSha256: cfg.sha256,
      });
      const res = await runner.runGates([...new Set(cfg.gates.map((g) => g.rung))], cwd);
      return {
        passed: res.passed,
        gates: res.rungResults,
        failures: res.failures.map((f) => ({
          gate: f.gate,
          excerpt: f.errorExcerpt,
          fix: f.suggestedAction,
        })),
      };
    },
  },
  {
    name: "sekhemet_ask_merit",
    description:
      "Send a message to Merit, the project manager. Its reply appears in the PM thread.",
    inputSchema: { type: "object", properties: { text: str, card_id: str }, required: ["text"] },
    handler: async (a, ctx) => {
      const m = await new PmStore(ctx.log).appendUserMessage(
        String(a.text).slice(0, 8000),
        typeof a.card_id === "string" ? { cardId: a.card_id, view: "mcp" } : { view: "mcp" },
        "mcp",
      );
      return `Queued for Merit as ${m.id}. Read the reply with sekhemet_pm_thread.`;
    },
  },
  {
    name: "sekhemet_pm_thread",
    description: "The PM conversation: messages, Merit's replies and open proposals.",
    inputSchema: { type: "object", properties: { since: { type: "number" } } },
    handler: async (a, ctx) => new PmStore(ctx.log).thread(Number(a.since ?? 0) || 0),
  },
  {
    name: "sekhemet_capability",
    description:
      "The Worker's measured capability: pass rate by card kind with 95% intervals, size horizon.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => capabilityReport(ctx.repoPath, await ctx.cardStore.listCards()),
  },
  {
    name: "sekhemet_learning",
    description: "Learned rules (with status and counters) and the user profile.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => {
      const store = new LearningStore(ctx.log);
      return { rules: await store.rules(), profile: await store.profile() };
    },
  },
  {
    name: "sekhemet_get_events",
    description: "Ledger events (newest last) and whether the hash chain is intact.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (a, ctx) => {
      const limit = Math.min(500, Number(a.limit ?? 50) || 50);
      const last = (await ctx.log.getLastEvent())?.seq ?? 0;
      return {
        verification: await ctx.log.verifyHashChain(),
        events: await ctx.log.getEvents(Math.max(1, last - limit + 1), limit),
      };
    },
  },
  {
    name: "sekhemet_doctor",
    description: "Health checks: memory, inference server, worktrees, sandbox, toolchain.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_a, ctx) => runDoctor(ctx.repoPath),
  },
];

/** Handle one JSON-RPC message. Notifications (no id) get no response. */
export async function handleMcpRequest(
  req: McpRpcRequest,
  ctx: McpContext,
): Promise<McpRpcResponse | undefined> {
  const { id, method } = req;
  const params = req.params ?? {};
  if (id === undefined || id === null) return undefined;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sekhemet-mcp-server", version: "0.2.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS.map(({ handler: _h, ...t }) => t) },
    };
  }
  if (method === "tools/call") {
    const tool = MCP_TOOLS.find((t) => t.name === params.name);
    if (!tool)
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool not found: ${String(params.name)}` },
      };
    try {
      const out = await tool.handler((params.arguments ?? {}) as Record<string, unknown>, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) },
          ],
        },
      };
    } catch (err) {
      // Tool errors are results with isError, so the calling agent can react.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
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
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
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
