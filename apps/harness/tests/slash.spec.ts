import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { beforeEach, describe, expect, it } from "vitest";
import type { Audience } from "../src/pm/audience.js";
import { answerQueued } from "../src/pm/service.js";
import { parseSlash, runSlash } from "../src/pm/slash.js";
import { PmStore } from "../src/pm/store.js";

describe("slash commands in Seshat's chat (H16)", () => {
  let cards: CardStore;
  let pm: PmStore;
  let log: EventLog;
  let board: BoardServiceImpl;
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
      board,
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
    board = new BoardServiceImpl(cards, { entryConditions: true });
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
    // STA-01: Status's forecast words, with the open issues it counts.
    expect(replies[1]).toMatch(/^\d+ open issues?\. Forecast: /);
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
    expect((await lastReply())?.text).toMatch(/No issue matches "nosuchcard"/);
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
    expect((await lastReply())?.text).toMatch(/No Research model is configured/);
  });

  it("PM-P1-1: /plan runs the one planner, not a free-form request to Seshat", async () => {
    await pm.appendUserMessage("/plan an HTTP API for the ledger");
    await run();
    // No Planner model given: the heuristic plans, loading nothing, and says so.
    expect(loads).toBe(0);
    expect(prompts).toEqual([]);
    expect((await lastReply())?.text).toMatch(/^Planned without a model|Planned without a model/m);
  });

  describe("PM-N9-8: slash commands are scoped by the audience; a hidden card reads as missing", () => {
    const ASKER = "p_asker";
    let audience: Audience;

    beforeEach(async () => {
      // A second project's card, hidden from the asker (only "proj_visible" is theirs).
      await cards.createCard({
        id: "card_secret_widget",
        tier: "task",
        title: "Widget",
        status: "backlog",
        projectId: "proj_hidden",
        acceptanceCriteria: ["builds a widget"],
      });
      await cards.updateCard("card_chron_hasher", { projectId: "proj_visible" }, "human");
      audience = {
        setup: "team",
        nameOf: () => undefined,
        levelOf: () => "member",
        canSee: (_p, project) => project === "proj_visible",
        leadOf: () => undefined,
      };
    });

    it("/forecast and /capability count only the asker's visible cards", async () => {
      const all = await runSlash(
        { name: "forecast", args: "" },
        { cardStore: cards, board, pmStore: pm, repoPath: repo },
      );
      expect(all).toMatchObject({ reply: expect.stringMatching(/^2 open/) });
      const scoped = await runSlash(
        { name: "forecast", args: "" },
        { cardStore: cards, board, pmStore: pm, repoPath: repo, audience, asker: ASKER },
      );
      expect(scoped).toMatchObject({ reply: expect.stringMatching(/^1 open/) });
    });

    it("/ready, /park and /backlog cannot resolve a card the asker cannot see", async () => {
      const hidden = await runSlash(
        { name: "ready", args: "secret_widget" },
        { cardStore: cards, board, pmStore: pm, repoPath: repo, audience, asker: ASKER },
      );
      expect(hidden).toEqual({ reply: 'No issue matches "secret_widget".' });
      expect((await cards.getCard("card_secret_widget"))?.status).toBe("backlog");
      const visible = await runSlash(
        { name: "ready", args: "hasher" },
        { cardStore: cards, board, pmStore: pm, repoPath: repo, audience, asker: ASKER },
      );
      expect(visible).toEqual({ reply: "Moved card_chron_hasher to To do." });
    });

    it("TEAM-40, TEAM-6: /ready is checked at the named card's own project level, not the workspace one", async () => {
      // A Viewer workspace-wide, raised to Member on proj_visible only.
      const perProject: Audience = {
        setup: "team",
        nameOf: () => undefined,
        levelOf: (_p, project) => (project === "proj_visible" ? "member" : "viewer"),
        canSee: () => true,
        leadOf: () => undefined,
      };
      await EventLog.actingFor(ASKER, () => pm.appendUserMessage("/ready hasher"));
      await run({ audience: perProject });
      expect((await cards.getCard("card_chron_hasher"))?.status).toBe("ready");
      // A card on a project where the override does not reach: refused.
      await cards.createCard({
        id: "card_other_widget",
        tier: "task",
        title: "Other widget",
        status: "backlog",
        projectId: "proj_hidden",
        acceptanceCriteria: ["builds a widget"],
      });
      await EventLog.actingFor(ASKER, () => pm.appendUserMessage("/ready other_widget"));
      await run({ audience: perProject });
      expect((await lastReply())?.text).toMatch(/a Member can run \/ready/);
      expect((await cards.getCard("card_other_widget"))?.status).toBe("backlog");
    });
  });
});
