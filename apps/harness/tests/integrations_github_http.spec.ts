import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { DELEGATE_LABEL } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import {
  type FakeGitHub,
  binWithoutGh,
  builtInReview,
  fakeGh,
  fakeGitHub,
  ghFixture,
  git,
  githubWrites,
  issuePages,
  signedDelivery,
  writeIn,
} from "./support/g3_github.js";

/**
 * GitHub through the dashboard server's own doors (integrations P9,
 * NEW-integrations-1 to -3; FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): a
 * real server started on port 0 over a real repository and an on-disk
 * ledger, driven over HTTP as the page and GitHub drive it — the sync button
 * (`POST /api/integrations/github/sync`), the signed webhook route
 * (`POST /webhooks/github`), Accept with PR-on-accept, and the server's own
 * catch-up at start. GitHub is `support/g3_github.ts`'s local fake reached as
 * a GitHub Enterprise Server, with a fake `gh` on PATH: no request leaves the
 * machine and no model is loaded.
 */

const SECRET = "hook-secret";

let root: string;
let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let api: FakeGitHub;
let server: { port: number; close: () => Promise<void> } | undefined;
let base: string;

async function serve(): Promise<void> {
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store, {
      entryConditions: true,
      customLimits: { review: 5 },
    }),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 1000,
    pressureLevel: () => 1,
  });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sek-int-http-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Jane Doe");
  git(repo, "config", "user.email", "jane@example.com");
  writeIn(repo, "src/a.ts", "export const a = 1;\n");
  writeIn(repo, ".gitignore", ".sekhemet/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  // The GitHub repository is read from the remote locally, never asked of `gh`.
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(root, "config", "config.toml"));
  vi.stubEnv("SEKHEMET_KEYCHAIN", "off");
  for (const k of Object.keys(process.env).filter((x) => x.startsWith("SEKHEMET_GITHUB"))) {
    vi.stubEnv(k, "");
  }
  for (const k of Object.keys(process.env).filter((x) => x.startsWith("SEKHEMET_SLACK"))) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("PATH", `${fakeGh(join(root, "bin"))}:${process.env.PATH}`);
  vi.stubEnv("FAKE_GH_TOKEN", "gho_fake");
  vi.stubEnv("SEKHEMET_GITHUB_WEBHOOK_SECRET", SECRET);
  api = await fakeGitHub();
  vi.stubEnv("SEKHEMET_GITHUB_HOST", api.url);
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  await serve();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface SyncResult {
  created: number;
  updated: number;
  clamped: { id: string; ancestor: string }[];
  errors: string[];
  budget?: { rest: Record<string, number>; graphql: Record<string, number> };
}

