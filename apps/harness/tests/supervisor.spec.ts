import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recordedReplayCases } from "@sekhemet/context";
import { BlobStore, type CardStore, EventLog, serializeContextPack } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCard } from "../src/execute.js";
import { initLocalKernel, main } from "../src/index.js";
import { Tracer } from "../src/tracing.js";

/**
 * The supervisor's start (runtime.md items 10, 33, 34; NEW-runtime-3 and
 * NEW-runtime-4), driven through `sekhemet queue` on real SQLite, real git
 * worktrees and real processes.
 */
const DIST = resolve(import.meta.dirname, "../dist");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "supervisor-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return repo;
}

/** `sekhemet queue` with its output captured; no Ready card loads no model. */
async function queue(repo: string): Promise<string> {
  const lines: string[] = [];
  const keep = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  try {
    await main(["queue", "--repo", repo]);
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join("\n");
}

function scripted(turn: (n: number) => Omit<ToolCall, "id">[]) {
  const seen: InferenceRequest[] = [];
  let n = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "scripted",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      n++;
      return {
        text: "",
        toolCalls: turn(n).map((c, i) => ({ id: `t${n}-${i}`, ...c })),
        usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

describe("NEW-runtime-3: crash recovery", () => {
  it("RUN-9, RUN-10, RUN-12: a runner killed with SIGKILL mid-card leaves no card In Progress and no orphan; the card resumes from its last completed step", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const card = await k.cardStore.createCard({
      id: "card_crash",
      tier: "story",
      title: "Write a (SPIDR: Path)",
      scopeFiles: ["src/a.ts"],
      acceptanceCriteria: ["exports a"],
      spec: "Write src/a.ts",
      status: "ready",
      stepBudget: 6,
    });
    k.db.close();
    const wt = join(repo, ".sekhemet", "worktrees", card.id);
    // Written in the worktree, the only place the confined command may write.
    const cmdPid = join(wt, "cmd.pid");
    const command = `node -e "require('fs').writeFileSync('cmd.pid', String(process.pid)); setTimeout(() => {}, 60000)"`;
    const script = join(repo, "runner.mjs");
    // A runner: two steps that write (a checkpoint each), then a command that
    // runs for a minute — during which the runner is killed.
    writeFileSync(
      script,
      `import { executeCard } from ${JSON.stringify(join(DIST, "execute.js"))};
       import { initLocalKernel } from ${JSON.stringify(join(DIST, "index.js"))};
       import { acquireRunnerLease } from ${JSON.stringify(join(DIST, "runner_lease.js"))};
       const repo = ${JSON.stringify(repo)};
       const got = acquireRunnerLease(repo, { kind: "run", cardId: "card_crash" });
       if ("holder" in got) process.exit(3);
       const { cardStore, boardService } = initLocalKernel(repo);
       let n = 0;
       const adapter = {
         modelId: "scripted",
         supportedArms: ["arm_a_flat"],
         generate: async () => {
           n++;
           const calls = n <= 2
             ? [{ name: "write_file", arguments: { path: "src/a.ts", content: "export const a = " + n + ";\\n" } }]
             : [{ name: "run_cmd", arguments: { command: ${JSON.stringify(command)} } }];
           return { text: "", toolCalls: calls.map((c, i) => ({ id: "t" + n + "-" + i, ...c })), usage: { promptTokens: 10, completionTokens: 2, durationMs: 1 } };
         },
       };
       const card = await cardStore.getCard("card_crash");
       await executeCard({ repoPath: repo, restrictedMode: false, cardStore, boardService, log: () => {}, headroomCheck: false }, card, adapter);`,
    );
    const runner = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] });
    children.push(runner);
    await waitFor(() => existsSync(cmdPid) && readFileSync(cmdPid, "utf8").trim() !== "");
    const orphan = Number(readFileSync(cmdPid, "utf8").trim());
    runner.kill("SIGKILL");
    await new Promise((r) => runner.once("exit", r));
    expect(alive(orphan)).toBe(true);

    // Stuck before the sweep: In Progress, its attempt still running.
    {
      const before = initLocalKernel(repo);
      expect((await before.cardStore.getCard(card.id))?.status).toBe("in_progress");
      expect(before.cardStore.runs.listAttempts(card.id).at(-1)?.status).toBe("running");
      before.db.close();
    }
    // A partial step left an untracked file and an edit behind.
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 'partial';\n");
    writeFileSync(join(wt, "src", "stray.ts"), "partial\n");

    const out = await queue(repo);
    expect(out).toContain("card_crash");

    const after = initLocalKernel(repo);
    const swept = await after.cardStore.getCard(card.id);
    expect(swept?.status).toBe("ready");
    expect(swept?.stopReason).toBe("crashed");
    const attempt = after.cardStore.runs.listAttempts(card.id).at(-1);
    expect(attempt?.status).not.toBe("running");
    expect(attempt?.stopReason).toBe("crashed");
    // RUN-12: no orphaned process.
    await waitFor(() => !alive(orphan), 5_000);
    // RUN-9: the worktree is at its last checkpoint.
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(existsSync(join(wt, "src", "stray.ts"))).toBe(false);

    // RUN-10: the next run continues from the last completed step.
    const { adapter } = scripted(() => [{ name: "finish_card", arguments: {} }]);
    const resumed = await executeCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore: after.cardStore,
        boardService: after.boardService,
        log: () => {},
        headroomCheck: false,
      },
      swept as never,
      adapter,
    );
    expect(resumed.resumedFrom?.step).toBe(2);
    after.db.close();
  }, 90_000);
});

