import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { acceptBrief } from "@sekhemet/planner";
import { NodeGitSyncAdapter, readBranchFile } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The dashboard's own browser modules, as the page runs them.
import { shownFiles } from "../../../packages/ui/web/diff_parse.js";
import { reportOpened } from "../../../packages/ui/web/opened.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * RG-N5-5 on the dashboard, end to end: a real repository, a real ledger, a
 * real server. Accept is refused until the page records the files it showed
 * (`POST /api/cards/<id>/opened`); once it has, Accept from the dashboard merges.
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
/** dom.js's postJSON, against this server. */
const post = async (path: string, body?: unknown) => {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(url(""))) },
    body: JSON.stringify(body ?? {}),
  });
  return { ok: res.ok, status: res.status, data: (await res.json()) as Record<string, unknown> };
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-dash-accept-"));
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
  const board = new BoardServiceImpl(store, { entryConditions: true });

  // A card built on its branch, verified, its evidence on the ledger, in Review.
  const adapter = new NodeGitSyncAdapter(repo);
  await store.createCard({ id: "d1", tier: "story", title: "Card d1", scopeFiles: ["src/**"] });
  const wt = await adapter.createWorktree("d1", "main", "Card d1");
  write(wt, "src/b.ts", "export const b = 2;\n");
  await adapter.commitCheckpoint({
    cardId: "d1",
    step: 1,
    gateStatus: "pass",
    agentModel: "nail",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: "ev_d1",
    cardId: "d1",
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
    repoState: await adapter.getRepoStateHash("d1"),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(repo, ".sekhemet", "evidence", "ev_d1.json"), body);
  writeFileSync(join(repo, ".sekhemet", "evidence", "latest-d1.json"), body);
  await recordLedgerRun(store, {
    cardId: "d1",
    modelId: "nail",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: "ev_d1",
    path: join(".sekhemet", "evidence", "ev_d1.json"),
    body,
    filesTouched: ["src/b.ts"],
  });
  await store.updateCardStatus("d1", "review", "verified", "harness", { override: true });
  server = await startDashboardServer({
    db,
    log,
    boardService: board,
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

describe("RG-N5-5: Accept from the dashboard once the page has recorded what it showed", () => {
  it("refuses an Accept before the files are shown, naming them; merges after the page posts /opened", async () => {
    const refused = await post("/api/cards/d1/accept");
    expect(refused.status).toBe(409);
    expect(String(refused.data.error)).toContain("src/b.ts");
    expect((await store.getCard("d1"))?.status).toBe("review");

    // The page loads the evidence it renders and records the expanded diffs.
    const evidence = await (await fetch(url("/api/evidence/d1"))).json();
    const card = (await (await fetch(url("/api/cards/d1"))).json()).card;
    const files = shownFiles(evidence, { card });
    expect(files).toEqual(["src/b.ts"]);
    expect(await reportOpened("d1", evidence.id, files, post)).toBe(true);
    const opened = await store.cardEvents("d1", ["review/opened"]);
    expect(opened.at(-1)?.payload).toMatchObject({ filesShown: ["src/b.ts"], evidence: "ev_d1" });

    const accepted = await post("/api/cards/d1/accept");
    expect(accepted.status).toBe(200);
    expect(accepted.data).toMatchObject({ ok: true, status: "done" });
    expect(git("rev-parse", "main")).toBe(accepted.data.sha);
    expect((await store.getCard("d1"))?.status).toBe("done");
    // The person's checkout is on main, which moved: the toast says how to catch up.
    expect(String(accepted.data.notice)).toMatch(/is on main, which moved.*read-tree -m -u/);
  });

  it("DS-N3-1: a person's Accept from the dashboard exports the project documents after the squash", async () => {
    const projectId = (await store.ensureProject({ rootPath: repo, name: "Recipes" })).id;
    await acceptBrief(
      { store, log },
      {
        projectId,
        baseline: "Recipes live in a shared spreadsheet",
        slices: [
          {
            title: "Walking skeleton",
            appetite: { cards: 6 },
            requirements: [{ key: "save", title: "Save a recipe" }],
          },
        ],
      },
      store.localPrincipal(),
    );
    expect((await post("/api/cards/d1/opened", { filesShown: ["src/b.ts"] })).ok).toBe(true);
    const accepted = await post("/api/cards/d1/accept");
    expect(accepted.status).toBe(200);
    expect(git("rev-parse", "main^")).toBe(accepted.data.sha);
    expect(readBranchFile(repo, "main", "docs/product/requirements.md")).toContain("Save a recipe");
  });

  it("refuses the /opened record from a page that is not the dashboard", async () => {
    const res = await fetch(url("/api/cards/d1/opened"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filesShown: ["src/b.ts"] }),
    });
    expect(res.status).toBe(403);
    expect(await store.cardEvents("d1", ["review/opened"])).toEqual([]);
  });
});