/** The Integrations page's Sync now: the request the page sends. */
async function sync(direction: "both" | "pull" | "push" = "both"): Promise<SyncResult> {
  const r = await fetch(`${base}/api/integrations/github/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify({ direction }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as SyncResult;
}

/** A page write: PATCH, POST or PUT with the page's headers. */
async function write(method: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
}

/** GitHub delivering a webhook, signed with the route's secret unless told otherwise. */
async function deliver(
  event: string,
  delivery: string,
  payload: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: headers ?? signedDelivery(SECRET, event, delivery, body),
    body,
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const byRef = async (id: string) =>
  (await store.listCards()).filter(
    (c) => c.externalRef?.system === "github" && c.externalRef.id === id,
  );
const conflicts = async () => log.getEventsByTypes(["sync/conflict"]);
const must = async (id: string): Promise<CardRecord> => {
  const c = await store.getCard(id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

describe("Sync now over HTTP: every issue, idempotent, merged three ways", () => {
  it("INT-2: a repository with 150 open issues: every one becomes a card, over two pages", async () => {
    for (let n = 1; n <= 150; n++) api.edit(n, { title: `Issue ${n}` });
    const r = await sync("pull");
    expect(r.errors).toEqual([]);
    expect(r.created).toBe(150);
    const linked = (await store.listCards()).filter((c) => c.externalRef?.system === "github");
    expect(linked).toHaveLength(150);
    expect(new Set(linked.map((c) => c.externalRef?.id)).size).toBe(150);
    expect(linked.map((c) => c.externalRef?.id)).toEqual(
      expect.arrayContaining(["o/r#1", "o/r#150"]),
    );
    expect(issuePages(api)).toHaveLength(2);
  });

  it("INT-3, INT-11d: a second sync with no change on either side creates and updates nothing, writes nothing and logs no conflict", async () => {
    api.edit(1, { title: "One" });
    await store.createCard({ tier: "task", title: "Board card", spec: "From the board." });
    const first = await sync();
    expect(first.errors).toEqual([]);
    expect(first.created).toBe(2); // one pulled, one pushed
    const writes = githubWrites(api).length;
    const events = log.lastSeq();
    // INT-11d: the same push retried changes nothing the second time.
    const second = await sync();
    expect(second).toMatchObject({ created: 0, updated: 0, errors: [] });
    expect(githubWrites(api).length).toBe(writes);
    expect(await conflicts()).toEqual([]);
    expect(
      (await log.getEvents(events + 1, 500)).filter((e) => e.type.startsWith("card/")),
    ).toEqual([]);
  });

  it("INT-4: the tracker's title wins when only the tracker changed it, even after the board moved the card", async () => {
    api.edit(2, { title: "Before" });
    await sync();
    const [card] = await byRef("o/r#2");
    const id = card?.id as string;
    await store.updateCardStatus(id, "ready", "planned", "human", { override: true });
    api.edit(2, { title: "After, edited in GitHub" });
    expect((await sync()).errors).toEqual([]);
    expect((await must(id)).title).toBe("After, edited in GitHub");
    expect((await must(id)).status).toBe("ready");
    expect(await conflicts()).toEqual([]);
  });

  it("INT-5: a title changed only on the board, through the issue page's edit, is pushed to the tracker", async () => {
    api.edit(3, { title: "Tracker title" });
    await sync();
    const [card] = await byRef("o/r#3");
    const edited = await write("PATCH", `/api/cards/${card?.id}`, { title: "Board title" });
    expect(edited.status).toBe(200);
    expect((await sync()).errors).toEqual([]);
    expect(api.issues.get(3)?.title).toBe("Board title");
    expect(await conflicts()).toEqual([]);
  });

  it("INT-7: a title edited on the tracker while the card runs is applied when the card completes", async () => {
    api.edit(4, { title: "Running" });
    await sync();
    const [card] = await byRef("o/r#4");
    const id = card?.id as string;
    await store.updateCardStatus(id, "in_progress", "run", "harness", { override: true });
    api.edit(4, { title: "Renamed mid-run" });
    await sync();
    expect((await must(id)).title).toBe("Running");
    await store.updateCardStatus(id, "review", "gates passed", "harness", { override: true });
    await sync();
    expect((await must(id)).title).toBe("Renamed mid-run");
  });

  it("INT-11a: a scope edit arriving while the card runs is recorded on the card, and the card is neither stopped nor paused", async () => {
    api.edit(6, { title: "Fix A", body: "Touch src/a.ts" });
    await sync();
    const [card] = await byRef("o/r#6");
    const id = card?.id as string;
    await store.updateCardStatus(id, "in_progress", "run", "harness", { override: true });
    api.edit(6, { body: "Touch src/a.ts and src/b.ts" });
    expect((await sync()).errors).toEqual([]);
    expect((await must(id)).status).toBe("in_progress");
    const changed = await store.cardEvents(id, ["sync/scope_changed"]);
    expect(changed.map((e) => e.payload)).toEqual([{ id, fields: ["body"], change: "scope" }]);
    // No decision asked of anyone: the Worker is not stopped to ask.
    expect(await log.getEventsByTypes(["decision/requested"])).toEqual([]);
    await sync();
    expect(await store.cardEvents(id, ["sync/scope_changed"])).toHaveLength(1);
  });

  it("INT-8: a secondary rate limit is waited out for its advertised time and retried; past the retry limit the failure is reported", async () => {
    api.edit(7, { title: "Limited" });
    api.limitNext(1);
    const started = Date.now();
    const ok = await sync("pull");
    expect(ok.errors).toEqual([]);
    expect(await byRef("o/r#7")).toHaveLength(1);
    // The fake advertises one second: the retry waited for it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    // The page asked twice: the limited request, then its retry.
    expect(issuePages(api)).toHaveLength(2);
    // Limited on every attempt: three retries, then the failure is said.
    api.edit(8, { title: "Still limited" });
    const before = api.seen.filter((s) => s.url === "/api/graphql").length;
    api.limitNext(100);
    const failed = await sync("pull");
    expect(failed.errors.join(" ")).toMatch(/rate limit 4 times; giving up/);
    expect(api.seen.filter((s) => s.url === "/api/graphql").length - before).toBe(4);
    expect(await byRef("o/r#8")).toEqual([]);
    api.limitNext(0);
  }, 30_000);

  it("INT-11c: a page of issues comes with its sub-issues and labels in one query, and GraphQL's points are counted apart from REST's requests", async () => {
    api.edit(41, { title: "Child one" });
    api.edit(42, { title: "Child two" });
    api.edit(40, { title: "Epic", labels: [{ name: "epic" }], sub_issues: [41, 42] });
    const r = await sync("pull");
    expect(r.errors).toEqual([]);
    expect(issuePages(api)).toHaveLength(1);
    // No per-issue request for the sub-issues or the labels.
    expect(api.seen.filter((s) => /\/issues\/\d+\/(sub_issues|labels)/.test(s.url))).toEqual([]);
    expect((await byRef("o/r#40"))[0]?.labels).toEqual(["epic"]);
    // The sub-issues arrived in the same query: the snapshot holds them.
    const snap = (await log.getEventsByTypes(["sync/snapshot"])).find(
      (e) => (e.payload as { ref: { id: string } }).ref.id === "o/r#40",
    );
    expect((snap?.private as { item: { subIssues: string[] } }).item.subIssues).toEqual([
      "o/r#41",
      "o/r#42",
    ]);
    expect(r.budget?.graphql).toMatchObject({ requests: 1, spent: 1, limit: 5000 });
    expect(r.budget?.rest.requests).toBe(1);
    expect(r.budget?.rest.remaining).toBe(4990);
  });
});

describe("Sync now over HTTP: nesting, people and the tracker's Done", () => {
  it("INT-11e: pushed to Forgejo, which declares no hierarchy (maxDepth 1), a subtask is not written; it links to its written card, and the sync result reports the clamp", async () => {
    // Forgejo's issues API, local: the tracker the sync reaches when it is configured.
    const created: string[] = [];
    const forgejo = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && /^\/api\/v1\/repos\/o\/r\/issues/.test(req.url ?? "")) {
          res.end("[]");
          return;
        }
        if (req.method === "POST" && req.url === "/api/v1/repos/o/r/issues") {
          created.push(String((JSON.parse(raw) as { title: string }).title));
          const n = created.length;
          res.writeHead(201).end(JSON.stringify({ number: n, html_url: `f/${n}` }));
          return;
        }
        res.writeHead(404).end("{}");
      });
    });
    await new Promise<void>((r) => forgejo.listen(0, "127.0.0.1", r));
    try {
      vi.stubEnv(
        "SEKHEMET_FORGEJO_URL",
        `http://127.0.0.1:${(forgejo.address() as AddressInfo).port}`,
      );
      vi.stubEnv("SEKHEMET_FORGEJO_TOKEN", "tok");
      vi.stubEnv("SEKHEMET_FORGEJO_REPO", "o/r");
      const story = await store.createCard({ tier: "story", title: "Story" });
      const sub = await store.createCard({ tier: "task", title: "Sub", parentId: story.id });
      const r = await sync("push");
      expect(r.errors).toEqual([]);
      expect(r.clamped).toEqual([{ id: sub.id, ancestor: story.id }]);
      expect(created).toEqual(["Story"]);
      expect((await must(sub.id)).externalRef).toBeUndefined();
      const [link] = await store.cardEvents(sub.id, ["sync/clamped"]);
      expect(link?.payload).toEqual({ id: sub.id, ancestor: story.id, ref: "1", maxDepth: 1 });
      // Reported again, written once.
      const again = await sync("push");
      expect(again.clamped).toEqual([{ id: sub.id, ancestor: story.id }]);
      expect(await store.cardEvents(sub.id, ["sync/clamped"])).toHaveLength(1);
      expect(created).toEqual(["Story"]);
    } finally {
      await new Promise<void>((r) => forgejo.close(() => r()));
    }
  });

  it("INT-36: the owner's login is the issue's assignee and the Worker a label, never 'worker' as a user", async () => {
    const me = store.localPrincipal();
    await store.linkIdentity(me, "github", "alice-gh", me);
    const card = await store.createCard({ tier: "task", title: "Delegated" });
    await store.changeOwner(card.id, me, me);
    await store.delegateCard(card.id, { kind: "worker" }, me);
    expect((await sync()).errors).toEqual([]);
    const created = api.seen.find(
      (s) => s.method === "POST" && s.url === "/api/v3/repos/o/r/issues",
    )?.body as { assignees: string[]; labels: string[] };
    expect(created.assignees).toEqual(["alice-gh"]);
    expect(created.labels).toContain(DELEGATE_LABEL);
    expect(JSON.stringify(api.seen.map((s) => s.body))).not.toMatch(/"assignees":\["worker"\]/);
    expect(await conflicts()).toEqual([]);
  });

  it("INT-41: an assignee who maps to no principal leaves the owner unchanged and records one sync/conflict naming them", async () => {
    const me = store.localPrincipal();
    await store.linkIdentity(me, "github", "alice-gh", me);
    const card = await store.createCard({ tier: "task", title: "Stranger" });
    await store.changeOwner(card.id, me, me);
    await sync();
    const n = Number(String((await must(card.id)).externalRef?.id).split("#")[1]);
    api.edit(n, { assignee: { login: "stranger-gh" } });
    expect((await sync()).errors).toEqual([]);
    expect((await must(card.id)).owner).toBe(me);
    const recorded = await conflicts();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ field: "assignee", reason: "unmapped" });
    expect(recorded[0]?.private).toEqual({ assignee: "stranger-gh" });
    await sync();
    expect(await conflicts()).toHaveLength(1);
    // The person's assignment on the tracker is not pushed back over.
    expect((api.issues.get(n)?.assignee as { login: string }).login).toBe("stranger-gh");
  });

  it("INT-20b: as the linked card moves from Ready to In progress to Review to Done, each sync sets the issue's project status in turn and leaves the assignee", async () => {
    const me = store.localPrincipal();
    await store.linkIdentity(me, "github", "alice-gh", me);
    api.edit(60, { title: "Mirrored", assignee: { login: "alice-gh" } });
    api.projects.push({
      id: "PVT_agent",
      options: ["Queued", "Working", "Waiting for review", "Completed"],
      items: new Map([[60, undefined]]),
    });
    await sync();
    const [card] = await byRef("o/r#60");
    const id = card?.id as string;
    for (const status of ["ready", "in_progress", "review", "done"] as const) {
      await store.updateCardStatus(id, status, "moved", "harness", { override: true });
      expect((await sync("push")).errors).toEqual([]);
    }
    expect(api.statusLog).toEqual([
      "PVT_agent:Queued",
      "PVT_agent:Working",
      "PVT_agent:Waiting for review",
      "PVT_agent:Completed",
    ]);
    // No write named an assignee: the issue's assignee is still the person.
    expect(api.seen.filter((s) => s.method === "PATCH" && s.body && "assignees" in s.body)).toEqual(
      [],
    );
    expect((api.issues.get(60)?.assignee as { login: string }).login).toBe("alice-gh");
  });

  it("INT-20c: an issue closed on the tracker before its card passed and was accepted keeps the card where it is and records one sync/conflict", async () => {
    api.edit(70, { title: "Closed early" });
    await sync();
    const [card] = await byRef("o/r#70");
    const id = card?.id as string;
    await store.updateCardStatus(id, "in_progress", "running", "harness", { override: true });
    api.edit(70, { state: "closed", closed_at: "2026-09-20T10:00:00Z" });
    expect((await sync()).errors).toEqual([]);
    expect((await must(id)).status).toBe("in_progress");
    const recorded = await conflicts();
    expect(recorded.map((e) => e.payload)).toEqual([
      { field: "state", reason: "done_before_accept", at: "2026-09-20T10:00:00Z" },
    ]);
    await sync();
    expect(await conflicts()).toHaveLength(1);
    expect(api.issues.get(70)?.state).toBe("closed");
  });
});

