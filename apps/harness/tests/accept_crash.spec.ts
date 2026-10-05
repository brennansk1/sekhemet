import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPT_STARTED,
  AcceptRefusedError,
  acceptCard,
  reconcileAccepts,
  recordReviewOpened,
} from "../src/accept.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { supervisorStart } from "../src/supervisor.js";

// review-git NEW-review-git-8 (RG-N8-1 to -3; FINDINGS_C1 REL-02) and
// kernel K-N11-2: a crash between Accept's merge and its record leaves the
// integration branch with a squash the log does not know; the start-up sweep
// reconciles it from the repository. The crash is real (DEFINITION_OF_DONE
// §2A): Accept runs in its own process against the real repository and the
// real ledger, the test holds the ledger's write lock once `card/accept_started`
// is committed so the process waits at its next append, and kills it with
// SIGKILL once the integration branch has moved. Then the WAL is cut at its
// frames, as a power cut would leave it, and the sweep runs on each copy.

const root = resolve(import.meta.dirname, "../../..");
const dist = {
  kernel: join(root, "packages/kernel/dist/index.js"),
  board: join(root, "packages/board/dist/index.js"),
  accept: join(root, "apps/harness/dist/accept.js"),
};
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (base: string, rel: string, text: string) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), text);
};

/** A repository with card `id` built, verified and In review, its evidence on the ledger. */
async function cardInReview(id: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sek-acc-crash-")));
  dirs.push(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(repo, ".sekhemet"));
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  const board = new BoardServiceImpl(store, { entryConditions: true });
  const adapter = new NodeGitSyncAdapter(repo);
  await store.createCard({ id, tier: "story", title: `Card ${id}`, scopeFiles: ["src/**"] });
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
    rungResults: [
      { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0, durationMs: 9 },
    ],
    filesTouched: ["src/b.ts"],
    linesAdded: 1,
    linesRemoved: 0,
    settings: { modelId: "nail" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "nail",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: evidence.filesTouched,
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  const card = await store.getCard(id);
  if (card)
    await recordReviewOpened({ repoPath: repo, cardStore: store, boardService: board }, card, [
      "src/b.ts",
    ]);
  db.close();
  return { repo, git };
}

/** Accept in a process of its own; it prints `accepted <sha>`, then waits to be killed. */
function acceptProcess(repo: string, id: string): ChildProcess {
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const { CardStore, EventLog, initSchema } = await import(${JSON.stringify(dist.kernel)});
    const { BoardServiceImpl } = await import(${JSON.stringify(dist.board)});
    const { acceptCard } = await import(${JSON.stringify(dist.accept)});
    const db = new DatabaseSync(${JSON.stringify(join(repo, ".sekhemet", "events.db"))});
    initSchema(db);
    // Checkpoints off, so a power cut can lose the last commits from the WAL.
    db.exec("PRAGMA wal_autocheckpoint = 0");
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const board = new BoardServiceImpl(store, { entryConditions: true });
    const card = await store.getCard(${JSON.stringify(id)});
    const sha = await acceptCard({ repoPath: ${JSON.stringify(repo)}, cardStore: store, boardService: board }, card);
    console.log("accepted " + sha);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SEKHEMET_MODEL_LOADS: "off" },
  });
  children.push(child);
  return child;
}

function openStore(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  return { db, log, store, board: new BoardServiceImpl(store, { entryConditions: true }) };
}

const typesOf = (db: DatabaseSync, cardId: string): string[] =>
  (
    db.prepare("SELECT type FROM events WHERE card_id = ? ORDER BY seq").all(cardId) as {
      type: string;
    }[]
  ).map((r) => r.type);

/**
 * Accept `id` in its own process and kill it with SIGKILL after its merge
 * lands and before `card/accepted` is recorded; returns the squash on main.
 */
