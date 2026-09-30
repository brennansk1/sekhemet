import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLocalKernel } from "../src/index.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { type McpContext, handleMcpLine, handleMcpRequest } from "../src/mcp.js";
import { McpConnection } from "../src/mcp_client.js";

/**
 * extensibility NEW-extensibility-3, the criteria that hold whatever carries
 * the JSON-RPC: protocol negotiation, `id: null` on a parse error, a checked
 * `card_id`, the read-only evidence and registry tools, Seshat's name, and a
 * started server's environment. Real ledger file, real child process.
 */
let root: string;
let repo: string;
let db: DatabaseSync;
let ctx: McpContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-mcp-hard-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  ctx = {
    repoPath: repo,
    log,
    cardStore,
    boardService: new BoardServiceImpl(cardStore),
  } as McpContext;
});
afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { isError?: boolean; content: { text: string }[] };
  return { error: result.isError === true, text: result.content[0]?.text ?? "" };
};

describe("EXT-14: the protocol version is negotiated", () => {
  it("answers a newer version it supports with that version, an unknown one with its latest", async () => {
    const init = async (protocolVersion: string) =>
      (
        (
          await handleMcpRequest(
            { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } },
            ctx,
          )
        )?.result as { protocolVersion: string }
      ).protocolVersion;
    expect(await init("2025-06-18")).toBe("2025-06-18");
    expect(await init("2024-11-05")).toBe("2024-11-05");
    expect(await init("2099-01-01")).toBe("2025-06-18");
  });
});

describe("EXT-15: a malformed request is a parse error with id null", () => {
  it("answers id: null and code -32700", async () => {
    const r = await handleMcpLine("{not json", ctx);
    expect(r).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });
});

