import { createInterface } from "node:readline";
import type { CardStore } from "@sekhemet/kernel";
import type { ModelHold } from "@sekhemet/models";
import { plural } from "@sekhemet/ui";
import { appendPersonMessage } from "./pm/documents.js";
import { answerQueued } from "./pm/service.js";
import type { PmStore } from "./pm/store.js";

/**
 * The editor surface (H14): Sekhemet as an agent over the Agent Client
 * Protocol (ACP, agentclientprotocol.com), the JSON-RPC-over-stdio protocol
 * Zed and other editors use to talk to coding agents.
 *
 * The agent behind it is Seshat, the project manager: an editor's agent panel
 * becomes a conversation about the board, with the same slash commands
 * (/status, /ready, /research ...), and replies stream back as
 * `session/update` agent_message_chunk notifications. Cards themselves still
 * run in the queue; the editor asks, plans and triages.
 *
 * Implemented: initialize, session/new, session/prompt, session/cancel.
 */

export const ACP_PROTOCOL_VERSION = 1;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface AcpDeps {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel: string;
  acquire: () => Promise<ModelHold>;
  researcher?: Parameters<typeof answerQueued>[0]["researcher"];
  /** The harness's board: `/ready` and the other moves go through it (kernel K-S4-3). */
  board: Parameters<typeof answerQueued>[0]["board"];
  send: (msg: unknown) => void;
}

interface Session {
  id: string;
  cwd: string;
  cancelled: boolean;
}

/** Text of an ACP prompt: its text content blocks, plus resource links named. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => {
      const block = b as {
        type?: string;
        text?: string;
        uri?: string;
        name?: string;
        resource?: { uri?: string; text?: string };
      };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "resource_link") return `[${block.name ?? block.uri}](${block.uri})`;
      if (block.type === "resource")
        return `${block.resource?.uri ?? ""}\n${block.resource?.text ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export class AcpAgent {
  private sessions = new Map<string, Session>();
  private nextSession = 1;

  constructor(private deps: AcpDeps) {}

  private reply(id: RpcMessage["id"], result: unknown): void {
    this.deps.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: RpcMessage["id"], code: number, message: string): void {
    this.deps.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.deps.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  async handle(msg: RpcMessage): Promise<void> {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return this.reply(msg.id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "sekhemet", title: "Seshat · Project manager", version: "0.2.0" },
        });
      case "session/new": {
        const id = `sess_${this.nextSession++}`;
        this.sessions.set(id, { id, cwd: String(p.cwd ?? this.deps.repoPath), cancelled: false });
        return this.reply(msg.id, { sessionId: id });
      }
      case "session/cancel": {
        const s = this.sessions.get(String(p.sessionId));
        if (s) s.cancelled = true;
        return;
      }
      case "session/prompt": {
        const s = this.sessions.get(String(p.sessionId));
        if (!s) return this.fail(msg.id, -32602, `Unknown session ${String(p.sessionId)}`);
        s.cancelled = false;
        const text = promptText(p.prompt).trim();
        if (!text) return this.reply(msg.id, { stopReason: "end_turn" });
        // PM-N10-1, -2: kept whole; a long prompt is a project document too.
        const { message: asked } = await appendPersonMessage(
          this.deps.pmStore,
          {
            repoPath: this.deps.repoPath,
            cardStore: this.deps.cardStore,
            log: this.deps.pmStore.log,
          },
          {
            text,
            context: { view: "editor" },
            principal: this.deps.cardStore.localPrincipal(),
          },
        );
        this.update(s.id, {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Seshat reads the board and answers",
              priority: "medium",
              status: "in_progress",
            },
          ],
        });
        try {
          await answerQueued({
            repoPath: this.deps.repoPath,
            cardStore: this.deps.cardStore,
            pmStore: this.deps.pmStore,
            pmModel: this.deps.pmModel,
            acquire: this.deps.acquire,
            board: this.deps.board,
            ...(this.deps.researcher ? { researcher: this.deps.researcher } : {}),
          });
        } catch (err) {
          this.update(s.id, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Seshat could not answer: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
          return this.reply(msg.id, { stopReason: "end_turn" });
        }
        if (s.cancelled) return this.reply(msg.id, { stopReason: "cancelled" });
        const replies = (await this.deps.pmStore.thread()).filter(
          (m) => m.role === "pm" && m.seq > asked.seq,
        );
        for (const r of replies) {
          // Stream in paragraphs, the way a chat panel renders best.
          for (const para of r.text.split(/(?<=\n\n)/)) {
            this.update(s.id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: para },
            });
          }
          if ((r.proposals ?? []).length > 0) {
            this.update(s.id, {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `\n\n${plural(r.proposals?.length ?? 0, "proposed change")} ${(r.proposals?.length ?? 0) === 1 ? "is" : "are"} waiting in the dashboard (Seshat panel) to apply or discard.`,
              },
            });
          }
        }
        return this.reply(msg.id, { stopReason: "end_turn" });
      }
      default:
        if (msg.id !== undefined && msg.id !== null)
          this.fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
}

/** Serve ACP on stdio (`sekhemet acp`); editors launch this as their agent command. */
export function runAcpStdio(deps: Omit<AcpDeps, "send">): Promise<void> {
  const agent = new AcpAgent({
    ...deps,
    send: (m) => process.stdout.write(`${JSON.stringify(m)}\n`),
  });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    void agent.handle(msg);
  });
  return new Promise((resolve) => rl.on("close", () => resolve()));
}
