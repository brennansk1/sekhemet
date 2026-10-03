import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { acceptCard, recordReviewOpened } from "../src/accept.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";

/**
 * A real project for the release and push tests (C2b; DoD §2A): a git
 * repository on `main` with a bare remote as `origin`, a real SQLite ledger,
 * the board, and issues built on their own branches, verified and in Review,
 * each accepted by a person through the product's Accept.
 */
export interface ReleaseProject {
  dir: string;
  repo: string;
  remote: string;
  db: DatabaseSync;
  log: EventLog;
  store: CardStore;
  board: BoardServiceImpl;
  project: string;
  git: (...args: string[]) => string;
  remoteGit: (...args: string[]) => string;
  /** An issue built on its branch (one file), verified and waiting in Review. */
  review: (id: string, title: string) => Promise<void>;
  /** A person opens the issue's change and accepts it; returns the squash sha. */
  accept: (id: string) => Promise<string>;
  close: () => void;
}

export async function releaseProject(name = "Timesheet"): Promise<ReleaseProject> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sek-release-")));
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(repo);
  const run = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => run(repo, args);
  const remoteGit = (...args: string[]) => run(dir, ["--git-dir", remote, ...args]);
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: init");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  const board = new BoardServiceImpl(store, { entryConditions: true });
  const project = (await store.ensureProject({ rootPath: repo, name })).id;
  const adapter = new NodeGitSyncAdapter(repo);
  let n = 0;

  const review = async (id: string, title: string) => {
    const file = `src/${id}.ts`;
    await store.createCard({
      id,
      tier: "story",
      title,
      scopeFiles: ["src/**"],
      projectId: project,
    });
    const wt = await adapter.createWorktree(id, "main", title);
    write(wt, file, `export const v${n++} = ${n};\n`);
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
      filesTouched: [file],
      linesAdded: 1,
      linesRemoved: 0,
      diff: `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+x\n`,
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
      filesTouched: [file],
    });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  };

  const accept = async (id: string) => {
    const ctx = { repoPath: repo, cardStore: store, boardService: board, eventLog: log };
    const card = await store.getCard(id);
    if (!card) throw new Error(`no card ${id}`);
    await recordReviewOpened(ctx, card, [`src/${id}.ts`]);
    return acceptCard(ctx, card, "human");
  };

  return {
    dir,
    repo,
    remote,
    db,
    log,
    store,
    board,
    project,
    git,
    remoteGit,
    review,
    accept,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
