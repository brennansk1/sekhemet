import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { NodeGitSyncAdapter, intentFor } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptRefusedError, acceptCard, acceptPreconditions } from "../src/accept.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { identitySettings } from "../src/team/settings.js";
import { applyWebhookIntent } from "../src/wave2_server.js";

/**
 * B4.11, teams NEW-teams-8 (item 25; TEAM-24, TEAM-25) and review-git §2
 * item 4, on a real Team server over a Team ledger and a real repository,
 * with five people signed in at four levels (DoD §2A): the *Comment*
 * verdict and its review threads, replies and resolving, a project that
 * requires every thread resolved before Accept, and an accept dismissed
 * because new commits landed on the issue's branch before its merge.
 */

const PASSWORD = "correct horse battery staple";

let repo: string;
let side: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let base: string;
let server: { port: number; close: () => Promise<void> } | undefined;

interface Person {
  principal: string;
  headers: Record<string, string>;
}
const nobody: Person = { principal: "", headers: {} };

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-verdicts-"));
  side = mkdtempSync(join(tmpdir(), "sek-verdicts-side-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(side, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(side, "noop.mjs");
  process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sek-verdicts-cfg-"));
  writeFileSync(join(side, "list.txt"), "passwordpassword1\n");
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db, { setup: "team" });
  store = new CardStore(db, log);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(side, { recursive: true, force: true });
});

async function start() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store, { entryConditions: true }),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
    pmAdapter: () => new MockInferenceAdapter("dirk-27b", []),
    identity: {
      dir: join(side, "identity"),
      passwordList: join(side, "list.txt"),
      settings: identitySettings({ mode: "team", workspace: "Northwind" }),
    },
  });
  vi.mocked(console.log).mockRestore();
  base = `http://127.0.0.1:${server.port}`;
}

const call = (method: string, path: string, who: Person, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Sekhemet-Action": "1", ...who.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function signedIn(res: Response): Promise<Person> {
  const body = (await res.json()) as { principal: string; csrf: string; error?: string };
  expect(res.status, body.error).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { principal: body.principal, headers: { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf } };
}

async function invited(by: Person, level: string, name: string, email: string) {
  const res = await call("POST", "/api/invites", by, { level, email });
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { id: string }).id;
  return signedIn(
    await call("POST", `/api/invites/${id}/accept`, nobody, { name, email, password: PASSWORD }),
  );
}

const asPerson = <T>(who: Person, fn: () => T): T => EventLog.actingFor(who.principal, fn);