describe("POST /webhooks/github: signed, at most once, triggers only", () => {
  const labeled = () => ghFixture("webhook-issues-labeled.json");

  it("INT-9: a delivery ID already processed is answered 202 and does nothing, across a server restart", async () => {
    const first = await deliver("issues", "72d3162e-cc78-11e3-81ab-4c9367dc0958", labeled());
    expect(first).toMatchObject({ status: 202, body: { intent: "create_card" } });
    expect(await byRef("octo-org/octo-repo#1347")).toHaveLength(1);
    const events = log.lastSeq();
    const again = await deliver("issues", "72d3162e-cc78-11e3-81ab-4c9367dc0958", labeled());
    expect(again).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(log.lastSeq()).toBe(events);
    // A restart: the delivery is remembered on the ledger, not in memory.
    await server?.close();
    await serve();
    const afterRestart = await deliver("issues", "72d3162e-cc78-11e3-81ab-4c9367dc0958", labeled());
    expect(afterRestart).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(log.lastSeq()).toBe(events);
    expect(await byRef("octo-org/octo-repo#1347")).toHaveLength(1);
  });

  it("INT-10: a missing or wrong signature is answered 401 and nothing is parsed or recorded", async () => {
    const events = log.lastSeq();
    const body = JSON.stringify(labeled());
    const unsigned = await deliver("issues", "d-unsigned", body, {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "d-unsigned",
    });
    expect(unsigned.status).toBe(401);
    const wrong = await deliver("issues", "d-wrong", body, {
      ...signedDelivery("not-the-secret", "issues", "d-wrong", body),
    });
    expect(wrong.status).toBe(401);
    // Not JSON at all: refused for its signature, never parsed (a parse would answer 400).
    const garbage = await deliver("issues", "d-garbage", "{not json", {
      ...signedDelivery("not-the-secret", "issues", "d-garbage", "{not json"),
    });
    expect(garbage.status).toBe(401);
    expect(log.lastSeq()).toBe(events);
    expect(await store.listCards()).toEqual([]);
  });

  it("INT-11: a comment command other than /review is ignored and not recorded; /review on a pull request makes its review card", async () => {
    const events = log.lastSeq();
    const plan = ghFixture("webhook-issue_comment-created.json"); // "/plan this into smaller pieces"
    expect(await deliver("issue_comment", "d-plan", plan)).toMatchObject({
      status: 202,
      body: { intent: "ignored" },
    });
    const approve = ghFixture("webhook-issue_comment-created.json");
    approve.issue.pull_request = {
      url: "https://api.github.com/repos/octo-org/octo-repo/pulls/1347",
    };
    approve.comment.body = "/approve";
    expect(await deliver("issue_comment", "d-approve", approve)).toMatchObject({
      status: 202,
      body: { intent: "ignored" },
    });
    // Nothing recorded: not the delivery, not an unread command.
    expect(log.lastSeq()).toBe(events);
    expect(await store.listCards()).toEqual([]);
    const review = ghFixture("webhook-issue_comment-created.json");
    review.issue.pull_request = {
      url: "https://api.github.com/repos/octo-org/octo-repo/pulls/1347",
    };
    review.comment.body = "/review please";
    expect(await deliver("issue_comment", "d-review", review)).toMatchObject({
      status: 202,
      body: { intent: "external_review" },
    });
    expect((await store.listCards()).map((c) => c.title)).toEqual(["Review PR #1347"]);
  });

  it("INT-11d: the same issue's webhook redelivered under a new delivery ID, same updatedAt, changes nothing the second time", async () => {
    expect((await deliver("issues", "d-first", labeled())).status).toBe(202);
    const [card] = await byRef("octo-org/octo-repo#1347");
    const id = card?.id as string;
    const ofCard = async () => (await log.getEvents(0, 10_000)).filter((e) => e.cardId === id);
    const cardEvents = (await ofCard()).length;
    const snapshots = (await log.getEventsByTypes(["sync/snapshot"])).length;
    expect((await deliver("issues", "d-second", labeled())).status).toBe(202);
    expect(await byRef("octo-org/octo-repo#1347")).toHaveLength(1);
    expect((await ofCard()).length).toBe(cardEvents);
    expect((await log.getEventsByTypes(["sync/snapshot"])).length).toBe(snapshots);
    expect(await must(id)).toEqual(card);
  });

  it("INT-20c: the issues.closed webhook for a card not yet accepted keeps the card where it is and records one sync/conflict", async () => {
    expect((await deliver("issues", "d-open", labeled())).status).toBe(202);
    const [card] = await byRef("octo-org/octo-repo#1347");
    const id = card?.id as string;
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
    const closed = labeled();
    closed.action = "closed";
    closed.issue.closed_at = "2026-09-21T10:00:00Z";
    expect((await deliver("issues", "d-closed", closed)).status).toBe(202);
    expect((await must(id)).status).toBe("review");
    expect((await conflicts()).map((e) => e.cardId)).toEqual([id]);
  });

  describe("a pull request PR-on-accept opened, closed on GitHub", () => {
    const bob = "p_bob";
    async function awaiting(id: string): Promise<void> {
      await store.createCard({ id, tier: "task", title: id });
      await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
      await store.recordPullRequestOpened(id, {
        pr: 5,
        url: "https://github.com/octo-org/octo-repo/pull/5",
        headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        accepter: store.localPrincipal(),
      });
    }

    it("INT-13: merged, the card is Done with the merge commit and who merged it recorded", async () => {
      await store.linkIdentity(bob, "github", "hubot", bob);
      await awaiting("m1");
      const hook = ghFixture("webhook-pull_request-closed.json");
      expect(await deliver("pull_request", "d-merge", hook)).toMatchObject({
        status: 202,
        body: { intent: "pull_request_closed" },
      });
      expect((await must("m1")).status).toBe("done");
      const [closed] = await store.cardEvents("m1", ["card/pr_closed"]);
      expect(closed?.payload).toMatchObject({
        merged: true,
        mergeCommit: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
        closedBy: bob,
      });
    });

    it("INT-14: closed without merging, the hold and the accepter clear, the card stays in Review counted toward its limit, and the closer is recorded", async () => {
      await awaiting("m2");
      const hook = ghFixture("webhook-pull_request-closed.json");
      hook.pull_request.merged = false;
      hook.pull_request.merged_at = null;
      hook.pull_request.merge_commit_sha = null;
      hook.pull_request.merged_by = null;
      hook.sender.login = "octocat";
      expect((await deliver("pull_request", "d-close", hook)).status).toBe(202);
      const card = await must("m2");
      expect(card.status).toBe("review");
      expect(card.hold).toBeUndefined();
      expect(card.accepter).toBeUndefined();
      const [closed] = await store.cardEvents("m2", ["card/pr_closed"]);
      expect(closed?.payload).toEqual({ id: "m2", pr: 5, merged: false });
      expect(closed?.private).toEqual({ closedByHandle: "octocat" });
    });
  });

  it("INT-16a: a signed pull_request.opened from Dependabot makes a Ready verification card linked to the pull request; a person's look-alike makes none", async () => {
    const opened = (login: string, type: string) => {
      const hook = ghFixture("webhook-pull_request-closed.json");
      hook.action = "opened";
      hook.repository.full_name = "o/r";
      hook.pull_request.html_url = "https://github.com/o/r/pull/9";
      hook.pull_request.number = 9;
      hook.pull_request.merged = false;
      hook.pull_request.user = { login, id: 49699333, type };
      hook.pull_request.head.repo = { full_name: "o/r" };
      hook.pull_request.base.repo = { full_name: "o/r" };
      return hook;
    };
    expect(await deliver("pull_request", "d-dep", opened("dependabot[bot]", "Bot"))).toMatchObject({
      status: 202,
      body: { intent: "verify_dependency_pr" },
    });
    const [card] = await store.listCards();
    expect(card).toMatchObject({ status: "ready", labels: ["dependency-update"] });
    expect(card?.externalRef).toEqual({
      system: "github",
      id: "pr/9",
      url: "https://github.com/o/r/pull/9",
    });
    expect(card?.spec).toContain("ec26c3e57ca3a959ca5aad62de7213c562f8c821");
    expect(await deliver("pull_request", "d-fake", opened("dependabot", "User"))).toMatchObject({
      status: 202,
      body: { intent: "ignored" },
    });
    expect(await store.listCards()).toHaveLength(1);
  });
});

