import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { beforeEach, describe, expect, it } from "vitest";
import { answerQueued } from "../src/pm/service.js";
import { parseSlash } from "../src/pm/slash.js";
import { PmStore } from "../src/pm/store.js";

describe("slash commands in Seshat's chat (H16)", () => {
  let cards: CardStore;
  let pm: PmStore;
  let log: EventLog;
  let loads: number;
  let prompts: string[];
  const repo = mkdtempSync(join(tmpdir(), "slash-"));
  const model: LocalInferenceAdapter = {
    modelId: "pm",
    supportedArms: ["arm_a_flat"],
    async generate(req: InferenceRequest) {
      prompts.push(req.prompt);
      return {
        text: "Planned.",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  const run = (extra: Record<string, unknown> = {}) =>
    answerQueued({
      repoPath: repo,
      cardStore: cards,
      pmStore: pm,
      pmModel: "pm",
      acquire: async () => {
        loads++;
        return { role: "chat", adapter: model, release: () => {} };
      },
      ...extra,
    });
  const lastReply = async () => (await pm.thread()).filter((m) => m.role === "pm").at(-1);

  beforeEach(async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    pm = new PmStore(log);
    loads = 0;
    prompts = [];
    await cards.createCard({
      id: "card_chron_hasher",
      tier: "task",
      title: "Hasher",
      status: "backlog",
      // Ready's entry condition (kernel rule 27): the move goes through the board.
      acceptanceCriteria: ["hashes a chain"],
    });
  });

  it("parses commands and leaves prose alone", () => {
    expect(parseSlash("/park hasher too big")).toEqual({ name: "park", args: "hasher too big" });
    expect(parseSlash("  /HELP")).toEqual({ name: "help", args: "" });
    expect(parseSlash("what about /park?")).toBeUndefined();
  });

  it("answers /help, /forecast and /capability from code, without loading a model", async () => {
    for (const text of ["/help", "/forecast", "/capability"]) {
      await pm.appendUserMessage(text);
      await run();
    }
    expect(loads).toBe(0);
    const replies = (await pm.thread()).filter((m) => m.role === "pm").map((m) => m.text);
    expect(replies[0]).toMatch(/`\/research <question>`/);
    expect(replies[1]).toMatch(/open card\(s\)/);
    expect(replies[2]?.length).toBeGreaterThan(0);
  });

  it("moves cards as the human, by short name, and says when a card is unknown", async () => {
    await pm.appendUserMessage("/ready hasher");
    await run();
    expect((await cards.getCard("card_chron_hasher"))?.status).toBe("ready");
    const moved = (await log.getEventsByCard("card_chron_hasher"))
      .filter((e) => e.type === "card/status_changed")
      .at(-1);
    expect(moved?.actor).toBe("human");
    await pm.appendUserMessage("/park hasher waiting on the spec");
    await run();
    expect((await cards.getCard("card_chron_hasher"))?.status).toBe("parked");
    await pm.appendUserMessage("/park nosuchcard");
    await run();
    expect((await lastReply())?.text).toMatch(/No card matches "nosuchcard"/);
    expect(loads).toBe(0);
  });

  it("runs /research and /deep through the Researcher and shows the verdict and sources", async () => {
    const asked: { q: string; deep?: boolean }[] = [];
    const researcher = async (q: string, o?: { deep?: boolean }) => {
      asked.push({ q, ...(o?.deep ? { deep: true } : {}) });
      return {
        answer: "Use exec('BEGIN') [1].",
        sources: ["https://nodejs.org/api/sqlite.html"],
        grounded: true,
        evidence: [],
        confidence: 0.35,
        badCitations: [],
      };
    };
    await pm.appendUserMessage("/deep node:sqlite transactions");
    await run({ researcher });
    expect(asked).toEqual([{ q: "node:sqlite transactions", deep: true }]);
    const text = (await lastReply())?.text ?? "";
    expect(text).toMatch(/Grounded, confidence 0\.35\./);
    expect(text).toMatch(/1\. https:\/\/nodejs\.org\/api\/sqlite\.html/);
    await pm.appendUserMessage("/research x");
    await run();
    expect((await lastReply())?.text).toMatch(/No Researcher is configured/);
  });

  it("forwards /plan to Seshat as the request it stands for", async () => {
    await pm.appendUserMessage("/plan an HTTP API for the ledger");
    await run();
    expect(loads).toBe(1);
    expect(prompts.join("\n")).toMatch(
      /Plan this feature into cards, each at most 3 files .*an HTTP API for the ledger/,
    );
  });
});
