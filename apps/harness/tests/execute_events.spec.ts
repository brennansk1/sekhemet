import { execFileSync } from "node:child_process";
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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { TurnResult } from "@sekhemet/loop";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type QueueReport,
  acceptCard,
  executeCard,
  recordQueueProgress,
  stepEventPayload,
  writeQueueReport,
} from "../src/execute.js";
import { Tracer } from "../src/tracing.js";

// Additive ledger facts from the runner and the accept path (FRONTEND_DESIGN
// 3.2, and the backend gaps: accept sha, Planner repair plan, run history).
describe("@sekhemet/harness execution ledger events", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let boardService: BoardServiceImpl;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-exec-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".sekhemet"));
    writeFileSync(join(repo, "src", "a.ts"), "");
    // One trivially passing gate, so the card reaches Review without a toolchain.
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
    );
    writeFileSync(
      join(repo, ".gitignore"),
      ".sekhemet/events.db*\n.sekhemet/worktrees\n.sekhemet/evidence\n.sekhemet/transcripts\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    boardService = new BoardServiceImpl(cardStore);
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("appends one card/step per turn, the repair plan, and the accept sha; the chain stays valid", async () => {
    const card = await cardStore.createCard({
      id: "card_exec",
      tier: "story",
      title: "Write a",
      scopeFiles: ["src/a.ts"],
      stepBudget: 6,
      spec: "Write src/a.ts",
    });
    const ctx = {
      repoPath: repo,
      restrictedMode: false,
      cardStore,
      boardService,
      log: () => {},
      // The host's swap moves with whatever else runs; the watchdog tests cover memory.
      headroomCheck: false,
    };
    const model = new MockInferenceAdapter("scripted", [
      {
        text: "",
        toolCalls: [
          {
            id: "1",
            name: "write_file",
            arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
          },
          { id: "2", name: "finish_card", arguments: {} },
        ],
        usage: { promptTokens: 100, completionTokens: 10, durationMs: 5 },
      },
    ]);
    const result = await executeCard(ctx, card, model, "1. Export a constant named a.");
    expect(result.passed).toBe(true);

    const events = await log.getEventsByCard("card_exec");
    const steps = events.filter((e) => e.type === "card/step");
    expect(steps.length).toBe(result.turns.length);
    const first = steps[0]?.payload as ReturnType<typeof stepEventPayload>;
    expect(first.calls[0]).toMatchObject({ name: "write_file", target: "src/a.ts" });
    expect(first.usage?.promptTokens).toBe(100);

    // H24: the attempt's reproducibility record, on the ledger and beside the evidence.
    const repro = events.find((e) => e.type === "card/repro")?.payload as {
      attempt: number;
      model: { id: string };
      promptSha: string;
      toolSchemaSha: string;
      gatesSha: string;
    };
    expect(repro.model.id).toBe(model.modelId);
    expect(repro.promptSha).toMatch(/^[0-9a-f]{64}$/);
    expect(repro.toolSchemaSha).toMatch(/^[0-9a-f]{64}$/);
    expect(repro.gatesSha).toMatch(/^[0-9a-f]{64}$/);
    const latest = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_exec.json"), "utf8"),
    ) as { reproducibility?: { attempt: number } };
    expect(latest.reproducibility?.attempt).toBe(repro.attempt);

    // H22: the run left spans: the card, its turns and its model calls.
    const tracer = Tracer.forRepo(repo);
    const names = tracer.spans().map((sp) => sp.name);
    tracer.close();
    expect(names).toContain("card.run");
    expect(names.filter((n) => n === "gen_ai.chat").length).toBeGreaterThan(0);
    expect(names.filter((n) => n === "card.turn").length).toBe(result.turns.length);

    const plan = events.find((e) => e.type === "card/repair_plan");
    expect(plan?.actor).toBe("planner");
    expect((plan?.payload as { plan: string }).plan).toContain("Export a constant");

    const reviewed = await cardStore.getCard("card_exec");
    expect(reviewed?.status).toBe("review");
    const sha = await acceptCard(ctx, reviewed as NonNullable<typeof reviewed>);
    const accepted = (await log.getEventsByCard("card_exec")).find(
      (e) => e.type === "card/accepted",
    );
    expect(accepted?.actor).toBe("human");
    expect((accepted?.payload as { sha: string }).sha).toBe(sha);
    const done = (await log.getEventsByCard("card_exec"))
      .filter((e) => e.type === "card/status_changed")
      .at(-1);
    expect(done?.actor).toBe("human");
    expect((await log.verifyHashChain()).valid).toBe(true);
  });

  it("builds a compact step payload with targets, gate result and stop reason", () => {
    const turn = {
      turnIndex: 8,
      toolCalls: [{ id: "n", name: "note", arguments: { message: "stuck" } }],
      observations: [{ tool: "note", ok: true, summary: "recorded note (4 total)" }],
      gateResult: {
        passed: false,
        durationMs: 1,
        failures: [
          {
            rung: "typecheck",
            gate: "typecheck",
            exitCode: 1,
            errorExcerpt: "x",
            suggestedFixFiles: [],
          },
          {
            rung: "typecheck",
            gate: "typecheck",
            exitCode: 1,
            errorExcerpt: "y",
            suggestedFixFiles: [],
          },
        ],
      },
      stopReason: "oscillation_detected",
    } as unknown as TurnResult;
    expect(stepEventPayload("card_h", turn)).toEqual({
      id: "card_h",
      turn: 8,
      calls: [{ name: "note", target: "stuck", ok: true, summary: "recorded note (4 total)" }],
      gate: { passed: false, failed: ["typecheck"], errors: 2 },
      stopReason: "oscillation_detected",
    });
  });

  it("keeps every queue report under .sekhemet/runs as well as the latest", () => {
    const report = (startedAt: string): QueueReport => ({
      startedAt,
      model: "m",
      entries: [],
      passAt1: 0,
      passAfterEscalation: 0,
      modelSwaps: 0,
      totalDurationMs: 1,
    });
    writeQueueReport(repo, report("2026-09-18T14:16:10.135Z"));
    writeQueueReport(repo, report("2026-09-18T16:00:00.000Z"));
    const runs = readdirSync(join(repo, ".sekhemet", "runs"));
    expect(runs.sort()).toEqual(["2026-09-18T14-16-10-135Z.json", "2026-09-18T16-00-00-000Z.json"]);
    expect(existsSync(join(repo, ".sekhemet", "queue_report.json"))).toBe(true);
    const latest = JSON.parse(readFileSync(join(repo, ".sekhemet", "queue_report.json"), "utf8"));
    expect(latest.startedAt).toBe("2026-09-18T16:00:00.000Z");
  });

  it("records the queue's progress after every entry, so a run stopped part-way keeps its record (review M4)", () => {
    const entry = {
      cardId: "c1",
      attempt: 1,
      passed: true,
      accepted: true,
      stopReason: "gates_passed",
      turns: 3,
      durationMs: 10,
      promptTokens: 100,
      completionTokens: 5,
    };
    recordQueueProgress(repo, {
      startedAt: "2026-09-25T01:00:00.000Z",
      model: "cyber-tiel",
      entries: [entry],
      modelSwaps: 0,
      totalDurationMs: 10,
    });
    const partial = JSON.parse(readFileSync(join(repo, ".sekhemet", "queue_report.json"), "utf8"));
    expect(partial).toMatchObject({ partial: true, entries: [entry], passAt1: 1 });
  });
});