async function answer(who: Person, method: string, path: string, body?: unknown) {
  const res = await call(method, path, who, body);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function ok(who: Person, method: string, path: string, body?: unknown) {
  const r = await answer(who, method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.data)}`).toBeLessThan(400);
  return r.data;
}

/** Five people at four levels on Chronicle, led by Lee (who accepts: no Accept rule, DEC-42). */
async function team() {
  await start();
  const token = readFileSync(join(side, "identity", "setup-token"), "utf8").trim();
  const ada = await signedIn(
    await call("POST", "/api/setup", nobody, {
      token,
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  );
  const project = (
    await asPerson(ada, () => store.ensureProject({ rootPath: repo, name: "Chronicle" }))
  ).id;
  const mo = await invited(ada, "member", "Mo Member", "mo@northwind.test");
  const lee = await invited(ada, "member", "Lee Lead", "lee@northwind.test");
  const sam = await invited(ada, "stakeholder", "Sam Stakeholder", "sam@northwind.test");
  const vic = await invited(ada, "viewer", "Vic Viewer", "vic@northwind.test");
  await ok(ada, "PATCH", `/api/projects/${project}/settings`, { lead: lee.principal });
  return { ada, mo, lee, sam, vic, project };
}

/** An issue the Agent built on its branch, its checks passed and on the ledger, in Review. */
async function inReview(id: string, project: string, by: Person) {
  const adapter = new NodeGitSyncAdapter(repo);
  await asPerson(by, () =>
    store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: ["src/**"],
      projectId: project,
    }),
  );
  const wt = await adapter.createWorktree(id, "main", `Card ${id}`);
  write(wt, "src/b.ts", "export const b = 2;\n");
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
    filesTouched: ["src/b.ts"],
    linesAdded: 1,
    linesRemoved: 0,
    diff: [
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+export const b = 2;",
      "",
    ].join("\n"),
    settings: { modelId: "nail" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(repo, ".sekhemet", "evidence", `ev_${id}.json`), body);
  writeFileSync(join(repo, ".sekhemet", "evidence", `latest-${id}.json`), body);
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
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}

interface Thread {
  id: string;
  file?: string;
  line?: number;
  principal?: string;
  name?: string;
  resolved: boolean;
  resolvedByName?: string;
  comments: { name?: string; text: string }[];
}

const threadsOf = async (who: Person, id: string) =>
  (await ok(who, "GET", `/api/cards/${id}/threads`)) as {
    threads: Thread[];
    requireResolvedThreads: boolean;
    acceptDismissed?: { pr?: number; headSha?: string; accepterName?: string };
  };

describe("the Comment verdict and review threads (teams item 25)", () => {
  it("a review with no verdict opens threads on lines and on the whole change; its text stays private", async () => {
    const t = await team();
    await inReview("d1", t.project, t.ada);

    const posted = await ok(t.mo, "POST", "/api/cards/d1/reviews", {
      body: "Looks close; two things.",
      comments: [{ file: "src/b.ts", line: 1, text: "Name this for what it holds." }],
    });
    const threads = posted.threads as Thread[];
    expect(threads.map((th) => [th.file, th.line, th.name, th.resolved])).toEqual([
      [undefined, undefined, "Mo Member", false],
      ["src/b.ts", 1, "Mo Member", false],
    ]);
    // Nothing moved: a Comment is no verdict.
    expect((await store.getCard("d1"))?.status).toBe("review");
    const [event] = await store.cardEvents("d1", ["review/commented"]);
    expect(event?.principal).toBe(t.mo.principal);
    expect(JSON.stringify(event?.payload)).not.toContain("Name this");
    expect((event as { private?: unknown }).private).toEqual({
      texts: ["Looks close; two things.", "Name this for what it holds."],
    });

    // A Viewer can take part in the conversation, as on a pull request.
    const line = threads[1] as Thread;
    const replied = (await ok(t.vic, "POST", `/api/cards/d1/threads/${line.id}/replies`, {
      text: "Maybe `retryLimit`?",
    })) as { thread: Thread };
    expect(replied.thread.comments.map((c) => [c.name, c.text])).toEqual([
      ["Mo Member", "Name this for what it holds."],
      ["Vic Viewer", "Maybe `retryLimit`?"],
    ]);

    // Everyone who can see the project reads the threads, in order.
    const read = await threadsOf(t.sam, "d1");
    expect(read.threads.map((th) => th.comments.length)).toEqual([1, 2]);
    expect(read.requireResolvedThreads).toBe(false);

    // Refusals: empty, a path outside the change, a bad line, an unknown thread.
    expect((await answer(t.mo, "POST", "/api/cards/d1/reviews", { body: "  " })).status).toBe(400);
    expect(
      (
        await answer(t.mo, "POST", "/api/cards/d1/reviews", {
          comments: [{ file: "../etc/passwd", line: 1, text: "x" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await answer(t.mo, "POST", "/api/cards/d1/reviews", {
          comments: [{ file: "src/b.ts", line: 0, text: "x" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await answer(t.mo, "POST", "/api/cards/d1/threads/thr_nope/replies", { text: "x" })).status,
    ).toBe(404);
  });

  it("resolving is a reviewer's: a Stakeholder is refused and the refusal recorded; reopening brings it back", async () => {
    const t = await team();
    await inReview("d2", t.project, t.ada);
    const posted = await ok(t.sam, "POST", "/api/cards/d2/reviews", { body: "Is the copy final?" });
    const thread = (posted.threads as Thread[])[0] as Thread;

    const refused = await answer(t.sam, "POST", `/api/cards/d2/threads/${thread.id}/resolve`);
    expect(refused.status).toBe(403);
    expect(String(refused.data.error)).toMatch(/Member/);
    const recorded = (await log.getEventsByTypes(["access/refused"])).at(-1);
    expect(recorded?.principal).toBe(t.sam.principal);
    expect(recorded?.payload).toMatchObject({ permission: "review" });

    const resolved = (await ok(t.mo, "POST", `/api/cards/d2/threads/${thread.id}/resolve`)) as {
      thread: Thread;
    };
    expect(resolved.thread).toMatchObject({ resolved: true, resolvedByName: "Mo Member" });
    expect((await answer(t.mo, "POST", `/api/cards/d2/threads/${thread.id}/resolve`)).status).toBe(
      409,
    );
    const reopened = (await ok(t.lee, "POST", `/api/cards/d2/threads/${thread.id}/reopen`)) as {
      thread: Thread;
    };
    expect(reopened.thread.resolved).toBe(false);
    expect(reopened.thread.resolvedByName).toBeUndefined();
    expect(
      (await store.cardEvents("d2", ["review/thread_resolved", "review/thread_reopened"])).map(
        (e) => [e.type, e.principal, e.payload],
      ),
    ).toEqual([
      ["review/thread_resolved", t.mo.principal, { cardId: "d2", thread: thread.id }],
      ["review/thread_reopened", t.lee.principal, { cardId: "d2", thread: thread.id }],
    ]);
  });
});

describe("TEAM-25: a project that requires resolved threads disables Accept while one is open, naming it", () => {
  it("refuses the lead's Accept naming the open thread, and merges once every thread is resolved", async () => {
    const t = await team();
    await inReview("d3", t.project, t.ada);
    const posted = await ok(t.mo, "POST", "/api/cards/d3/reviews", {
      comments: [
        { file: "src/b.ts", line: 1, text: "Name this for what it holds." },
        { file: "src/b.ts", text: "Add a test for the zero case." },
      ],
    });
    const ids = (posted.threads as Thread[]).map((th) => th.id);
    await ok(t.lee, "POST", "/api/cards/d3/opened", { filesShown: ["src/b.ts"] });

    // Not required: open threads do not hold Accept back.
    let desk = (await ok(t.lee, "GET", "/api/cards/d3/review")) as {
      threads: Thread[];
      requireResolvedThreads: boolean;
      openThread?: string;
    };
    expect(desk.requireResolvedThreads).toBe(false);
    expect(desk.openThread).toBeUndefined();

    // The lead requires resolved threads: `project/settings_changed` records only that.
    await ok(t.lee, "PATCH", `/api/projects/${t.project}/settings`, {
      require_resolved_threads: true,
    });
    const named =
      "This project needs every review thread resolved before Accept. Open thread on src/b.ts:1 from Mo Member: “Name this for what it holds.” (and 1 more open).";
    desk = (await ok(t.lee, "GET", "/api/cards/d3/review")) as typeof desk;
    expect(desk.requireResolvedThreads).toBe(true);
    expect(desk.threads).toHaveLength(2);
    expect(desk.openThread).toBe(named);
    const refused = await answer(t.lee, "POST", "/api/cards/d3/accept");
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe(named);
    expect((await store.getCard("d3"))?.status).toBe("review");
    // The command line's Accept reads the same rule from the ledger.
    const cli = await acceptCard(
      {
        repoPath: repo,
        cardStore: store,
        boardService: new BoardServiceImpl(store, { entryConditions: true }),
        eventLog: log,
      },
      (await store.getCard("d3")) as CardRecord,
      "human",
      // No `requireResolvedThreads`: the rule is read from `project/settings_changed`.
      { principal: t.lee.principal, acceptHolders: [t.lee.principal] },
    ).catch((err: unknown) => err);
    expect(cli).toBeInstanceOf(AcceptRefusedError);
    expect((cli as AcceptRefusedError).code).toBe("open_thread");
    expect((cli as Error).message).toMatch(/^This project needs every review thread resolved/);

    await ok(t.mo, "POST", `/api/cards/d3/threads/${ids[0]}/resolve`);
    desk = (await ok(t.lee, "GET", "/api/cards/d3/review")) as typeof desk;
    expect(desk.openThread).toBe(
      "This project needs every review thread resolved before Accept. Open thread on src/b.ts from Mo Member: “Add a test for the zero case.”.",
    );
    await ok(t.lee, "POST", `/api/cards/d3/threads/${ids[1]}/resolve`);
    desk = (await ok(t.lee, "GET", "/api/cards/d3/review")) as typeof desk;
    expect(desk.openThread).toBeUndefined();

    const accepted = await ok(t.lee, "POST", "/api/cards/d3/accept");
    expect(accepted).toMatchObject({ ok: true, status: "done" });
    expect(git("rev-parse", "main")).toBe(accepted.sha);
    const done = (await store.cardEvents("d3", ["card/accepted"])).at(-1);
    expect(done?.principal).toBe(t.lee.principal);
    // A closed issue's review is over.
    expect((await answer(t.mo, "POST", "/api/cards/d3/reviews", { body: "late" })).status).toBe(
      409,
    );
  });
});

describe("TEAM-24: new commits on an accepted issue's branch before its merge dismiss the accept", () => {
  it("records why, clears the accept, keeps the issue in Review, and the page says so", async () => {
    const t = await team();
    await asPerson(t.ada, () =>
      store.createCard({ id: "m1", tier: "task", title: "Merge me", projectId: t.project }),
    );
    await store.updateCardStatus("m1", "review", "verified", "harness", { override: true });
    const first = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";
    await store.recordPullRequestOpened("m1", {
      pr: 5,
      url: "https://github.com/octo-org/octo-repo/pull/5",
      headSha: first,
      accepter: t.lee.principal,
    });
    const hook = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "packages",
          "sync",
          "tests",
          "fixtures",
          "github",
          "webhook-pull_request-closed.json",
        ),
        "utf8",
      ),
    );
    hook.action = "synchronize";

    // The head the accept was given on is not new: nothing happens.
    expect(await applyWebhookIntent(store, intentFor("pull_request", hook), "d-same")).toBe(
      undefined,
    );
    // Another repository's pull request #5 is not this one.
    const other = structuredClone(hook);
    other.repository.full_name = "someone/else";
    other.pull_request.head.sha = "1".repeat(40);
    expect(await applyWebhookIntent(store, intentFor("pull_request", other), "d-other")).toBe(
      undefined,
    );
    expect((await store.getCard("m1"))?.hold?.kind).toBe("awaitingMerge");

    hook.pull_request.head.sha = "2".repeat(40);
    expect(await applyWebhookIntent(store, intentFor("pull_request", hook), "d-push")).toBe("m1");
    const card = await store.getCard("m1");
    expect(card?.status).toBe("review");
    // The pull request stays open on GitHub, so the issue keeps it — the
    // accept dismissed, the new head known — and waits for a new decision,
    // counted in Review's WIP again.
    expect(card?.hold).toMatchObject({
      kind: "awaitingMerge",
      pr: 5,
      headSha: "2".repeat(40),
      dismissed: true,
    });
    expect(card?.accepter).toBeUndefined();
    const wip = await new BoardServiceImpl(store).checkWipLimits();
    expect(wip.find((w) => w.column === "review")?.currentCount).toBe(1);
    const [dismissed] = await store.cardEvents("m1", ["review/accept_dismissed"]);
    expect(dismissed?.payload).toEqual({
      id: "m1",
      reason: "new_commits",
      pr: 5,
      headSha: "2".repeat(40),
      accepter: t.lee.principal,
    });

    // The issue page and the desk say so, naming who had accepted it.
    const read = await threadsOf(t.mo, "m1");
    expect(read.acceptDismissed).toMatchObject({
      pr: 5,
      headSha: "2".repeat(40),
      accepterName: "Lee Lead",
    });
    const desk = (await ok(t.lee, "GET", "/api/cards/m1/review")) as {
      acceptDismissed?: { accepterName?: string };
    };
    expect(desk.acceptDismissed?.accepterName).toBe("Lee Lead");

    // A further push dismisses nothing more: there is no accept left to dismiss.
    hook.pull_request.head.sha = "3".repeat(40);
    expect(await applyWebhookIntent(store, intentFor("pull_request", hook), "d-again")).toBe(
      undefined,
    );
    expect(await store.cardEvents("m1", ["review/accept_dismissed"])).toHaveLength(1);

    // A new Accept is a new decision on the same pull request, not a second one.
    const pre = await acceptPreconditions(
      {
        repoPath: repo,
        cardStore: store,
        boardService: new BoardServiceImpl(store, { entryConditions: true }),
        eventLog: log,
      },
      "m1",
      "human",
      { principal: t.lee.principal, acceptHolders: [t.lee.principal] },
    ).catch((err: unknown) => err);
    expect((pre as AcceptRefusedError).code).not.toBe("not_in_review");
  });

  it("records a merge on GitHub after the dismissal, and leaves Done to a new accept", async () => {
    const t = await team();
    await asPerson(t.ada, () =>
      store.createCard({ id: "m2", tier: "task", title: "Merged anyway", projectId: t.project }),
    );
    await store.updateCardStatus("m2", "review", "verified", "harness", { override: true });
    await store.recordPullRequestOpened("m2", {
      pr: 5,
      url: "https://github.com/octo-org/octo-repo/pull/5",
      headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
      accepter: t.lee.principal,
    });
    await store.dismissAccept("m2", { pr: 5, headSha: "2".repeat(40) }, "github");
    const hook = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "packages",
          "sync",
          "tests",
          "fixtures",
          "github",
          "webhook-pull_request-closed.json",
        ),
        "utf8",
      ),
    );
    expect(hook.action).toBe("closed");
    expect(hook.pull_request.merged).toBe(true);
    // Not ignored: the merge is on the issue's record, its hold gone.
    expect(await applyWebhookIntent(store, intentFor("pull_request", hook), "d-merge")).toBe("m2");
    const [closed] = await store.cardEvents("m2", ["card/pr_closed"]);
    expect(closed?.payload).toMatchObject({ id: "m2", pr: 5, merged: true });
    const card = await store.getCard("m2");
    expect(card?.hold).toBeUndefined();
    // No accept covers the commits that dismissed it, so the merge alone does
    // not take it to Done (spine: a person's acceptance; kernel rule 24).
    expect(card?.status).toBe("review");
  });
});
