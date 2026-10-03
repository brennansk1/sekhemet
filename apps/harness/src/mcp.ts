import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  type JSONRPCMessage,
  ListToolsRequestSchema,
  McpError,
  type MessageExtraInfo,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { BoardService } from "@sekhemet/board";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import {
  type CardStore,
  type CardTier,
  type EventLog,
  isCardStatus,
  nearestCardEstimate,
} from "@sekhemet/kernel";
import { defaultRegistryPath } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { ledgerBundle } from "./accept.js";
import { isolateCheckout, projectRootOf } from "./card_root.js";
import { runDoctor } from "./doctor.js";
import { LearningStore } from "./learning/store.js";
import { capabilityReport } from "./pm/capability.js";
import { appendPersonMessage } from "./pm/documents.js";
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
  /** `null` only on a request that could not be read (JSON-RPC, EXT-15). */
  id: number | string | null;
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

/** Where an MCP client may move a card (EXT-6, EXT-7); Done is a person's acceptance. */
const MOVE_CARD_TO = ["ready", "backlog", "parked"] as const;

/** The card-id pattern the dashboard's routes use; an id is checked before any path (EXT-16). */
const CARD_ID = /^[A-Za-z0-9_.-]+$/;
function cardIdArg(a: Record<string, unknown>): string | undefined {
  if (a.card_id === undefined) return undefined;
  const id = typeof a.card_id === "string" ? a.card_id : "";
  if (!CARD_ID.test(id) || id === "." || id === "..") {
    throw new Error(`${JSON.stringify(a.card_id)} is not a card id`);
  }
  return id;
}

