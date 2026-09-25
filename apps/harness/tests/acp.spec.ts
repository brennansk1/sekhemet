import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { ACP_PROTOCOL_VERSION, AcpAgent, promptText } from "../src/acp.js";
import { PmStore } from "../src/pm/store.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const pmStore = new PmStore(log);
  const sent: Record<string, unknown>[] = [];
  const model: LocalInferenceAdapter = {
    modelId: "pm",
    supportedArms: ["arm_a_flat"],
    async generate(_req: InferenceRequest) {
      return {
        text: "The ledger card is next.\n\nIt waits on the hasher.",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  const agent = new AcpAgent({
    repoPath: process.cwd(),
    cardStore,
    pmStore,
    pmModel: "pm",
    acquire: async () => model,
    send: (m) => sent.push(m as Record<string, unknown>),
  });
  return { agent, sent, cardStore };
}

describe("Agent Client Protocol surface (H14)", () => {
  it("initializes with the protocol version and capabilities, and opens sessions", async () => {
    const { agent, sent } = setup();
    await agent.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      },
    });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    });
    expect(sent[1]).toMatchObject({ id: 2, result: { sessionId: "sess_1" } });
    await agent.handle({ jsonrpc: "2.0", id: 3, method: "nope/nope" });
    expect(sent[2]).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("streams Seshat's reply as agent_message_chunk updates, then ends the turn", async () => {
    const { agent, sent } = setup();
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: "What is next?" }] },
    });
    const chunks = sent
      .filter((m) => m.method === "session/update")
      .map(
        (m) =>
          (m.params as { update: { sessionUpdate: string; content?: { text: string } } }).update,
      )
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text);
    expect(chunks.join("")).toBe("The ledger card is next.\n\nIt waits on the hasher.");
    expect(chunks.length).toBe(2);
    expect(sent.at(-1)).toMatchObject({ id: 2, result: { stopReason: "end_turn" } });
  });

  it("answers slash commands without a model and rejects unknown sessions", async () => {
    const { agent, sent, cardStore } = setup();
    // Criteria: Ready's entry condition applies to a person's move too (kernel rule 27).
    await cardStore.createCard({
      id: "card_x",
      tier: "task",
      title: "X",
      status: "backlog",
      acceptanceCriteria: ["x"],
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: "/ready card_x" }] },
    });
    expect((await cardStore.getCard("card_x"))?.status).toBe("ready");
    expect(JSON.stringify(sent)).toContain("Moved card_x to Ready");
    await agent.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess_9", prompt: [] },
    });
    expect(sent.at(-1)).toMatchObject({ id: 3, error: { code: -32602 } });
  });

  it("reads text, resource links and embedded resources from prompts", () => {
    expect(
      promptText([
        { type: "text", text: "Review this" },
        { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
        { type: "resource", resource: { uri: "file:///b.ts", text: "export const b = 1;" } },
      ]),
    ).toBe("Review this\n\n[a.ts](file:///a.ts)\n\nfile:///b.ts\nexport const b = 1;");
  });
});
