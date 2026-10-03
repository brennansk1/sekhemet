import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * NEW-dashboard-21 (FINDINGS ISS-04; DEC-51) over HTTP against a real Solo
 * server, a real repository and a real ledger (DoD §2A): Won't do
 * (`reject`), Reopen (`reopen`, new) and Revert (`revert`), the routes the
 * dashboard's issue actions call.
 * - DB-N21-1: Won't do needs a reason and is offered from Backlog, To do,
 *   In review and On hold only;
 * - DB-N21-2: Reopen moves a Won't do issue to To do;
 * - DB-N21-3: Revert adds a revert commit of the squash, moves the issue to
 *   To do and records `card/reverted` with both shas; the review desk says
 *   whether the viewer may revert, from the same rule the route enforces;
 * - DB-N21-4: a revert git cannot apply leaves the issue in Done, adds no
 *   commit and names the files.
 */
let repo: string;
let db: DatabaseSync;
let store: CardStore;
let log: EventLog;
let server: { port: number; close: () => Promise<void> };
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = async (path: string, body?: unknown) => {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(url(""))) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
};
const status = async (id: string) => (await store.getCard(id))?.status;

/** A card built on its branch, its evidence on the ledger, in Review. */
async function builtInReview(id: string, file: string, text: string): Promise<void> {
  const adapter = new NodeGitSyncAdapter(repo);
  await store.createCard({ id, tier: "story", title: `Card ${id}`, scopeFiles: ["src/**"] });
  const wt = await adapter.createWorktree(id, "main", `Card ${id}`);
  write(wt, file, text);
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "stand-in",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
    filesTouched: [file],
    linesAdded: 1,
    linesRemoved: 0,
    diff: "",
    settings: { modelId: "stand-in" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(repo, ".sekhemet", "evidence", `ev_${id}.json`), body);
  writeFileSync(join(repo, ".sekhemet", "evidence", `latest-${id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "stand-in",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: `ev_${id}`,
    path: join(".sekhemet", "evidence", `ev_${id}.json`),
    body,
    filesTouched: [file],
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}

/** Accept a card in Review from the dashboard, as Review does. */
async function acceptFromDashboard(id: string, file: string): Promise<string> {
  expect((await post(`/api/cards/${id}/opened`, { filesShown: [file] })).status).toBe(200);
  const accepted = await post(`/api/cards/${id}/accept`);
  expect(accepted.status, String(accepted.data.error)).toBe(200);
  return String(accepted.data.sha);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-issue-actions-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store, { entryConditions: true }),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 10_000,
  });
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("DB-N21-1: Won't do, with a reason, from Backlog, To do, In review and On hold", () => {
  it("refuses a Won't do with no reason and leaves the issue where it was", async () => {
    await store.createCard({ id: "w1", tier: "story", title: "Export to CSV", status: "ready" });
    const res = await post("/api/cards/w1/reject", { reason: "  " });
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toMatch(/reason/i);
    expect(await status("w1")).toBe("ready");
  });

  it("moves an issue in each allowed column to Won't do, and refuses one In progress", async () => {
    for (const [id, from] of [
      ["b1", "backlog"],
      ["r1", "ready"],
      ["v1", "review"],
      ["p1", "parked"],
    ] as const) {
      await store.createCard({ id, tier: "story", title: `Issue ${id}`, status: "ready" });
      if (from !== "ready")
        await store.updateCardStatus(id, from, "setup", "harness", { override: true });
      const res = await post(`/api/cards/${id}/reject`, { reason: "Out of scope this quarter" });
      expect(res.status, `${from}: ${String(res.data.error)}`).toBe(200);
      expect(res.data).toMatchObject({ ok: true, status: "rejected" });
      expect(await status(id)).toBe("rejected");
    }
    await store.createCard({ id: "ip", tier: "story", title: "Running", status: "ready" });
    await store.updateCardStatus("ip", "in_progress", "setup", "harness", { override: true });
    const refused = await post("/api/cards/ip/reject", { reason: "No longer needed" });
    expect(refused.status).toBe(409);
    expect(String(refused.data.error)).toContain("In progress");
    expect(await status("ip")).toBe("in_progress");
  });
});

describe("DB-N21-2: Reopen moves a Won't do issue to To do", () => {
  it("reopens over POST /api/cards/:id/reopen, and refuses an issue that is not Won't do", async () => {
    await store.createCard({ id: "o1", tier: "story", title: "Dark mode", status: "ready" });
    expect((await post("/api/cards/o1/reject", { reason: "Not now" })).status).toBe(200);
    const reopened = await post("/api/cards/o1/reopen");
    expect(reopened.status, String(reopened.data.error)).toBe(200);
    expect(reopened.data).toMatchObject({ ok: true, status: "ready" });
    expect(await status("o1")).toBe("ready");
    const moves = await store.cardEvents("o1", ["card/status_changed"]);
    expect(moves.at(-1)?.payload).toMatchObject({ fromStatus: "rejected", toStatus: "ready" });

    const again = await post("/api/cards/o1/reopen");
    expect(again.status).toBe(409);
    expect(String(again.data.error)).toMatch(/Won't do/);
    expect(await status("o1")).toBe("ready");
  });

  it("refuses a Reopen from a page that is not the dashboard", async () => {
    await store.createCard({ id: "o2", tier: "story", title: "Dark mode", status: "ready" });
    await post("/api/cards/o2/reject", { reason: "Not now" });
    const res = await fetch(url("/api/cards/o2/reopen"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await status("o2")).toBe("rejected");
  });
});

describe("DB-N21-3: Revert adds a revert commit, moves the issue to To do and records both shas", () => {
  it("reverts an accepted issue and says on the review desk that this person may revert", async () => {
    await builtInReview("d1", "src/b.ts", "export const b = 2;\n");
    const squash = await acceptFromDashboard("d1", "src/b.ts");
    expect(await status("d1")).toBe("done");

    const desk = (await (await fetch(url("/api/cards/d1/review"))).json()) as {
      revert?: { may: boolean };
    };
    expect(desk.revert).toEqual({ may: true });

    const res = await post("/api/cards/d1/revert", { reason: "Broke the export" });
    expect(res.status, String(res.data.error)).toBe(200);
    expect(res.data).toMatchObject({ ok: true, status: "ready" });
    const revertSha = String(res.data.sha);
    expect(git("rev-parse", "main")).toBe(revertSha);
    expect(git("rev-parse", "main^")).toBe(squash);
    expect(git("log", "-1", "--format=%B", "main")).toContain(`This reverts commit ${squash}`);
    expect(git("ls-tree", "--name-only", "-r", "main")).not.toContain("src/b.ts");
    expect(await status("d1")).toBe("ready");
    const reverted = await store.cardEvents("d1", ["card/reverted"]);
    expect(reverted.at(-1)?.payload).toMatchObject({ id: "d1", sha: squash, revertSha });
  });

  it("refuses a revert of an issue that is not Done", async () => {
    await store.createCard({ id: "nd", tier: "story", title: "Not done", status: "ready" });
    const res = await post("/api/cards/nd/revert");
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toMatch(/not Done/);
  });
});

describe("DB-N21-4: a revert git cannot apply changes nothing and names the files", () => {
  it("leaves the issue in Done, adds no commit, and answers with the conflicting files", async () => {
    await builtInReview("d2", "src/b.ts", "export const b = 2;\n");
    await acceptFromDashboard("d2", "src/b.ts");
    // A later change on main to the same line: the revert no longer applies.
    // (Accept moved main's ref; the checkout catches up first.)
    git("reset", "-q", "--hard", "main");
    write(repo, "src/b.ts", "export const b = 3;\n");
    git("commit", "-q", "-am", "later change to b");
    const head = git("rev-parse", "main");

    const res = await post("/api/cards/d2/revert");
    expect(res.status).toBe(409);
    expect(res.data.files).toEqual(["src/b.ts"]);
    expect(String(res.data.error)).toContain("src/b.ts");
    expect(String(res.data.error)).toMatch(/stays in Done/);
    expect(String(res.data.error)).not.toMatch(/Review/);
    expect(git("rev-parse", "main")).toBe(head);
    expect(await status("d2")).toBe("done");
    expect(await store.cardEvents("d2", ["card/reverted"])).toEqual([]);
  });
});