describe("EXT-16: a card_id is checked before any path is built from it", () => {
  it("refuses a card_id outside the card-id pattern, touching nothing", async () => {
    // No gates.toml: a run would fail on reading it; the refusal comes first.
    const r = await call("sekhemet_run_gates", { card_id: "../../etc" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/not a card id/);
  });
});

describe("EXT-17: the evidence bundle and the model registry, read-only", () => {
  it("returns a card's ledger-named evidence and the registry, with no write tool for either", async () => {
    await ctx.cardStore.createCard({ id: "c1", tier: "story", title: "C1" });
    const body = `${JSON.stringify({ id: "ev_c1", cardId: "c1", passed: true })}\n`;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_c1.json"), body);
    await recordLedgerRun(ctx.cardStore, {
      cardId: "c1",
      modelId: "nail",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_c1",
      path: join(".sekhemet", "evidence", "ev_c1.json"),
      body,
      filesTouched: [],
    });
    const ev = await call("sekhemet_get_evidence", { card_id: "c1" });
    expect(ev.error).toBe(false);
    expect(JSON.parse(ev.text)).toMatchObject({ id: "ev_c1", passed: true });
    // A bundle whose bytes no longer match the ledger's hash is not served.
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_c1.json"), body.replace("true", "false"));
    expect((await call("sekhemet_get_evidence", { card_id: "c1" })).error).toBe(true);

    const registry = join(root, "models.json");
    writeFileSync(registry, JSON.stringify({ version: 1, models: { nail: { engine: "ollama" } } }));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", registry);
    const reg = await call("sekhemet_model_registry");
    expect(reg.error).toBe(false);
    expect(reg.text).toContain("nail");
    expect(readFileSync(registry, "utf8")).toContain('"engine":"ollama"');
    const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
    const names = (listed?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names.filter((n) => /evidence|registry/.test(n)).sort()).toEqual([
      "sekhemet_get_evidence",
      "sekhemet_model_registry",
    ]);
  });
});

/**
 * EXT-6, EXT-7 (S4, fix round F3): the server checks `to` itself. The tool's
 * schema offers ready, backlog and parked, but a client need not honour a
 * schema; a card in Review is one legal edge from Done (kernel rule 28 stops
 * only the `override:`), so the server refuses anything else before the board
 * is asked, in words, as a JSON-RPC invalid-params error. The ledger records
 * the refusal and nothing else (fix round F3 review: an attempted bypass to
 * Done leaves an audit trace): one `mcp/refused` naming the tool, the column
 * asked for (a board column, else `other`) and the card when it exists —
 * never the client's reason text.
 */
describe("EXT-6, EXT-7: move_card goes only to ready, backlog or parked", () => {
  // The ledger's one-time record of its installing person (kernel rule 19)
  // comes with its first attributed event; it is not the tool's.
  const events = () =>
    (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type != 'person/created'").get() as {
        n: number;
      }
    ).n;
  const lastRefusal = async () => (await ctx.log.getEventsByTypes(["mcp/refused"])).at(-1);
  const move = async (args: Record<string, unknown>) =>
    handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "sekhemet_move_card", arguments: args },
      },
      ctx,
    );

  beforeEach(async () => {
    ctx.db = db;
    await ctx.cardStore.createCard({
      id: "c_rev",
      tier: "task",
      title: "Rev",
      status: "in_progress",
    });
    // Into Review by the transition law, as a card that passed its gates gets there.
    for (const [fromStatus, toStatus] of [
      ["in_progress", "verify"],
      ["verify", "review"],
    ] as const) {
      await ctx.boardService.transitionCard({
        cardId: "c_rev",
        fromStatus,
        toStatus,
        actor: "harness",
        reason: "gates passed",
      });
    }
  });

  it("refuses Done, with or without an override reason, leaves the card as it was and records only the refusal", async () => {
    for (const reason of [undefined, "override: the model says it is finished"]) {
      const before = events();
      const r = await move({ card_id: "c_rev", to: "done", ...(reason ? { reason } : {}) });
      expect(r?.error?.code).toBe(-32602);
      expect(r?.error?.message).toMatch(/ready, backlog or parked/);
      expect(r?.error?.message).toMatch(/accept/i);
      expect((await ctx.cardStore.getCard("c_rev"))?.status).toBe("review");
      expect(events()).toBe(before + 1);
      const refusal = await lastRefusal();
      expect(refusal).toMatchObject({
        actor: "mcp",
        cardId: "c_rev",
        payload: { tool: "sekhemet_move_card", to: "done" },
      });
      expect(JSON.stringify(refusal)).not.toContain("finished");
    }
  });

  it("answers invalid params for any other destination, a non-string or none", async () => {
    for (const [to, recorded] of [
      ["in_progress", "in_progress"],
      ["verify", "verify"],
      ["rejected", "rejected"],
      ["planning", "planning"],
      ["READY", "other"],
      [3, "other"],
      [null, "other"],
    ] as const) {
      const before = events();
      const r = await move({ card_id: "c_rev", to });
      expect(r?.error?.code, String(to)).toBe(-32602);
      expect(r?.error?.message).toMatch(/ready, backlog or parked/);
      expect((await ctx.cardStore.getCard("c_rev"))?.status).toBe("review");
      expect(events()).toBe(before + 1);
      expect((await lastRefusal())?.payload).toEqual({ tool: "sekhemet_move_card", to: recorded });
    }
    expect((await move({ card_id: "c_rev" }))?.error?.code).toBe(-32602);
    // A card that does not exist is not named on the refusal.
    expect((await move({ card_id: "c_none", to: "done" }))?.error?.code).toBe(-32602);
    expect((await lastRefusal())?.cardId).toBeUndefined();
  });

  it("behind it, the board `sekhemet mcp` is given refuses the MCP actor Done too (rules 24 and 28)", async () => {
    // The kernel `sekhemet mcp` opens (`initLocalKernel`) and hands the server, not a stand-in.
    const own = join(root, "own");
    mkdirSync(own);
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "config"));
    const k = initLocalKernel(own);
    try {
      // Put in Review by the store's recorded override: this board's entry
      // conditions want a real attempt and evidence to get there, and the
      // refusal under test is Done's.
      await k.cardStore.createCard({ id: "c_rev", tier: "task", title: "Rev" });
      await k.cardStore.updateCardStatus("c_rev", "review", "set up", "harness", {
        override: true,
      });
      const count = () =>
        (k.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      const before = count();
      for (const reason of ["moved via MCP", "override: finished"]) {
        await expect(
          k.boardService.transitionCard({
            cardId: "c_rev",
            fromStatus: "review",
            toStatus: "done",
            actor: "mcp",
            reason,
          }),
        ).rejects.toThrow(/Only a person/);
      }
      expect((await k.cardStore.getCard("c_rev"))?.status).toBe("review");
      expect(count()).toBe(before);
    } finally {
      k.db.close();
    }
  });

  it("still moves a card to each allowed column", async () => {
    const r = await move({ card_id: "c_rev", to: "ready", reason: "needs another pass" });
    expect(r?.error).toBeUndefined();
    expect((await ctx.cardStore.getCard("c_rev"))?.status).toBe("ready");
    await move({ card_id: "c_rev", to: "backlog" });
    expect((await ctx.cardStore.getCard("c_rev"))?.status).toBe("backlog");
  });
});

describe("EXT-21a: the PM tool is named after Seshat", () => {
  it("offers sekhemet_ask_seshat and nothing named after Merit", async () => {
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    const names = (r?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain("sekhemet_ask_seshat");
    expect(names.some((n) => /merit/i.test(n))).toBe(false);
  });
});

describe("EXT-18: a started MCP server gets only the allowlist and its declared env", () => {
  it("passes no other variable of the harness's environment", async () => {
    vi.stubEnv("SEKHEMET_TEST_SECRET", "do-not-leak");
    const out = join(root, "env.txt");
    const server = join(root, "server.mjs");
    writeFileSync(
      server,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const result = m.method === "tools/list" ? { tools: [] } : { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "1" } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`,
    );
    const conn = new McpConnection("t", {
      command: process.execPath,
      args: [server],
      env: { DECLARED: "yes" },
    });
    await conn.connect();
    await conn.close();
    const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
    expect(env.DECLARED).toBe("yes");
    expect(env.SEKHEMET_TEST_SECRET).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });
});
