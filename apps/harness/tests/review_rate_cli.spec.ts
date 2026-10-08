import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cardInReview, sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * The review rate (review-git §2.4.3, RG-S6-7; C2d finding, routed to C5),
 * through the built `sekhemet review` (`apps/harness/dist/index.js`): a
 * person's decisions read faster than 500 changed lines an hour are reported
 * beside the issue waiting on them, never refused. A real repository, a real
 * card worktree and the on-disk ledger; no model.
 */

describe("sekhemet review reports fast reviews, never refusing them (RG-S6-7)", () => {
  it("RG-S6-7: the decisions read faster than 500 changed lines an hour are named, with their rate, and the review still shows its commands", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const store = new CardStore(db, log);
      // Two earlier decisions by the person: one careful, one fast.
      for (const [id, lines, minutes] of [
        ["d_slow", 100, 30],
        ["d_fast", 1200, 30],
      ] as const) {
        await store.createCard({ id, tier: "story", title: `Done ${id}` });
        await log.append({
          actor: "human",
          type: "review/decided",
          cardId: id,
          payload: {
            id,
            principal: log.localPrincipal(),
            decision: "accept",
            linesReviewed: lines,
            minutes,
            acknowledgedFindings: [],
          },
          principal: log.localPrincipal(),
        });
      }
    } finally {
      db.close();
    }
    const r = sekhemet(["review"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("c1 — Card c1");
    expect(r.stdout).toMatch(
      /1 of 2 review decisions read faster than 500 changed lines an hour: d_fast \(2400 lines an hour\)\. Reported, not refused\./,
    );
    expect(r.stdout).toContain("sekhemet accept c1");
  }, 60_000);

  it("RG-S6-7: no line when no decision was that fast", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["review"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/faster than 500 changed lines an hour/);
  }, 60_000);
});