async function crashBetweenMergeAndRecord(
  repo: string,
  git: (...a: string[]) => string,
  id: string,
): Promise<{ before: string; merged: string }> {
  const before = git("rev-parse", "main");
  const dbPath = join(repo, ".sekhemet", "events.db");
  const watcher = new DatabaseSync(dbPath);
  watcher.exec("PRAGMA busy_timeout = 5000");
  const child = acceptProcess(repo, id);
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  // Hold the ledger's write lock the moment accept_started is committed.
  const started = Date.now();
  let locked = false;
  while (Date.now() - started < 20_000) {
    const row = watcher
      .prepare("SELECT seq FROM events WHERE type = ? AND card_id = ?")
      .get(ACCEPT_STARTED, id);
    if (row) {
      watcher.exec("BEGIN IMMEDIATE");
      locked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(locked, stderr).toBe(true);
  // The process merges, then waits at its next append; kill it once main moved.
  const until = Date.now() + 4_000;
  while (git("rev-parse", "main") === before && Date.now() < until)
    await new Promise((r) => setTimeout(r, 5));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  watcher.exec("ROLLBACK");
  watcher.close();
  return { before, merged: git("rev-parse", "main") };
}

describe("RG-N8-1, RG-N8-2: a crash between Accept's merge and its record", () => {
  it("the merge lands, the process is killed before card/accepted, and the start-up sweep reconciles it", async () => {
    const { repo, git } = await cardInReview("c1");
    const dbPath = join(repo, ".sekhemet", "events.db");
    const { before, merged } = await crashBetweenMergeAndRecord(repo, git, "c1");
    expect(merged).not.toBe(before);
    expect(git("rev-parse", "main^")).toBe(before);
    expect(git("log", "-1", "--format=%B", "main")).toMatch(/Card: c1/);

    const s = openStore(dbPath);
    expect(typesOf(s.db, "c1")).toContain(ACCEPT_STARTED);
    expect(typesOf(s.db, "c1")).not.toContain("card/accepted");
    expect((await s.store.getCard("c1"))?.status).toBe("review");
    // The next start's sweep (runtime item 10) finds the squash on main.
    const start = await supervisorStart({
      repoPath: repo,
      cardStore: s.store,
      log: s.log,
      boardService: s.board,
    });
    expect(start.accepts).toEqual([{ cardId: "c1", reconciled: merged }]);
    expect((await s.store.getCard("c1"))?.status).toBe("done");
    const accepted = (await s.store.cardEvents("c1", ["card/accepted"])).map((e) => e.payload);
    expect(accepted).toEqual([
      expect.objectContaining({ id: "c1", sha: merged, reconciled: true, integration: "main" }),
    ]);
    expect(s.store.verifyLedger().valid).toBe(true);
    // A second sweep finds nothing left to do.
    expect(await reconcileAccepts(repo, s.store, s.board)).toEqual([]);
    s.db.close();
  }, 60_000);

  it("RG-N8-2: an accept_started whose squash never reached main is recorded as failed; the card stays in Review", async () => {
    const { repo, git } = await cardInReview("c2");
    const s = openStore(join(repo, ".sekhemet", "events.db"));
    const base = git("rev-parse", "main");
    // What Accept records before its merge, with the process then lost before it.
    await s.store.recordEvent({
      type: ACCEPT_STARTED,
      cardId: "c2",
      actor: "human",
      principal: s.store.localPrincipal(),
      payload: {
        id: "c2",
        base,
        branch: new NodeGitSyncAdapter(repo).cardBranch("c2") as string,
        branchHead: git("rev-parse", "HEAD"),
        squashTree: git("rev-parse", "HEAD^{tree}"),
        integration: "main",
        principal: s.store.localPrincipal(),
      },
    });
    expect(await reconcileAccepts(repo, s.store, s.board)).toEqual([
      { cardId: "c2", failed: "merge_missing" },
    ]);
    expect((await s.store.getCard("c2"))?.status).toBe("review");
    expect(git("rev-parse", "main")).toBe(base);
    expect((await s.store.cardEvents("c2", ["card/accept_failed"])).map((e) => e.payload)).toEqual([
      { id: "c2", reason: "merge_missing", integration: "main" },
    ]);
    expect(await reconcileAccepts(repo, s.store, s.board)).toEqual([]);
    s.db.close();
  }, 60_000);
});

describe("K-N11-2, RG-N8-3: the sweep after a reopened, cut WAL", () => {
  it("an Accept whose card/accepted the cut lost is reconciled from the repository", async () => {
    const { repo, git } = await cardInReview("c3");
    const dbPath = join(repo, ".sekhemet", "events.db");
    const child = acceptProcess(repo, "c3");
    const said = await new Promise<string>((ok, bad) => {
      let out = "";
      child.stdout?.on("data", (d) => {
        out += String(d);
        if (/accepted [0-9a-f]+/.test(out)) ok(out);
      });
      child.once("exit", (code) => bad(new Error(`accept exited ${code}: ${out}`)));
    });
    const sha = /accepted ([0-9a-f]+)/.exec(said)?.[1] as string;
    expect(git("rev-parse", "main")).toBe(sha);
    // Power cut: the process dies with its WAL unmerged into the database.
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    const wal = statSync(`${dbPath}-wal`).size;
    const header = 32;
    // The WAL header's page size (bytes 8-11, big-endian).
    const pageSize = readFileSync(`${dbPath}-wal`).readUInt32BE(8);
    const frame = 24 + pageSize;
    const frames = Math.floor((wal - header) / frame);
    // The longest prefix of whole frames that keeps accept_started but lost card/accepted.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sek-acc-cut-")));
    dirs.push(dir);
    let found: string | undefined;
    for (let k = frames; k >= 0 && !found; k--) {
      const copy = join(dir, `cut-${k}.db`);
      copyFileSync(dbPath, copy);
      copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
      truncateSync(`${copy}-wal`, header + k * frame);
      const db = new DatabaseSync(copy);
      const types = typesOf(db, "c3");
      db.close();
      if (types.includes(ACCEPT_STARTED) && !types.includes("card/accepted")) found = copy;
    }
    expect(found).toBeDefined();
    const s = openStore(found as string);
    expect(s.store.verifyLedger().valid).toBe(true);
    expect((await s.store.getCard("c3"))?.status).toBe("review");
    expect(await reconcileAccepts(repo, s.store, s.board)).toEqual([
      { cardId: "c3", reconciled: sha },
    ]);
    expect((await s.store.getCard("c3"))?.status).toBe("done");
    expect(s.store.verifyLedger().valid).toBe(true);
    s.db.close();
  }, 60_000);
});

/**
 * Most Accepts are made on the dashboard (C4 review). A dashboard-only setup
 * runs no queue, so the start-up sweep must also run when the server starts
 * (RG-N8-3: "WHEN the ledger reopens"), and a second Accept of a card whose
 * first merge was never recorded must settle that first one rather than
 * stack a newer `card/accept_started` on it, whose own failure would make
 * the first look settled and leave its squash unrecorded for good.
 */
describe("RG-N8-3, RG-N8-5: the dashboard settles an Accept a crash left unrecorded", () => {
  it("the dashboard server's start settles it from the repository before it serves", async () => {
    const { repo, git } = await cardInReview("c4");
    const { merged } = await crashBetweenMergeAndRecord(repo, git, "c4");
    const s = openStore(join(repo, ".sekhemet", "events.db"));
    expect((await s.store.getCard("c4"))?.status).toBe("review");
    const server = await startDashboardServer({
      db: s.db,
      log: s.log,
      boardService: s.board,
      cardStore: s.store,
      repoPath: repo,
      port: 0,
    });
    try {
      const board = (await (await fetch(`${server.address}/api/board`)).json()) as unknown;
      expect(JSON.stringify(board)).toContain("c4");
      expect((await s.store.getCard("c4"))?.status).toBe("done");
      expect((await s.store.cardEvents("c4", ["card/accepted"])).map((e) => e.payload)).toEqual([
        expect.objectContaining({ id: "c4", sha: merged, reconciled: true }),
      ]);
    } finally {
      await server.close();
    }
    expect(s.store.verifyLedger().valid).toBe(true);
    s.db.close();
  }, 60_000);

  it("a second Accept settles the first merge's record instead of squashing again", async () => {
    const { repo, git } = await cardInReview("c5");
    const { merged } = await crashBetweenMergeAndRecord(repo, git, "c5");
    const s = openStore(join(repo, ".sekhemet", "events.db"));
    const card = await s.store.getCard("c5");
    expect(card?.status).toBe("review");
    const err = await acceptCard(
      { repoPath: repo, cardStore: s.store, boardService: s.board, report: () => {} },
      card as NonNullable<typeof card>,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcceptRefusedError);
    expect(String((err as Error).message)).toMatch(
      new RegExp(`c5 was already accepted: its squash ${merged.slice(0, 10)}`),
    );
    expect(git("rev-parse", "main")).toBe(merged);
    expect((await s.store.getCard("c5"))?.status).toBe("done");
    expect(typesOf(s.db, "c5").filter((t) => t === ACCEPT_STARTED)).toHaveLength(1);
    expect((await s.store.cardEvents("c5", ["card/accepted"])).map((e) => e.payload)).toEqual([
      expect.objectContaining({ id: "c5", sha: merged, reconciled: true }),
    ]);
    s.db.close();
  }, 60_000);
});
