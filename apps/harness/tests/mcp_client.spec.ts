import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHub, loadMcpConfig } from "../src/mcp_client.js";
import { setInvocationTrust } from "../src/workspace_trust.js";

// These servers are the person's own: trusted for this run, as `--trust` does
// (S9; an untrusted project's servers are workspace_trust.spec.ts's).
beforeAll(() => setInvocationTrust(true));
afterAll(() => setInvocationTrust(false));
import { research } from "../src/research/researcher.js";

/** A real stdio MCP server: two tools, one of which the config hides. */
const SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
console.log("server log line that is not JSON-RPC");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "lookup", description: "Look up a term", inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] } },
    { name: "delete_everything", description: "Dangerous", inputSchema: { type: "object", properties: {} } } ] } });
  else if (m.method === "tools/call") {
    if (m.params.arguments.term === "boom") send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "no such term" }] } });
    else send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "definition of " + m.params.arguments.term }] } });
  }
});`;

function project(): string {
  const repo = mkdtempSync(join(tmpdir(), "mcpc-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const script = join(repo, "server.cjs");
  writeFileSync(script, SERVER);
  writeFileSync(
    join(repo, ".sekhemet", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        demo: { command: process.execPath, args: [script], tools: ["lookup"] },
        broken: { command: "/nonexistent/binary" },
        off: { command: process.execPath, args: [script], disabled: true },
        "bad name!": { command: "x" },
      },
    }),
  );
  return repo;
}

describe("MCP client (H11)", () => {
  it("reads the mcpServers config, skipping invalid names", () => {
    const cfg = loadMcpConfig(project());
    expect(Object.keys(cfg).sort()).toEqual(["broken", "demo", "off"]);
  });

  it("connects over stdio, namespaces allowed tools, calls them, and survives a broken server", async () => {
    const hub = await McpHub.connect(project());
    try {
      expect(hub.toolDefinitions().map((t) => t.name)).toEqual(["mcp__demo__lookup"]);
      expect(hub.errors.some((e) => e.startsWith("broken:"))).toBe(true);
      expect(await hub.call("mcp__demo__lookup", { term: "WAL" })).toBe("definition of WAL");
      expect(await hub.call("mcp__demo__lookup", { term: "boom" })).toBe("[ERROR]: no such term");
      expect(await hub.call("mcp__demo__delete_everything", {})).toMatch(/offers no tool/);
      expect(await hub.call("mcp__nope__x", {})).toMatch(/no MCP server/);
    } finally {
      hub.close();
    }
  });

  it("offers MCP tools to the Researcher and runs them", async () => {
    const hub = await McpHub.connect(project());
    const seen: string[] = [];
    let i = 0;
    const model: LocalInferenceAdapter = {
      modelId: "generic",
      supportedArms: ["arm_a_flat"],
      nativeTools: true,
      async generate(req: InferenceRequest) {
        seen.push(...(req.tools ?? []).map((t) => t.name));
        const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
        if (i++ === 0)
          return {
            text: "",
            usage,
            toolCalls: [{ id: "a", name: "mcp__demo__lookup", arguments: { term: "WAL" } }],
          };
        const tool = req.messages?.find((m) => m.role === "tool")?.content ?? "";
        return {
          text: tool.includes("definition of WAL") ? "It is write-ahead logging [1]." : "missing",
          toolCalls: [],
          usage,
        };
      },
    };
    try {
      const r = await research(model, "What is WAL?", { repoPath: process.cwd(), mcp: hub });
      expect(seen).toContain("mcp__demo__lookup");
      expect(r.answer).toBe("It is write-ahead logging [1].");
      expect(r.grounded).toBe(true);
    } finally {
      hub.close();
    }
  });
});
