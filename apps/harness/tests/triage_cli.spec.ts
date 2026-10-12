import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  /** A card held in Planning, as a plan without a model leaves it (To do on the board). */
  async function inPlanning(): Promise<string> {
    const repo = await withCard();
    const { db, cardStore } = initLocalKernel(repo);
    await cardStore.createCard({
      id: "card_p",
      tier: "story",
      title: "Held",
      scopeFiles: ["b.ts"],
      status: "planning",
    });
    db.close();
    return repo;
  }
  const statusOf = async (repo: string, id: string): Promise<string | undefined> => {
    const { db, cardStore } = initLocalKernel(repo);
    const c = await cardStore.getCard(id);
    db.close();
    return c?.status;
  };
  /** What `main` writes to stderr, and whether it threw past the refusal. */
  async function stderrOf(argv: string[]): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await main(argv);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("S1B-B21: reject takes an issue from To do, held in Planning too (review-git §2.4: Review, Parked, Ready, Planning, Backlog)", async () => {
    const repo = await inPlanning();
    await main(["reject", "card_p", "out of scope", "--repo", repo]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(await statusOf(repo, "card_p")).toBe("rejected");
    // Its undo still puts it in Ready (RG-S5-11).
    await main(["reopen", "card_p", "--repo", repo]);
    expect(await statusOf(repo, "card_p")).toBe("ready");
  });

  it("S1B-B19: a triage verb refused by the issue's state is one `sekhemet:` line and a Do: line, exit 1 — never the crash line", async () => {
    const repo = await inPlanning();
    const out = await stderrOf(["request-changes", "card_p", "fix it", "--repo", repo]);
    expect(out).toMatch(
      /^sekhemet: card_p is To do; request changes on an issue In review or On hold/m,
    );
    expect(out).toMatch(/^ {2}Do: sekhemet approve card_p/m);
    expect(out).not.toMatch(/sekhemet stopped|details are in/);
    expect(process.exitCode).toBe(1);
    expect(await statusOf(repo, "card_p")).toBe("planning");
    process.exitCode = undefined;
    const unpark = await stderrOf(["unpark", "card_t", "--repo", repo]);
    expect(unpark).toMatch(/^sekhemet: card_t is not On hold \(it is To do\)/m);
    expect(unpark).not.toMatch(/sekhemet stopped/);
    expect(process.exitCode).toBe(1);
  });

  it("S1B-B19: park on a Won't do or Done issue, and revert on one not Done, are refusals with a Do: line — never the crash line", async () => {
    const repo = await inPlanning();
    await main(["reject", "card_p", "out of scope", "--repo", repo]);
    expect(process.exitCode ?? 0).toBe(0);
    const parkRejected = await stderrOf(["park", "card_p", "x", "--repo", repo]);
    expect(parkRejected).toMatch(
      /^sekhemet: card_p is Won't do; an issue is put on hold from Backlog, To do, In progress or In review$/m,
    );
    expect(parkRejected).toMatch(/^ {2}Do: sekhemet reopen card_p$/m);
    expect(parkRejected).not.toMatch(/sekhemet stopped|details are in/);
    expect(process.exitCode).toBe(1);
    expect(await statusOf(repo, "card_p")).toBe("rejected");
    process.exitCode = undefined;

    const { db, cardStore } = initLocalKernel(repo);
    await cardStore.createCard({
      id: "card_d",
      tier: "story",
      title: "Done",
      scopeFiles: ["c.ts"],
    });
    // A Done issue as a fixture (full_text_search.spec does the same): reaching
    // Done by the transition law needs a run, its gates and an accept.
    db.prepare("UPDATE cards SET status = 'done' WHERE id = ?").run("card_d");
    db.close();
    const parkDone = await stderrOf(["park", "card_d", "x", "--repo", repo]);
    expect(parkDone).toMatch(/^sekhemet: card_d is Done; an issue is put on hold from /m);
    expect(parkDone).toMatch(/^ {2}Do: to undo its accept: sekhemet revert card_d$/m);
    expect(parkDone).not.toMatch(/sekhemet stopped|details are in/);
    expect(process.exitCode).toBe(1);
    expect(await statusOf(repo, "card_d")).toBe("done");
    process.exitCode = undefined;

    const revert = await stderrOf(["revert", "card_t", "x", "--repo", repo]);
    expect(revert).toMatch(
      /^sekhemet: card_t is not Done \(it is To do\); only an accepted issue is reverted$/m,
    );
    expect(revert).toMatch(/^ {2}Do: sekhemet run card_t/m);
    expect(revert).not.toMatch(/sekhemet stopped|details are in/);
    expect(process.exitCode).toBe(1);
    expect(await statusOf(repo, "card_t")).toBe("ready");
  });

  it("loop wave 10 A2: Undo of a Done issue Sekhemet did not merge is no loop — revert says why and a step that moves on", async () => {
    const repo = await withCard();
    const { db, cardStore, boardService } = initLocalKernel(repo);
    // Done through its pull request, merged on the hosting service (rule 24, K-N3-4).
    await cardStore.createCard({ id: "card_pr", tier: "story", title: "PR", scopeFiles: ["p.ts"] });
    db.prepare("UPDATE cards SET status = 'review' WHERE id = ?").run("card_pr");
    const url = "https://github.com/o/r/pull/7";
    const principal = cardStore.localPrincipal();
    await boardService.acceptWithPullRequest(
      "card_pr",
      { pr: 7, url, headSha: "a".repeat(40) },
      principal,
      "harness",
      [
        {
          type: "card/accepted",
          actor: "human",
          principal,
          payload: { id: "card_pr", pr: url, principal },
        },
      ],
    );
    await boardService.closePullRequest("card_pr", {
      pr: 7,
      merged: true,
      mergeCommit: "b".repeat(40),
    });
    // Done with no Accept on its Activity log (a fixture, as above).
    await cardStore.createCard({ id: "card_n", tier: "story", title: "N", scopeFiles: ["n.ts"] });
    db.prepare("UPDATE cards SET status = 'done' WHERE id = ?").run("card_n");
    db.close();
    expect(await statusOf(repo, "card_pr")).toBe("done");

    // Reopen points at revert, the one undo of a Done issue (review-git §2.4).
    const reopened = await stderrOf(["reopen", "card_pr", "--repo", repo]);
    expect(reopened).toMatch(/^ {2}Do: to undo its accept: sekhemet revert card_pr$/m);
    process.exitCode = undefined;

    const pr = await stderrOf(["revert", "card_pr", "--repo", repo]);
    expect(pr).toMatch(
      /^sekhemet: card_pr was accepted through its pull request https:\/\/github\.com\/o\/r\/pull\/7, merged as bbbbbbbbbb; Sekhemet has no squash of its own to revert$/m,
    );
    expect(pr).toMatch(
      /^ {2}Do: revert that merge where the pull request lives \(git revert -m 1 bbbbbbbbbb\), then plan the work again: sekhemet plan "<what to change>"$/m,
    );
    expect(pr).not.toMatch(/sekhemet stopped|details are in|sekhemet (revert|reopen) card_pr/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const none = await stderrOf(["revert", "card_n", "--repo", repo]);
    expect(none).toMatch(
      /^sekhemet: card_n is Done with no Accept on its Activity log, so Sekhemet merged nothing of it to revert$/m,
    );
    expect(none).toMatch(
      /^ {2}Do: to do the work again, plan it: sekhemet plan "<what to change>"$/m,
    );
    expect(none).not.toMatch(/sekhemet stopped|details are in|sekhemet (revert|reopen) card_n/);
    expect(process.exitCode).toBe(1);
    expect(await statusOf(repo, "card_n")).toBe("done");
  });

  it("loop wave 10 A4, dashboard §2.13 item 13: an issue In review with no attempt offers neither Accept nor Request changes, in the CLI as on the dashboard", async () => {
    const repo = await withCard();
    const { db } = initLocalKernel(repo);
    // In review with no evidence (a fixture: the transition law reaches Review only from Verify).
    db.prepare("UPDATE cards SET status = 'review' WHERE id = ?").run("card_t");
    db.close();
    const changes = await stderrOf([
      "request-changes",
      "card_t",
      "fix the rounding",
      "--repo",
      repo,
    ]);
    expect(changes).toMatch(
      /^sekhemet: card_t is In review with no attempt yet, so there is no work to request changes on$/m,
    );
    expect(changes).toMatch(
      /^ {2}Do: sekhemet park card_t "<why>", then sekhemet unpark card_t puts it in Ready to run$/m,
    );
    expect(changes).not.toMatch(/sekhemet stopped|details are in/);
    expect(process.exitCode).toBe(1);
    expect(await status(repo)).toBe("review");
    process.exitCode = undefined;
    const accept = await stderrOf(["accept", "card_t", "--repo", repo]);
    expect(accept).toMatch(/no checks recorded/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // Put on hold is the one decision offered, and it is taken.
    await main(["park", "card_t", "not run yet", "--repo", repo]);
    expect(await status(repo)).toBe("parked");
  });

  it("S1B-B19: Accept on an issue not In review names the step that brings it there", async () => {
    const repo = await inPlanning();
    const out = await stderrOf(["accept", "card_p", "--repo", repo]);
    expect(out).toMatch(
      /^sekhemet: Issue card_p is To do\. Only an issue In review can be accepted\.$/m,
    );
    expect(out).toMatch(/^ {2}Do: sekhemet approve card_p/m);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const ready = await stderrOf(["accept", "card_t", "--repo", repo]);
    expect(ready).toMatch(/^ {2}Do: sekhemet run card_t/m);
  });

  it("S1B-B19: an unknown issue is one line and a hint: the closest ID, or where the IDs are listed", async () => {
    const repo = await withCard();
    const near = await stderrOf(["park", "card_u", "--repo", repo]);
    expect(near).toMatch(/^sekhemet: no issue card_u\. Did you mean card_t\?$/m);
    expect(near).toMatch(/^ {2}Do: sekhemet status lists every issue with its ID$/m);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const far = await stderrOf(["reject", "zzzzzzzz", "why", "--repo", repo]);
    expect(far).toMatch(/^sekhemet: no issue zzzzzzzz$/m);
    expect(far).toMatch(/^ {2}Do: sekhemet status lists every issue with its ID$/m);
  });

  it("refuses a send-back without a reason", async () => {
    const repo = await withCard();
    await main(["send-back", "card_t", "--repo", repo]);
    expect(process.exitCode).toBe(2);
    expect(await status(repo)).not.toBe("parked");
  });
});