describe("INT-11b: with a webhook route, the server pulls only to catch up", () => {
  it("INT-11b: started again after a sync, the server pulls once to catch up what changed while it was down, and no timer pulls after", async () => {
    api.edit(50, { title: "Before the restart" });
    await sync();
    const [card] = await byRef("o/r#50");
    await server?.close();
    api.edit(50, { title: "Edited while the server was down" });
    const pagesBefore = issuePages(api).length;
    await serve();
    await vi.waitFor(async () =>
      expect(await log.getEventsByTypes(["github/catch_up"])).toHaveLength(1),
    );
    const [caught] = await log.getEventsByTypes(["github/catch_up"]);
    expect(caught?.payload).toMatchObject({ reason: "restart", created: 0, updated: 1, errors: 0 });
    expect((await must(card?.id as string)).title).toBe("Edited while the server was down");
    expect(issuePages(api).length).toBe(pagesBefore + 1);
    // The server runs on: no timer pulls the tracker.
    await new Promise((r) => setTimeout(r, 6000));
    expect(issuePages(api).length).toBe(pagesBefore + 1);
  }, 30_000);

  it("INT-11b: on the App, a delivery the App's log shows failed is a gap, and the next delivery's arrival pulls to catch up, once", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(join(root, "key.pem"), privateKey);
    vi.stubEnv("SEKHEMET_GITHUB_APP_ID", "1");
    vi.stubEnv("SEKHEMET_GITHUB_INSTALLATION_ID", "2");
    vi.stubEnv("SEKHEMET_GITHUB_APP_KEY_PATH", join(root, "key.pem"));
    vi.stubEnv("SEKHEMET_GITHUB_REPO", "o/r");
    api.edit(52, { title: "Before the gap" });
    expect((await sync()).errors).toEqual([]);
    const [card] = await byRef("o/r#52");
    api.edit(52, { title: "Edited during the gap" });
    await new Promise((r) => setTimeout(r, 5));
    api.deliveries.push({
      id: 9001,
      guid: "0b989ba4-242f-11e5-81e1-c7b6966d2516",
      delivered_at: new Date().toISOString(),
      redelivery: false,
      status: "Invalid HTTP Response: 502",
      status_code: 502,
      event: "issues",
      action: "edited",
    });
    // An ordinary delivery arrives: not a trigger, but its arrival runs the check.
    expect(
      (await deliver("issues", "d-ok-1", { action: "edited", issue: { number: 52 } })).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(await log.getEventsByTypes(["github/catch_up"])).toHaveLength(1),
    );
    const [caught] = await log.getEventsByTypes(["github/catch_up"]);
    expect(caught?.payload).toMatchObject({ reason: "gap", gaps: 1, updated: 1, errors: 0 });
    expect((await must(card?.id as string)).title).toBe("Edited during the gap");
    // Read with the App's JWT, not an installation token.
    const read = api.seen.find((s) => s.url.startsWith("/api/v3/app/hook/deliveries"));
    expect(read?.auth).toMatch(/^Bearer eyJ/);
  }, 30_000);
});

