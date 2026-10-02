import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routeFrontDoor } from "../src/cli_commands.js";
import { initLocalKernel, main } from "../src/index.js";

/**
 * The design's command-surface rule: every action reachable from the board is
 * reachable from the command line, with its undo. The board could send a card
 * back and park it; the CLI could not.
 */
describe("triage from the command line", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function withCard(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "triage-"));
    dirs.push(repo);
    const { db, cardStore } = initLocalKernel(repo);
    await cardStore.createCard({ id: "card_t", tier: "story", title: "T", scopeFiles: ["a.ts"] });
    db.close();
    return repo;
  }

  const status = (repo: string): Promise<string | undefined> => {
    const { db, cardStore } = initLocalKernel(repo);
    return cardStore.getCard("card_t").then((c) => {
      db.close();
      return c?.status;
    });
  };

  it("parks a card and unparks it", async () => {
    const repo = await withCard();
    await main(["park", "card_t", "waiting on the API", "--repo", repo]);
    expect(await status(repo)).toBe("parked");
    await main(["unpark", "card_t", "--repo", repo]);
    expect(await status(repo)).toBe("ready");
  });

  it("sends a card back with its reason, which becomes a playbook candidate", async () => {
    const repo = await withCard();
    await main(["park", "card_t", "--repo", repo]);
    // RG-P8-15: a note naming a file (a symbol, a check or an error) is a candidate.
    await main([
      "send-back",
      "card_t",
      "use",
      "the",
      "parser",
      "in",
      "src/parse.ts",
      "--repo",
      repo,
    ]);
    expect(await status(repo)).toBe("ready");
    // K-S7-6: the candidate is a ledger event, and no side file is written.
    expect(existsSync(join(repo, ".sekhemet", "playbook_candidates.jsonl"))).toBe(false);
    const { db, log } = initLocalKernel(repo);
    const candidates = await log.getEventsByTypes(["playbook/candidate"]);
    db.close();
    // The note is free text: the private part, not the hashed payload (K-S7-9).
    expect(candidates.map((e) => e.payload)).toEqual([{ cardId: "card_t" }]);
    expect(candidates.map((e) => e.private)).toEqual([
      { reason: "use the parser in src/parse.ts" },
    ]);
  });

  it("K-S4-7: every state has a command-line exit to Ready — unpark for Parked, reopen for Rejected", async () => {
    expect(routeFrontDoor(["unpark", "card_t"])).toMatchObject({ kind: "unpark" });
    expect(routeFrontDoor(["reopen", "card_t"])).toMatchObject({ kind: "reopen" });
    const repo = await withCard();
    const { db, boardService } = initLocalKernel(repo);
    await boardService.transitionCard({
      cardId: "card_t",
      fromStatus: "ready",
      toStatus: "rejected",
      actor: "human",
      reason: "not now",
    });
    db.close();
    await main(["reopen", "card_t", "--repo", repo]);
    expect(await status(repo)).toBe("ready");
  });

  it("K-N5-6: unpark returns a card to Backlog or Planning when it was parked from there, else Ready", async () => {
    const repo = await withCard();
    const { db, boardService } = initLocalKernel(repo);
    await boardService.transitionCard({
      cardId: "card_t",
      fromStatus: "ready",
      toStatus: "backlog",
      actor: "human",
      reason: "later",
    });
    db.close();
    await main(["park", "card_t", "--repo", repo]);
    await main(["unpark", "card_t", "--repo", repo]);
    expect(await status(repo)).toBe("backlog");
  });

  it("refuses a send-back without a reason", async () => {
    const repo = await withCard();
    await main(["send-back", "card_t", "--repo", repo]);
    expect(process.exitCode).toBe(2);
    expect(await status(repo)).not.toBe("parked");
  });
});
