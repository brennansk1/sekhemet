import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, type ModelHold } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAsk } from "../src/ask_cmd.js";
import { PRIMARY_COMMANDS, routeFrontDoor } from "../src/cli_commands.js";
import { PmStore } from "../src/pm/store.js";

/**
 * NEW-surface-6 (O23, approved under DEC-42): `sekhemet ask "<question>"`,
 * Seshat from the terminal through the PM's queued-answer path, into the
 * same thread the dashboard shows (SUR-51); `ask` at the front door in place
 * of `board`, which still runs (SUR-52). A real ledger, a scripted model.
 */
const usage = { promptTokens: 10, completionTokens: 10, durationMs: 1 };
const held = (adapter: MockInferenceAdapter): ModelHold =>
  ({ role: "chat", adapter, release: () => {} }) as unknown as ModelHold;

let repo: string;
let log: EventLog;
let cards: CardStore;
let pm: PmStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ask-"));
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  log = new EventLog(db);
  cards = new CardStore(db, log);
  pm = new PmStore(log);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("SUR-51: sekhemet ask", () => {
  it("posts the question as the person's message, prints Seshat's reply, records both in the thread, exit 0", async () => {
    const model = new MockInferenceAdapter("dirk-27b", [
      { text: "Two cards are left: the export and the mailer.", toolCalls: [], usage },
    ]);
    const lines: string[] = [];
    const code = await runAsk("What is left before the release?", {
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => held(model),
      say: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Two cards are left: the export and the mailer.");
    const thread = await pm.thread();
    expect(thread.map((m) => [m.role, m.state])).toEqual([
      ["user", "done"],
      ["pm", "done"],
    ]);
    expect(thread[0]).toMatchObject({
      text: "What is left before the release?",
      context: { view: "terminal" },
    });
    const [message] = await log.getEventsByTypes(["pm/message"]);
    expect(message?.actor).toBe("human");
  });

  it("lists the proposals a reply creates and applies none", async () => {
    const card = await cards.createCard({ tier: "task", title: "Export", status: "ready" });
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: `Export (\`${card.id}\`) should go first.`,
        toolCalls: [
          {
            id: "1",
            name: "propose_update_card",
            arguments: { card_id: card.id, priority: 1, reason: "customers wait on it" },
          },
        ],
        usage,
      },
    ]);
    const lines: string[] = [];
    const code = await runAsk("What should go first?", {
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => held(model),
      say: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/1 proposed change/);
    expect(text).toMatch(/applies none|nothing is applied/i);
    const reply = (await pm.thread()).at(-1);
    expect(reply?.proposals?.[0]?.state).toBe("open");
    expect((await cards.getCard(card.id))?.priority).toBe(0);
  });

  it("says why when no model can answer, and exits 1", async () => {
    const lines: string[] = [];
    const code = await runAsk("Anything?", {
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => {
        throw new Error("no weights for dirk-27b in the models folder");
      },
      say: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    // PM-01: the worded cause; the exception's own text goes to stderr only.
    expect(lines.join("\n")).toMatch(/No model is answering for Seshat/);
    expect(lines.join("\n")).not.toMatch(/no weights for dirk-27b/);
  });

  it("refuses an empty question with a usage error", async () => {
    const code = await runAsk("  ", {
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "dirk-27b",
      acquire: async () => {
        throw new Error("never");
      },
      say: () => {},
    });
    expect(code).toBe(2);
    expect(await pm.thread()).toEqual([]);
  });
});

describe("SUR-52: ask at the front door, board under dev", () => {
  it("lists ask among the eight front-door commands and not board; board still routes", () => {
    const usages = PRIMARY_COMMANDS.map((c) => c.usage);
    expect(usages).toHaveLength(8);
    expect(usages).toContain('sekhemet ask "<question>"');
    expect(usages.some((u) => u.startsWith("sekhemet board"))).toBe(false);
    expect(routeFrontDoor(["ask", "what is left?"])).toEqual({
      kind: "argv",
      argv: ["ask", "what is left?"],
    });
    expect(routeFrontDoor(["board"])).toEqual({ kind: "argv", argv: ["board"] });
    expect(routeFrontDoor(["board", "--terminal"])).toEqual({
      kind: "argv",
      argv: ["board", "--terminal"],
    });
  });
});