describe("Accept with PR-on-accept, from the issue page", () => {
  let upstream: string;
  beforeEach(async () => {
    upstream = join(root, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    git(repo, "remote", "add", "upstream", upstream);
    git(repo, "branch", "develop");
    writeIn(
      repo,
      ".sekhemet/config.toml",
      '[review]\nintegration_branch = "develop"\nremote = "upstream"\n',
    );
    // The Integrations page's switch.
    expect((await write("PUT", "/api/integrations/github-pr", { enabled: true })).status).toBe(200);
  });

  /** The issue page: the review opened, then Accept. */
  async function accept(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    expect(
      (await write("POST", `/api/cards/${id}/opened`, { filesShown: ["src/b.ts"] })).status,
    ).toBe(200);
    const r = await write("POST", `/api/cards/${id}/accept`, {});
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  it("INT-12, INT-12a, INT-39: Accept pushes to the configured remote, opens a draft against the integration branch with the evidence, names the accepter, and the card waits in Review", async () => {
    await builtInReview(repo, store, "p1", { "src/b.ts": "export const b = 2;\n" }, "develop");
    const r = await accept("p1");
    expect(r).toMatchObject({
      status: 200,
      body: { status: "review", sha: "https://github.com/o/r/pull/5" },
    });
    const pr = api.seen.find((s) => s.url === "/api/v3/repos/o/r/pulls")?.body as {
      head: string;
      base: string;
      draft: boolean;
      body: string;
    };
    // INT-12: against develop, not the repository's default branch.
    expect(pr).toMatchObject({ base: "develop", draft: true });
    // INT-12a: the evidence summary — gates, diff, coverage, abandoned attempts.
    expect(pr.body).toContain("### Checks\n- pass unit (12 ms)");
    expect(pr.body).toContain("### Coverage");
    expect(pr.body).toContain("### Tried and abandoned");
    // INT-39: the accepter named in the body, by name, never by email.
    expect(pr.body).toContain("Accepted by Jane Doe");
    expect(pr.body).not.toContain("jane@example.com");
    expect(git(repo, "ls-remote", "upstream")).toContain(`refs/heads/${pr.head}`);
    const card = await must("p1");
    expect(card.status).toBe("review");
    expect(card.hold).toMatchObject({ kind: "awaitingMerge", pr: 5 });
    // INT-39: the tracker's assignee is not touched by the accept.
    expect(api.seen.filter((s) => s.method === "PATCH" && /\/issues\/\d+$/.test(s.url))).toEqual(
      [],
    );
  });

  it("INT-47, INT-47a: through the GitHub App, a gate run with 120 annotations posts them to one Check Run in requests of at most 50; one with 3 posts them in one request", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(join(root, "key.pem"), privateKey);
    vi.stubEnv("SEKHEMET_GITHUB_APP_ID", "1");
    vi.stubEnv("SEKHEMET_GITHUB_INSTALLATION_ID", "2");
    vi.stubEnv("SEKHEMET_GITHUB_APP_KEY_PATH", join(root, "key.pem"));
    vi.stubEnv("SEKHEMET_GITHUB_REPO", "o/r");
    await builtInReview(repo, store, "p47", { "src/b.ts": "export const b = 2;\n" }, "develop");
    // The card's latest gate run, as the runner leaves it beside the ledger's record.
    const located = (n: number, file: string) =>
      Array.from(
        { length: n },
        (_, i) => `${file}:${i + 1}:1 - error TS2322: Type mismatch ${i + 1}`,
      ).join("\n");
    writeFileSync(
      join(repo, ".sekhemet", "evidence", "latest-p47.json"),
      JSON.stringify({
        id: "ev_p47",
        cardId: "p47",
        passed: true,
        rungResults: [
          { gate: "lint", rung: "hygiene", passed: false, durationMs: 5 },
          { gate: "types", rung: "hygiene", passed: false, durationMs: 5 },
          { gate: "unit", rung: "test", passed: true, durationMs: 12 },
        ],
        failures: [
          { gate: "lint", rung: "hygiene", errorExcerpt: located(120, "src/b.ts") },
          { gate: "types", rung: "hygiene", errorExcerpt: located(3, "src/c.ts") },
        ],
      }),
    );
    const r = await accept("p47");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const runs = (name: string) => {
      const created = api.checkRunWrites.find((w) => w.method === "POST" && w.name === name);
      return {
        created,
        patches: api.checkRunWrites.filter((w) => w.method === "PATCH" && w.id === created?.id),
      };
    };
    // INT-47: one Check Run, 50 + 50 + 20, every annotation on it when the last request completes.
    const lint = runs("sekhemet/lint");
    expect(lint.created?.annotations).toEqual([]);
    expect(lint.patches.map((p) => p.annotations.length)).toEqual([50, 50, 20]);
    const lines = lint.patches
      .flatMap((p) => p.annotations as { start_line: number }[])
      .map((a) => a.start_line)
      .sort((x, y) => x - y);
    expect(lines).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    const completing = api.seen.filter(
      (x) => x.method === "PATCH" && x.url === `/api/v3/repos/o/r/check-runs/${lint.created?.id}`,
    );
    expect(completing.map((x) => (x.body as { status?: string }).status)).toEqual([
      undefined,
      undefined,
      "completed",
    ]);
    // INT-47a: three annotations, one request.
    const types = runs("sekhemet/types");
    expect(types.patches.map((p) => p.annotations.length)).toEqual([3]);
    expect(runs("sekhemet/unit").patches.map((p) => p.annotations.length)).toEqual([0]);
  });

  it("INT-15: without gh on PATH, Accept says gh is not installed and the card stays in Review, nothing pushed", async () => {
    vi.stubEnv("PATH", binWithoutGh(root));
    await builtInReview(repo, store, "p2", { "src/b.ts": "export const b = 2;\n" }, "develop");
    const r = await accept("p2");
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/gh CLI is not installed/);
    const card = await must("p2");
    expect(card.status).toBe("review");
    expect(card.hold).toBeUndefined();
    expect(git(repo, "ls-remote", "upstream")).toBe("");
  });

  it("INT-15: with gh logged out, Accept says so and the card stays in Review", async () => {
    vi.stubEnv("FAKE_GH_TOKEN", "");
    await builtInReview(repo, store, "p3", { "src/b.ts": "export const b = 2;\n" }, "develop");
    const r = await accept("p3");
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/gh is not logged in/);
    expect((await must("p3")).status).toBe("review");
    expect(git(repo, "ls-remote", "upstream")).toBe("");
  });
});

