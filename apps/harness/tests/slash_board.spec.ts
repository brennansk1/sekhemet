import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl, type CardTransition } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ModelHold } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp.js";
import { runAsk } from "../src/ask_cmd.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Fix round F3 (W2b finding; kernel K-S4-3): a slash command that moves a
 * card — `/ready`, `/park`, `/backlog` — goes through the harness's own
 * board, the one with its Review limit, its evidence reader and its entry
 * conditions, by every door Seshat is reached through: the dashboard's
 * composer, `sekhemet ask` and the editor (ACP). Before this, Seshat's
 * service called `runSlash` without it, and the command built a board of its
 * own. A real SQLite ledger and a real server; the model is never loaded.
 */

/** The harness's board, with every move it is asked for recorded. */
class RecordingBoard extends BoardServiceImpl {
  moves: CardTransition[] = [];
  override async transitionCard(t: CardTransition): Promise<void> {
    this.moves.push(t);
    await super.transitionCard(t);
  }
}

const model: LocalInferenceAdapter = {
  modelId: "pm",
  supportedArms: ["arm_a_flat"],
  async generate() {
    return {
      text: "A model answer: a slash command should never reach here.",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    };
  },
};
const hold = async (): Promise<ModelHold> =>
  ({ role: "chat", adapter: model, release: () => {} }) as unknown as ModelHold;

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let cards: CardStore;
let board: RecordingBoard;

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "slash-board-")));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  cards = new CardStore(db, log);
  board = new RecordingBoard(cards, { entryConditions: true });
  await cards.createCard({
    id: "card_chron_hasher",
    tier: "task",
    title: "Hasher",
    status: "backlog",
    acceptanceCriteria: ["hashes a chain"],
  });
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

const movedThroughTheBoard = () => {
  expect(board.moves.map((m) => [m.cardId, m.toStatus, m.actor])).toEqual([
    ["card_chron_hasher", "ready", "human"],
  ]);
};

describe("a slash command's move goes through the harness's board", () => {
  it("from the dashboard's composer (the PM route)", async () => {
    const server = await startDashboardServer({
      db,
      log,
      boardService: board,
      cardStore: cards,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
      pmAdapter: () => model,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const sent = await fetch(`${base}/api/pm/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify({ text: "/ready hasher" }),
      });
      expect(sent.status).toBe(200);
      let reply: string | undefined;
      for (let i = 0; i < 200 && !reply; i++) {
        const { messages } = (await (await fetch(`${base}/api/pm/thread`)).json()) as {
          messages: { role: string; text: string }[];
        };
        reply = messages.find((m) => m.role === "pm")?.text;
        if (!reply) await new Promise((r) => setTimeout(r, 25));
      }
      expect(reply).toBe("Moved card_chron_hasher to Ready.");
      movedThroughTheBoard();
      expect((await cards.getCard("card_chron_hasher"))?.status).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("from the terminal (sekhemet ask)", async () => {
    const lines: string[] = [];
    const code = await runAsk("/ready hasher", {
      repoPath: repo,
      cardStore: cards,
      pmStore: new PmStore(log),
      pmModel: "pm",
      acquire: hold,
      board,
      say: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Moved card_chron_hasher to Ready.");
    movedThroughTheBoard();
  });

  it("from an editor (ACP)", async () => {
    const sent: unknown[] = [];
    const agent = new AcpAgent({
      repoPath: repo,
      cardStore: cards,
      pmStore: new PmStore(log),
      pmModel: "pm",
      acquire: hold,
      board,
      send: (m) => sent.push(m),
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: "/ready hasher" }] },
    });
    expect(JSON.stringify(sent)).toContain("Moved card_chron_hasher to Ready");
    movedThroughTheBoard();
  });

  it("and a refusal of the harness's board is what the person reads", async () => {
    // The harness's board refuses what a board of the command's own would
    // allow: here, its Ready column is full.
    const full = new RecordingBoard(cards, { entryConditions: true, customLimits: { ready: 0 } });
    board = full;
    const lines: string[] = [];
    await runAsk("/ready hasher", {
      repoPath: repo,
      cardStore: cards,
      pmStore: new PmStore(log),
      pmModel: "pm",
      acquire: hold,
      board: full,
      say: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toMatch(/WIP limit exceeded for column 'ready'/);
    expect((await cards.getCard("card_chron_hasher"))?.status).toBe("backlog");
  });
});
