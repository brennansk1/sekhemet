import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptCard, recordReviewOpened } from "../src/accept.js";
import { latestLedgerEvidence, recordLedgerRun } from "../src/ledger_evidence.js";

/**
 * NEW-review-git-2: after a parent is accepted, each stacked child rebases
 * onto the integration branch and re-runs its gates there; a child whose
 * gates now fail goes back to the Worker, never left in Review. Real git,
 * real gates, real SQLite (DoD §2A).
 */
let repo: string;
let db: DatabaseSync;
let store: CardStore;
let board: BoardServiceImpl;
let adapter: NodeGitSyncAdapter;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-restack-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  // One gate: it fails once src/breaker.ts exists.
  write(
    repo,
    ".sekhemet/gates.toml",
    `[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(require('fs').existsSync('src/breaker.ts') ? 1 : 0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  store = new CardStore(db, new EventLog(db));
  board = new BoardServiceImpl(store, { entryConditions: true, customLimits: { review: 5 } });
  adapter = new NodeGitSyncAdapter(repo);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

async function built(id: string, file: string, parentId?: string): Promise<void> {
  await store.createCard({
    id,
    tier: "story",
    title: `Card ${id}`,
    scopeFiles: ["src/**"],
    ...(parentId ? { parentId } : {}),
  });
  const wt = await adapter.createWorktree(id, "main", `Card ${id}`, parentId);
  write(wt, file, `export const x = "${id}";\n`);
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
    passed: true,
    rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, durationMs: 5 }],
    filesTouched: [file],
    settings: { modelId: "nail" },
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence)}\n`;
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
    filesTouched: [file],
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}

const ctx = () => ({ repoPath: repo, cardStore: store, boardService: board });

async function acceptParent(): Promise<void> {
  const parent = await store.getCard("par");
  if (!parent) throw new Error("no parent");
  await recordReviewOpened(ctx(), parent, ["src/p.ts"]);
  await acceptCard(ctx(), parent);
}

describe("NEW-review-git-2: restacked children re-run their gates", () => {
  it("RG-N2-1: a child that rebases cleanly gets new evidence from gates run on the rebased branch", async () => {
    await built("par", "src/p.ts");
    await built("kid", "src/c.ts", "par");
    const before = await latestLedgerEvidence(store, "kid");
    await acceptParent();
    const after = await latestLedgerEvidence(store, "kid");
    expect(after?.id).not.toBe(before?.id);
    expect(after?.passed).toBe(true);
    expect((await store.getCard("kid"))?.status).toBe("review");
    // The rebased branch holds only the child's own change against main.
    expect(
      git("diff", "--name-only", `main...sekhemet/${repo.split("/").at(-1)}/kid-card-kid`),
    ).toBe("src/c.ts");
    const [restacked] = await store.cardEvents("par", ["card/restacked"]);
    expect(restacked?.payload).toMatchObject({ ok: true, child: "kid" });
  });

  it("RG-N2-2: a child whose gates fail after the restack goes back to the Worker with the failures", async () => {
    await built("par", "src/p.ts");
    await built("kid", "src/c.ts", "par");
    // Another change lands on main before the parent's accept, breaking the child's gate.
    write(repo, "src/breaker.ts", "export const broken = true;\n");
    git("add", "src/breaker.ts");
    git("commit", "-q", "-m", "another accept");
    await acceptParent();
    const kid = await store.getCard("kid");
    expect(kid?.status).toBe("ready");
    const evidence = await latestLedgerEvidence(store, "kid");
    expect(evidence?.passed).toBe(false);
    const dossier = await store.getDossier("kid");
    expect(dossier.entries.map((e) => e.text).join("\n")).toMatch(/gates failed: \[unit\]/);
  });
});
