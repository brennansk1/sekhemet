import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    await main(["send-back", "card_t", "use", "the", "shared", "parser", "--repo", repo]);
    expect(await status(repo)).toBe("ready");
    const candidates = readFileSync(join(repo, ".sekhemet", "playbook_candidates.jsonl"), "utf8");
    expect(candidates).toContain("use the shared parser");
  });

  it("refuses a send-back without a reason", async () => {
    const repo = await withCard();
    await main(["send-back", "card_t", "--repo", repo]);
    expect(process.exitCode).toBe(2);
    expect(await status(repo)).not.toBe("parked");
  });
});
