import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptCard, recordReviewOpened } from "../src/accept.js";
import { cardZeroCard, installScaffoldGate } from "../src/card_zero.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";

/**
 * design-stage DS-P2-1, -2: when a person accepts card zero, the project's
 * gates are derived from what its generator left on the accepted commit —
 * not only by the queue's next pass — and the generator and its versions go
 * into the brief. Real git, real SQLite (DoD §2A); nothing is downloaded.
 */
let repo: string;
let db: DatabaseSync;
let store: CardStore;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-card0-accept-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  installScaffoldGate(repo, "typescript");
  write(repo, ".sekhemet/brief.md", "# Brief\n\n## Constraints\n- TypeScript.\n");
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  store = new CardStore(db, new EventLog(db));
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("accepting card zero derives the project's gates (DS-P2-1, -2)", () => {
  it("replaces card zero's gate with the gates derived from the accepted commit", async () => {
    const adapter = new NodeGitSyncAdapter(repo);
    const card = await store.createCard({
      ...cardZeroCard("typescript"),
      id: "zero",
      tier: "task",
    });
    const wt = await adapter.createWorktree(card.id, "main", card.title);
    // What the generator leaves (its installed packages are ignored, never merged).
    write(
      wt,
      "package.json",
      JSON.stringify({
        name: "calc",
        version: "1.0.0",
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        devDependencies: { typescript: "^5.9.2", vitest: "^3.2.7" },
      }),
    );
    write(
      wt,
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "calc" },
          "node_modules/typescript": { version: "5.9.2" },
          "node_modules/vitest": { version: "3.2.7" },
        },
      }),
    );
    write(wt, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
    write(wt, ".gitignore", ".sekhemet/\nnode_modules\n");
    await adapter.commitCheckpoint({
      cardId: card.id,
      step: 1,
      gateStatus: "pass",
      agentModel: "nail",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const files = ["package.json", "package-lock.json", "tsconfig.json", ".gitignore"];
    const evidence = {
      id: "ev_zero",
      cardId: card.id,
      passed: true,
      rungResults: [
        { gate: "scaffold", rung: "test", layer: "functional", passed: true, durationMs: 5 },
      ],
      filesTouched: files,
      settings: { modelId: "nail" },
      repoState: await adapter.getRepoStateHash(card.id),
    };
    const body = `${JSON.stringify(evidence)}\n`;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
    await recordLedgerRun(store, {
      cardId: card.id,
      modelId: "nail",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: evidence.id,
      path: join(".sekhemet", "evidence", `${evidence.id}.json`),
      body,
      filesTouched: files,
    });
    await store.updateCardStatus(card.id, "review", "verified", "harness", { override: true });
    const ctx = {
      repoPath: repo,
      cardStore: store,
      boardService: new BoardServiceImpl(store, { entryConditions: true }),
    };
    await recordReviewOpened(ctx, (await store.getCard(card.id)) as never, files);
    await acceptCard(ctx, (await store.getCard(card.id)) as never);
    expect((await store.getCard(card.id))?.status).toBe("done");
    // The checkout on main still has its old files (accept moves the branch
    // by plumbing): the gates come from the accepted commit, not the checkout.
    const ids = loadGatesConfig(repo).gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["typecheck", "unit"]));
    expect(ids).not.toContain("scaffold");
    expect(readFileSync(join(repo, ".sekhemet", "brief.md"), "utf8")).toContain(
      "Generator: npm init, tsc --init and Vitest (TypeScript 5.9.2, Vitest 3.2.7)",
    );
  }, 60_000);
});
