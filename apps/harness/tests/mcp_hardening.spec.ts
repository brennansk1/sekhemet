import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
