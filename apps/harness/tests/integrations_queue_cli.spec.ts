import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import { describe, expect, it, vi } from "vitest";
import { PR_EVENT } from "../src/github_sync.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";
import { type FakeGitHub, fakeGh, fakeGitHub, isGraphqlRead } from "./support/g3_github.js";
import { slowWorkerPreload } from "./support/g3_slow_worker.js";

/**
 * GitHub through `sekhemet queue` (integrations P9 items 10-12, INT-12b,
 * INT-16a, INT-16; FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): the
 * built binary spawned in a real repository, its prelude advancing the open
 * pull requests and its dependency-bot verifications running the project's
 * own gates, before any card reaches the Worker. GitHub is
 * `support/g3_github.ts`'s local fake reached as a GitHub Enterprise Server
 * through a fake `gh` login; the Coding model is a scripted stand-in
 * qualified for this host. No model is loaded and nothing leaves the machine.
 */

const FINISH: Turn[] = [[{ name: "finish_card", arguments: { summary: "done" } }]];
const HEAD = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";

interface World {
  p: G2Project;
  api: FakeGitHub;
}

async function world(
  seed: (store: CardStore, log: EventLog, repo: string) => Promise<void>,
  files: Record<string, string> = {},
): Promise<World> {
  const api = await fakeGitHub();
  const where = g2Dirs();
  const p = await g2Project(where, {
    files: {
      "package.json": JSON.stringify({ name: "app", version: "0.1.0" }),
      "src/a.ts": "",
      ...files,
    },
    cards: [],
    seed: (store, log) => seed(store, log, where.cwd),
  });
  // The GitHub repository is read from the remote locally, never asked of `gh`.
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: p.repo });
  return { p, api };
}

/** `sekhemet queue` with GitHub reached through the fake `gh` login. */
async function queue(w: World, worker: Turn[] = FINISH) {
  const bin = fakeGh(join(w.p.home, "gh-bin"));
  const r = await cli(["queue", "--worker", SCRIPTED_MODEL], {
    cwd: w.p.repo,
    preload: w.p.preload,
    env: {
      ...w.p.env,
      ...scriptEnv(w.p.record, { worker }),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_TOKEN: "gho_fake",
      SEKHEMET_GITHUB_HOST: w.api.url,
    },
    timeoutMs: 180_000,
  });
  return { status: r.status, out: r.stdout + r.stderr, rows: ledgerRows(w.p.repo) };
}

