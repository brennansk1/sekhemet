#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import { DeterministicGateRunner, summarizeEvidence } from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { planRepair } from "@sekhemet/loop";
import {
  HttpInferenceAdapter,
  ModelRouter,
  NAIL_WORKER_PROFILE,
  canCoReside,
  createCyberTielWorker,
  createNail35BAdapter,
} from "@sekhemet/models";
import { SpidrFeaturePlanner } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { type DoctorReport, runDoctor } from "./doctor.js";
import {
  type QueueEntry,
  type QueueReport,
  acceptCard,
  collectCardFiles,
  executeCard,
  inferDependencies,
  writeQueueReport,
} from "./execute.js";
import { notifySlack } from "./integrations.js";
import { reflectWithManager } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import { runMcpStdioServer } from "./mcp.js";
import { DEFAULT_PM_MODEL, answerQueued, createPmAdapter, holdRunnerLease } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js";
import { loadAttempts, tune, writeTuningReport } from "./tune.js";

export interface CliConfig {
  command:
    | "doctor"
    | "board"
    | "log"
    | "serve"
    | "run"
    | "plan"
    | "gate"
    | "replay"
    | "bake-off"
    | "accept"
    | "tune"
    | "queue"
    | "mcp"
    | "help";
  targetArg?: string | undefined;
  restrictedMode: boolean;
  modelId: string;
  repoPath: string;
  port: number;
}

export interface MemoryPressureStatus {
  level: "normal" | "warning" | "critical";
  usedRatio: number;
  throttleMtp: boolean;
  throttleWorktrees: boolean;
  pauseExecution: boolean;
}

export function checkMemoryPressure(usedMb: number, totalMb: number): MemoryPressureStatus {
  const usedRatio = totalMb > 0 ? usedMb / totalMb : 0;

  if (usedRatio >= 0.94) {
    return {
      level: "critical",
      usedRatio,
      throttleMtp: true,
      throttleWorktrees: true,
      pauseExecution: true,
    };
  }

  if (usedRatio >= 0.85) {
    return {
      level: "warning",
      usedRatio,
      throttleMtp: true,
      throttleWorktrees: usedRatio >= 0.9,
      pauseExecution: false,
    };
  }

  return {
    level: "normal",
    usedRatio,
    throttleMtp: false,
    throttleWorktrees: false,
    pauseExecution: false,
  };
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliConfig {
  let command: CliConfig["command"] = "help";
  let targetArg: string | undefined;

  const validCommands = [
    "accept",
    "tune",
    "queue",
    "doctor",
    "board",
    "log",
    "serve",
    "ui",
    "run",
    "plan",
    "gate",
    "replay",
    "bake-off",
    "mcp",
  ] as const;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "ui") {
      command = "serve";
      break;
    }
    if (validCommands.includes(arg as never)) {
      command = arg as CliConfig["command"];
      targetArg = argv[i + 1] && !argv[i + 1]?.startsWith("-") ? argv[i + 1] : undefined;
      break;
    }
  }

  const restrictedMode = argv.includes("--restricted");

  let modelId = "ollama/qwen2.5-coder:7b";
  const modelIdx = argv.indexOf("--model");
  const nextModel = modelIdx !== -1 ? argv[modelIdx + 1] : undefined;
  if (nextModel) {
    modelId = nextModel;
  }

  let repoPath = process.cwd();
  const repoIdx = argv.indexOf("--repo");
  const nextRepo = repoIdx !== -1 ? argv[repoIdx + 1] : undefined;
  if (nextRepo) {
    repoPath = nextRepo;
  }

  let port = DEFAULT_DASHBOARD_PORT;
  const portIdx = argv.indexOf("--port");
  const nextPort = portIdx !== -1 ? argv[portIdx + 1] : undefined;
  if (nextPort) {
    const parsedPort = Number.parseInt(nextPort, 10);
    if (!Number.isNaN(parsedPort)) {
      port = parsedPort;
    }
  }

  return {
    command,
    targetArg,
    restrictedMode,
    modelId,
    repoPath,
    port,
  };
}

export function initLocalKernel(repoPath: string): {
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
} {
  const dotSekhemet = join(repoPath, ".sekhemet");
  if (!existsSync(dotSekhemet)) {
    mkdirSync(dotSekhemet, { recursive: true });
  }

  // The design and the permission engine's protected-path list both name
  // .sekhemet/events.db; opening a differently-named file meant the deny rule
  // guarded a database nothing used.
  const dbPath = join(dotSekhemet, "events.db");
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore);

  return { db, log, cardStore, boardService };
}

