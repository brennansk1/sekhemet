import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("PM_CONTRACT §2: a card created with an out-of-scale estimate is mapped, not refused", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "sekhemet_create_card",
          arguments: { title: "Jira-sized story", tier: "task", estimate: 13 },
        },
      },
      context,
    );
    expect(res.error).toBeUndefined();
    const created = (await cardStore.listCards()).find((c) => c.title === "Jira-sized story");
    expect(created?.estimate).toBe(8);
    const dossier = await cardStore.getDossier(created?.id as string);
    expect(dossier.notes.map((n) => n.text).join("\n")).toContain("Estimate 13");
  });
});

describe("MCP tools beyond the basics (H10)", () => {
  let ctx: McpContext;
  let cardStore: CardStore;
  let repo: string;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } },
      ctx,
    );
    const r = res?.result as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]?.text ?? "" };
  };

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "mcp-"));
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    cardStore = new CardStore(db, log);
    ctx = { db, log, cardStore, boardService: new BoardServiceImpl(cardStore), repoPath: repo };
    await cardStore.createCard({ id: "card_a", tier: "task", title: "A", status: "backlog" });
  });

  it("offers only tiers the database accepts", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    const tools = (
      res?.result as {
        tools: { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[];
      }
    ).tools;
    const create = tools.find((t) => t.name === "sekhemet_create_card");
    expect(create?.inputSchema.properties.tier?.enum).not.toContain("spike");
    expect(tools.every((t) => !("handler" in t))).toBe(true);
    // Accepting stays a human action.
    expect(tools.some((t) => /accept/.test(t.name))).toBe(false);
    const epic = await call("sekhemet_create_card", { title: "Ledger", tier: "epic" });
    expect(epic.error).toBe(false);
  });

  it("gets a card with its evidence, minus the raw diff", async () => {
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "evidence", "latest-card_a.json"),
      JSON.stringify({ gatesPassed: false, diff: "x".repeat(50_000), failures: ["tsc"] }),
    );
    const r = await call("sekhemet_get_card", { card_id: "card_a" });
    expect(r.text).toContain('"gatesPassed": false');
    expect(r.text).not.toContain("xxxxx");
    expect((await call("sekhemet_get_card", { card_id: "nope" })).error).toBe(true);
  });

  it("updates team fields only, and moves cards", async () => {
    expect(
      (await call("sekhemet_update_card", { card_id: "card_a", fields: { status: "done" } })).error,
    ).toBe(true);
    await call("sekhemet_update_card", {
      card_id: "card_a",
      fields: { priority: 1, labels: ["api"] },
    });
    const card = await cardStore.getCard("card_a");
    expect(card?.priority).toBe(1);
    expect(card?.status).toBe("backlog");
    const moved = await call("sekhemet_move_card", { card_id: "card_a", to: "ready" });
    expect(moved.error).toBe(false);
    expect((await cardStore.getCard("card_a"))?.status).toBe("ready");
  });

  it("answers notifications with nothing and ping with an empty result", async () => {
    expect(
      await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx),
    ).toBeUndefined();
    expect(
      (await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" }, ctx))?.result,
    ).toEqual({});
  });

  it("runs the declared gates in the repository", async () => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      '[[gate]]\nid = "ok"\nrung = "test"\ncommand = "true"\n',
    );
    const r = await call("sekhemet_run_gates");
    expect(r.error).toBe(false);
    expect(r.text).toContain('"passed": true');
  });

  it("EXT-35: describes the gate run, in at most two sentences, as a pre-check that is not evidence and moves no issue", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    const tool = (res?.result as { tools: { name: string; description: string }[] }).tools.find(
      (t) => t.name === "sekhemet_run_gates",
    );
    const d = tool?.description ?? "";
    expect(d).toMatch(/pre-check/i);
    expect(d).toMatch(/not evidence/i);
    expect(d).toMatch(/moves no issue/i);
    expect(d.split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it("EXT-36: a gate run on a card returns the verdict and records no gate result, no evidence, no move", async () => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      '[[gate]]\nid = "ok"\nrung = "test"\ncommand = "true"\n',
    );
    const events = () =>
      (ctx.db.prepare("SELECT type FROM events ORDER BY rowid").all() as { type: string }[]).map(
        (e) => e.type,
      );
    const before = events();
    const r = await call("sekhemet_run_gates", { card_id: "card_a" });
    expect(r.error).toBe(false);
    expect(r.text).toContain('"passed": true');
    expect(events()).toEqual(before);
    expect(existsSync(join(repo, ".sekhemet", "evidence"))).toBe(false);
    expect((await cardStore.getCard("card_a"))?.status).toBe("backlog");
  });

  it("queues a message for Seshat and shows it in the thread", async () => {
    await call("sekhemet_ask_seshat", { text: "What is blocking the ledger?" });
    const thread = await call("sekhemet_pm_thread");
    expect(thread.text).toContain("What is blocking the ledger?");
  });
});