describe("INT-40: the tracker reassigns a delegated card, on a Team server", () => {
  it("INT-40: with three people holding Accept, a reassignment on the tracker changes the owner; the delegator is still refused the accept, naming who may; the new owner may accept", async () => {
    const [ADMIN, ALICE, BOB, CAROL] = ["p_admin", "p_alice", "p_bob", "p_carol"];
    for (const [who, level] of [
      [ADMIN, "admin"],
      [ALICE, "member"],
      [BOB, "member"],
      [CAROL, "member"],
    ] as const) {
      log.appendNow({
        actor: "system",
        type: "member/joined",
        principal: who,
        payload: { principal: who, level, via: "invite", pending: false },
      });
    }
    const project = (await store.ensureProject({ rootPath: repo, name: "Shop" })).id;
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: ADMIN,
      payload: { project, accept_rule: [ALICE, BOB, CAROL] },
    });
    await store.linkIdentity(ALICE, "github", "alice-gh", ALICE);
    await store.linkIdentity(BOB, "github", "bob-gh", BOB);
    await builtInReview(repo, store, "c40", { "src/b.ts": "export const b = 2;\n" }, "main", {
      projectId: project,
    });
    await store.changeOwner("c40", ALICE, ALICE);
    await store.delegateCard("c40", { kind: "worker" }, ALICE);
    // The Team setup: who a request is comes from its header (the test's requester).
    await server?.close();
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(store, {
        entryConditions: true,
        customLimits: { review: 5 },
      }),
      cardStore: store,
      repoPath: repo,
      port: 0,
      streamIntervalMs: 10_000,
      setup: "team",
      requester: (req) => {
        const h = req.headers["x-test-principal"];
        return typeof h === "string" && h ? h : undefined;
      },
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
    const as = async (who: string, method: string, path: string, body: unknown = {}) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(await pageWriteHeaders(base)),
          "X-Test-Principal": who,
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect((await as(ADMIN, "POST", "/api/integrations/github/sync", {})).status).toBe(200);
    const n = Number(String((await must("c40")).externalRef?.id).split("#")[1]);
    expect((api.issues.get(n)?.assignee as { login: string }).login).toBe("alice-gh");
    // On the tracker, someone reassigns the issue to Bob.
    api.edit(n, { assignee: { login: "bob-gh" } });
    expect((await as(ADMIN, "POST", "/api/integrations/github/sync", {})).status).toBe(200);
    expect((await must("c40")).owner).toBe(BOB);
    // Alice delegated it to the Agent: she may not accept it, and is told who may.
    expect(
      (await as(ALICE, "POST", "/api/cards/c40/opened", { filesShown: ["src/b.ts"] })).status,
    ).toBe(200);
    const refused = await as(ALICE, "POST", "/api/cards/c40/accept");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(String(refused.body.error)).toContain(BOB);
    expect((await must("c40")).status).toBe("review");
    // Bob, the new owner, neither built nor delegated it: he may.
    expect(
      (await as(BOB, "POST", "/api/cards/c40/opened", { filesShown: ["src/b.ts"] })).status,
    ).toBe(200);
    const accepted = await as(BOB, "POST", "/api/cards/c40/accept");
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await must("c40")).status).toBe("done");
    // Nothing pushed the assignee back: the tracker still names Bob.
    expect((api.issues.get(n)?.assignee as { login: string }).login).toBe("bob-gh");
  });
});