export async function printTerminalBoard(boardService: BoardServiceImpl): Promise<void> {
  const state = await boardService.getBoardState();
  console.log(
    "\n=========================================================================================",
  );
  console.log(
    "                           SEKHEMET DUAL-AXIS KANBAN BOARD                                ",
  );
  if (state.backpressureActive) {
    console.log(
      " [!] WARNING: REVIEW WIP BACKPRESSURE ACTIVE — Verify-to-Review transitions throttled!    ",
    );
  }
  console.log(
    "=========================================================================================",
  );

  const columns = ["backlog", "ready", "in_progress", "verify", "review", "done"] as const;

  for (const col of columns) {
    const colCards = state.cards.filter((c) => c.status === col);
    const limit = state.wipLimits[col];
    const header = `${col.toUpperCase()} (${colCards.length}${limit < 1000 ? `/${limit}` : ""})`;
    console.log(`\n--- ${header} ---`);
    if (colCards.length === 0) {
      console.log("  (empty)");
    } else {
      for (const card of colCards) {
        console.log(
          `  [${card.tier.toUpperCase()}] ${card.id} — ${card.title} (steps: ${card.stepsUsed}/${card.stepBudget})`,
        );
      }
    }
  }
  console.log(
    "=========================================================================================\n",
  );
}

