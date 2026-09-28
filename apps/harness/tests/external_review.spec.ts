import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { intentFor } from "@sekhemet/sync";
import { REVIEW_DESK_COPY } from "@sekhemet/ui";
import { afterEach, describe, expect, it } from "vitest";
import {
  externalReviewerFor,
  isExternalReview,
  reviewTargetOf,
  runExternalReview,
  runExternalReviews,
} from "../src/external_review.js";
import { ledgerEvidenceSummary } from "../src/ledger_evidence.js";
import { applyWebhookIntent } from "../src/wave2_server.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repoWithPr(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "sek-xreview-"));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".gitignore"), ".sekhemet/\n");
  git("add", "a.ts", ".gitignore");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "contributor");
  writeFileSync(join(root, "b.ts"), "export const b = 2;\nexport const c = b as any;\n");
  git("add", "b.ts");
  git("commit", "-q", "-m", "someone else's change");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  return { root, head };
}

function ledger(root: string) {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  // The production board: entry conditions on, Review's evidence from the ledger.
  const board = new BoardServiceImpl(store, {
    entryConditions: true,
    evidenceFor: (id) => ledgerEvidenceSummary(store, root, id),
  });
  return { log, store, board };
}

describe("X15: external review cards", () => {
  it("PR review comments asking for /review become external review intents", () => {
    const onPr = intentFor("issue_comment", {
      action: "created",
      issue: {
        number: 7,
        title: "t",
        html_url: "https://github.com/o/r/pull/7",
        pull_request: { url: "x" },
      },
      comment: { id: 1, body: "please /review" },
    });
    expect(onPr).toMatchObject({ kind: "external_review", pr: 7, headSha: "" });
    const inline = intentFor("pull_request_review_comment", {
      action: "created",
      comment: { id: 2, body: "/review this again" },
      pull_request: { number: 8, html_url: "u", head: { sha: "abc1234" } },
    });
    expect(inline).toMatchObject({ kind: "external_review", pr: 8, headSha: "abc1234" });
  });

  it("checks out the PR, gates and reviews it, writes evidence, posts a review, never edits", async () => {
    const { root, head } = repoWithPr();
    const { store, log, board } = ledger(root);
    const id = await applyWebhookIntent(
      store,
      { kind: "external_review", pr: 7, headSha: head, url: "https://github.com/o/r/pull/7" },
      "d1",
    );
    const card = await store.getCard(id as string);
    if (!card) throw new Error("no card");
    expect(isExternalReview(card)).toBe(true);
    expect(reviewTargetOf(card)).toEqual({
      pr: 7,
      headSha: head,
      url: "https://github.com/o/r/pull/7",
    });

    const seenCwd: string[] = [];
    const posted: { method: string; path: string; body: unknown }[] = [];
    const reviewer = new MockInferenceAdapter("seshat", [
      {
        text: '{"criteria":[],"preferences":[{"n":1,"broken":true,"at":"b.ts:2","note":"`as any` breaks the no-any preference; type c as number."}]}', // review-git P8: the Reviewer's structured reply, a broken preference at its line.
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const r = await runExternalReview(root, card, {
      store,
      board,
      runGates: async (cwd) => {
        seenCwd.push(cwd);
        expect(readFileSync(join(cwd, "b.ts"), "utf8")).toContain("as any");
        // A misbehaving gate that writes into the checkout: the runner discards it.
        writeFileSync(join(cwd, "b.ts"), "tampered");
        return {
          passed: false,
          failures: [
            {
              rung: "typecheck",
              gate: "typecheck",
              exitCode: 2,
              errorExcerpt: "b.ts:2:18 - error TS7018: implicit any",
              suggestedFixFiles: ["b.ts"],
            },
          ],
          durationMs: 5,
          rungResults: [{ gate: "typecheck", rung: "typecheck", passed: false, durationMs: 5 }],
        };
      },
      reviewer: async () => reviewer,
      preferences: ["Never use any."],
      github: {
        client: {
          rest: async (method: string, path: string, body?: unknown) => {
            posted.push({ method, path, body });
            return { id: 99 };
          },
        },
        repo: { owner: "o", repo: "r" },
      },
    });
    expect(seenCwd[0]).not.toBe(root);
    expect(r.gatesPassed).toBe(false);
    expect(r.findings.map((f) => f.source)).toEqual(["gate", "reviewer"]);
    expect(r.discardedEdits).toBe(true);
    expect(existsSync(seenCwd[0] as string)).toBe(false);
    // The user's checkout is untouched.
    expect(existsSync(join(root, "b.ts"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(
      "",
    );
    const evidence = JSON.parse(readFileSync(join(root, r.evidencePath), "utf8"));
    expect(evidence).toMatchObject({ pr: 7, headSha: head, gatesPassed: false });
    expect(evidence.files).toEqual(["b.ts"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: "POST", path: "/repos/o/r/pulls/7/reviews" });
    const body = posted[0]?.body as {
      commit_id: string;
      event: string;
      comments: { path: string; line: number }[];
    };
    expect(body.commit_id).toBe(head);
    expect(body.event).toBe("COMMENT");
    // The gate's failure and the AI review's finding, each at its line.
    expect(body.comments).toEqual([
      expect.objectContaining({ path: "b.ts", line: 2 }),
      expect.objectContaining({ path: "b.ts", line: 2, body: expect.stringMatching(/as any/) }),
    ]);
    // K-S4-4: through the board, and a review whose gates failed never
    // enters Review; its run is an attempt on the ledger with its evidence.
    const after = await store.getCard(card.id);
    expect(after?.status).toBe("parked");
    const moves = (await store.cardEvents(card.id, ["card/status_changed"])).map(
      (e) => (e.payload as { toStatus: string }).toStatus,
    );
    expect(moves).toEqual(["in_progress", "verify", "parked"]);
    expect(store.runs.listAttempts(card.id)).toEqual([
      expect.objectContaining({ status: "failed", stopReason: "repair_exhausted" }),
    ]);
    const dossier = await store.getDossier(card.id);
    expect(dossier.reviews.some((e) => /as any/.test(e.text))).toBe(true);
    expect(await log.getEventsByTypes(["review/external"])).toHaveLength(1);
  });

  it("a PR head that cannot be resolved leaves the card where it is, with the reason", async () => {
    const { root } = repoWithPr();
    const { store, board } = ledger(root);
    const id = await applyWebhookIntent(
      store,
      { kind: "external_review", pr: 9, headSha: "", url: "u" },
      "d2",
    );
    const card = await store.getCard(id as string);
    if (!card) throw new Error("no card");
    const r = await runExternalReview(root, card, {
      store,
      board,
      runGates: async () => {
        throw new Error("must not run");
      },
    });
    expect(r.error).toMatch(/could not fetch PR #9/);
    // An environment failure parks nothing (kernel rule 27, K-N5-2); the reason is shown.
    expect((await store.getCard(card.id))?.status).toBe(card.status);
    expect((await store.getCard(card.id))?.blockedReason).toMatch(/could not fetch PR #9/);
  });

  it("the queue hook reviews external cards and hands only the rest to the Worker", async () => {
    const { root, head } = repoWithPr();
    const { store, board } = ledger(root);
    const id = await applyWebhookIntent(
      store,
      { kind: "external_review", pr: 3, headSha: head, url: "u" },
      "d3",
    );
    const worker = await store.createCard({ tier: "task", title: "normal card" });
    const ready = [
      (await store.getCard(id as string)) as NonNullable<Awaited<ReturnType<typeof store.getCard>>>,
      worker,
    ];
    const lines: string[] = [];
    const left = await runExternalReviews(root, ready, { store, board, say: (l) => lines.push(l) });
    expect(left.map((c) => c.id)).toEqual([worker.id]);
    expect(lines[0]).toMatch(/External review card_review3 \(PR #3\)/);
  });

  it("K-S4-4: a review whose gates pass enters Review through Verify, on its ledger evidence", async () => {
    const { root, head } = repoWithPr();
    const { store, board } = ledger(root);
    const id = await applyWebhookIntent(
      store,
      { kind: "external_review", pr: 5, headSha: head, url: "u" },
      "d5",
    );
    const card = await store.getCard(id as string);
    if (!card) throw new Error("no card");
    const r = await runExternalReview(root, card, {
      store,
      board,
      runGates: async () => ({
        passed: true,
        failures: [],
        durationMs: 1,
        rungResults: [{ gate: "test", rung: "test", passed: true, durationMs: 1 }],
      }),
    });
    expect(r.gatesPassed).toBe(true);
    expect((await store.getCard(card.id))?.status).toBe("review");
    const [ev] = store.runs.listEvidence(card.id);
    expect(ev).toMatchObject({ passed: true, path: r.evidencePath });
  });

  describe("the AI review of a pull request (RG-P8-10, -1)", () => {
    const passing = async () => ({
      passed: true,
      failures: [],
      durationMs: 1,
      rungResults: [{ gate: "test", rung: "test", passed: true, durationMs: 1 }],
    });
    async function reviewCardFor(n: number) {
      const { root, head } = repoWithPr();
      const { store, board } = ledger(root);
      const id = await applyWebhookIntent(
        store,
        { kind: "external_review", pr: n, headSha: head, url: "u" },
        `dx${n}`,
      );
      await store.updateCard(
        id as string,
        { acceptanceCriteria: ["b is exported as a number", "c keeps b's type"] },
        "harness",
      );
      const card = await store.getCard(id as string);
      if (!card) throw new Error("no card");
      return { root, store, board, card };
    }

    it("posts no inline comment at a line the model never cited", async () => {
      const { root, store, board, card } = await reviewCardFor(41);
      const posted: { body: unknown }[] = [];
      // The model skips criterion 2: its finding is unclear with no citation.
      const reviewer = new MockInferenceAdapter("gemma-4-26b", [
        {
          text: '{"criteria":[{"n":1,"verdict":"unmet","at":"b.ts:2","note":"c is typed any."}]}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        },
      ]);
      const r = await runExternalReview(root, card, {
        store,
        board,
        runGates: passing,
        reviewer: async () => reviewer,
        github: {
          client: {
            rest: async (_m: string, _p: string, body?: unknown) => {
              posted.push({ body });
              return {};
            },
          },
          repo: { owner: "o", repo: "r" },
        },
      });
      const reviewerFindings = r.findings.filter((f) => f.source === "reviewer");
      expect(reviewerFindings).toHaveLength(2);
      expect(reviewerFindings[0]).toMatchObject({ path: "b.ts", line: 2 });
      expect(reviewerFindings[1]?.path).toBeUndefined();
      const comments = (posted[0]?.body as { comments: { path: string; line: number }[] }).comments;
      expect(comments).toEqual([expect.objectContaining({ path: "b.ts", line: 2 })]);
    });

    it("with the Review role unfilled, runs no AI review and says why on the issue", async () => {
      const { root, store, board, card } = await reviewCardFor(42);
      const r = await runExternalReview(root, card, {
        store,
        board,
        runGates: passing,
        notReviewed: REVIEW_DESK_COPY.noReviewer,
      });
      expect(r.error).toBeUndefined();
      expect((await store.getCard(card.id))?.status).toBe("review");
      expect((await store.getDossier(card.id)).reviews).toEqual([
        expect.objectContaining({ verdict: "not_reviewed", text: REVIEW_DESK_COPY.noReviewer }),
      ]);
    });

    it("a Review model that cannot be loaded parks nothing: the issue reaches Review saying so", async () => {
      const { root, store, board, card } = await reviewCardFor(43);
      const r = await runExternalReview(root, card, {
        store,
        board,
        runGates: passing,
        reviewer: async () => {
          throw new Error("No model is assigned to the reviewer role");
        },
      });
      expect(r.error).toBeUndefined();
      expect((await store.getCard(card.id))?.status).toBe("review");
      expect((await store.getDossier(card.id)).reviews).toEqual([
        expect.objectContaining({
          verdict: "not_reviewed",
          text: REVIEW_DESK_COPY.reviewFailed("No model is assigned to the reviewer role"),
        }),
      ]);
    });

    it("takes its Review model from the run's Review role, never the Coding model's family", async () => {
      const asked: string[] = [];
      const access = {
        queuedModel: (queue: string) => {
          asked.push(queue);
          return {
            model: async () => new MockInferenceAdapter("gemma-4-26b", []) as never,
            release: async () => undefined,
          };
        },
      };
      const unfilled = externalReviewerFor(
        { state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer },
        access,
      );
      expect(unfilled.reviewer).toBeUndefined();
      expect(unfilled.notReviewed).toBe(REVIEW_DESK_COPY.noReviewer);
      expect(asked).toEqual([]);
      const onPlanner = externalReviewerFor(
        { state: "filled", model: "gemma-4-26b", queue: "manager" },
        access,
      );
      expect(onPlanner.notReviewed).toBeUndefined();
      expect((await onPlanner.reviewer?.())?.modelId).toBe("gemma-4-26b");
      expect(asked).toEqual(["manager"]);
    });
  });

  it("K-N3-4: a pull_request closed webhook merges an accepted card to Done, or returns it to Review", async () => {
    const { store, board } = ledger(mkdtempSync(join(tmpdir(), "sek-prclosed-")));
    for (const [id, pr] of [
      ["card_m", 31],
      ["card_c", 32],
    ] as const) {
      await store.createCard({ id, tier: "task", title: id });
      await store.updateCardStatus(id, "review", "test setup", "harness", { override: true });
      await board.acceptWithPullRequest(
        id,
        { pr, url: `https://github.com/o/r/pull/${pr}`, headSha: "abc" },
        "p_owner",
      );
    }
    // Matched by repository and number (integrations M3).
    const closed = (pr: number, merged: boolean) =>
      intentFor("pull_request", {
        action: "closed",
        pull_request: {
          number: pr,
          html_url: `https://github.com/o/r/pull/${pr}`,
          head: { sha: "abc" },
          merged,
        },
        repository: { full_name: "o/r" },
      });
    expect(closed(31, true)).toEqual({
      kind: "pull_request_closed",
      pr: 31,
      merged: true,
      repo: "o/r",
    });
    expect(await applyWebhookIntent(store, closed(31, true), "d31")).toBe("card_m");
    expect(await store.getCard("card_m")).toMatchObject({ status: "done", accepter: "p_owner" });
    expect(await applyWebhookIntent(store, closed(32, false), "d32")).toBe("card_c");
    const back = await store.getCard("card_c");
    expect(back?.status).toBe("review");
    expect(back?.hold).toBeUndefined();
    expect(back?.accepter).toBeUndefined();
  });
});
