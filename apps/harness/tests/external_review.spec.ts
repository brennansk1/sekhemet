import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { intentFor } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import {
  isExternalReview,
  reviewTargetOf,
  runExternalReview,
  runExternalReviews,
} from "../src/external_review.js";
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

function ledger() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
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
    const { store, log } = ledger();
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
        text: '{"findings":[{"severity":"likely_send_back","note":"b.ts: `as any` breaks the no-any preference; type c as number."}]}',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const r = await runExternalReview(root, card, {
      store,
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
    expect(body.comments).toEqual([expect.objectContaining({ path: "b.ts", line: 2 })]);
    const after = await store.getCard(card.id);
    expect(after?.status).toBe("review");
    const dossier = await store.getDossier(card.id);
    expect(dossier.reviews.some((e) => /as any/.test(e.text))).toBe(true);
    expect(await log.getEventsByTypes(["review/external"])).toHaveLength(1);
  });

  it("a PR head that cannot be resolved parks the card with the reason", async () => {
    const { root } = repoWithPr();
    const { store } = ledger();
    const id = await applyWebhookIntent(
      store,
      { kind: "external_review", pr: 9, headSha: "", url: "u" },
      "d2",
    );
    const card = await store.getCard(id as string);
    if (!card) throw new Error("no card");
    const r = await runExternalReview(root, card, {
      store,
      runGates: async () => {
        throw new Error("must not run");
      },
    });
    expect(r.error).toMatch(/could not fetch PR #9/);
    expect((await store.getCard(card.id))?.status).toBe("parked");
  });

  it("the queue hook reviews external cards and hands only the rest to the Worker", async () => {
    const { root, head } = repoWithPr();
    const { store } = ledger();
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
    const left = await runExternalReviews(root, ready, { store, say: (l) => lines.push(l) });
    expect(left.map((c) => c.id)).toEqual([worker.id]);
    expect(lines[0]).toMatch(/External review card_review3 \(PR #3\)/);
  });
});