export async function printEventLog(log: EventLog): Promise<void> {
  const events = await log.getEvents(1, 20);
  const verification = await log.verifyHashChain();

  console.log(
    "\n=========================================================================================",
  );
  console.log(
    "                      SEKHEMET CRYPTOGRAPHIC EVENT LOG & WAL                             ",
  );
  console.log(
    ` SHA-256 Chain Verification: ${verification.valid ? "VALID (100% Intact)" : `CORRUPTED at seq ${verification.corruptedSeq}`}`,
  );
  console.log(
    "=========================================================================================",
  );

  if (events.length === 0) {
    console.log("  (no events recorded yet)");
  } else {
    for (const evt of events) {
      console.log(
        `  #${evt.seq} [${evt.actor}] ${evt.type} | hash: ${evt.hash.slice(0, 12)}... | prev: ${evt.prevHash.slice(0, 12)}...`,
      );
    }
  }
  console.log(
    "=========================================================================================\n",
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseCliArgs(argv);

  if (config.command === "tune") {
    // `sekhemet tune [--from <repo> ...]`: replay recorded runs under candidate
    // stopping policies (Dream-RSI style) and recommend one. Never applies it.
    const argv = process.argv.slice(2);
    const sources = argv.flatMap((a, i) => (argv[i - 1] === "--from" ? [a] : []));
    const attempts = loadAttempts(sources.length > 0 ? sources : [config.repoPath]);
    if (attempts.length === 0) {
      console.log("No recorded Worker steps yet. Run `sekhemet queue` first.");
      return;
    }
    const report = tune(attempts, { stepBudget: 40, maxFailedChecks: 4 });
    const fmt = (s: typeof report.current) =>
      `${s.policy.stepBudget} steps, ${s.policy.maxFailedChecks} failed checks: first try ${s.firstTry}/${s.cards}, eventually ${s.eventually}/${s.cards}, ${s.minutes} min`;
    console.log(`Replayed ${attempts.length} attempts on ${report.current.cards} cards.`);
    console.log(`Current:     ${fmt(report.current)}`);
    console.log(`Recommended: ${fmt(report.best)}`);
    console.log(
      `Replay can only stop a recorded attempt earlier, so the recommendation never overstates. Apply it with: sekhemet queue --max-turns ${report.best.policy.stepBudget}`,
    );
    console.log(`Report: ${writeTuningReport(config.repoPath, report)}`);
    return;
  }

  if (config.command === "doctor") {
    const report = await runDoctor(config.repoPath);
    console.log("\n=== Sekhemet Doctor Diagnostics ===");
    for (const c of report.checks) {
      const mark = c.status === "pass" ? "\u2713" : c.status === "warn" ? "!" : "\u2717";
      console.log(`  ${mark} ${c.name}: ${c.detail}`);
    }
    console.log(report.ok ? "\nAll critical checks passed.\n" : "\nOne or more checks FAILED.\n");
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const { db, log, cardStore, boardService } = initLocalKernel(config.repoPath);

  if (config.command === "mcp") {
    runMcpStdioServer({ db, log, cardStore, boardService, repoPath: config.repoPath });
    return;
  }

  if (config.command === "board") {
    await printTerminalBoard(boardService);
    return;
  }

  if (config.command === "log") {
    await printEventLog(log);
    return;
  }

  if (config.command === "serve") {
    const server = await startDashboardServer({
      db,
      log,
      boardService,
      cardStore,
      repoPath: config.repoPath,
      port: config.port,
    });
    console.log("\n=================================================");
    console.log(" Sekhemet Visual Dashboard running at:");
    console.log(`   http://127.0.0.1:${server.port}`);
    console.log(" Press Ctrl+C to stop.");
    console.log("=================================================\n");
    return;
  }

  if (config.command === "plan") {
    const spec = config.targetArg || "New feature specification";
    console.log(`\nPlanning feature: "${spec}"`);
    const planner = new SpidrFeaturePlanner();
    const epicId = `epic_${Date.now().toString(16)}`;

    await cardStore.createCard({
      id: epicId,
      tier: "epic",
      title: spec,
      status: "in_progress",
    });

    const decomp = await planner.decomposeFeature(epicId, spec);
    console.log(`Decomposed into ${decomp.stories.length} SPIDR stories:`);
    for (const s of decomp.stories) {
      await cardStore.createCard(s);
      console.log(`  ✓ [${s.tier.toUpperCase()}] ${s.id}: ${s.title}`);
    }
    console.log("All cards saved to kanban board. View with 'sekhemet board'.\n");
    return;
  }

  if (config.command === "gate") {
    console.log("\nRunning verification gates against workspace...");
    const sandbox = new ProcessSandbox();
    const gateRunner = new DeterministicGateRunner(sandbox);
    const res = await gateRunner.runGates(["typecheck", "test", "lint"], config.repoPath);

    if (res.passed) {
      console.log("✓ ALL VERIFICATION GATES PASSED (100% Green)\n");
    } else {
      console.error(`✗ Gates failed (${res.failures.length} errors):`);
      for (const f of res.failures) {
        console.error(`  [${f.rung}] Exit code ${f.exitCode}: ${f.errorExcerpt}`);
      }
      process.exit(1);
    }
    return;
  }

  if (config.command === "replay") {
    const cardId = config.targetArg;
    if (!cardId) {
      console.error("Usage: sekhemet replay <card-id>");
      process.exit(1);
    }
    const checkpoints = await cardStore.getCheckpoints(cardId);
    console.log(`\nReplaying trajectory for ${cardId} (${checkpoints.length} checkpoints):`);
    for (const cp of checkpoints) {
      console.log(
        `  Step ${cp.step}: ref=${cp.gitRef} | gate=${cp.gateStatus} | model=${cp.agentModel} | role=${cp.agentRole}`,
      );
    }
    console.log("");
    return;
  }

  if (config.command === "bake-off") {
    // Run the same release-gate fixture once per candidate worker, each from an
    // identical clean repository, and compare the scorecards. The previous
    // command scored a scripted mock against a task whose "test" was the string
    // "t1", so its number measured nothing.
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(name);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    const workers = (flag("--workers") ?? NAIL_WORKER_PROFILE.modelId).split(",").filter(Boolean);
    const fixture = flag("--fixture") ?? "chronicle";
    const manager = flag("--manager");
    const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const script = join(harnessRoot, "scripts", "run_gate.sh");
    const base = join(tmpdir(), `sekhemet-bakeoff-${Date.now()}`);

    const rows: { worker: string; report?: QueueReport; error?: string }[] = [];
    for (const worker of workers) {
      const runRoot = join(base, worker.replace(/[^A-Za-z0-9._-]/g, "_"));
      mkdirSync(runRoot, { recursive: true });
      console.log(`\n=== bake-off: ${worker} on ${fixture} ===`);
      const code = await new Promise<number>((resolve) => {
        const child = spawn(
          "bash",
          [script, fixture, "--worker", worker, ...(manager ? ["--manager", manager] : [])],
          { stdio: "inherit", env: { ...process.env, GATE_RUN_DIR: runRoot } },
        );
        child.on("exit", (c) => resolve(c ?? 1));
      });

      const runDir = readdirSync(runRoot).map((d) => join(runRoot, d))[0];
      const reportPath = runDir ? join(runDir, ".sekhemet", "queue_report.json") : "";
      if (reportPath && existsSync(reportPath)) {
        rows.push({ worker, report: JSON.parse(readFileSync(reportPath, "utf8")) as QueueReport });
      } else {
        rows.push({ worker, error: `no report (exit ${code})` });
      }
    }

    console.log(`\nBake-off on ${fixture}${manager ? ` (manager: ${manager})` : ""}`);
    console.log("worker                                   Pass@1  escalated  minutes  tokens");
    for (const row of rows) {
      if (!row.report) {
        console.log(`${row.worker.padEnd(40)} ${row.error}`);
        continue;
      }
      const r = row.report;
      const tokens = r.entries.reduce((n, e) => n + e.promptTokens + e.completionTokens, 0);
      console.log(
        `${row.worker.padEnd(40)} ${(r.passAt1 * 100).toFixed(0).padStart(5)}%  ${(((r.passAfterEscalation ?? r.passAt1) as number) * 100).toFixed(0).padStart(8)}%  ${(r.totalDurationMs / 60000).toFixed(1).padStart(7)}  ${String(tokens).padStart(6)}`,
      );
    }
    const out = join(config.repoPath, ".sekhemet", "bakeoff_report.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ fixture, manager, rows }, null, 2)}\n`);
    console.log(`\nReport: ${out}`);
    return;
  }

  if (config.command === "accept") {
    const cardId = config.targetArg;
    if (!cardId) {
      console.error("Usage: sekhemet accept <card-id>");
      process.exit(1);
    }
    const card = await cardStore.getCard(cardId);
    if (!card) {
      console.error(`Card not found: ${cardId}`);
      process.exit(1);
    }
    try {
      const sha = await acceptCard(
        {
          repoPath: config.repoPath,
          restrictedMode: config.restrictedMode,
          cardStore,
          boardService,
        },
        card,
      );
      console.log(
        `\nAccepted ${cardId} — squashed to main as ${sha.slice(0, 10)}, card moved to Done.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (config.command === "run") {
    const cardId = config.targetArg;
    if (!cardId) {
      console.error("Usage: sekhemet run <card-id>");
      process.exit(1);
    }
    const card = await cardStore.getCard(cardId);
    if (!card) {
      console.error(`Card not found: ${cardId}`);
      process.exit(1);
    }

    console.log(`\nExecuting card ${cardId}: "${card.title}"`);
    console.log(`Scope: [${card.scopeFiles.join(", ") || "unrestricted"}]`);
    console.log(`Budget: ${card.stepBudget} steps\n`);

    const model = createNail35BAdapter();
    const ctx = {
      repoPath: config.repoPath,
      restrictedMode: config.restrictedMode,
      cardStore,
      boardService,
    };
    let result: Awaited<ReturnType<typeof executeCard>>;
    try {
      result = await executeCard(ctx, card, model);
    } finally {
      // Release the weights on every exit path, including a crash mid-card:
      // a resident 13GB checkpoint left behind by a failed run is how the host
      // ran out of memory overnight.
      await model.unload();
    }

    console.log(`\n${summarizeEvidence(result.evidence)}\n`);
    console.log(
      result.passed
        ? `Card ${cardId} PASSED verification and moved to Review for human acceptance.`
        : `Card ${cardId} stopped: ${result.stopReason}. Left in ${result.finalStatus} for inspection.`,
    );

    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (config.command === "queue") {
    // Run every Ready card in board order on one resident worker. With
    // --manager <ollama-model>, cards that fail are then reviewed in one batch
    // by the manager, which writes a repair plan per card, and the worker
    // retries each once with its plan. Roles are batched rather than
    // alternated because only one model fits in memory and every swap
    // reloads weights. --auto-accept merges passing cards so later cards build
    // on them: a benchmarking convenience, since acceptance is a human call.
    const autoAccept = argv.includes("--auto-accept");
    const managerIdx = argv.indexOf("--manager");
    const managerModel = managerIdx !== -1 ? argv[managerIdx + 1] : undefined;
    const workerIdx = argv.indexOf("--worker");
    const workerModel = workerIdx !== -1 ? argv[workerIdx + 1] : undefined;

    const ready = (await cardStore.listCards({ status: "ready" })) as CardRecord[];
    if (ready.length === 0) {
      console.log("No Ready cards.");
      return;
    }

    const router = new ModelRouter(
      {
        // "cyber-tiel" runs under a harness-managed llama-server so its MTP head
        // and chat template are used; any other name is an Ollama model.
        worker: () =>
          workerModel === "cyber-tiel"
            ? createCyberTielWorker()
            : workerModel
              ? new HttpInferenceAdapter({ ...NAIL_WORKER_PROFILE, modelId: workerModel })
              : createNail35BAdapter(),
        // The manager doubles as the PM you chat with during the run; without
        // --manager it is still available for chat, just not for repair plans.
        manager: () =>
          managerModel
            ? new HttpInferenceAdapter({
                modelId: managerModel,
                apiFormat: "ollama",
                contextTokens: 8192,
                maxTokens: 2048,
                disableReasoning: true,
                sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
              })
            : createPmAdapter(DEFAULT_PM_MODEL),
        // The manager's (stronger, dense) model as a coder, for --escalate-retries.
        escalation: () =>
          new HttpInferenceAdapter({
            modelId: managerModel ?? DEFAULT_PM_MODEL,
            apiFormat: "ollama",
            // 12k keeps a dense 27B inside a 24 GB host; roomier hosts get 16k.
            contextTokens: totalmem() >= 48 * 1024 ** 3 ? 16384 : 12288,
            maxTokens: 3072,
            disableReasoning: true,
            sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
          }),
      },
      // Every swap proves the unload and waits for normal memory pressure.
      // With enough RAM (a 48 GB+ host) both stay resident and swaps vanish.
      {
        log: (line) => console.log(`   ${line}`),
        coResident: canCoReside(totalmem(), 14 * 1024 ** 3, 17 * 1024 ** 3),
      },
    );
    const pmModel = managerModel ?? DEFAULT_PM_MODEL;
    const pmStore = new PmStore(log);
    // Tells the dashboard this process holds the Worker, so PM messages are
    // answered here, between steps, instead of loading a second large model.
    const releaseLease = holdRunnerLease(config.repoPath, pmModel);

    /**
     * Preemption (PM_CONTRACT §4): after any Worker step, if the human has
     * written to the PM, swap the Worker out, answer, swap it back. The card
     * resumes from its worktree, so nothing is lost; only the reload costs time.
     */
    const answerPm = async (step?: number): Promise<void> => {
      if ((await pmStore.queued()).length === 0) return;
      console.log(
        `   PM: pausing the Worker${step !== undefined ? ` after step ${step}` : ""} to answer`,
      );
      const workerWasActive = router.activeRole === "worker";
      await answerQueued({
        repoPath: config.repoPath,
        cardStore,
        pmStore,
        pmModel,
        acquire: () => router.use("manager"),
        ...(step !== undefined ? { step } : {}),
      });
      if (workerWasActive) {
        await pmStore.setStatus({
          phase: "resuming_worker",
          detail: "Reloading the Worker",
          workerPaused: true,
          ...(step !== undefined ? { step } : {}),
        });
        const worker = (await router.use("worker")) as { ensureRunning?: () => Promise<void> };
        await worker.ensureRunning?.();
        await pmStore.setStatus({ phase: "idle" });
      }
    };
    const ctx = {
      repoPath: config.repoPath,
      restrictedMode: config.restrictedMode,
      cardStore,
      boardService,
      learning: new LearningStore(log),
      afterTurn: async (_cardId: string, turn: { turnIndex: number }) => {
        await answerPm(turn.turnIndex).catch((err) =>
          console.log(`   PM: could not answer (${err instanceof Error ? err.message : err})`),
        );
      },
    };
    const started = Date.now();
    const entries: QueueEntry[] = [];
    const failed: { card: CardRecord; result: Awaited<ReturnType<typeof executeCard>> }[] = [];
    let halted = false;

    let workerModelId = workerModel ?? NAIL_WORKER_PROFILE.modelId;
    // --max-turns caps every card's step budget (the tuner's recommendation).
    const escalateRetries = argv.includes("--escalate-retries");
    const maxTurnsIdx = argv.indexOf("--max-turns");
    const maxTurns = maxTurnsIdx !== -1 ? Number(argv[maxTurnsIdx + 1]) : undefined;
    // Lessons each attempt learned, handed to the next attempt at the same card.
    const lessonsByCard = new Map<string, string[]>();
    const attempt = async (rawCard: CardRecord, n: number, guidance?: string) => {
      const card =
        maxTurns && maxTurns > 0 && rawCard.stepBudget > maxTurns
          ? { ...rawCard, stepBudget: maxTurns }
          : rawCard;
      // A retry of a card the worker could not do runs on the stronger model
      // when asked: capability-based routing, not the same model again.
      const role = n >= 2 && escalateRetries ? "escalation" : "worker";
      const worker = await router.use(role);
      if (role === "escalation") console.log(`   escalating ${rawCard.id} to ${worker.modelId}`);
      if (role === "worker") workerModelId = worker.modelId;
      console.log(`\n=== ${card.id} (attempt ${n}): ${card.title} ===`);
      const prior = lessonsByCard.get(card.id);
      const result = await executeCard(ctx, card, worker, guidance, prior);
      if (result.lessons.lines.length > 0) lessonsByCard.set(card.id, result.lessons.lines);

      let accepted = false;
      if (result.passed && autoAccept) {
        const reviewed = await cardStore.getCard(card.id);
        if (reviewed) {
          // --auto-accept is the harness's verdict, not a person's: the ledger
          // must not credit a human with a merge nobody reviewed.
          const sha = await acceptCard(ctx, reviewed, "harness");
          accepted = true;
          console.log(`   accepted -> main ${sha.slice(0, 10)}`);
        }
      }

      entries.push({
        cardId: card.id,
        attempt: n,
        passed: result.passed,
        accepted,
        stopReason: result.stopReason,
        turns: result.evidence.turnsUsed,
        durationMs: result.evidence.durationMs,
        promptTokens: result.evidence.tokens.promptTokens,
        completionTokens: result.evidence.tokens.completionTokens,
      });
      console.log(
        `   ${result.passed ? "PASSED" : "FAILED"} (${result.stopReason}) in ${result.evidence.turnsUsed} turns, ${(result.evidence.durationMs / 1000).toFixed(1)}s`,
      );
      if (result.stopReason === "memory_pressure") {
        console.log("   queue halted: memory pressure");
        halted = true;
      }
      return result;
    };

    const deps = inferDependencies(ready);
    const blockedBy = async (card: CardRecord): Promise<string[]> => {
      const waiting: string[] = [];
      for (const id of deps.get(card.id) ?? []) {
        const dep = await cardStore.getCard(id);
        // A prerequisite outside this queue counts as satisfied only when done.
        if (dep && dep.status !== "done") waiting.push(id);
      }
      return waiting;
    };
    const deferred: CardRecord[] = [];

    /** Run every runnable card; defer those whose prerequisites have not merged. */
    const pass = async (cards: CardRecord[], n: number, plans?: Map<string, string>) => {
      for (const queued of cards) {
        if (halted) break;
        const card = (await cardStore.getCard(queued.id)) ?? queued;
        const waiting = await blockedBy(card);
        if (waiting.length > 0) {
          console.log(`\n--- ${card.id} waits on ${waiting.join(", ")}: deferred ---`);
          if (!deferred.some((d) => d.id === card.id)) deferred.push(card);
          continue;
        }
        const index = deferred.findIndex((d) => d.id === card.id);
        if (index !== -1) deferred.splice(index, 1);
        const result = await attempt(card, n, plans?.get(card.id));
        if (!result.passed) failed.push({ card, result });
      }
    };

    try {
      await pass(ready, 1);

      if (!halted && managerModel && failed.length > 0) {
        // One swap to the manager for the whole batch of failures.
        const manager = await router.use("manager");
        const plans = new Map<string, string>();
        const reflections: {
          card: CardRecord;
          plan: string;
          firstStop: string;
          retryPassed: boolean;
        }[] = [];
        for (const { card, result } of failed) {
          console.log(`\n--- manager reviewing ${card.id} ---`);
          const plan = await planRepair(manager, {
            card,
            stopReason: result.stopReason,
            failures: result.evidence.failures,
            files: collectCardFiles(result.worktreePath, card),
          });
          plans.set(card.id, plan);
          reflections.push({ card, plan, firstStop: result.stopReason, retryPassed: false });
          console.log(
            plan
              .split("\n")
              .slice(0, 6)
              .map((l) => `   | ${l}`)
              .join("\n"),
          );
        }

        // One swap back, then retry each failure with its plan.
        const retry = failed.splice(0, failed.length).map(({ card }) => card);
        // Merit's reflection runs now, while its model is already resident:
        // learning must never cost an extra swap.
        const learned = await reflectWithManager(manager, ctx.learning, reflections).catch(() => 0);
        if (learned > 0) console.log(`\n--- Merit proposed ${learned} rule(s) from this run ---`);
        await pass(retry, 2, plans);
      }

      // Cards held back for a prerequisite get their first attempt once it has
      // merged. Repeat until a sweep makes no progress.
      let progress = true;
      while (!halted && progress && deferred.length > 0) {
        const before = deferred.length;
        await pass([...deferred], 1);
        progress = deferred.length < before;
      }
      for (const card of deferred) {
        console.log(
          `\n--- ${card.id} never ran: prerequisites ${(await blockedBy(card)).join(", ")} did not merge ---`,
        );
      }
      // Anything asked during the last step is answered before the run ends.
      await answerPm().catch(() => undefined);
    } finally {
      await router.releaseAll();
      releaseLease();
    }

    const cardIds = [...new Set(entries.map((e) => e.cardId))];
    const firstTry = entries.filter((e) => e.attempt === 1 && e.passed).length;
    const eventually = cardIds.filter((id) =>
      entries.some((e) => e.cardId === id && e.passed),
    ).length;
    const report: QueueReport = {
      startedAt: new Date(started).toISOString(),
      model: workerModelId,
      ...(managerModel ? { managerModel } : {}),
      entries,
      passAt1: cardIds.length > 0 ? firstTry / cardIds.length : 0,
      passAfterEscalation: cardIds.length > 0 ? eventually / cardIds.length : 0,
      modelSwaps: router.swapCount,
      totalDurationMs: Date.now() - started,
    };
    const path = writeQueueReport(config.repoPath, report);

    console.log(
      `\nScorecard: Pass@1 ${firstTry}/${cardIds.length} (${(report.passAt1 * 100).toFixed(0)}%), after escalation ${eventually}/${cardIds.length}, ${router.swapCount} model swap(s), ${(report.totalDurationMs / 60000).toFixed(1)} min`,
    );
    console.log(`Report: ${path}`);
    // The run report goes to Slack when the user connected it; a no-op otherwise.
    await notifySlack(
      config.repoPath,
      log,
      "run_report",
      `Run finished: ${firstTry}/${cardIds.length} cards passed on the first try, ${eventually}/${cardIds.length} after a Planner retry, in ${(report.totalDurationMs / 60000).toFixed(1)} min.`,
    ).catch(() => undefined);
    if (eventually < cardIds.length) process.exitCode = 1;
    return;
  }

  console.log("=================================================");
  console.log(" Sekhemet — Board-Native Local-First Coding Harness");
  console.log(` Model: ${config.modelId}`);
  console.log(
    ` Restricted Mode: ${config.restrictedMode ? "ENABLED (auditing only)" : "DISABLED"}`,
  );
  console.log(` Repository: ${config.repoPath}`);
  console.log("\nAvailable Commands:");
  console.log("  sekhemet doctor             Run hardware & local socket diagnostics");
  console.log("  sekhemet board              Display terminal visual kanban board");
  console.log("  sekhemet log                View cryptographic event log & SHA-256 chain");
  console.log("  sekhemet plan <spec>        Decompose feature into SPIDR cards");
  console.log("  sekhemet run <card-id>      Execute card unattended in worktree");
  console.log("  sekhemet accept <card-id>   Squash-merge a reviewed card to main");
  console.log(
    "  sekhemet queue [--auto-accept] [--worker m] [--manager m]  Run Ready cards; escalate failures to a manager",
  );
  console.log("  sekhemet gate [card-id]     Run deterministic verification gates");
  console.log("  sekhemet replay <card-id>   Replay checkpoint trajectory for a card");
  console.log(
    "  sekhemet bake-off --workers a,b [--fixture f] [--manager m]  Compare workers on a release gate",
  );
  console.log("  sekhemet ui / serve         Launch local web visual dashboard");
  console.log("  sekhemet mcp                Run stdio MCP server for Cursor / Claude / IDEs");
  console.log("=================================================");
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("sekhemet")) {
  main().catch(console.error);
}
