#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import { DeterministicGateRunner, loadGatesConfig, summarizeEvidence } from "@sekhemet/gates";
import { remedyFor } from "@sekhemet/gates";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { planRepair } from "@sekhemet/loop";
import {
  MemoryWatchdog,
  ModelRoster,
  ModelRouter,
  NAIL_WORKER_PROFILE,
  PrefixCacheMonitor,
  ThroughputMeter,
  type UnloadableAdapter,
  createNail35BAdapter,
  measureThroughput,
} from "@sekhemet/models";
import { SpidrFeaturePlanner } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { type DoctorReport, runDoctor } from "./doctor.js";
import {
  type QueueEntry,
  type QueueReport,
  QueuedWorkerQuestions,
  acceptCard,
  collectCardFiles,
  ensureRepoProject,
  executeCard,
  inferDependencies,
  nextAttemptNumber,
  pruneRunData,
  recordReview,
  writeQueueReport,
} from "./execute.js";
import { notifySlack } from "./integrations.js";
import { readSettings } from "./integrations.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { consolidateWithManager, reflectWithManager } from "./learning/reflect.js";
import { reviewCard } from "./learning/review.js";
import { LearningStore } from "./learning/store.js";
import { runMcpStdioServer } from "./mcp.js";
import { DEFAULT_PM_MODEL, answerQueued, createPmAdapter, holdRunnerLease } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { CRAWL4AI_CREDIT, runResearchCommand } from "./research/cli.js";
import { ResearchService, researchSources } from "./research/service.js";
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
    | "research"
    | "explore"
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
    "explore",
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
    "research",
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

  if (config.command === "research") {
    // `sekhemet research "<question>" [--deep]`: the Researcher, with sources.
    const dbPath = join(config.repoPath, ".sekhemet", "events.db");
    let store: CardStore | undefined;
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      initSchema(db);
      store = new CardStore(db, new EventLog(db));
    }
    process.exitCode = await runResearchCommand(
      argv.slice(argv.indexOf("research") + 1),
      config.repoPath,
      store,
    );
    return;
  }

  if (config.command === "explore") {
    // `sekhemet explore [--activate]`: learn the project's constraints from its
    // own configuration before any card runs (RSIAgent's exploration phase).
    const found = exploreProject(config.repoPath);
    for (const c of found) console.log(`- ${c.key}: ${c.text}`);
    const db = new DatabaseSync(join(config.repoPath, ".sekhemet", "events.db"));
    initSchema(db);
    const exploreLog = new EventLog(db);
    const r = await applyExploration(
      new LearningStore(exploreLog),
      config.repoPath,
      process.argv.includes("--activate"),
      await new CardStore(db, exploreLog).listCards(),
    );
    console.log(
      `\n${found.length} constraint(s) found; ${r.proposed} new rule(s), ${r.activated} activated.${r.activated === 0 && r.proposed > 0 ? " Approve them in Playbook, or rerun with --activate." : ""}`,
    );
    return;
  }

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
  // The repository is a project (K14); cards created without one join it.
  await ensureRepoProject(cardStore, config.repoPath).catch(() => undefined);

  if (config.command === "mcp") {
    runMcpStdioServer({ db, log, cardStore, boardService, repoPath: config.repoPath });
    return;
  }

  if (config.command === "board") {
    // The board is the dashboard: start it and open the browser. The ASCII
    // board remains for terminals without one (--terminal).
    if (process.argv.includes("--terminal")) {
      await printTerminalBoard(boardService);
      return;
    }
    const server = await startDashboardServer({
      db,
      log,
      boardService,
      cardStore,
      repoPath: config.repoPath,
      port: config.port,
    });
    const url = `http://127.0.0.1:${server.port}/#/board`;
    console.log(`Sekhemet board: ${url}  (Ctrl+C to stop; --terminal for the text board)`);
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true })
      .on("error", () => {
        console.log("Could not open a browser; open the URL above.");
      })
      .unref();
    return;
  }

  if (config.command === "log") {
    await printEventLog(log);
    // K8: the projections must be exactly what the ledger derives.
    const verdict = await cardStore.verifyProjections();
    console.log(
      verdict.identical
        ? ` Projections: rebuilt from ${verdict.eventsApplied} events, byte-identical.`
        : ` Projections DRIFTED from the ledger: ${verdict.mismatched.join(", ")}.${argv.includes("--rebuild") ? "" : " Run `sekhemet log --rebuild` to rebuild them from the ledger."}`,
    );
    if (!verdict.identical && argv.includes("--rebuild")) {
      await cardStore.rebuildProjections();
      console.log(" Projections rebuilt from the ledger.");
    }
    if (!verdict.identical && !argv.includes("--rebuild")) process.exitCode = 1;
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
    // `sekhemet gate [<card>]`: run every gate declared in gates.toml, in the
    // card's own worktree when one exists, and report typed failures with
    // their remedies plus the 3-file / 200-line bounds.
    const cardId = config.targetArg;
    const worktree = cardId ? join(config.repoPath, ".sekhemet", "worktrees", cardId) : undefined;
    const cwd = worktree && existsSync(worktree) ? worktree : config.repoPath;
    if (cardId && cwd === config.repoPath) {
      console.log(`No worktree for ${cardId}; running the gates in the repository instead.`);
    }
    const gatesConfig = loadGatesConfig(config.repoPath);
    // --restricted runs only the static layer, confined or not at all (S12).
    const rungs = [
      ...new Set(
        gatesConfig.gates
          .filter((g) => !config.restrictedMode || g.layer === "static")
          .map((g) => g.rung),
      ),
    ];
    const gateRunner = new DeterministicGateRunner(
      new ProcessSandbox({ requireConfinement: config.restrictedMode }),
      {
        repoRoot: config.repoPath,
        expectedConfigSha256: gatesConfig.sha256,
      },
    );
    console.log(`\nRunning ${rungs.join(", ")} in ${cwd}`);
    const res = await gateRunner.runGates(rungs, cwd);
    let boundsOk = true;
    if (cardId && cwd !== config.repoPath) {
      const stats = await new NodeGitSyncAdapter(config.repoPath).getDiffStats(cardId);
      // Harness-staged acceptance tests are not the card's work, exactly as
      // in the card runner's bounds check.
      const staged = new Set(
        ((await cardStore.getCard(cardId))?.acceptanceTests ?? []).map((t) =>
          t.startsWith("tests/") ? t : `tests/${t}`,
        ),
      );
      const own = (stats.perFile ?? []).filter((f) => !staged.has(f.file));
      const files = own.length;
      const lines = own.reduce((n, f) => n + f.added + f.removed, 0);
      boundsOk = files <= gatesConfig.project.maxFiles && lines <= gatesConfig.project.maxDiffLines;
      console.log(
        `Bounds: ${files}/${gatesConfig.project.maxFiles} files, ${lines}/${gatesConfig.project.maxDiffLines} lines ${boundsOk ? "ok" : "EXCEEDED"}`,
      );
    }
    for (const r of res.rungResults ?? []) {
      console.log(`  ${r.passed ? "✓" : r.skipped ? "-" : "✗"} ${r.gate} (${r.durationMs} ms)`);
    }
    if (res.passed && boundsOk) {
      console.log("All gates pass.\n");
      return;
    }
    for (const f of res.failures) {
      console.error(`  [${f.gate ?? f.rung}] ${f.errorExcerpt.split("\n")[0]}`);
      if (f.suggestedAction) console.error(`      fix: ${f.suggestedAction}`);
    }
    process.exitCode = 1;
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
    // One run profile, so a run exercises what was built (integration review):
    // --profile full = exploration, escalated retries, review, and the step
    // cap the replay tuner recommended (16 until a tuning report exists).
    if (argv[argv.indexOf("--profile") + 1] === "full") {
      let cap = 16;
      try {
        const t = JSON.parse(
          readFileSync(join(config.repoPath, ".sekhemet", "tuning", "latest.json"), "utf8"),
        ) as { best?: { policy?: { stepBudget?: number } } };
        cap = t.best?.policy?.stepBudget ?? cap;
      } catch {
        // No tuning yet: the default cap.
      }
      for (const flag of ["--explore", "--escalate-retries", "--review"]) {
        if (!argv.includes(flag)) argv.push(flag);
      }
      if (!argv.includes("--max-turns")) argv.push("--max-turns", String(cap));
      console.log(
        `Profile full: ${argv.filter((a) => a.startsWith("--") && a !== "--profile").join(" ")}`,
      );
    }
    const autoAccept = argv.includes("--auto-accept");
    const managerIdx = argv.indexOf("--manager");
    const managerModel = managerIdx !== -1 ? argv[managerIdx + 1] : undefined;
    const researcherIdx = argv.indexOf("--researcher");
    const researcherModel =
      researcherIdx !== -1 ? argv[researcherIdx + 1] : process.env.SEKHEMET_RESEARCHER;
    const reviewerIdx = argv.indexOf("--reviewer");
    const reviewerModel = reviewerIdx !== -1 ? argv[reviewerIdx + 1] : undefined;
    const workerIdx = argv.indexOf("--worker");
    const workerModel = workerIdx !== -1 ? argv[workerIdx + 1] : undefined;

    const ready = (await cardStore.listCards({ status: "ready" })) as CardRecord[];
    if (ready.length === 0) {
      console.log("No Ready cards.");
      return;
    }
    // Retention (K27): packs and transcripts of cards closed 30+ days ago.
    const pruned = await pruneRunData(cardStore, config.repoPath).catch(() => undefined);
    if (pruned && pruned.closedCards.length > 0) {
      console.log(
        `Retention: pruned ${pruned.removed.packs} pack(s), ${pruned.removed.observations} observation(s), ${pruned.removed.transcripts} transcript(s) of ${pruned.closedCards.length} closed card(s).`,
      );
    }

    // Every role resolves through one roster (M5, C3): a managed name
    // (cyber-tiel, apodex, qwen3.8-27b/dirk) runs under a harness-managed
    // llama-server and roles on the same weights share one adapter; any other
    // name is an Ollama model with its role's profile.
    const roster = new ModelRoster();
    const pmModelName = managerModel ?? DEFAULT_PM_MODEL;
    /** Every adapter the router loaded, for the watchdog's actions. */
    const loaded = new Set<UnloadableAdapter>();
    // Prefill/decode speed per model and the Worker's prefix-cache hit rate (M3, M18).
    const meter = new ThroughputMeter();
    const cache = new PrefixCacheMonitor();
    const measured = new WeakSet<object>();
    const track =
      (factory: () => UnloadableAdapter, measure = false) =>
      (): UnloadableAdapter => {
        const adapter = factory();
        loaded.add(adapter);
        if (measure && !measured.has(adapter)) {
          measured.add(adapter);
          measureThroughput(adapter, meter, cache);
        }
        return adapter;
      };
    const router = new ModelRouter(
      {
        worker: track(roster.factory(workerModel ?? NAIL_WORKER_PROFILE.modelId, "worker"), true),
        // The manager doubles as the PM you chat with during the run; without
        // --manager it is still available for chat, just not for repair plans.
        manager: track(roster.factory(pmModelName, "manager")),
        // The Researcher (--researcher <model>; the user's choice is Apodex-1.1-mini).
        ...(researcherModel
          ? { researcher: track(roster.factory(researcherModel, "researcher")) }
          : {}),
        // A different model family for Merit's review (--reviewer <model>).
        ...(reviewerModel ? { reviewer: track(roster.factory(reviewerModel, "reviewer")) } : {}),
        // The manager's (stronger, dense) model as a coder, for --escalate-retries.
        escalation: track(roster.factory(pmModelName, "escalation"), true),
      },
      // Every swap proves the unload and waits for normal memory pressure.
      { log: (line) => console.log(`   ${line}`) },
    );
    // The memory watchdog (M20): polls every 2 s and acts through the
    // adapters; the card runner checks it before every turn.
    const eachLoaded = (fn: (a: UnloadableAdapter & Record<string, unknown>) => unknown) =>
      Promise.allSettled(
        [...loaded].map((a) => fn(a as UnloadableAdapter & Record<string, unknown>)),
      );
    const watchdog = new MemoryWatchdog({
      handlers: {
        suspendMtp: () => {
          void eachLoaded((a) =>
            (a as { setMtpSuspended?: (s: boolean) => void }).setMtpSuspended?.(true),
          );
        },
        trimCaches: async () => {
          await eachLoaded((a) => (a as { trimCache?: () => Promise<number> }).trimCache?.());
        },
        unloadModels: async () => {
          await router.releaseAll();
        },
      },
      releaseHandlers: {
        suspendMtp: () => {
          void eachLoaded((a) =>
            (a as { setMtpSuspended?: (s: boolean) => void }).setMtpSuspended?.(false),
          );
        },
      },
    });
    watchdog.onChange((state, previous) =>
      console.log(`   memory watchdog: ${previous} -> ${state.level} (${state.reason})`),
    );
    watchdog.start();
    // Hardware-aware residency: measure every model, derive the budget from
    // this host's RAM, keep the most valuable set resident, swap the rest.
    const plan = await router.calibrate(totalmem());
    console.log(
      `Residency plan (${(plan.budgetBytes / 1024 ** 3).toFixed(0)} GB budget): resident ${plan.resident.join(", ") || "one at a time"}${plan.swapped.length ? `; swapped on demand: ${plan.swapped.join(", ")}` : "; nothing swaps"}.`,
    );
    const pmModel = managerModel ?? DEFAULT_PM_MODEL;
    /** Run a question past the Researcher, then hand the manager back. */
    const askResearcher = researcherModel
      ? async (question: string) => {
          const { web } = await researchSources(config.repoPath);
          const r = await new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            model: () => router.use("researcher"),
          }).ask(question);
          await router.use("manager");
          return r;
        }
      : undefined;
    /** Struggles the playbook had no remedy for: the Researcher's queue. */
    const unexplained: { cardId: string; text: string }[] = [];
    const pmStore = new PmStore(log);
    // Tells the dashboard this process holds the Worker, so PM messages are
    // answered here, between steps, instead of loading a second large model.
    // The lease also publishes the model roster and which role is resident,
    // for the dashboard's Machine view.
    const releaseLease = holdRunnerLease(config.repoPath, pmModel, () => ({
      roster: [
        { role: "worker", model: workerModel ?? NAIL_WORKER_PROFILE.modelId },
        { role: "manager", model: pmModel },
        ...(reviewerModel ? [{ role: "reviewer" as const, model: reviewerModel }] : []),
        ...(researcherModel ? [{ role: "researcher" as const, model: researcherModel }] : []),
      ],
      ...(router.activeRole
        ? { active: router.activeRole === "escalation" ? "manager" : router.activeRole }
        : {}),
      resident: router.residentRoles().map((r) => (r === "escalation" ? "manager" : r)),
      coResident: plan.swapped.length === 0,
    }));

    /**
     * Preemption (PM_CONTRACT §4): after any Worker step, if the human has
     * written to the PM, swap the Worker out, answer, swap it back. The card
     * resumes from its worktree, so nothing is lost; only the reload costs time.
     */
    /** Worker questions waiting for Merit; answers are filed in each card's dossier. */
    const workerQuestions = new QueuedWorkerQuestions();
    const isWorkerQuestion = (m: { context?: { view?: string } }) =>
      m.context?.view === "worker-question";

    /**
     * Collaboration, shaped by the hardware. When Merit is resident, a
     * Worker question the card's contract cannot answer is answered now; when
     * it is swapped out, the question is queued (never forcing a swap on its
     * own) and answered in the next manager batch, then handed to the card's
     * next attempt.
     */
    const askTeam = async (
      cardId: string,
      question: string,
      meta: { questionEntryId?: string } = {},
    ): Promise<string | undefined> => {
      // Only when Merit's weights are already loaded, and always hand back to
      // the role that was running: switching to "worker" during an escalated
      // retry (which runs on Merit's weights) would load a second large model.
      const prior = router.activeRole;
      if (router.isResident("manager")) {
        const card = await cardStore.getCard(cardId);
        const res = await (await router.use("manager")).generate({
          systemPrompt:
            "You are Merit, the project manager. A teammate (the coding Worker) is mid-card and asks a question its card's spec does not answer. Answer in at most three sentences, concretely, consistent with the spec and acceptance tests. If it is genuinely the lead's call, say so and give the most conservative choice.",
          prompt: `Card: ${card?.title ?? cardId}\nSpec: ${card?.spec ?? "(none)"}\nDone when: ${(card?.acceptanceCriteria ?? []).join("; ")}\n\nQuestion: ${question}`,
          toolArm: "arm_a_flat",
          temperature: 0.2,
          maxTokens: 300,
        });
        if (prior) await router.use(prior);
        return res.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || undefined;
      }
      const m = await pmStore.appendUserMessage(
        `[The Worker asks about ${cardId}] ${question}`,
        { cardId, view: "worker-question" },
        "executor",
      );
      workerQuestions.add(cardId, m.id, meta.questionEntryId);
      return undefined;
    };

    /** One paragraph the Worker reads about its team, from the live residency. */
    const teamNote = (): string => {
      const now = (role: "manager" | "researcher" | "reviewer") =>
        router.isResident(role) ? "available now" : "loaded between cards";
      return [
        `Merit (project manager, ${now("manager")}) answers ask() questions your card's contract does not${router.isResident("manager") ? "" : "; until then, proceed conservatively and note your assumption"}.`,
        router.has("researcher")
          ? `A Researcher (${now("researcher")}) investigates errors nothing explained, with sources; its findings reach you as rules.`
          : "",
        router.has("reviewer")
          ? "A Reviewer from a different model family checks passing work against the lead's preferences."
          : "Merit reviews passing work against the lead's preferences.",
        "Everything you learn here is kept: fixed errors and failed approaches carry to the next attempt.",
      ]
        .filter(Boolean)
        .join(" ");
    };

    /**
     * File Merit's answers to queued Worker questions in each card's dossier,
     * threaded under the question, so the card's next attempt reads them.
     */
    const collectAnswers = async (): Promise<void> => {
      if (workerQuestions.size === 0) return;
      const filed = await workerQuestions.fileAnswers(await pmStore.thread(), cardStore);
      if (filed > 0) console.log(`   filed ${filed} answer(s) from Merit in the cards' dossiers`);
    };

    const answerPm = async (step?: number, batch = false): Promise<void> => {
      const queuedNow = await pmStore.queued();
      if (queuedNow.length === 0) return;
      // Only the human's messages pause the Worker; Worker questions wait for
      // the next manager batch instead of forcing a swap each.
      if (!batch && queuedNow.every(isWorkerQuestion)) return;
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
        team: [
          `Worker (${workerModelId}): ${router.isResident("worker") ? "resident" : "swapped out"}; it asks you questions its cards' contracts do not answer.`,
          router.has("researcher")
            ? `Researcher: ${router.isResident("researcher") ? "resident, asking is cheap" : "swapped out, asking costs a model load (~40 s): batch questions into one"}.`
            : "No Researcher configured: use find_library for packages.",
          router.has("reviewer")
            ? "Reviewer (different model family): reviews passing cards at the end of a pass."
            : "You review passing cards yourself at the end of a pass.",
          `Residency: ${router.residentRoles().join(", ") || "none"} loaded now.`,
        ].join("\n"),
        ...(askResearcher ? { researcher: askResearcher } : {}),
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
    /** Rules learned during this run from verified signals: in force for this run. */
    const runRules = new Set<string>();
    const ctx = {
      repoPath: config.repoPath,
      restrictedMode: config.restrictedMode,
      cardStore,
      boardService,
      learning: new LearningStore(log),
      runRules,
      teamNote: () => teamNote(),
      askTeam: (cardId: string, question: string, meta: { questionEntryId?: string }) =>
        askTeam(cardId, question, meta),
      watchdog,
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
    if (argv.includes("--explore")) {
      // Constraints read from the project's own config are facts, so they are
      // activated directly; heuristic rules still wait for a human.
      const r = await applyExploration(ctx.learning, config.repoPath, true, ready);
      console.log(`Explored the project: ${r.activated} constraint rule(s) active.`);
    }
    const maxTurnsIdx = argv.indexOf("--max-turns");
    const maxTurns = maxTurnsIdx !== -1 ? Number(argv[maxTurnsIdx + 1]) : undefined;
    const passedResults: { card: CardRecord; diff: string }[] = [];
    const reviewAll = argv.includes("--review");
    /**
     * Merit reviews passing cards against the user's learned preferences
     * (AutoDev's AI Reviewer). Advice only, recorded on the ledger; it runs
     * while Merit's model is resident, so it never forces an extra swap
     * unless --review asked for it.
     */
    const reviewPassed = async (model: Awaited<ReturnType<typeof router.use>>) => {
      const preferences = (await ctx.learning.profile())
        .filter((p) => p.status === "active" && p.category === "code_style")
        .map((p) => p.statement);
      const rules = (await ctx.learning.rules())
        .filter((r) => r.status === "active" && r.role === "worker")
        .map((r) => r.text);
      for (const { card, diff } of passedResults.splice(0)) {
        const findings = await reviewCard(model, { card, diff, preferences, rules }).catch(
          () => [],
        );
        if (findings.length === 0) continue;
        console.log(`   Merit's review of ${card.id}: ${findings.length} note(s)`);
        // Into the card's dossier: the Review surface shows it, and a
        // returned card's next attempt reads it.
        await recordReview(
          cardStore,
          card.id,
          findings,
          reviewerModel ? "reviewer" : "manager",
        ).catch(() => undefined);
      }
    };
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
      // The real attempt number (across queue runs), not the round.
      const attemptNo = Math.max(
        nextAttemptNumber(config.repoPath, card.id),
        cardStore.runs.nextAttemptNumber(card.id),
      );
      console.log(`\n=== ${card.id} (attempt ${attemptNo}): ${card.title} ===`);
      // What earlier attempts learned reaches this one through the card's
      // dossier (lessons, answers, reviews, send-backs), read by the runner.
      const result = await executeCard(ctx, card, worker, guidance, { attempt: attemptNo });
      if (result.passed) passedResults.push({ card, diff: result.evidence.diff ?? "" });
      for (const st of result.lessons.struggles) {
        const code = /\b(TS\d{4}|lint\/[\w/]+)\b/.exec(st.text)?.[1];
        if (!code || !remedyFor(code, st.text))
          unexplained.push({ cardId: card.id, text: st.text });
      }

      let accepted = false;
      if (result.passed && autoAccept && !result.held) {
        const reviewed = await cardStore.getCard(card.id);
        if (reviewed?.status === "review") {
          // --auto-accept is the harness's verdict, not a person's: the ledger
          // must not credit a human with a merge nobody reviewed.
          const sha = await acceptCard(ctx, reviewed, "harness");
          accepted = true;
          console.log(`   accepted -> main ${sha.slice(0, 10)}`);
        }
      }

      entries.push({
        cardId: card.id,
        attempt: attemptNo,
        passed: result.passed,
        accepted,
        stopReason: result.stopReason,
        turns: result.evidence.turnsUsed,
        durationMs: result.evidence.durationMs,
        promptTokens: result.evidence.tokens.promptTokens,
        completionTokens: result.evidence.tokens.completionTokens,
        ...(result.held ? { held: `${result.held.wanted}: ${result.held.reason}` } : {}),
        ...(result.parked ? { parked: result.parked.suggestion } : {}),
        ...(result.failToPass ? { failToPass: result.failToPass.status } : {}),
        ...(result.resumedFrom ? { resumedFromStep: result.resumedFrom.step } : {}),
        ...(result.replan ? { replanRequested: true } : {}),
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

    // Inferred prerequisites become checked edges in the dependency table
    // (K15, B5): an edge that would close a cycle is refused and reported.
    for (const [id, list] of inferDependencies(ready)) {
      for (const dep of list) {
        await cardStore.addDependency(id, dep, "inferred", "harness").catch((err) => {
          console.log(
            `   dependency ${id} -> ${dep} skipped: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    }
    /** Prerequisites not done yet, from the dependency table. */
    const blockedBy = async (card: CardRecord): Promise<string[]> => cardStore.waitingOn(card.id);
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
        // A parked card (repair rung 4, vacuous tests) waits for a person; it
        // is not re-planned automatically.
        if (!result.passed && !result.parked) failed.push({ card, result });
      }
    };

    try {
      /**
       * Rounds until nothing changes (integration review items 1 and 2).
       * Each round: first attempts (with prerequisite sweeps), then ONE
       * Researcher batch (one load for every question), then ONE manager
       * batch (plans informed by the research, answers to Worker questions),
       * then the retries. Cards that only became runnable later get the same
       * plan-and-retry chance as the rest. Reflection, consolidation and the
       * cross-family review run once at the end, after the retries, so they
       * see whether the plans worked.
       */
      const retried = new Set<string>();
      const reflections: {
        card: CardRecord;
        plan: string;
        firstStop: string;
        retryPassed: boolean;
      }[] = [];
      let firstAttempts: CardRecord[] = ready;
      for (let round = 1; round <= 6 && !halted; round++) {
        await pass(firstAttempts, 1);
        firstAttempts = [];
        let progress = true;
        while (!halted && progress && deferred.length > 0) {
          const before = deferred.length;
          await pass([...deferred], 1);
          progress = deferred.length < before;
        }

        const toRepair = failed
          .splice(0, failed.length)
          .filter(({ card }) => !retried.has(card.id));
        if (halted || !managerModel || toRepair.length === 0) break;

        // Researcher batch: one load, every unexplained struggle.
        if (askResearcher && unexplained.length > 0) {
          const { web } = await researchSources(config.repoPath);
          const service = new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            model: () => router.use("researcher"),
          });
          for (const u of unexplained.splice(0, 4)) {
            const r = await service
              .ask(
                `A coding model working on this TypeScript project hit this error and needed several attempts to fix it: "${u.text}". What is the correct approach? Give one concrete rule.`,
                { cardId: u.cardId },
              )
              .catch(() => undefined);
            if (!r?.grounded) continue;
            const rule = await ctx.learning.propose({
              role: "worker",
              text: r.answer.slice(0, 500),
              scope: {},
              source: "research",
              evidence: [
                { cardId: u.cardId, note: `Researcher, sources: ${r.sources.join("; ")}` },
              ],
            });
            if (rule) runRules.add(rule.id);
            console.log(`   Researcher proposed a rule for ${u.cardId}`);
          }
        }

        // Manager batch: plans (the research is now in the playbook), answers.
        const manager = await router.use("manager");
        const plans = new Map<string, string>();
        for (const { card, result } of toRepair) {
          console.log(`\n--- manager reviewing ${card.id} ---`);
          // A rung-3 re-plan request carries the Worker's own account of the
          // standing failures; otherwise the evidence's failures.
          const plan = await planRepair(manager, {
            card,
            stopReason: result.replan
              ? `${result.stopReason}: ${result.replan.summary}`
              : result.stopReason,
            failures: result.replan?.failures ?? result.evidence.failures,
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
        await answerPm(undefined, true).catch(() => undefined);
        await collectAnswers();

        // Retries, each once.
        const retry = toRepair.map(({ card }) => card);
        for (const card of retry) retried.add(card.id);
        await pass(retry, 2, plans);
        for (const r of reflections) {
          r.retryPassed = entries.some(
            (e) => e.cardId === r.card.id && e.attempt === 2 && e.passed,
          );
        }
        failed.splice(0, failed.length); // a failed retry does not repeat
      }
      for (const card of deferred) {
        console.log(
          `\n--- ${card.id} never ran: prerequisites ${(await blockedBy(card)).join(", ")} did not merge ---`,
        );
      }

      // End phase: learn from what happened, including the retries.
      if (!halted && managerModel && (reflections.length > 0 || passedResults.length > 0)) {
        const manager = await router.use("manager");
        const learned = await reflectWithManager(manager, ctx.learning, reflections).catch(() => 0);
        if (learned > 0) console.log(`\n--- Merit proposed ${learned} rule(s) from this run ---`);
        const c = await consolidateWithManager(manager, ctx.learning).catch(() => undefined);
        if (c && c.merged + c.contradictions + c.duplicates > 0) {
          console.log(
            `--- Merit consolidated rules: ${c.merged} merged, ${c.contradictions} contradiction(s) flagged, ${c.duplicates} duplicate(s) retired ---`,
          );
        }
        await answerPm(undefined, true).catch(() => undefined);
        // Review last, once: the reviewer model loads a single time.
        if (reviewerModel || reviewAll) {
          await reviewPassed(reviewerModel ? await router.use("reviewer") : manager).catch(
            () => undefined,
          );
        }
      } else if (reviewAll && passedResults.length > 0) {
        await reviewPassed(await router.use(reviewerModel ? "reviewer" : "manager")).catch(
          () => undefined,
        );
      }
      // The human's messages are answered before the run ends; queued Worker
      // questions too when Merit is already resident (no extra swap).
      await answerPm(undefined, router.isResident("manager")).catch(() => undefined);
      const held = await boardService.listHeld();
      for (const h of held) console.log(`\n--- ${h.id} is held: ${h.blockedReason} ---`);
    } finally {
      watchdog.stop();
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
      // Measured speed per model and the Worker's prefix-cache reuse (M3, M18).
      throughput: meter.all(),
      cache: cache.summary(),
      memory: { level: watchdog.state.level, reason: watchdog.state.reason },
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
  console.log('  sekhemet research "<q>" [--deep]  Ask the Researcher; answers with sources');
  console.log(`\n${CRAWL4AI_CREDIT}`);
  console.log("=================================================");
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("sekhemet")) {
  main().catch(console.error);
}
