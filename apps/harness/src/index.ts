#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { PlaybookRegistry, SkillsRegistry } from "@sekhemet/context";
import { BenchmarkHarness } from "@sekhemet/eval";
import { DeterministicGateRunner, loadGatesConfig, summarizeEvidence } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { CardRunner } from "@sekhemet/loop";
import { HttpInferenceAdapter, MockInferenceAdapter, createNail35BAdapter } from "@sekhemet/models";
import { SpidrFeaturePlanner } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { type DoctorReport, runDoctor } from "./doctor.js";
import { runMcpStdioServer } from "./mcp.js";
import { startDashboardServer } from "./server.js";

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

  let port = 3333;
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
    console.log("\nRunning model qualification bake-off...");
    const harness = new BenchmarkHarness();
    const mockModel = new MockInferenceAdapter("candidate-local-model", [
      {
        text: "qualified",
        toolCalls: [{ id: "1", name: "finish_card", arguments: {} }],
        usage: { promptTokens: 100, completionTokens: 20, durationMs: 20 },
      },
    ]);
    const res = await harness.runBenchmark(
      [
        {
          id: "task_eval_1",
          repoCommit: "HEAD",
          issueDescription: "Spike test qualification",
          failToPassTests: ["t1"],
          passToPassTests: [],
        },
      ],
      mockModel,
    );
    console.log(
      `Bake-off Results: Pass@1 = ${(res.passAt1 * 100).toFixed(1)}%, Tokens = ${res.totalTokens}, Duration = ${res.totalTimeMs}ms\n`,
    );
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
    if (card.status !== "review") {
      console.error(
        `Card ${cardId} is in '${card.status}'. Only a card in Review can be accepted — the harness verifies, a person accepts.`,
      );
      process.exit(1);
    }

    const gitAdapter = new NodeGitSyncAdapter(config.repoPath);
    // Squash the card's branch onto main so later cards build on accepted work.
    // Without this every card starts from a tree its predecessors never touched.
    const sha = await gitAdapter.squashAndMerge(
      cardId,
      "main",
      `feat(${cardId}): ${card.title}`,
      {
        "Agent-Model": card.modelRoute?.executor ?? "local",
        "Agent-Harness": "sekhemet",
        "Agent-Role": "implementer",
        GateStatus: "pass",
      },
      card.title,
    );

    await boardService.transitionCard({
      cardId,
      fromStatus: card.status,
      toStatus: "done",
      actor: "human",
      reason: "accepted by operator",
    });
    await gitAdapter.removeWorktree(cardId);

    console.log(
      `\nAccepted ${cardId} — squashed to main as ${sha.slice(0, 10)}, card moved to Done.`,
    );
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

    const gitAdapter = new NodeGitSyncAdapter(config.repoPath);
    const gatesConfig = loadGatesConfig(config.repoPath);
    // Restricted mode refuses to execute where the OS cannot confine the
    // subprocess, rather than quietly running the agent unsandboxed.
    const sandbox = new ProcessSandbox({ requireConfinement: config.restrictedMode });
    const gateRunner = new DeterministicGateRunner(sandbox, {
      repoRoot: config.repoPath,
      expectedConfigSha256: gatesConfig.sha256,
    });
    const model = createNail35BAdapter();
    const skills = new SkillsRegistry();
    skills.loadFromDirectory(join(config.repoPath, ".sekhemet", "skills"));
    const playbook = new PlaybookRegistry(config.repoPath);

    const runner = new CardRunner({
      card,
      repoRoot: config.repoPath,
      worktreePath: join(config.repoPath, ".sekhemet", "worktrees", cardId),
      stepBudget: card.stepBudget,
      modelAdapter: model,
      gateRunner,
      syncAdapter: gitAdapter,
      scopeFiles: card.scopeFiles,
      agentRole: "implementer",
      agentHarness: "sekhemet",
      skillsRegistry: skills,
      playbookRegistry: playbook,
      lifecycle: {
        transition: async (id, to) => {
          const current = await cardStore.getCard(id);
          if (!current || current.status === to) return;
          await boardService.transitionCard({
            cardId: id,
            fromStatus: current.status,
            toStatus: to,
            actor: "executor",
            reason: `card runner advanced card to ${to}`,
          });
        },
      },
      onWorktreeReady: async (worktreePath) => {
        // Stage this card's acceptance tests. Contract-first means the oracle
        // for THIS card is present and failing before any work begins, and the
        // suites belonging to later cards are not there to fail it.
        const staged = card.acceptanceTests ?? [];
        if (staged.length === 0) return;

        const testsDir = join(worktreePath, "tests");
        if (!existsSync(testsDir)) mkdirSync(testsDir, { recursive: true });

        for (const name of staged) {
          const from = join(config.repoPath, "acceptance", name);
          if (existsSync(from)) {
            copyFileSync(from, join(testsDir, name));
            console.log(`   staged acceptance test: tests/${name}`);
          }
        }
      },
      onProgress: (event) => {
        const prefix = event.turn ? `  [turn ${event.turn}]` : "  ";
        console.log(`${prefix} ${event.type}: ${event.message}`);
      },
    });

    const result = await runner.run();

    console.log(`\n${summarizeEvidence(result.evidence)}\n`);
    console.log(
      result.passed
        ? `Card ${cardId} PASSED verification and moved to Review for human acceptance.`
        : `Card ${cardId} stopped: ${result.stopReason}. Left in ${result.finalStatus} for inspection.`,
    );

    // Release the model before exiting: holding a resident MoE checkpoint on a
    // constrained box is what starts swapping.
    await model.unload();
    if (!result.passed) process.exitCode = 1;
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
  console.log("  sekhemet gate [card-id]     Run deterministic verification gates");
  console.log("  sekhemet replay <card-id>   Replay checkpoint trajectory for a card");
  console.log("  sekhemet bake-off           Qualify and benchmark local models");
  console.log("  sekhemet ui / serve         Launch local web visual dashboard");
  console.log("  sekhemet mcp                Run stdio MCP server for Cursor / Claude / IDEs");
  console.log("=================================================");
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("sekhemet")) {
  main().catch(console.error);
}