/** A card accepted with PR-on-accept: in Review, its draft pull request #5 recorded as Accept records it. */
async function awaitingMerge(store: CardStore, repo: string, id = "p7"): Promise<void> {
  await store.createCard({
    id,
    tier: "story",
    title: `Card ${id}`,
    status: "ready",
    scopeFiles: ["src/**"],
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  await store.recordEvent({
    type: PR_EVENT,
    cardId: id,
    actor: "harness",
    payload: {
      number: 5,
      nodeId: "PR_5",
      url: "https://github.com/o/r/pull/5",
      headSha: HEAD,
      repo: { owner: "o", repo: "r" },
    },
  });
  // The card's verified run, on the ledger as the runner records it, and its changed files.
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  const body = JSON.stringify({
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    filesTouched: ["src/b.ts"],
  });
  writeFileSync(join(repo, ".sekhemet", "evidence", `ev_${id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "nail",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: `ev_${id}`,
    path: join(".sekhemet", "evidence", `ev_${id}.json`),
    body,
    filesTouched: ["src/b.ts"],
  });
  writeFileSync(
    join(repo, ".sekhemet", "evidence", `latest-${id}.json`),
    JSON.stringify({
      id: `ev_${id}`,
      cardId: id,
      passed: true,
      diff: "+++ b/src/b.ts\n+export const b = 2;\n",
    }),
  );
}

/** One Ready issue, so the pass runs (the queue's prelude runs when there is one). */
const nextIssue = (store: CardStore) =>
  store.createCard({
    id: "next",
    tier: "story",
    title: "Next issue",
    status: "ready",
    scopeFiles: ["src/next.ts"],
    acceptanceCriteria: ["works"],
  });

const graphqlWrites = (api: FakeGitHub, name: RegExp) =>
  api.seen.filter(
    (s) =>
      s.url === "/api/graphql" &&
      !isGraphqlRead(s) &&
      name.test(String((s.body as { query?: string }).query)),
  );
describe("sekhemet queue advances the open pull requests", () => {
  it(
    "INT-12b: once every check run on the pull request succeeds, the draft is marked ready for review and the reviewers CODEOWNERS names for its changed files are requested",
    { timeout: 240_000 },
    async () => {
      const w = await world(
        async (store, _log, repo) => {
          await awaitingMerge(store, repo);
          await nextIssue(store);
        },
        { ".github/CODEOWNERS": "/src/ @alice-gh @octo-org/reviewers\n" },
      );
      w.api.prHeads.set(5, HEAD);
      const r = await queue(w);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/PR #5: ready/);
      expect(graphqlWrites(w.api, /markPullRequestReadyForReview/)).toHaveLength(1);
      expect(w.api.seen.find((s) => s.url.endsWith("/pulls/5/requested_reviewers"))?.body).toEqual({
        reviewers: ["alice-gh"],
        team_reviewers: ["reviewers"],
      });
      expect(r.rows.filter((x) => x.type === "github/pr_advanced").map((x) => x.payload)).toEqual([
        { number: 5, state: "ready" },
      ]);
    },
  );
});

describe("sekhemet queue verifies a dependency bot's pull request", () => {
  /** The bot's branch, here, with its head; and the card its signed webhook made. */
  async function dependabot(store: CardStore, repo: string): Promise<string> {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "dependabot/npm/left-pad-2");
    writeFileSync(
      join(repo, "package.json"),
      '{ "name": "app", "dependencies": { "left-pad": "2.0.0" } }\n',
    );
    git("add", "package.json");
    git("commit", "-q", "-m", "Bump left-pad");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    await store.createCard({
      id: "card_deps9",
      tier: "task",
      title: "Verify dependabot[bot] PR #9",
      status: "ready",
      spec: `Run the full checks against PR #9 at ${head} and report.`,
      labels: ["dependency-update"],
      externalRef: { system: "github", id: "pr/9", url: "https://github.com/o/r/pull/9" },
    });
    return head;
  }

  it(
    "INT-16a: every gate passes on the pull request's head and the project's policy allows it: auto-merge is enabled at that head, and the Worker never sees it",
    { timeout: 240_000 },
    async () => {
      let head = "";
      const w = await world(
        async (store, _log, repo) => {
          head = await dependabot(store, repo);
        },
        { ".sekhemet/config.toml": "[review]\nauto_merge_dependencies = true\n" },
      );
      w.api.prHeads.set(9, head);
      const r = await queue(w, []);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Dependency PR #9: all checks passed; auto-merge enabled/);
      const merge = graphqlWrites(w.api, /enablePullRequestAutoMerge/);
      expect(merge).toHaveLength(1);
      expect((merge[0]?.body as { variables: unknown }).variables).toMatchObject({
        id: "PR_9",
        head,
      });
      const [verified] = r.rows.filter((x) => x.type === "github/dependency_verified");
      expect(verified?.payload).toMatchObject({
        pr: 9,
        headSha: head,
        passed: true,
        autoMerge: "enabled",
      });
      // The Worker was never asked.
      const { recorded } = await import("./support/g2_model.js");
      expect(recorded(w.p.record).filter((x) => x.role === "worker")).toEqual([]);
    },
  );

  it(
    "INT-16: every gate passes but the project does not allow auto-merge: it waits in Review for a person",
    { timeout: 240_000 },
    async () => {
      let head = "";
      const w = await world(async (store, _log, repo) => {
        head = await dependabot(store, repo);
      });
      w.api.prHeads.set(9, head);
      const r = await queue(w, []);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Dependency PR #9: all checks passed; left for a person/);
      expect(graphqlWrites(w.api, /enablePullRequestAutoMerge/)).toEqual([]);
      const [verified] = r.rows.filter((x) => x.type === "github/dependency_verified");
      expect(verified?.payload).toMatchObject({ passed: true, autoMerge: "not_allowed" });
      const moves = r.rows
        .filter((x) => x.type === "card/status_changed" && x.cardId === "card_deps9")
        .map((x) => x.payload.toStatus);
      expect(moves.at(-1)).toBe("review");
    },
  );
});

