import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { acceptBrief } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import { contextForCard } from "../src/card_root.js";
import { acceptCard, executeCard, regateRestackedChild } from "../src/execute.js";
import { main } from "../src/index.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { checkMain } from "../src/project_done.js";
import { startDashboardServer } from "../src/server.js";
import { registerProject } from "../src/workspace_locator.js";

/**
 * Runtime item 2a, NEW-runtime-16 (RUN-79, RUN-80) with security item 10a
 * (SEC-N13-1): one server, many project roots. One card in each of two
 * projects of one workspace runs through `executeCard` from the server's
 * folder and is accepted through `acceptCard`; each builds, checks and merges
 * in its own repository, the other repository's refs and files stay as they
 * were, and the workspace's evidence stays beside its ledger. A check of
 * project B's that tries to read project A's root or the workspace's ledger
 * passes only when the sandbox denies the read. Real git, a real ledger and
 * the real sandbox; the model is scripted.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A gate that passes only when reading `path` is refused (security item 10a). */
const deniedRead = (id: string, path: string) =>
  `[[gate]]\nid = "${id}"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "try { require('fs').readFileSync(${JSON.stringify(path).replace(/"/g, "'")}); process.exit(1) } catch { process.exit(0) }"]\ntimeout_s = 30\nparser = "generic"\n`;