describe("NEW-runtime-4: retention is a recorded erasure, through `queue`", () => {
  async function closedCardWithRunData(cards: CardStore, repo: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 31 * 24 * 3600 * 1000));
    const old = await cards.createCard({ id: "card_old", tier: "task", title: "Old" });
    const attempt = await cards.runs.startAttempt({
      cardId: old.id,
      attemptNumber: 1,
      modelId: "worker",
    });
    const blobs = new BlobStore(repo);
    const pack = blobs.put(
      serializeContextPack({
        step: 1,
        cardId: old.id,
        modelId: "worker",
        systemPrompt: "S",
        prompt: "P",
        tools: ["read_file"],
      }),
    );
    await cards.runs.recordStep({
      attemptId: attempt.id,
      cardId: old.id,
      stepIndex: 1,
      calls: [],
      contextPackId: pack,
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
    await cards.updateCardStatus(old.id, "rejected", "not wanted", "human");
    vi.useRealTimers();
    const dot = join(repo, ".sekhemet");
    mkdirSync(join(dot, "transcripts"), { recursive: true });
    mkdirSync(join(dot, "observations"), { recursive: true });
    mkdirSync(join(dot, "evidence"), { recursive: true });
    writeFileSync(join(dot, "transcripts", "card_old-2026-01-01T00-00-00-000Z.jsonl"), "{}");
    writeFileSync(
      join(dot, "observations", "ev-aaa.json"),
      JSON.stringify({ meta: { cardId: "card_old" } }),
    );
    writeFileSync(join(dot, "observations", "ev-aaa.txt"), "raw");
    writeFileSync(join(dot, "evidence", "ev_old.json"), "{}");
    return { old, pack };
  }

  it("RUN-13, RUN-54, RUN-57: `queue` prunes a card closed 31 days ago in one ledger/erased event, lists what it pruned by card, and replay names the gap", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const { old, pack } = await closedCardWithRunData(k.cardStore, repo);
    const owner = k.cardStore.localPrincipal();
    const eventsBefore = (await k.log.getEvents(1, 1000)).length;
    k.db.close();

    const out = await queue(repo);
    expect(out).toMatch(/Retention: pruned 1 pack\(s\), 1 observation\(s\), 1 transcript\(s\)/);
    expect(out).toContain(`card_old: pack ${pack}`);

    const dot = join(repo, ".sekhemet");
    expect(new BlobStore(repo).has(pack)).toBe(false);
    expect(readdirSync(join(dot, "transcripts"))).toEqual([]);
    expect(readdirSync(join(dot, "observations"))).toEqual([]);
    expect(existsSync(join(dot, "evidence", "ev_old.json"))).toBe(true);

    const db = new DatabaseSync(join(dot, "events.db"));
    const log = new EventLog(db);
    const events = await log.getEvents(1, 1000);
    const erased = events.filter((e) => e.type === "ledger/erased");
    expect(erased).toHaveLength(1);
    expect(erased[0]?.actor).toBe("harness");
    expect(erased[0]?.payload).toMatchObject({
      blobIds: [pack],
      files: [
        "transcripts/card_old-2026-01-01T00-00-00-000Z.jsonl",
        "observations/ev-aaa.json",
        "observations/ev-aaa.txt",
      ],
      reason: "retention",
      principal: owner,
    });
    // Every other ledger event is kept, and the chain verifies.
    expect(events.length).toBeGreaterThan(eventsBefore);
    expect((await log.verifyHashChain({ full: true })).valid).toBe(true);
    db.close();
    // RUN-54: the replay names the gap and the erasing seq, never "missing".
    const r = recordedReplayCases([repo], { modelId: "worker" });
    expect(r.gaps).toEqual([{ contextPackId: pack, erasedBySeq: erased[0]?.seq }]);
    expect(r.skipped["context pack missing"]).toBeUndefined();
    expect(old.id).toBe("card_old");
  });

  it("RUN-15: spans older than 30 days are deleted at the retention pass", async () => {
    const repo = gitRepo();
    const tracer = Tracer.forRepo(repo);
    const day = 24 * 3600 * 1000;
    const ns = (ms: number) => BigInt(ms) * 1_000_000n;
    tracer.write({
      traceId: "a".repeat(32),
      spanId: "1".repeat(16),
      name: "card",
      startNs: ns(Date.now() - 31 * day),
      endNs: ns(Date.now() - 31 * day + 5),
      attributes: {},
      status: "ok",
    });
    tracer.write({
      traceId: "b".repeat(32),
      spanId: "2".repeat(16),
      name: "card",
      startNs: ns(Date.now() - day),
      endNs: ns(Date.now() - day + 5),
      attributes: {},
      status: "ok",
    });
    tracer.close();
    const out = await queue(repo);
    expect(out).toContain("Retention: 1 span(s) older than 30 days deleted");
    const again = Tracer.forRepo(repo);
    expect(again.spans().map((s) => s.spanId)).toEqual(["2".repeat(16)]);
    again.close();
  });
});