/** Protocol versions this server speaks, newest first (EXT-14). */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
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
      // PM_CONTRACT §2: the kernel refuses any estimate outside {1,2,3,5,8};
      // map to the nearest allowed value rather than refuse the create, and
      // keep the number given in the dossier.
      const mappedEstimate =
        typeof a.estimate === "number" ? nearestCardEstimate(a.estimate) : undefined;
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
          ...(mappedEstimate !== undefined ? { estimate: mappedEstimate } : {}),
          ...(Array.isArray(a.labels) ? { labels: a.labels as string[] } : {}),
        },
        "mcp",
      );
      if (mappedEstimate !== undefined && mappedEstimate !== a.estimate) {
        await ctx.cardStore.recordDossierEntry({
          cardId: card.id,
          kind: "note",
          actor: "mcp",
          text: `Estimate ${a.estimate as number} is not one of {1,2,3,5,8}; mapped to the nearest allowed value, ${mappedEstimate}.`,
        });
      }
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
        to: { type: "string", enum: [...MOVE_CARD_TO] },
        reason: str,
      },
      required: ["card_id", "to"],
    },
    handler: async (a, ctx) => {
      // EXT-6, EXT-7: the schema's enum binds no client, so the server checks
      // `to` itself, before the board is asked or anything is recorded. Done
      // is a person's acceptance, never a tool's (kernel rules 24, 28). The
      // refusal, and nothing else, is recorded: an attempt at Done leaves a trace.
      const to = MOVE_CARD_TO.find((s) => s === a.to);
      if (!to) {
        const known =
          typeof a.card_id === "string" ? await ctx.cardStore.getCard(a.card_id) : undefined;
        await ctx.log.append({
          actor: "mcp",
          type: "mcp/refused",
          ...(known ? { cardId: known.id } : {}),
          payload: { tool: "sekhemet_move_card", to: isCardStatus(a.to) ? a.to : "other" },
        });
        throw new McpError(
          ErrorCode.InvalidParams,
          `sekhemet_move_card moves a card to ready, backlog or parked, not ${JSON.stringify(a.to ?? null)}. Accepting a card into Done is a person's decision, made on the board.`,
        );
      }
      const card = await ctx.cardStore.getCard(String(a.card_id));
      if (!card) throw new Error(`No card ${String(a.card_id)}`);
      await ctx.boardService.transitionCard({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: to,
        actor: "mcp",
        reason: typeof a.reason === "string" ? a.reason : "moved via MCP",
      });
      return `Moved ${card.id} to ${to}`;
    },
  },
  {
    name: "sekhemet_run_gates",
    description: "Run the project's declared gates, in a card's worktree when given.",
    inputSchema: { type: "object", properties: { card_id: str } },
    handler: async (a, ctx) => {
      const id = cardIdArg(a);
      // Runtime item 2a: a card's checks run in its own project's root.
      const card = id ? await ctx.cardStore.getCard(id) : undefined;
      const root = (card ? projectRootOf(ctx.cardStore, card) : undefined) ?? ctx.repoPath;
      const wt = id ? join(root, ".sekhemet", "worktrees", id) : undefined;
      const cwd = wt && existsSync(wt) ? wt : root;
      const cfg = loadGatesConfig(root);
      const runner = new DeterministicGateRunner(new ProcessSandbox(), {
        repoRoot: root,
        expectedConfigSha256: cfg.sha256,
      });
      // Security item 10a: a card's checks see only its own project.
      // Item 10a wherever the checks run: the card's worktree, else its project's root.
      const release = id
        ? isolateCheckout({ repoPath: root, cardStore: ctx.cardStore }, cwd)
        : () => {};
      const res = await runner
        .runGates([...new Set(cfg.gates.map((g) => g.rung))], cwd)
        .finally(release);
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
    name: "sekhemet_get_evidence",
    description:
      "A card's latest evidence bundle, as the ledger names it and checked against its hash. Read-only.",
    inputSchema: { type: "object", properties: { card_id: str }, required: ["card_id"] },
    handler: async (a, ctx) => {
      const id = cardIdArg(a);
      if (!id) throw new Error("card_id is required");
      const ev = await ledgerBundle(
        {
          repoPath: ctx.repoPath,
          cardStore: ctx.cardStore,
          boardService: ctx.boardService as never,
        },
        id,
      );
      if (!ev) throw new Error(`${id} has no evidence bundle the ledger vouches for`);
      return ev;
    },
  },
  {
    name: "sekhemet_model_registry",
    description: "The model registry: each model's engine, qualification and settings. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const path = defaultRegistryPath();
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { models: {} };
    },
  },
  {
    name: "sekhemet_ask_seshat",
    description:
      "Send a message to Seshat, the project manager. Its reply appears in the PM thread.",
    inputSchema: { type: "object", properties: { text: str, card_id: str }, required: ["text"] },
    handler: async (a, ctx) => {
      // PM-N10-1, -2: kept whole; a long message is a project document too.
      const { message: m } = await appendPersonMessage(new PmStore(ctx.log), ctx, {
        text: String(a.text).trim(),
        context:
          typeof a.card_id === "string" ? { cardId: a.card_id, view: "mcp" } : { view: "mcp" },
        actor: "mcp",
        principal: ctx.cardStore.localPrincipal(),
      });
      return `Queued for Seshat as ${m.id}. Read the reply with sekhemet_pm_thread.`;
    },
  },
  {
    name: "sekhemet_pm_thread",
    description: "The PM conversation: messages, Seshat's replies and open proposals.",
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

const SERVER_INFO = { name: "sekhemet-mcp-server", version: "0.2.0" };
const CAPABILITIES = { tools: {} };

/**
 * The harness's MCP server: the official SDK's `Server` (extensibility item
 * 21, DEC-08) with Sekhemet's tools. The SDK frames, validates and answers
 * `ping`; this server supplies the tools and one override, the initialize
 * handler, so a client offering a version outside `MCP_PROTOCOL_VERSIONS` is
 * answered with this server's newest (EXT-14) rather than the SDK's.
 */
export function createMcpServer(ctx: McpContext): Server {
  const server = new Server(SERVER_INFO, { capabilities: CAPABILITIES });
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const asked = request.params.protocolVersion;
    const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
      ? asked
      : MCP_PROTOCOL_VERSIONS[0];
    return { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map(({ handler: _h, ...t }) => ({
      ...t,
      inputSchema: t.inputSchema as Tool["inputSchema"],
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    try {
      const out = await tool.handler(request.params.arguments ?? {}, ctx);
      return {
        content: [
          { type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) },
        ],
      };
    } catch (err) {
      // A request the tool refuses as malformed is a JSON-RPC error (EXT-7).
      if (err instanceof McpError) throw err;
      // Tool errors are results with isError, so the calling agent can react.
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });
  return server;
}

/**
 * Handle one JSON-RPC message in process, through the SDK server over an
 * in-memory transport. Notifications (no id) get no response. An `initialize`
 * missing the client's capabilities or info is given empty ones, so a probe
 * that sends only a protocol version is still answered.
 */
export async function handleMcpRequest(
  req: McpRpcRequest,
  ctx: McpContext,
): Promise<McpRpcResponse | undefined> {
  const { id } = req;
  if (id === undefined || id === null) return undefined;
  const params =
    req.method === "initialize"
      ? {
          protocolVersion: "",
          capabilities: {},
          clientInfo: { name: "unknown", version: "0" },
          ...req.params,
        }
      : req.params;
  const message = { ...req, id, ...(params ? { params } : {}) } as JSONRPCMessage;

  const server = createMcpServer(ctx);
  const [near, far] = InMemoryTransport.createLinkedPair();
  const reply = new Promise<McpRpcResponse>((resolve) => {
    near.onmessage = (m) => {
      if ("id" in m && m.id === id) resolve(m as McpRpcResponse);
    };
  });
  await server.connect(far);
  await near.start();
  try {
    await near.send(message);
    return await reply;
  } finally {
    await server.close();
  }
}

/**
 * One line, in process: a request's response, nothing for a notification,
 * and a parse error with `id: null` for a line that is not JSON (JSON-RPC
 * 2.0, EXT-15).
 */
export async function handleMcpLine(
  line: string,
  ctx: McpContext,
): Promise<McpRpcResponse | undefined> {
  let parsed: McpRpcRequest;
  try {
    parsed = JSON.parse(line) as McpRpcRequest;
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
    };
  }
  return handleMcpRequest(parsed, ctx);
}

/**
 * The SDK's stdio server transport with one addition. The SDK reads lines
 * with its own framing and reports a line it cannot read to `onerror` with no
 * reply; this wrapper answers it as JSON-RPC 2.0 requires, with `id: null`:
 * -32700 for a line that is not JSON (EXT-15), -32600 for JSON that is not a
 * JSON-RPC message. Everything else is the SDK's.
 */
export class ParseErrorStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly inner: StdioServerTransport;

  constructor(stdin: Readable = process.stdin, stdout: Writable = process.stdout) {
    this.inner = new StdioServerTransport(stdin, stdout);
    this.inner.onmessage = (m: JSONRPCMessage) => this.onmessage?.(m);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (err) => {
      const code =
        err instanceof SyntaxError ? -32700 : err.name === "ZodError" ? -32600 : undefined;
      if (code === undefined) {
        this.onerror?.(err);
        return;
      }
      const message = code === -32700 ? `Parse error: ${err.message}` : "Invalid Request";
      const reply = { jsonrpc: "2.0", id: null, error: { code, message } };
      void this.inner.send(reply as unknown as JSONRPCMessage);
    };
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message);
  }
}

export async function runMcpStdioServer(ctx: McpContext): Promise<void> {
  await createMcpServer(ctx).connect(new ParseErrorStdioServerTransport());
}