function repo(dir: string, gates: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "src", "seed.ts"), "export const seed = 1;\n");
  writeFileSync(
    join(dir, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n${gates}`,
  );
  writeFileSync(join(dir, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return realpathSync(dir);
}

/** A repository's refs and its tracked files at main, for before-and-after comparison. */
function snapshot(dir: string): { refs: string; files: string } {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  return {
    refs: git("for-each-ref", "--format=%(refname) %(objectname)"),
    files: git("ls-tree", "-r", "main"),
  };
}

const writes = (file: string, text: string) =>
  new MockInferenceAdapter("scripted", [
    {
      text: "",
      toolCalls: [
        { id: "1", name: "write_file", arguments: { path: file, content: text } },
        { id: "2", name: "finish_card", arguments: {} },
      ],
      usage: { promptTokens: 10, completionTokens: 10, durationMs: 1 },
    },
  ]);

describe("one server, many project roots (RUN-79, RUN-80)", () => {
  let root: string;
  let ws: string;
  let b: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let ctx: {
    repoPath: string;
    restrictedMode: boolean;
    cardStore: CardStore;
    boardService: BoardServiceImpl;
    log: (line: string) => void;
    headroomCheck: boolean;
  };
  let aId: string;
  let bId: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sek-ws-runs-")));
    dirs.push(root);
    ws = repo(join(root, "alpha"), "");
    // Project B's checks read project A's root and the workspace's ledger: they
    // pass only where the sandbox refuses both reads (SEC-N13-1).
    b = repo(
      join(root, "beta"),
      deniedRead("no-alpha", join(root, "alpha", "src", "seed.ts")) +
        deniedRead("no-ledger", join(root, "alpha", ".sekhemet", "events.db")),
    );
    ({ db, log } = openLocalLedger(ws));
    cardStore = new CardStore(db, log);
    cardStore.workspaceFolder = ws;
    aId = (await cardStore.ensureProject({ rootPath: ws, name: "Alpha" })).id;
    bId = (await registerProject(cardStore, log, ws, { rootPath: b, name: "Beta" })).id;
    ctx = {
      // The server's folder: the workspace folder, which is project A's root.
      repoPath: ws,
      restrictedMode: false,
      cardStore,
      boardService: new BoardServiceImpl(cardStore),
      log: () => {},
      headroomCheck: false,
    };
  });
  afterEach(() => db.close());

  it("RUN-79: a card of project B runs, is checked and merges in B's repository from the server's folder; A's repository is untouched", async () => {
    const card = await cardStore.createCard({
      id: "b1",
      tier: "task",
      title: "Write b",
      scopeFiles: ["src/b.ts"],
      stepBudget: 4,
      spec: "Write src/b.ts",
      projectId: bId,
    });
    const alphaBefore = snapshot(ws);
    const result = await executeCard(ctx, card, writes("src/b.ts", "export const b = 2;\n"));
    expect(result.passed, JSON.stringify(result.gateResult?.failures ?? result.stopReason)).toBe(
      true,
    );
    // Its worktree was in B's root, never in the server's folder.
    expect(existsSync(join(ws, ".sekhemet", "worktrees", "b1"))).toBe(false);
    // The workspace's evidence and transcripts are beside its ledger, not in B.
    expect(existsSync(join(ws, ".sekhemet", "evidence", "latest-b1.json"))).toBe(true);
    expect(existsSync(join(b, ".sekhemet", "evidence"))).toBe(false);
    expect(existsSync(join(b, ".sekhemet", "events.db"))).toBe(false);
    // B's checks ran in B, under item 10a: both refused reads passed.
    const evidence = JSON.parse(
      readFileSync(join(ws, ".sekhemet", "evidence", "latest-b1.json"), "utf8"),
    ) as { rungResults?: { gate: string; passed: boolean; skipped?: boolean }[] };
    const ran = (evidence.rungResults ?? []).filter((r) => r.passed && !r.skipped);
    expect(ran.map((r) => r.gate)).toEqual(expect.arrayContaining(["no-alpha", "no-ledger"]));
    const reviewed = await cardStore.getCard("b1");
    expect(reviewed?.status).toBe("review");
    await recordReviewOpened(ctx, reviewed as NonNullable<typeof reviewed>, ["src/b.ts"]);
    const sha = await acceptCard(ctx, reviewed as NonNullable<typeof reviewed>);
    // Merged into B's main; A's refs and files exactly as before.
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: b, encoding: "utf8" }).trim()).toBe(
      sha,
    );
    expect(execFileSync("git", ["show", "main:src/b.ts"], { cwd: b, encoding: "utf8" })).toBe(
      "export const b = 2;\n",
    );
    expect(snapshot(ws)).toEqual(alphaBefore);
  });

  it("RUN-79: a card of project A, the workspace folder's own, leaves B's repository untouched", async () => {
    const card = await cardStore.createCard({
      id: "a1",
      tier: "task",
      title: "Write a",
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
      spec: "Write src/a.ts",
      projectId: aId,
    });
    const betaBefore = snapshot(b);
    const result = await executeCard(ctx, card, writes("src/a.ts", "export const a = 1;\n"));
    expect(result.passed).toBe(true);
    const reviewed = await cardStore.getCard("a1");
    await recordReviewOpened(ctx, reviewed as NonNullable<typeof reviewed>, ["src/a.ts"]);
    const sha = await acceptCard(ctx, reviewed as NonNullable<typeof reviewed>);
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: ws, encoding: "utf8" }).trim()).toBe(
      sha,
    );
    expect(snapshot(b)).toEqual(betaBefore);
    expect(existsSync(join(b, ".sekhemet", "worktrees", "a1"))).toBe(false);
  });

  it("SEC-N13-1 at Accept: a parent's integration checks in B see only B, from the server's folder", async () => {
    await cardStore.createCard({ id: "pb", tier: "story", title: "Parent", projectId: bId });
    const card = await cardStore.createCard({
      id: "b1",
      tier: "task",
      title: "Write b",
      scopeFiles: ["src/b.ts"],
      stepBudget: 4,
      spec: "Write src/b.ts",
      projectId: bId,
      parentId: "pb",
    });
    const result = await executeCard(ctx, card, writes("src/b.ts", "export const b = 2;\n"));
    expect(result.passed).toBe(true);
    const reviewed = await cardStore.getCard("b1");
    await recordReviewOpened(ctx, reviewed as NonNullable<typeof reviewed>, ["src/b.ts"]);
    await acceptCard(ctx, reviewed as NonNullable<typeof reviewed>);
    // The rollup's integration run is in a scratch checkout of B's main: its
    // checks that read A's root and the workspace's ledger pass only when refused.
    const [rollup] = await cardStore.eventsOfType(["card/rollup"]);
    expect(rollup?.payload).toMatchObject({ id: "pb", passed: true, failures: [] });
  });

  it("SEC-N13-1 at a restack: a restacked child's checks in B see only B", async () => {
    const child = await cardStore.createCard({
      id: "b2",
      tier: "task",
      title: "Stacked",
      projectId: bId,
    });
    const r = await regateRestackedChild(contextForCard(ctx, child), child, "main");
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("SUR-75: `sekhemet gate <card>` from the workspace folder runs a B card's checks in B, under item 10a", async () => {
    const card = await cardStore.createCard({
      id: "b3",
      tier: "task",
      title: "Write b",
      scopeFiles: ["src/b.ts"],
      stepBudget: 4,
      spec: "Write src/b.ts",
      projectId: bId,
    });
    const result = await executeCard(ctx, card, writes("src/b.ts", "export const b = 3;\n"));
    expect(result.passed).toBe(true);
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const before = process.exitCode;
    try {
      await main(["gate", "b3", "--repo", ws]);
      expect(out.join("\n")).not.toMatch(/No worktree for b3/);
      expect(out.join("\n")).toContain(join(b, ".sekhemet", "worktrees", "b3"));
      expect(out.join("\n")).toMatch(/✓ no-alpha/);
      expect(out.join("\n")).toMatch(/✓ no-ledger/);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      spy.mockRestore();
      err.mockRestore();
      process.exitCode = before;
    }
  }, 60_000);

  it("RUN-79: GET /api/cards/:id/diff reads a B card's branch in B's repository", async () => {
    const card = await cardStore.createCard({
      id: "b4",
      tier: "task",
      title: "Write b",
      scopeFiles: ["src/b.ts"],
      stepBudget: 4,
      spec: "Write src/b.ts",
      projectId: bId,
    });
    const result = await executeCard(ctx, card, writes("src/b.ts", "export const b = 4;\n"));
    expect(result.passed).toBe(true);
    const server = await startDashboardServer({
      db,
      log,
      boardService: ctx.boardService,
      cardStore,
      repoPath: ws,
      port: 0,
      streamIntervalMs: 1000,
    });
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/cards/b4/diff`);
      expect(r.status).toBe(200);
      expect(JSON.stringify(await r.json())).toContain("src/b.ts");
    } finally {
      await server.close();
    }
  });

  it("SEC-N13-1 at the main check: B's checks on its integration branch see only B, from the server's folder", async () => {
    await acceptBrief(
      { store: cardStore, log },
      {
        projectId: bId,
        baseline: "By hand",
        slices: [{ title: "One", appetite: { cards: 2 }, requirements: [{ title: "Do b" }] }],
      },
      cardStore.localPrincipal(),
    );
    const r = await checkMain({ repoPath: ws, cardStore, log }, { projectId: bId });
    const headB = execFileSync("git", ["rev-parse", "main"], { cwd: b, encoding: "utf8" }).trim();
    expect(r.check).toMatchObject({ sha: headB, projectId: bId, gatesPassed: true });
  }, 60_000);
});