describe("a scope edit on the tracker while the card runs (INT-11a)", () => {
  it(
    "INT-11a: recorded on the card, the Agent neither stopped nor paused, and at the card's end the card goes to Planning naming the changed field instead of to Review",
    { timeout: 300_000 },
    async () => {
      const api = await fakeGitHub();
      api.edit(6, { title: "Fix A", body: "Touch src/a.ts" });
      const where = g2Dirs();
      const p = await g2Project(where, {
        files: {
          "package.json": JSON.stringify({ name: "app", version: "0.1.0" }),
          "src/a.ts": "",
        },
        cards: [],
      });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
        cwd: p.repo,
      });
      const bin = fakeGh(join(p.home, "gh-bin"));
      const gh = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_GH_TOKEN: "gho_fake",
        SEKHEMET_GITHUB_HOST: api.url,
        SEKHEMET_CONFIG_DIR: p.env.SEKHEMET_CONFIG_DIR as string,
        SEKHEMET_USER_CONFIG: p.env.SEKHEMET_USER_CONFIG as string,
        SEKHEMET_KEYCHAIN: "off",
      };
      for (const [k, v] of Object.entries(gh)) vi.stubEnv(k, v);
      const { db, log } = openLocalLedger(p.repo);
      const store = new CardStore(db, log);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(store),
        cardStore: store,
        repoPath: p.repo,
        port: 0,
        streamIntervalMs: 10_000,
        pressureLevel: () => 1,
      });
      const base = `http://127.0.0.1:${server.port}`;
      const sync = async () => {
        const r = await fetch(`${base}/api/integrations/github/sync`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
          body: JSON.stringify({ direction: "pull" }),
        });
        expect(r.status).toBe(200);
        expect(((await r.json()) as { errors: string[] }).errors).toEqual([]);
      };
      try {
        // The issue is a card on the board, Ready to run.
        await sync();
        const card = (await store.listCards()).find((c) => c.externalRef?.id === "o/r#6");
        const id = card?.id as string;
        await store.updateCard(id, { scopeFiles: ["src/a.ts"], acceptanceCriteria: ["works"] });
        await store.updateCardStatus(id, "ready", "planned", "human", { override: true });
        // The queue runs it; the Agent takes its time with its first answer.
        const preload = slowWorkerPreload(p.home, p.preload);
        const running = cli(["queue", "--worker", SCRIPTED_MODEL], {
          cwd: p.repo,
          preload,
          env: {
            ...p.env,
            ...scriptEnv(p.record, { worker: FINISH }),
            ...gh,
            G3_WORKER_DELAY_MS: "6000",
          },
          timeoutMs: 180_000,
        });
        await vi.waitFor(
          async () => expect((await store.getCard(id))?.status).toBe("in_progress"),
          {
            timeout: 60_000,
            interval: 200,
          },
        );
        // Meanwhile the issue's scope is edited on the tracker, and a sync takes it.
        api.edit(6, { body: "Touch src/a.ts and src/b.ts" });
        await sync();
        expect((await store.getCard(id))?.status).toBe("in_progress");
        expect((await store.cardEvents(id, ["sync/scope_changed"])).map((e) => e.payload)).toEqual([
          { id, fields: ["body"], change: "scope" },
        ]);
        const done = await running;
        // The Agent was not stopped: it answered and finished its turn.
        expect(done.stdout).toContain("turn: finish_card");
        const moves = (await store.cardEvents(id, ["card/status_changed"])).map(
          (e) => e.payload as { toStatus: string; reason?: string },
        );
        expect(moves.map((m) => m.toStatus)).not.toContain("review");
        expect(moves.at(-1)).toMatchObject({ toStatus: "planning" });
        expect(moves.at(-1)?.reason).toMatch(
          /the tracker changed the card's scope while it ran \(body\)/,
        );
      } finally {
        await server.close();
        db.close();
        vi.unstubAllEnvs();
      }
    },
  );
});