describe("NEW-runtime-4: bounded logs and worktrees", () => {
  it("RUN-16: closing a parked card removes its worktree and keeps its branch", async () => {
    const repo = gitRepo();
    const k = initLocalKernel(repo);
    const card = await k.cardStore.createCard({
      id: "card_pk",
      tier: "story",
      title: "Write a (SPIDR: Path)",
      scopeFiles: ["src/a.ts"],
      acceptanceCriteria: ["exports a"],
      spec: "Write src/a.ts",
      status: "ready",
      stepBudget: 1,
    });
    const run = await executeCard(
      {
        repoPath: repo,
        restrictedMode: false,
        cardStore: k.cardStore,
        boardService: k.boardService,
        log: () => {},
        headroomCheck: false,
      },
      card,
      scripted(() => [
        { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
      ]).adapter,
    );
    const wt = run.worktreePath;
    expect(existsSync(wt)).toBe(true);
    const stored = await k.cardStore.getCard(card.id);
    if (stored?.status !== "parked") {
      await k.cardStore.updateCardStatus(card.id, "parked", "test: parked", "human", {
        override: true,
      });
    }
    await k.cardStore.updateCardStatus(card.id, "rejected", "closed by a person", "human");
    await waitFor(() => !existsSync(wt), 10_000);
    const branches = execFileSync("git", ["branch", "--list", "sekhemet/*"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(branches).toContain(card.id);
    k.db.close();
  }, 60_000);

  it("RUN-14: a daemon.log over its size limit is rotated, keeping at most the configured number of files", async () => {
    const { rotateLog } = await import("../src/daemon.js");
    const dir = mkdtempSync(join(tmpdir(), "rotate-"));
    dirs.push(dir);
    const log = join(dir, "daemon.log");
    for (let i = 0; i < 6; i++) {
      writeFileSync(log, "x".repeat(2048));
      const rotated = rotateLog(log, { maxBytes: 1024, keep: 3 });
      expect(rotated).toBe(true);
    }
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]);
    expect(readFileSync(log, "utf8")).toBe("");
    // Under the limit: left alone.
    writeFileSync(log, "small");
    expect(rotateLog(log, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("small");
  });
});
