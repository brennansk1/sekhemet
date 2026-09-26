#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import { type RunProfile, type SuiteRunResult, profileArgs, runScore } from "@sekhemet/eval";
import {
  DeterministicGateRunner,
  detectGateTemplate,
  gateTemplate,
  generateGateHostCerts,
  loadGatesConfig,
  npmRegistry,
  renderGatesToml,
  runBuiltinGates,
  startGateHost,
  summarizeEvidence,
} from "@sekhemet/gates";
import { remedyFor } from "@sekhemet/gates";
import {
  type CardRecord,
  CardStore,
  DEFAULT_STEP_BUDGET,
  EventLog,
  initSchema,
} from "@sekhemet/kernel";
import { planRepair } from "@sekhemet/loop";
import {
  MemoryWatchdog,
  ModelRegistry,
  ModelRoster,
  ModelRouter,
  NAIL_WORKER_PROFILE,
  PrefixCacheMonitor,
  ThroughputMeter,
  type UnloadableAdapter,
  type WorkerOverride,
  defaultRegistryPath,
  describeOverride,
  measureThroughput,
  resolveWorkerModelId,
} from "@sekhemet/models";
import { SpidrFeaturePlanner } from "@sekhemet/planner";
import {
  ProcessSandbox,
  confinedSandbox,
  mergeNetworkConfigs,
  policyFetch,
} from "@sekhemet/sandbox";
import { NodeGitSyncAdapter, gitEnvFor, hardenGitForProcess } from "@sekhemet/sync";
import {
  checkoutNotice,
  enableAutoAccept,
  implementationFiles,
  integrationBranch,
  ledgerBundle,
  recordReviewOpened,
} from "./accept.js";
import { runAcpStdio } from "./acp.js";
import { isAirgapped, mirrorRegistry } from "./airgap.js";
import { resolveVisionModel, visionPrePass } from "./attachments.js";
import { watchBoardHooks } from "./board_hooks.js";
import { parseModelList, runCalibrate, runMtpAb } from "./calibrate_cmd.js";
import { handBack, postCardMessage, requestPause, takeOver } from "./collaborate.js";
import { resolveConfig } from "./config.js";
import {
  cardStepCap,
  configOverrideLines,
  effectiveConfig,
  networkConfigs,
  queueDefaults,
  reviewLimit,
} from "./config_apply.js";
import { daemonStart, daemonStatus, daemonStop, rotateLog } from "./daemon.js";
import { type DoctorReport, runDoctor } from "./doctor.js";
import { egressEvent } from "./egress_event.js";
import {
  type QueueEntry,
  type QueueReport,
  QueuedWorkerQuestions,
  acceptCard,
  collectCardFiles,
  ensureRepoProject,
  executeCard,
  forkCard,
  inferDependencies,
  nextAttemptNumber,
  plannerDifficulty,
  queueEntryOf,
  recordQueueProgress,
  recordQueueReport,
  recordReview,
  requestAbort,
  rewindCard,
} from "./execute.js";
import { reviewPosterFromEnv, runExternalReviews } from "./external_review.js";
import {
  COMMANDS,
  FRONT_DOOR,
  type FrontDoorRoute,
  routeFrontDoor,
  runExitCode,
} from "./front_door.js";
import { runInit } from "./init.js";
import { notifySlack } from "./integrations.js";
import { readSettings } from "./integrations.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { consolidateWithManager, reflectWithManager } from "./learning/reflect.js";
import { reviewCard } from "./learning/review.js";
import { LearningStore } from "./learning/store.js";
import {
  LEDGER_COMMANDS,
  checkLedgerAnchor,
  ledgerCommand,
  openLocalLedger,
} from "./ledger_cmds.js";
import { cardBranchHead, ledgerEvidenceSummary } from "./ledger_evidence.js";
import { licenseGate } from "./license_gate.js";
import { runMcpStdioServer } from "./mcp.js";
import { McpHub, loadMcpConfig, plannerToolsOf } from "./mcp_client.js";
import {
  applyProfileSwitches,
  autoAcceptRefusal,
  profileForQueue,
  profileForRun,
  readMeasurementMarker,
  withoutProfileFlags,
} from "./measure_cmd.js";
import { sendPush, startNotifier } from "./notify.js";
import { nightModelServer, runOvernight } from "./overnight.js";
import { DEFAULT_PM_MODEL, answerQueued, createPmAdapter, dailyStandup } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { runPromptScreen } from "./prompt_screen_cmd.js";
import { applyWorkerOverride, gateWorker } from "./qualify.js";
import { diffTrajectories, formatDiff, formatTrajectory, trajectories } from "./replay.js";
import { isResearchCard, runResearchCard } from "./research/cards.js";
import { CRAWL4AI_CREDIT, runResearchCommand } from "./research/cli.js";
import { planResearch } from "./research/plan_research.js";
import { ResearchService, researchSources } from "./research/service.js";
import { oneShotResearcher } from "./research/service.js";
import { mayStartCard, parseUntil, releaseMachine, reserveMachine } from "./reservation.js";
import {
  LEASE_TOKEN_ENV,
  type LiveLeaseInfo,
  acquireRunnerLease,
  leaseRefusal,
} from "./runner_lease.js";
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js";
import { bakeOffOnSuitePath } from "./suite_path.js";
import { describeSupervisorStart, removeWorktreesOnClose, supervisorStart } from "./supervisor.js";
import { terminalBoardLines } from "./terminal_board.js";
import { tracesCommand } from "./tracing.js";
import { trailerGate } from "./trailer_gate.js";
import { nextForReview, park, reject, reopen, revertAccept, sendBack, unpark } from "./triage.js";
import {
  describeTuning,
  globalTuningPath,
  loadAttempts,
  tuneForRepo,
  writeTuningReport,
} from "./tune.js";
import { migrateLegacyUserDir } from "./user_dir.js";
import { hookEngineFor } from "./user_hooks.js";
import {
  WAVE2_COMMANDS,
  type Wave2Command,
  appliedStepBudget,
  applyTunedPolicy,
  isGreenfield,
  modelRegistry,
  planCommand,
  queuePrelude,
  recordBakeOff,
  replanOnRung3,
  roleForCard,
  runPackageGates,
  runWave2Command,
} from "./wave2.js";
import { runDependencyVerifications } from "./wave2_github.js";
import {
  describeUntrusted,
  setInvocationTrust,
  trustFiles,
  untrustedFiles,
} from "./workspace_trust.js";

export interface CliConfig {
  command:
    | "backup"
    | "restore"
    | "reserve"
    | "pause"
    | "trust"
    | "export"
    | "erase"
    | "doctor"
    | "board"
    | "log"
    | "serve"
    | "run"
    | "plan"
    | "gate"
    | "gates"
    | "gate-host"
    | "replay"
    | "bake-off"
    | "accept"
    | "tune"
    | "research"
    | "overnight"
    | "calibrate"
    | "prompt-screen"
    | "daemon"
    | "traces"
    | "acp"
    | "init"
    | "abort"
    | "rewind"
    | "fork"
    | "resume"
    | "explore"
    | "queue"
    | "mcp"
    | "goal"
    | "decide"
    | "m0"
    | "qualify"
    | "improve"
    | "skills"
    | "release"
    | "ci"
    | "measure"
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

  // One list for the parser and the front door (front_door.ts).
  const validCommands = COMMANDS;

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

/** The repository's measurement marker, as the board's option (rule 24). */
function measurementOption(repoPath: string): { measurementMarker?: { purpose: string } } {
  const marker = readMeasurementMarker(repoPath);
  return marker ? { measurementMarker: marker } : {};
}

/** A project named by id or by name (`dev pause|resume <project>`). */
function findProject(cardStore: CardStore, ref: string | undefined) {
  if (!ref) return undefined;
  return cardStore.listProjects().find((p) => p.id === ref || p.name === ref);
}

/** Whether `resume <ref>` names a project rather than a card (RUN-48). */
function isProjectRef(cardStore: CardStore, ref: string | undefined): boolean {
  return findProject(cardStore, ref) !== undefined;
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
  // The install's person, the erasure register and the schema check (RUN-44).
  const { db, log } = openLocalLedger(repoPath);
  const cardStore = new CardStore(db, log);
  // Production boards check every column's entry condition (B1); Review
  // reads the evidence bundle the ledger records for the card (K-S7-7),
  // never a `latest-<card>.json` pointer, and none recorded before a rewind
  // (K-S7-8).
  // H15: [review] wip from config.toml sets the Review limit.
  const review = reviewLimit(effectiveConfig(repoPath).config);
  const boardService = new BoardServiceImpl(cardStore, {
    ...(review ? { customLimits: { review } } : {}),
    entryConditions: true,
    // K-N8-4: external CI results count only when declared blocking, at the branch head.
    evidenceFor: (cardId) =>
      ledgerEvidenceSummary(cardStore, repoPath, cardId, {
        blockingChecks: effectiveConfig(repoPath).config.review.blockingChecks,
        branchHead: (id) => cardBranchHead(repoPath, id),
      }),
    // K-N5-1: the Planner scores an unscored card as it enters Planning.
    planner: { scoreDifficulty: (card) => plannerDifficulty(card) },
    // Rule 24: the harness accepts a leaf card only where a measured run
    // prepared the repository (--auto-accept's bound); elsewhere a person does.
    ...measurementOption(repoPath),
  });

  // NEW-extensibility-1: the team's board-lifecycle hooks (a card moved, was
  // accepted, had a pull request opened) run after each such ledger event.
  watchBoardHooks(log, cardStore, repoPath);

  // RUN-16: a closed card's worktree goes, its branch stays — on every path
  // that closes a card through this kernel.
  removeWorktreesOnClose(repoPath, log);
  return { db, log, cardStore, boardService };
}

export async function printTerminalBoard(boardService: BoardServiceImpl): Promise<void> {
  // NEW-surface-2 (SUR-27): the board's columns and state names, not internal ids.
  console.log(`\n${terminalBoardLines(await boardService.getBoardState()).join("\n")}`);
}

export async function printEventLog(log: EventLog): Promise<boolean> {
  const events = await log.getEvents(1, 20);
  const verification = await log.verifyHashChain({ full: true });

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
  // K-N7-2: an erasure is a named gap, never a corruption.
  for (const gap of verification.erased ?? []) console.log(`  ${gap.message}`);
  console.log(
    "=========================================================================================\n",
  );
  return verification.valid;
}

export async function main(rawArgv: string[] = process.argv.slice(2)): Promise<void> {
  // Every git call this process makes ignores repository config that runs
  // programs (core.fsmonitor, hooks): git runs outside the sandbox in
  // worktrees the Worker has written to (Phase A security finding S1).
  const route = routeFrontDoor(rawArgv);
  // SUR-13: the version reads one file and writes nothing.
  if (route.kind === "version") {
    console.log(harnessVersion());
    return;
  }
  // SUR-15: an unknown flag is named, never ignored.
  if (route.kind === "unknown-flag") {
    console.error(`sekhemet: unknown flag ${route.flag}. \`sekhemet --help\` lists the commands.`);
    process.exitCode = 2;
    return;
  }
  hardenGitForProcess();
  if (route.kind === "help") return printFrontDoorHelp();
  if (route.kind === "dev-help") return printDevHelp();
  if (route.kind === "unknown") {
    console.error(
      route.suggest
        ? `sekhemet: no command "${route.word}". Did you mean \`sekhemet ${route.suggest}\`?`
        : `sekhemet: ${route.word.includes(" ") ? route.word : `no command "${route.word}"`}. \`sekhemet --help\` lists them; to ask for work, describe it in a sentence.`,
    );
    process.exitCode = 2;
    return;
  }
  if (route.kind === "spec") {
    // One verb for "plan this and build it": the plan, then the queue.
    await main(["plan", route.spec, ...route.flags]);
    if (process.exitCode) return;
    return main(["queue", ...route.flags]);
  }
  if (route.kind === "home") return openHome(route.flags);
  if (
    route.kind === "review" ||
    route.kind === "send-back" ||
    route.kind === "park" ||
    route.kind === "unpark" ||
    route.kind === "reopen" ||
    route.kind === "reject" ||
    route.kind === "revert"
  ) {
    return runTriage(route, parseCliArgs(route.flags).repoPath);
  }
  if (route.kind === "card") return runCardVerb(route, parseCliArgs(route.flags).repoPath);
  const argv = route.argv;
  const config = parseCliArgs(argv);
  // S9, item 40: `--trust` trusts the repository's configuration for this
  // invocation only; nothing is ever trusted implicitly.
  setInvocationTrust(argv.includes("--trust"));

  if (config.command === "traces") {
    // `sekhemet traces [--since-hours N] [--out f.json] [--otlp http://host:4318]` (H22).
    process.exitCode = await tracesCommand(config.repoPath, argv.slice(argv.indexOf("traces") + 1));
    return;
  }

  if ((LEDGER_COMMANDS as readonly string[]).includes(config.command)) {
    // `sekhemet dev backup|restore|export`, `sekhemet erase` (kernel NEW-kernel-7,
    // runtime NEW-runtime-8, security NEW-security-7).
    process.exitCode = await ledgerCommand(
      config.command as (typeof LEDGER_COMMANDS)[number],
      argv,
      config.repoPath,
    );
    return;
  }

  if (config.command === "daemon") {
    // `sekhemet daemon start|stop|status [--port N]` (H1): the dashboard in the background.
    const action = argv[argv.indexOf("daemon") + 1] ?? "status";
    if (action === "start") {
      const r = await daemonStart(config.repoPath, config.port);
      console.log(r.message);
      if (!r.started && !r.message.startsWith("Already")) process.exitCode = 1;
    } else if (action === "stop") {
      console.log(await daemonStop(config.repoPath));
    } else {
      console.log(await daemonStatus(config.repoPath));
    }
    return;
  }

  if (config.command === "prompt-screen") {
    // `sekhemet prompt-screen [--from <repo,...>] [--limit N] [--worker cyber-tiel]`:
    // the step-replay screen (PROMPT_STANDARD rule 35.3). It screens, never admits.
    const rest = argv.slice(argv.indexOf("prompt-screen") + 1);
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i === -1 ? undefined : rest[i + 1];
    };
    const limit = Number(flag("--limit")) || undefined;
    const model = new ModelRoster({ registry: modelRegistry() }).resolve(
      flag("--worker") ?? "cyber-tiel",
      "worker",
    );
    const report = await runPromptScreen({
      model,
      repos: (flag("--from") ?? "").split(",").filter(Boolean),
      ...(limit ? { limit } : {}),
    });
    await model.unload?.();
    process.exitCode = report.passed ? 0 : 1;
    return;
  }

  if (config.command === "calibrate") {
    // `sekhemet calibrate [--models cyber-tiel=worker,apodex=researcher] [--buckets 2048,8192] [--force]` (H3).
    const rest = argv.slice(argv.indexOf("calibrate") + 1);
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i === -1 ? undefined : rest[i + 1];
    };
    // `sekhemet calibrate --mtp-ab --from <repo,...> [--max-steps N] [--thinking off|surgical|all] [--worker cyber-tiel]`:
    // MTP decided on recorded Worker steps (MD-M11-1/2).
    if (rest.includes("--mtp-ab")) {
      const repos = (flag("--from") ?? "").split(",").filter(Boolean);
      if (repos.length === 0) {
        console.error(
          "Usage: sekhemet calibrate --mtp-ab --from <repo,...> [--max-steps N] [--thinking off|surgical|all]",
        );
        process.exitCode = 2;
        return;
      }
      const maxSteps = Number(flag("--max-steps")) || undefined;
      const thinking = flag("--thinking");
      if (thinking !== undefined && !["off", "surgical", "all"].includes(thinking)) {
        console.error("--thinking takes off, surgical or all");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runMtpAb({
        repos,
        ...(flag("--worker") ? { worker: flag("--worker") as string } : {}),
        ...(maxSteps ? { maxSteps } : {}),
        ...(thinking ? { thinking: thinking as "off" | "surgical" | "all" } : {}),
      });
      return;
    }
    const buckets = flag("--buckets")
      ?.split(",")
      .map(Number)
      .filter((n) => n > 0);
    await runCalibrate({
      models: parseModelList(flag("--models")),
      ...(buckets?.length ? { buckets } : {}),
      force: rest.includes("--force"),
    });
    return;
  }

  if (config.command === "init") {
    // `sekhemet init [--force]`: the first-run wizard (H25).
    const r = runInit(config.repoPath, { force: argv.includes("--force") });
    if (!r.ready) process.exitCode = 1;
    return;
  }

  if (config.command === "research") {
    // `sekhemet research "<question>" [--deep]`: the Researcher, with sources.
    const dbPath = join(config.repoPath, ".sekhemet", "events.db");
    let store: CardStore | undefined;
    let researchLog: EventLog | undefined;
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      initSchema(db);
      researchLog = new EventLog(db);
      store = new CardStore(db, researchLog);
    }
    const researchCode = await runResearchCommand(
      argv.slice(argv.indexOf("research") + 1),
      config.repoPath,
      store,
      researchLog,
    );
    // Exit explicitly: the Crawl4AI sidecar, sockets and timers must not keep
    // the CLI alive once the answer is out.
    process.exit(researchCode);
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
    // MS-T8-11: tuned here only on classes with MIN_ARM_TRIALS attempts;
    // otherwise the machine's report is proposed, labelled inherited.
    const tuning = tuneForRepo(attempts, {
      current: { stepBudget: DEFAULT_STEP_BUDGET, maxFailedChecks: 4 },
      globalPath: globalTuningPath(),
      repo: config.repoPath,
    });
    console.log(describeTuning(tuning));
    if (tuning.kind === "insufficient data") return;
    let proposed = tuning.kind === "inherited" ? tuning.policy : tuning.report.best.policy;
    if (tuning.kind === "local") {
      const report = tuning.report;
      const fmt = (s: typeof report.current) =>
        `${s.policy.stepBudget} steps, ${s.policy.maxFailedChecks} failed checks: first try ${s.firstTry}/${s.cards}, eventually ${s.eventually}/${s.cards}, ${s.minutes} min`;
      console.log(`Replayed ${attempts.length} attempts on ${report.current.cards} cards.`);
      console.log(`Current:     ${fmt(report.current)}`);
      console.log(`Recommended: ${fmt(report.best)}`);
      console.log(
        `Replay can only stop a recorded attempt earlier, so the recommendation never overstates. Apply it with: sekhemet queue --max-turns ${report.best.policy.stepBudget}`,
      );
      console.log(`Report: ${writeTuningReport(config.repoPath, report)}`);
      proposed = report.best.policy;
    }
    if (argv.includes("--apply")) {
      // E8: applied within +-15% of the current policy, watched by the
      // learning guard and rolled back if the next 10 cards do worse.
      const applied = applyTunedPolicy(
        config.repoPath,
        proposed,
        tuning.kind === "inherited"
          ? `tune: inherited from ${tuning.from} (${tuning.at.slice(0, 10)})`
          : `tune: ${tuning.report.best.firstTry}/${tuning.report.best.cards} first try at ${proposed.stepBudget} steps`,
      );
      console.log(
        `Applied ${applied.id}: ${applied.stepBudget} steps, ${applied.maxFailedChecks} failed checks${applied.clamped ? " (clamped to +-15%)" : ""}. The queue uses it when --max-turns is not given.`,
      );
    }
    return;
  }

  if (config.command === "doctor") {
    if (argv.includes("--airgap")) {
      // X14: the air-gap self-test, written to the audit log.
      const { airgapCommand } = await import("./airgap.js");
      const { log } = initLocalKernel(config.repoPath);
      process.exitCode = await airgapCommand(
        config.repoPath,
        ["selftest", ...argv.slice(argv.indexOf("--airgap") + 1)],
        {
          log,
          print: (l) => console.log(l),
        },
      );
      return;
    }
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
  const project = await ensureRepoProject(cardStore, config.repoPath).catch(() => undefined);
  // ReviewWIP from this person's measured review minutes (B3).
  if (project) {
    await boardService.calibrateReviewWip(project.reviewMinutesPerDay).catch(() => undefined);
  }

  if ((WAVE2_COMMANDS as readonly string[]).includes(config.command)) {
    // goal, decide, m0, qualify, improve, skills, release, ci (wave2.ts).
    const cmd = config.command as Wave2Command;
    const roster = new ModelRoster({ registry: modelRegistry() });
    process.exitCode = await runWave2Command(
      cmd,
      argv
        .slice(argv.indexOf(cmd) + 1)
        .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
      { repoPath: config.repoPath, cardStore, log, boardService },
      { print: (l) => console.log(l), model: (name) => roster.resolve(name, "worker") },
    );
    return;
  }

  if (config.command === "mcp") {
    await runMcpStdioServer({ db, log, cardStore, boardService, repoPath: config.repoPath });
    return;
  }

  if (config.command === "overnight") {
    // `sekhemet overnight [--until 07:00] [--idle-min 20] [--max-failures 3] [queue flags...]`:
    // queue rounds while the machine is free and every breaker holds (H21, H23).
    const { config: cfg } = resolveConfig({ repoPath: config.repoPath });
    // One runner (item 3): the night holds the lease, and each round's queue
    // runs under it (its token handed down), so no other runner slips in
    // between rounds.
    const nightLease = acquireRunnerLease(config.repoPath, { kind: "overnight" });
    if ("holder" in nightLease) {
      console.error(leaseRefusal(nightLease.holder));
      process.exitCode = 1;
      return;
    }
    process.env[LEASE_TOKEN_ENV] = nightLease.lease.token;
    // The supervisor's start-up pass under the night's lease, before M0 and
    // the first round (items 10, 33, 34); each round's queue makes its own.
    for (const line of describeSupervisorStart(
      await supervisorStart({ repoPath: config.repoPath, cardStore, log, boardService }),
    )) {
      console.log(line);
    }
    const own = new Set(["--until", "--idle-min", "--max-failures", "--round-limit-min", "--repo"]);
    const rest = argv.slice(argv.indexOf("overnight") + 1);
    const queueArgs = rest.filter((a, i) => !own.has(a) && !own.has(rest[i - 1] ?? ""));
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i === -1 ? undefined : rest[i + 1];
    };
    const summary = await runOvernight({
      repoPath: config.repoPath,
      log,
      cardStore,
      hours: cfg.machine.hours,
      limits: {
        kwhPerDay: cfg.machine.powerBudgetKwhDay,
        maxConsecutiveFailures: Number(flag("--max-failures")) || 3,
      },
      ...(flag("--until") ? { until: flag("--until") as string } : {}),
      ...(flag("--idle-min") ? { idleMinutes: Number(flag("--idle-min")) } : {}),
      ...(Number(flag("--round-limit-min")) > 0
        ? { roundLimitMs: Number(flag("--round-limit-min")) * 60_000 }
        : {}),
      queueArgs,
      // SEC-37b: the Worker this queue runs, as the model registry records it.
      worker: (() => {
        // The queue's own choice (`--worker`, then config, then the default
        // Worker profile), with an `ollama/` prefix stripped as the queue does.
        // A managed name resolves to the model it serves (B1 Tier 3 run).
        const modelId = resolveWorkerModelId(
          flag("--worker") ??
            queueDefaults(effectiveConfig(config.repoPath, argv).config, argv).worker ??
            NAIL_WORKER_PROFILE.modelId,
        );
        const quant = new ModelRegistry(defaultRegistryPath()).get(modelId)?.quant ?? "unknown";
        return { modelId, quant };
      })(),
      // RUN-18a: the night owns the Worker's server; every round attaches to it.
      ...(() => {
        try {
          const name =
            flag("--worker") ??
            queueDefaults(effectiveConfig(config.repoPath, argv).config, argv).worker ??
            NAIL_WORKER_PROFILE.modelId;
          const held = nightModelServer(
            new ModelRoster({ registry: modelRegistry() }).resolve(name, "worker"),
          );
          return held ? { modelServer: held } : {};
        } catch {
          return {};
        }
      })(),
    });
    nightLease.release();
    if (summary.passed < summary.cardsRun) process.exitCode = 1;
    return;
  }

  if (config.command === "trust") {
    // `sekhemet dev trust [--yes]` (S9, items 38–40): exactly what the
    // repository's configuration would run outside the sandbox, then the
    // person's yes, recorded in the user directory by each file's SHA-256.
    const files = untrustedFiles(config.repoPath);
    if (files.length === 0) {
      console.log("Nothing in this repository waits for your trust.");
      return;
    }
    console.log("This repository's configuration would run code outside the sandbox:");
    for (const line of describeUntrusted(config.repoPath, files)) console.log(line);
    let yes = argv.includes("--yes");
    if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      yes = /^y(es)?$/i.test((await rl.question("Trust exactly this? [y/N] ")).trim());
      rl.close();
    }
    if (!yes) {
      console.error(
        "Not trusted: nothing of it runs. Trust it with `sekhemet dev trust --yes`, or for one run with --trust.",
      );
      process.exitCode = 1;
      return;
    }
    const principal = cardStore.localPrincipal();
    const trusted = trustFiles(config.repoPath, files, principal);
    // The decision on the ledger too: who trusted what, by SHA-256 (item 39).
    await cardStore.recordLedgerEvent({
      type: "workspace/trusted",
      actor: "human",
      principal,
      payload: { principal, files: trusted },
    });
    console.log(
      `Trusted ${files.length} file(s) as they are now; any change to one untrusts it again.`,
    );
    return;
  }

  if (config.command === "reserve") {
    // `sekhemet dev reserve [--until HH:MM|ISO]` and `--release` (item 17,
    // RUN-58): the same ledger events the dashboard's Reserve now appends.
    const principal = cardStore.localPrincipal();
    if (argv.includes("--release")) {
      const released = await releaseMachine(log, { principal });
      console.log(
        released
          ? "Released: unattended work may use the machine again."
          : "The machine was not reserved.",
      );
      return;
    }
    const untilSpec = argv[argv.indexOf("--until") + 1];
    const until = argv.includes("--until") && untilSpec ? parseUntil(untilSpec) : undefined;
    if (argv.includes("--until") && !until) {
      console.error(`--until takes HH:MM or an ISO time, not "${untilSpec ?? ""}".`);
      process.exitCode = 2;
      return;
    }
    const reserved = await reserveMachine(log, { principal, ...(until ? { until } : {}) });
    console.log(
      reserved
        ? `Reserved${until ? ` until ${until.toISOString()}` : " until you run `sekhemet dev reserve --release`"}: no unattended card or benchmark starts meanwhile.`
        : "The machine is already reserved.",
    );
    return;
  }

  if (
    config.command === "pause" ||
    (config.command === "resume" && isProjectRef(cardStore, config.targetArg))
  ) {
    // `sekhemet dev pause|resume <project>` (item 17a, RUN-48): no new card of
    // a paused project starts; a running one finishes. Recorded, with the person.
    const project = findProject(cardStore, config.targetArg);
    if (!project) {
      console.error(`Usage: sekhemet dev ${config.command} <project id or name>`);
      process.exitCode = 2;
      return;
    }
    const status = config.command === "pause" ? "paused" : "active";
    try {
      await cardStore.setProjectStatus(project.id, status, "human");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    console.log(
      status === "paused"
        ? `Project ${project.name} is paused: no new card of it starts until you resume it; a running card finishes.`
        : `Project ${project.name} is active again.`,
    );
    return;
  }

  if (config.command === "acp") {
    // `sekhemet acp`: the Agent Client Protocol on stdio, for editors (H14).
    const acpResearcher = process.env.SEKHEMET_RESEARCHER;
    await runAcpStdio({
      repoPath: config.repoPath,
      cardStore,
      pmStore: new PmStore(log),
      pmModel: DEFAULT_PM_MODEL,
      acquire: async () => createPmAdapter(DEFAULT_PM_MODEL),
      ...(acpResearcher
        ? {
            researcher: (q: string, o?: { deep?: boolean }) =>
              oneShotResearcher(config.repoPath, acpResearcher, cardStore)(q, o),
          }
        : {}),
    });
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
    const chainValid = await printEventLog(log);
    if (!chainValid) process.exitCode = 1;
    // K-N1-5: the newest Ledger-Head anchor in git exposes a truncated tail.
    const anchor = checkLedgerAnchor(config.repoPath, db);
    if (anchor.status === "truncated") {
      console.log(
        ` Ledger TRUNCATED: git's newest Ledger-Head names seq ${anchor.seq}, and the ledger ends at seq ${anchor.lastSeq}.`,
      );
      process.exitCode = 1;
    } else if (anchor.status === "mismatch") {
      console.log(
        ` Ledger REWRITTEN: seq ${anchor.seq} no longer has the hash git's Ledger-Head recorded.`,
      );
      process.exitCode = 1;
    } else if (anchor.status === "ok") {
      console.log(` Ledger-Head anchor at seq ${anchor.seq} matches.`);
    }
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
    // Started by `daemon start`: rotate its log by size while it runs (RUN-14).
    const daemonLog = process.env.SEKHEMET_DAEMON_LOG;
    if (daemonLog) setInterval(() => rotateLog(daemonLog), 60_000).unref();
    console.log("\n=================================================");
    console.log(" Sekhemet Visual Dashboard running at:");
    console.log(`   http://127.0.0.1:${server.port}`);
    console.log(" Press Ctrl+C to stop.");
    console.log("=================================================\n");
    return;
  }

  if (config.command === "plan") {
    // `sekhemet plan "<spec>" [--sketcher <model>]`: SPIDR against the real
    // codebase map, persisted with the whole contract, INVEST enforced and
    // the batched decision parked (wave2.ts planCommand).
    const spec = config.targetArg || "New feature specification";
    console.log(`\nPlanning feature: "${spec}"`);
    // The planning model: --planner (or the older --sketcher), else an
    // explicit [models] planner. It is loaded before the Worker and unloaded
    // after planning, so the two never share memory.
    const flagged = (name: string) =>
      argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
    const configured = effectiveConfig(config.repoPath).config.models.planner;
    const plannerName =
      flagged("--planner") ??
      flagged("--sketcher") ??
      (configured !== "auto" ? configured : undefined);
    const sketcher = plannerName
      ? new ModelRoster({ registry: modelRegistry() }).resolve(plannerName, "manager")
      : undefined;
    // design-stage S8: the reuse survey reads public registries, GitHub and
    // paper indexes with short keyword queries only when a person allowed
    // research — asked once, on a new project's first plan, before any
    // request (DS-S8-2) — through the network policy, each query logged.
    // Otherwise, and under --offline, it makes no request and says so.
    const research = await planResearch({
      repoPath: config.repoPath,
      log,
      offline: argv.includes("--offline") || process.env.SEKHEMET_OFFLINE === "1",
      newProject: isGreenfield(config.repoPath),
      print: (l) => console.log(l),
      ...(process.stdin.isTTY ? { ask: askYesNo } : {}),
    });
    // EXT-20: the servers the person approved offer their tools to the
    // Planner while it sketches, within the prompt budget.
    const mcpConfig = sketcher ? loadMcpConfig(config.repoPath) : {};
    const hub =
      Object.keys(mcpConfig).length > 0
        ? await McpHub.connect(config.repoPath, mcpConfig)
        : undefined;
    for (const e of hub?.errors ?? []) console.log(`MCP server not connected: ${e}`);
    const plannerTools = hub ? plannerToolsOf(hub) : undefined;
    try {
      await planCommand({ repoPath: config.repoPath, cardStore, log }, spec, {
        ...(sketcher ? { sketcher } : {}),
        ...(plannerTools ? { plannerTools } : {}),
        ...(research ? { research } : {}),
      });
    } finally {
      await hub?.close();
    }
    await (sketcher as { unload?: () => Promise<void> } | undefined)?.unload?.();
    console.log("View the cards with 'sekhemet board'.\n");
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
    const gateRunner = new DeterministicGateRunner(confinedSandbox(config.restrictedMode), {
      repoRoot: config.repoPath,
      expectedConfigSha256: gatesConfig.sha256,
    });
    console.log(`\nRunning ${rungs.join(", ")} in ${cwd}`);
    let res = await gateRunner.runGates(rungs, cwd);
    // The built-in security, hygiene and robustness layers, on the card's diff (G3).
    if (cardId && cwd !== config.repoPath) {
      const diff = (() => {
        try {
          const env = gitEnvFor(cwd);
          execFileSync("git", ["add", "-A"], { cwd, env, stdio: "ignore" });
          return execFileSync(
            "git",
            ["diff", "--cached", "--unified=0", "--no-ext-diff", "--no-textconv", "main"],
            {
              cwd,
              env,
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
            },
          );
        } catch {
          return "";
        }
      })();
      const extra = await runBuiltinGates({
        root: cwd,
        base: "main",
        diff,
        project: { ...gatesConfig.project, mutation: false },
        // Air-gapped: only mirrored packages exist (X10).
        registry: isAirgapped(config.repoPath)
          ? mirrorRegistry(config.repoPath)
          : npmRegistry(config.repoPath, {
              // Through the one network policy (security item 32, SEC-14).
              fetchImpl: policyFetch(
                (() => {
                  const n = networkConfigs(config.repoPath);
                  return mergeNetworkConfigs(n.user, n.project);
                })(),
                {
                  purpose: "supply-chain",
                  // Inside the card-diff branch: cardId is set. A lookup whose
                  // record fails fails too (security item 33).
                  record: (r) =>
                    cardStore.recordEvent({
                      ...egressEvent(r),
                      cardId: String(cardId),
                      actor: "system",
                    }),
                },
              ) as typeof fetch,
            }),
      });
      res = {
        ...res,
        passed: res.passed && extra.failures.length === 0,
        failures: [...extra.failures, ...res.failures],
        rungResults: [...(res.rungResults ?? []), ...extra.outcomes],
      };
      for (const a of extra.advisories) console.log(`  advisory: ${a}`);
      // X20: dependencies the card adds, against the licence register.
      const lic = licenseGate(cwd, "main");
      if (lic.failures.length > 0)
        res = { ...res, passed: false, failures: [...res.failures, ...lic.failures] };
      for (const a of lic.advisories) console.log(`  advisory: ${a}`);
      // X26: every commit on the card's branch carries the attribution trailers.
      const trailers = trailerGate(cwd, "main");
      if (trailers.length > 0)
        res = { ...res, passed: false, failures: [...res.failures, ...trailers] };
    }
    // Y19: in a monorepo, each package the card touches runs its own gates.
    if (cardId && cwd !== config.repoPath) {
      const changed = (await new NodeGitSyncAdapter(config.repoPath).getDiffStats(cardId))
        .filesTouched;
      const pkg = await runPackageGates(config.repoPath, cwd, changed, undefined, {
        restricted: config.restrictedMode,
      });
      if (pkg.some((p) => !p.passed)) res = { ...res, passed: false };
    }
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

  if (config.command === "gate-host") {
    // `sekhemet gate-host init`: a CA, server and client certificates under
    // .sekhemet/gate-host. `sekhemet gate-host [--port N]`: serve
    // verifications over mutual TLS (G24); point gates.toml [gate_host] at it.
    const certDir = join(config.repoPath, ".sekhemet", "gate-host");
    const { server } = generateGateHostCerts(certDir);
    if (config.targetArg === "init") {
      console.log(`Gate host certificates in ${certDir} (ca.pem, server.*, client.*).`);
      console.log(
        `Add to gates.toml:\n[gate_host]\nurl = "https://127.0.0.1:${config.port === DEFAULT_DASHBOARD_PORT ? 7443 : config.port}"`,
      );
      return;
    }
    const host = await startGateHost({
      tls: server,
      port: config.port === DEFAULT_DASHBOARD_PORT ? 7443 : config.port,
      run: async (req) => {
        const root = req.repoRoot ?? req.cwd;
        const runner = new DeterministicGateRunner(new ProcessSandbox(), {
          repoRoot: root,
          // The caller caps once, after every gate (gates rule 20).
          maxFailuresReported: Number.POSITIVE_INFINITY,
          ...(req.expectedConfigSha256 ? { expectedConfigSha256: req.expectedConfigSha256 } : {}),
        });
        return runner.runGates(req.rungs, req.cwd);
      },
      onRun: (req, peer, result) =>
        console.log(
          `${new Date().toISOString()} ${peer}: ${req.rungs.join(",")} in ${req.cwd} -> ${result.passed ? "pass" : "fail"}`,
        ),
    });
    console.log(
      `Sekhemet gate host on https://127.0.0.1:${host.port} (mutual TLS; Ctrl+C to stop)`,
    );
    return;
  }

  if (config.command === "gates") {
    // `sekhemet gates init [--force]`: write the gate template detected from
    // the project's manifests to .sekhemet/gates.toml (G27).
    if (config.targetArg !== "init") {
      console.error("Usage: sekhemet gates init [--force]");
      process.exitCode = 1;
      return;
    }
    const target = join(config.repoPath, ".sekhemet", "gates.toml");
    if (existsSync(target) && !argv.includes("--force")) {
      console.error(`${target} exists; pass --force to replace it.`);
      process.exitCode = 1;
      return;
    }
    const kind = detectGateTemplate(config.repoPath);
    const gates = gateTemplate(config.repoPath, kind);
    if (!gates) {
      console.error("No manifest recognised (package.json, pyproject.toml, Cargo.toml, go.mod).");
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderGatesToml(gates));
    console.log(`Wrote ${target} (${kind}: ${gates.map((g) => g.id).join(", ")}).`);
    return;
  }

  if (config.command === "abort") {
    // `sekhemet abort <card> [reason]`: the running card stops before its next turn (L25).
    const cardId = config.targetArg;
    if (!cardId) {
      console.error("Usage: sekhemet abort <card-id> [reason]");
      process.exitCode = 1;
      return;
    }
    const reason = argv
      .slice(argv.indexOf(cardId) + 1)
      .filter((a) => !a.startsWith("--"))
      .join(" ");
    await requestAbort(cardStore, cardId, reason || "stopped from the CLI");
    console.log(`Stop requested for ${cardId}; it stops before its next turn.`);
    return;
  }

  if (config.command === "rewind" || config.command === "fork") {
    // `sekhemet rewind <card> <step>` (H19) / `sekhemet fork <card> <step> [--attempt <id>]` (H18).
    const cardId = config.targetArg;
    const step = Number(argv[argv.indexOf(cardId ?? "") + 1]);
    if (!cardId || !Number.isInteger(step) || step < 0) {
      console.error(`Usage: sekhemet ${config.command} <card-id> <step>`);
      process.exitCode = 1;
      return;
    }
    const ctx = { repoPath: config.repoPath, restrictedMode: false, cardStore, boardService };
    try {
      const attemptIdx = argv.indexOf("--attempt");
      const r =
        config.command === "fork"
          ? await forkCard(ctx, cardId, step, attemptIdx !== -1 ? argv[attemptIdx + 1] : undefined)
          : await rewindCard(ctx, cardId, step);
      console.log(
        `${config.command === "fork" ? "Forked" : "Rewound"} ${cardId} to step ${r.step} (${r.gitRef.slice(0, 10)}). The state it left is kept at ${r.preservedRef}. Its next run continues from step ${r.step}.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  if (config.command === "replay") {
    // `sekhemet replay <card> [--attempt N] [--diff A,B] [--as <model>]` (H8):
    // the trajectories from the ledger, a step-aligned diff of two attempts,
    // or a fresh attempt on another model (forked from the start) and its diff.
    const cardId = config.targetArg;
    if (!cardId) {
      console.error("Usage: sekhemet replay <card-id> [--attempt N] [--diff A,B] [--as <model>]");
      process.exit(1);
    }
    const flagOf = (name: string) => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    const as = flagOf("--as");
    if (as) {
      const card = await cardStore.getCard(cardId);
      if (!card) {
        console.error(`Card not found: ${cardId}`);
        process.exit(1);
      }
      const replayCtx = {
        repoPath: config.repoPath,
        restrictedMode: config.restrictedMode,
        cardStore,
        boardService,
      };
      // The same gate as run and queue (review medium 2): refused unless its
      // combination qualified, marked when it runs under a person's override.
      const registry = modelRegistry();
      const adapter = new ModelRoster({ registry }).resolve(as, "worker");
      const gate = gateWorker(registry, adapter, as);
      if (gate.refusal) {
        console.error(gate.refusal);
        process.exit(1);
      }
      if (gate.override)
        console.log(`Worker ${adapter.modelId}: ${describeOverride(gate.override)}`);
      await forkCard(replayCtx, cardId, 0);
      console.log(`Replaying ${cardId} from the start on ${as}...`);
      try {
        await executeCard(replayCtx, (await cardStore.getCard(cardId)) ?? card, adapter);
      } finally {
        await (adapter as { unload?: () => Promise<void> }).unload?.().catch(() => undefined);
      }
    }
    const all = await trajectories(cardStore, cardId);
    if (all.length === 0) {
      console.log(`No attempts recorded for ${cardId}.`);
      return;
    }
    const pick = (n: string | undefined) =>
      all.find((t) => String(t.attemptNumber) === n) ?? all.at(-1);
    const diff =
      flagOf("--diff") ??
      (as && all.length >= 2
        ? `${all.at(-2)?.attemptNumber},${all.at(-1)?.attemptNumber}`
        : undefined);
    if (diff) {
      const [x, y] = diff.split(",");
      const a = pick(x);
      const b = pick(y);
      if (a && b) console.log(`\n${formatDiff(a, b, diffTrajectories(a, b))}\n`);
      return;
    }
    const only = flagOf("--attempt");
    for (const t of only
      ? [pick(only)].filter((x): x is NonNullable<typeof x> => Boolean(x))
      : all) {
      console.log(`\n${formatTrajectory(t)}`);
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
    // The one measurement path (measurement MS-M9-1): each Worker runs the
    // fixture through the suite runner, and so through the product's queue.
    const base = join(tmpdir(), `sekhemet-bakeoff-${Date.now()}`);
    const rows = await bakeOffOnSuitePath({ harnessRoot, workers, fixture, manager, dir: base });

    console.log(`\nBake-off on ${fixture}${manager ? ` (manager: ${manager})` : ""}`);
    console.log(
      "worker                                   passed/measured  first try  minutes  tokens",
    );
    for (const row of rows) {
      if (!row.result) {
        console.log(`${row.worker.padEnd(40)} ${row.error}`);
        continue;
      }
      const r = row.result;
      const score = runScore(r);
      console.log(
        `${row.worker.padEnd(40)} ${`${score.passed}/${score.measured}`.padStart(15)}  ${String(r.firstTry).padStart(9)}  ${(r.cost.wallClockSeconds / 60).toFixed(1).padStart(7)}  ${String(r.cost.tokens).padStart(6)}`,
      );
    }
    const out = join(config.repoPath, ".sekhemet", "bakeoff_report.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ fixture, manager, rows }, null, 2)}\n`);
    console.log(`\nReport: ${out}`);
    // Full-settings records and MODEL_MATRIX.md (M23, E4).
    const bakeRegistry = modelRegistry();
    const bakeRoster = new ModelRoster({ registry: bakeRegistry });
    // Each record's settings as the run had them: a Worker under a person's
    // override is marked, so its record says so (review medium 2). The suite
    // runner already refused an unqualified one.
    const bakeAdapter = (worker: string) => {
      const adapter = bakeRoster.resolve(worker, "worker");
      gateWorker(bakeRegistry, adapter, worker);
      return adapter;
    };
    const recorded = await recordBakeOff(
      config.repoPath,
      fixture,
      rows
        .filter((r) => r.result)
        .map((r) => {
          const res = r.result as SuiteRunResult;
          return {
            adapter: bakeAdapter(r.worker),
            passed: res.firstTry,
            total: runScore(res).measured,
            minutes: res.cost.wallClockSeconds / 60,
            tokens: res.cost.tokens,
            stepBudget: appliedStepBudget(config.repoPath) ?? DEFAULT_STEP_BUDGET,
          };
        }),
      harnessRoot,
    );
    console.log(`Matrix: ${recorded.matrix} (${recorded.recorded} record(s))`);
    for (const m of recorded.inadmissible) console.log(`   inadmissible: ${m}`);
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
      const target = integrationBranch(config.repoPath);
      const notice = sha.startsWith("http")
        ? undefined
        : checkoutNotice(config.repoPath, target, sha);
      console.log(
        sha.startsWith("http")
          ? `\nAccepted ${cardId} — pull request ${sha} opened; the card reaches Done when it merges.`
          : `\nAccepted ${cardId} — squashed onto ${target} as ${sha.slice(0, 10)}, card moved to Done. Your files were not touched.`,
      );
      if (notice) console.log(notice);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (config.command === "run" || config.command === "resume") {
    // `resume` is `run` on a card that stopped part-way: the runner restarts
    // from its last checkpoint with the steps replayed from the log (H17).
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

    // One recorded RunProfile (measurement MS-M9-4/5): resolved once from the
    // settings file, the experiment switches and the flags, written into the
    // card's evidence, and the switches the card runs with are read from it.
    let runProfile: RunProfile;
    try {
      runProfile = profileForRun(argv, process.env);
      applyProfileSwitches(runProfile);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
      return;
    }

    // One runner at a time (runtime item 3, RUN-3): a second is refused
    // naming the holder, and runs nothing.
    const leased = acquireRunnerLease(config.repoPath, { kind: "run", cardId });
    if ("holder" in leased) {
      console.error(leaseRefusal(leased.holder));
      process.exitCode = 1;
      return;
    }
    const releaseRunLease = leased.release;
    // The supervisor's start-up pass (items 10, 33, 34), as `queue` makes it:
    // under the lease, before the card is read again to run.
    for (const line of describeSupervisorStart(
      await supervisorStart({ repoPath: config.repoPath, cardStore, log, boardService }),
    )) {
      console.log(line);
    }
    const swept = await cardStore.getCard(cardId);
    if (swept) Object.assign(card, swept);
    console.log(`\nExecuting card ${cardId}: "${card.title}"`);
    console.log(`Scope: [${card.scopeFiles.join(", ") || "unrestricted"}]`);
    console.log(`Budget: ${card.stepBudget} steps\n`);
    // SUR-40: the card's layer of the configuration, between the project's
    // and the command line's, shown and applied.
    const overrideLines = configOverrideLines(card.configOverrides);
    if (overrideLines.length) console.log(`Card config overrides: ${overrideLines.join(", ")}`);
    const profileCap = runProfile.policies.stepCap ?? undefined;
    const runCap = cardStepCap(
      card,
      runProfile.sources["policies.stepCap"] === "flag"
        ? { flag: profileCap }
        : { otherwise: profileCap },
    );

    // --worker was parsed by the suite runner and the queue but ignored here:
    // every `run` used the Nail adapter, whatever it was asked for. A managed
    // name (cyber-tiel, served by its own llama-server with its MTP head)
    // resolves through the roster; an Ollama tag keeps the Nail profile's
    // settings; no flag is the default Worker, as before.
    const workerIdx = argv.indexOf("--worker");
    const workerName = workerIdx !== -1 ? argv[workerIdx + 1]?.replace(/^ollama\//, "") : undefined;
    // Through the roster, as `qualify` and the queue build it, so the three
    // agree on the combination (B2.2 confirmation): one registry, read once.
    const registry = modelRegistry();
    const model = new ModelRoster({ registry }).resolve(
      workerName ?? NAIL_WORKER_PROFILE.modelId,
      "worker",
    );
    console.log(`Worker: ${model.modelId}`);
    // MD-N8-1: the Worker runs cards only once its exact combination (engine,
    // model build, host, settings) has qualified on this host. Nothing loads.
    // Rule 27, MD-N4-4: a person's override runs the failed combination, and
    // every bundle and card/repro of this run says so (the adapter is marked).
    const gate = gateWorker(registry, model, workerName ?? model.modelId);
    if (gate.refusal) {
      console.error(gate.refusal);
      process.exitCode = 1;
      releaseRunLease();
      return;
    }
    if (gate.override) console.log(`Worker ${model.modelId}: ${describeOverride(gate.override)}`);
    const ctx = {
      repoPath: config.repoPath,
      restrictedMode: config.restrictedMode,
      cardStore,
      boardService,
      runProfile,
    };
    let result: Awaited<ReturnType<typeof executeCard>>;
    // Ctrl+C stops the card cleanly before its next turn (L25); a second exits.
    const stop = new AbortController();
    const onSigint = () => {
      if (stop.signal.aborted) process.exit(130);
      console.log("\nStopping after the current turn (Ctrl+C again to quit now)...");
      stop.abort("stopped from the terminal");
    };
    process.on("SIGINT", onSigint);
    try {
      result = await executeCard(ctx, card, model, undefined, {
        signal: stop.signal,
        ...(runCap ? { maxSteps: runCap } : {}),
      });
    } finally {
      process.off("SIGINT", onSigint);
      // Release the weights on every exit path, including a crash mid-card:
      // a resident 13GB checkpoint left behind by a failed run is how the host
      // ran out of memory overnight.
      await model.unload?.();
      releaseRunLease();
    }

    console.log(`\n${summarizeEvidence(result.evidence)}\n`);
    console.log(
      result.passed
        ? `Card ${cardId} PASSED verification and moved to Review for human acceptance.`
        : `Card ${cardId} stopped: ${result.stopReason}. Left in ${result.finalStatus} for inspection.`,
    );

    // SUR-16: scripts read the card's outcome from the exit status.
    if (runExitCode(result.finalStatus) !== 0) process.exitCode = 1;
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
    // One recorded RunProfile (measurement MS-M9-1, MS-M9-4): the queue is the
    // path every measured run takes, so it resolves its settings once and
    // records them in every attempt's evidence.
    // --auto-accept stands in for the person only in a repository a measured
    // run prepared (review M5): the human is the rate limiter.
    // SUR-44, SUR-45: one RunProfile from defaults, config, a `--settings`
    // file and flags, or no run: a flag that would set others (`--profile
    // full`) is refused, never rewritten. The queue then reads its settings
    // from the profile, so a settings file applies and is what is recorded.
    let queueProfile: RunProfile;
    try {
      queueProfile = profileForQueue(
        argv,
        process.env,
        queueDefaults(effectiveConfig(config.repoPath, argv).config, []),
        appliedStepBudget(config.repoPath),
      );
    } catch (err) {
      console.error(`sekhemet: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
      return;
    }
    argv.splice(0, argv.length, ...withoutProfileFlags(argv), ...profileArgs(queueProfile).argv);
    applyProfileSwitches(queueProfile);
    const acceptRefusal = autoAcceptRefusal(argv, config.repoPath);
    if (acceptRefusal) {
      console.error(acceptRefusal);
      process.exitCode = 2;
      return;
    }
    // One runner at a time (runtime item 3): the lease first, so the
    // start-up pass below runs with no other runner live. Its roster and
    // residency are published once the router exists.
    const queueLive: { current?: LiveLeaseInfo } = {};
    const queueLease = acquireRunnerLease(config.repoPath, {
      kind: process.env.SEKHEMET_OVERNIGHT_ROUND === "1" ? "overnight" : "queue",
      live: () => queueLive.current?.() ?? {},
    });
    if ("holder" in queueLease) {
      console.error(leaseRefusal(queueLease.holder));
      process.exitCode = 1;
      return;
    }
    const releaseLease = queueLease.release;
    // The supervisor's start (items 10, 33, 34): reap what a killed runner
    // left, sweep crashed attempts back to Ready, and prune by retention as a
    // recorded erasure — before the Ready cards are read.
    const startPass = await supervisorStart({
      repoPath: config.repoPath,
      cardStore,
      log,
      boardService,
    });
    for (const line of describeSupervisorStart(startPass)) console.log(line);
    const measurement = argv.includes("--auto-accept")
      ? readMeasurementMarker(config.repoPath)
      : undefined;
    // review-git §2.5.6 (RG-S5-8): auto-accept is the person's recorded
    // standing decision for this run, named on every acceptance it writes.
    const autoRun = argv.includes("--auto-accept") ? await enableAutoAccept(cardStore) : undefined;
    for (const problem of effectiveConfig(config.repoPath, argv).problems) {
      console.error(`config: ${problem}`);
    }
    const autoAccept = argv.includes("--auto-accept");
    // H15: config.toml supplies the models and step cap the flags leave open.
    const configured = queueDefaults(effectiveConfig(config.repoPath, argv).config, argv);
    if (configured.maxTurns) argv.push("--max-turns", String(configured.maxTurns));
    const managerIdx = argv.indexOf("--manager");
    const managerModel = managerIdx !== -1 ? argv[managerIdx + 1] : configured.manager;
    const researcherIdx = argv.indexOf("--researcher");
    const researcherModel =
      researcherIdx !== -1 ? argv[researcherIdx + 1] : process.env.SEKHEMET_RESEARCHER;
    const reviewerIdx = argv.indexOf("--reviewer");
    const reviewerModel = reviewerIdx !== -1 ? argv[reviewerIdx + 1] : undefined;
    const workerIdx = argv.indexOf("--worker");
    const workerModel = workerIdx !== -1 ? argv[workerIdx + 1] : configured.worker;

    if (project && project.status !== "active") {
      console.log(
        `Project ${project.name} is ${project.status}; resume it on the dashboard (or pause another: at most ${cardStore.activeProjectCap} run at once).`,
      );
      releaseLease();
      return;
    }
    const readyRaw = (await cardStore.listCards({ status: "ready" })) as CardRecord[];
    if (readyRaw.length === 0) {
      console.log("No Ready cards.");
      releaseLease();
      return;
    }
    // Planning before the pass (wave2.ts): decision deadlines, the seven
    // signals, ceremonies, goals, the throughput floor, and WSJF/RICE order.
    let ready: CardRecord[];
    // Rule 27, MD-N4-4: the person's override the Worker runs under, if any.
    let workerOverride: WorkerOverride | undefined;
    try {
      // MD-N8-1: the Worker's combination must have qualified on this host;
      // resolving it builds the adapter without starting a server.
      const workerName = workerModel ?? NAIL_WORKER_PROFILE.modelId;
      const registry = modelRegistry();
      const workerProbe = new ModelRoster({ registry }).resolve(workerName, "worker");
      const gate = gateWorker(registry, workerProbe, workerName);
      workerOverride = gate.override;
      ({ ordered: ready } = await queuePrelude(
        { repoPath: config.repoPath, cardStore, log },
        readyRaw,
        {
          workerRefusal: gate.refusal,
          workerModelId: workerModel ?? NAIL_WORKER_PROFILE.modelId,
          reviewWip: (await boardService.getBoardState()).wipLimits.review,
        },
      ));
    } catch (err) {
      // M15: below the overnight throughput floor the harness refuses to run;
      // MD-N8-1: so it does with a Worker whose combination has not qualified.
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      releaseLease();
      return;
    }
    if (workerOverride) {
      console.log(
        `Worker ${workerModel ?? NAIL_WORKER_PROFILE.modelId}: ${describeOverride(workerOverride)}`,
      );
    }

    // Every role resolves through one roster (M5, C3): a managed name
    // (cyber-tiel, apodex, qwen3.8-27b/dirk) runs under a harness-managed
    // llama-server and roles on the same weights share one adapter; any other
    // name is an Ollama model with its role's profile.
    // The registry pins chat templates and supplies measured tool arms (M11).
    const roster = new ModelRoster({ registry: modelRegistry() });
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
    const workerFactory = roster.factory(workerModel ?? NAIL_WORKER_PROFILE.modelId, "worker");
    const router = new ModelRouter(
      {
        worker: track(() => {
          const worker = workerFactory();
          // Every bundle and card/repro made under a person's override says so.
          return workerOverride ? applyWorkerOverride(worker, workerOverride) : worker;
        }, true),
        // The manager doubles as the PM you chat with during the run; without
        // --manager it is still available for chat, just not for repair plans.
        manager: track(roster.factory(pmModelName, "manager")),
        // The Researcher (--researcher <model>; the user's choice is Apodex-1.1-mini).
        ...(researcherModel
          ? { researcher: track(roster.factory(researcherModel, "researcher")) }
          : {}),
        // A different model family for Seshat's review (--reviewer <model>).
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
      ? async (question: string, opts: { deep?: boolean } = {}) => {
          const { web } = await researchSources(config.repoPath, { log });
          const r = await new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            log,
            model: () => router.use("researcher"),
          }).ask(question, opts);
          await router.use("manager");
          return r;
        }
      : undefined;
    /** Struggles the playbook had no remedy for: the Researcher's queue. */
    const unexplained: { cardId: string; text: string }[] = [];
    const pmStore = new PmStore(log);
    // H20, INT-17 to INT-20a: the one notifier (push and Slack, budgeted, and
    // Seshat's daily standup) while the queue runs.
    const notifier = await startNotifier(log, config.repoPath, {
      standup: () => dailyStandup({ repoPath: config.repoPath, cardStore, pmStore, pmModel }),
    });
    // Tells the dashboard this process holds the Worker, so PM messages are
    // answered here, between steps, instead of loading a second large model.
    // The lease also publishes the model roster and which role is resident,
    // for the dashboard's Machine view.
    queueLive.current = () => ({
      pmModel,
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
    });

    /**
     * Preemption (PM_CONTRACT §4): after any Worker step, if the human has
     * written to the PM, swap the Worker out, answer, swap it back. The card
     * resumes from its worktree, so nothing is lost; only the reload costs time.
     */
    /** Worker questions waiting for Seshat; answers are filed in each card's dossier. */
    const workerQuestions = new QueuedWorkerQuestions();
    const isWorkerQuestion = (m: { context?: { view?: string } }) =>
      m.context?.view === "worker-question";

    /**
     * Collaboration, shaped by the hardware. When Seshat is resident, a
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
      // Only when Seshat's weights are already loaded, and always hand back to
      // the role that was running: switching to "worker" during an escalated
      // retry (which runs on Seshat's weights) would load a second large model.
      const prior = router.activeRole;
      if (router.isResident("manager")) {
        const card = await cardStore.getCard(cardId);
        const res = await (await router.use("manager")).generate({
          systemPrompt:
            "You are Seshat, the project manager. A teammate (the coding Worker) is mid-card and asks a question its card's spec does not answer. Answer in at most three sentences, concretely, consistent with the spec and acceptance tests. If it is genuinely the lead's call, say so and give the most conservative choice.",
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
        `Seshat (project manager, ${now("manager")}) answers ask() questions your card's contract does not${router.isResident("manager") ? "" : "; until then, proceed conservatively and note your assumption"}.`,
        router.has("researcher")
          ? `A Researcher (${now("researcher")}) investigates errors nothing explained, with sources; its findings reach you as rules.`
          : "",
        router.has("reviewer")
          ? "A Reviewer from a different model family checks passing work against the lead's preferences."
          : "Seshat reviews passing work against the lead's preferences.",
        "Everything you learn here is kept: fixed errors and failed approaches carry to the next attempt.",
      ]
        .filter(Boolean)
        .join(" ");
    };

    /**
     * File Seshat's answers to queued Worker questions in each card's dossier,
     * threaded under the question, so the card's next attempt reads them.
     */
    const collectAnswers = async (): Promise<void> => {
      if (workerQuestions.size === 0) return;
      const filed = await workerQuestions.fileAnswers(await pmStore.thread(), cardStore);
      if (filed > 0) console.log(`   filed ${filed} answer(s) from Seshat in the cards' dossiers`);
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
    // E5: a frozen-fixture regression run carries one candidate rule for this run only.
    if (process.env.SEKHEMET_CANDIDATE_RULE) {
      const candidate = await new LearningStore(log)
        .propose({
          role: "worker",
          text: process.env.SEKHEMET_CANDIDATE_RULE,
          scope: {},
          source: "seed",
          evidence: [],
        })
        .catch(() => undefined);
      if (candidate) runRules.add(candidate.id);
    }
    const ctx = {
      repoPath: config.repoPath,
      restrictedMode: config.restrictedMode,
      cardStore,
      boardService,
      // K12: rules proposed during the run pass the project's `playbook/propose`
      // hooks, which may refuse one before it is written.
      learning: new LearningStore(log, hookEngineFor(config.repoPath).engine),
      runRules,
      teamNote: () => teamNote(),
      askTeam: (cardId: string, question: string, meta: { questionEntryId?: string }) =>
        askTeam(cardId, question, meta),
      watchdog,
      runProfile: queueProfile,
      ...(measurement ? { measurement } : {}),
      afterTurn: async (_cardId: string, turn: { turnIndex: number }) => {
        await answerPm(turn.turnIndex).catch((err) =>
          console.log(`   PM: could not answer (${err instanceof Error ? err.message : err})`),
        );
      },
    };
    // X15: review cards for PRs the harness did not open run the reviewer
    // procedure on a checkout (never an edit) and do not reach the Worker.
    ready = await runExternalReviews(config.repoPath, ready, {
      store: cardStore,
      board: boardService,
      learning: ctx.learning,
      reviewer: () => router.use(reviewerModel ? "reviewer" : "manager"),
      ...(() => {
        const poster = reviewPosterFromEnv(config.repoPath, cardStore);
        return poster ? { github: poster } : {};
      })(),
      say: (line) => console.log(line),
    });
    // INT-16a, INT-16: a dependency bot's pull request runs the full gates on
    // its head (never the Worker); auto-merge only by the project's policy.
    ready = await runDependencyVerifications(config.repoPath, ready, {
      store: cardStore,
      board: boardService,
      say: (line) => console.log(line),
    });
    // X3: images on Ready cards are described by the vision model in one
    // batch (a scheduled swap: the resident models are released first).
    await visionPrePass(config.repoPath, cardStore, ready, {
      ...(() => {
        const name = resolveVisionModel(
          effectiveConfig(config.repoPath, argv).config.models.vision,
          modelRegistry(),
        );
        return name ? { modelName: name } : {};
      })(),
      load: async (name) => {
        await router.releaseAll();
        return roster.resolve(name, "reviewer");
      },
      release: async (m) => {
        await (m as UnloadableAdapter).unload?.();
      },
      say: (line) => console.log(`   ${line}`),
    }).catch((err) => console.log(`   vision: ${err instanceof Error ? err.message : err}`));
    const started = Date.now();
    // Ctrl+C stops the running card before its next turn and ends the queue
    // (L25); the card resumes from its checkpoint next time (H17).
    const queueStop = new AbortController();
    const onSigint = () => {
      if (queueStop.signal.aborted) process.exit(130);
      console.log("\nStopping after the current turn (Ctrl+C again to quit now)...");
      queueStop.abort("stopped from the terminal");
    };
    process.on("SIGINT", onSigint);
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
    // Without --max-turns, the budget `tune --apply` set (E8), if any.
    const maxTurns =
      maxTurnsIdx !== -1 ? Number(argv[maxTurnsIdx + 1]) : appliedStepBudget(config.repoPath);
    const passedResults: { card: CardRecord; diff: string }[] = [];
    const reviewAll = argv.includes("--review");
    /**
     * Seshat reviews passing cards against the user's learned preferences
     * (AutoDev's AI Reviewer). Advice only, recorded on the ledger; it runs
     * while Seshat's model is resident, so it never forces an extra swap
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
        console.log(`   Seshat's review of ${card.id}: ${findings.length} note(s)`);
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
      // SUR-40: a --max-turns flag, else the card's own step budget override, else the run's.
      const cap = cardStepCap(
        rawCard,
        maxTurnsIdx !== -1 ? { flag: maxTurns } : { otherwise: maxTurns },
      );
      const card = cap && rawCard.stepBudget > cap ? { ...rawCard, stepBudget: cap } : rawCard;
      // A retry of a card the worker could not do runs on the stronger model
      // when asked: capability-based routing, not the same model again.
      // The planner's route (P6) sends hard cards to the escalation model up front.
      const role = roleForCard(rawCard, n, escalateRetries);
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
      const result = await executeCard(ctx, rawCard, worker, guidance, {
        attempt: attemptNo,
        signal: queueStop.signal,
        ...(cap ? { maxSteps: cap } : {}),
      });
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
          const sha = await acceptCard(ctx, reviewed, "harness", autoRun ? { autoRun } : {});
          accepted = true;
          console.log(`   accepted -> main ${sha.slice(0, 10)}`);
        }
      }

      entries.push(queueEntryOf(card.id, attemptNo, result, accepted));
      // The report so far, after every entry: a run stopped part-way (the
      // suite runner's timeout) keeps the record of every card it finished.
      recordQueueProgress(config.repoPath, {
        startedAt: new Date(started).toISOString(),
        model: workerModelId,
        ...(managerModel ? { managerModel } : {}),
        entries,
        modelSwaps: router.swapCount,
        totalDurationMs: Date.now() - started,
        modelLoads: meter.loads(),
      });
      console.log(
        `   ${result.passed ? "PASSED" : "FAILED"} (${result.stopReason}) in ${result.evidence.turnsUsed} turns, ${(result.evidence.durationMs / 1000).toFixed(1)}s`,
      );
      // Rung 3 asked for a re-plan: the Replan session diffs the epic's plan (P12).
      if (result.replan) {
        const note = await replanOnRung3(
          { repoPath: config.repoPath, cardStore, log },
          rawCard,
          result.replan.summary,
        ).catch(() => undefined);
        if (note) console.log(`   ${note.split("\n").join("\n   ")}`);
      }
      // The learning guard observes every card once, in the card runner
      // (`learnFromOutcome`); observing here too counted each card twice.
      if (result.stopReason === "memory_pressure") {
        console.log("   queue halted: memory pressure");
        halted = true;
      }
      if (queueStop.signal.aborted) {
        console.log("   queue halted: stopped from the terminal");
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
        // RUN-18, RUN-48: no new card while the memory watchdog asks to stop
        // new worktrees (the queue waits for it to clear, then halts), nor
        // one of a paused project. A running card is never interrupted.
        let refusal = await mayStartCard({ cardStore, watchdog }, card);
        if (refusal && watchdog.isActive("stopNewWorktrees")) {
          console.log(`   waiting: ${refusal}`);
          await watchdog.waitUntilBelow("elevated", 5 * 60_000);
          refusal = await mayStartCard({ cardStore, watchdog }, card);
        }
        if (refusal) {
          console.log(`\n--- ${card.id} not started: ${refusal} ---`);
          if (watchdog.isActive("stopNewWorktrees")) halted = true;
          continue;
        }
        // B6: a card whose files another running card is editing waits.
        const overlap = await boardService.overlappingRunning(card);
        const waiting = [
          ...(await blockedBy(card)),
          ...overlap.map((o) => `${o.cardId} (editing ${o.files.join(", ")})`),
        ];
        if (waiting.length > 0) {
          console.log(`\n--- ${card.id} waits on ${waiting.join(", ")}: deferred ---`);
          if (!deferred.some((d) => d.id === card.id)) deferred.push(card);
          continue;
        }
        const index = deferred.findIndex((d) => d.id === card.id);
        if (index !== -1) deferred.splice(index, 1);
        // X7: a research card goes to the Researcher, not the Worker.
        if (isResearchCard(card)) {
          if (!researcherModel) {
            console.log(
              `\n--- ${card.id} is a research card; start the queue with --researcher to run it ---`,
            );
            continue;
          }
          console.log(`\n=== ${card.id} (research): ${card.title} ===`);
          const { web } = await researchSources(config.repoPath, { log });
          const service = new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            log,
            model: () => router.use("researcher"),
          });
          const r = await runResearchCard(
            card,
            (q, cardId) => service.ask(q, { deep: true, cardId }),
            cardStore,
            config.repoPath,
            boardService,
          ).catch((err) => {
            console.log(`   research failed: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          });
          if (r)
            console.log(
              `   ${r.passed ? "cited note ready for review" : "parked: not settled"}: ${r.notePath}`,
            );
          continue;
        }
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
          const { web } = await researchSources(config.repoPath, { log });
          const service = new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            log,
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
              // The struggle is the executed signal; the Researcher's answer
              // is a synthesis (MS-T8-9). The candidate waits for a person:
              // probation is off (O15, MS-T8-15).
              evidence: [
                { cardId: u.cardId, note: u.text, source: "gate", verified: "execution" },
                {
                  cardId: u.cardId,
                  note: `Researcher, sources: ${r.sources.join("; ")}`,
                  source: "researcher",
                  verified: "none",
                },
              ],
            });
            if (rule) console.log(`   Researcher proposed a candidate rule for ${u.cardId}`);
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
        if (learned > 0) console.log(`\n--- Seshat proposed ${learned} rule(s) from this run ---`);
        const c = await consolidateWithManager(manager, ctx.learning).catch(() => undefined);
        if (c && c.merged + c.contradictions + c.duplicates > 0) {
          console.log(
            `--- Seshat consolidated rules: ${c.merged} merged, ${c.contradictions} contradiction(s) flagged, ${c.duplicates} duplicate(s) retired ---`,
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
      // questions too when Seshat is already resident (no extra swap).
      await answerPm(undefined, router.isResident("manager")).catch(() => undefined);
      const held = await boardService.listHeld();
      for (const h of held)
        console.log(
          `\n--- ${h.id} is held: ${h.hold?.kind === "backpressure" ? `${h.hold.awaiting} refused: ${h.hold.reason}` : ""} ---`,
        );
    } finally {
      process.off("SIGINT", onSigint);
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
      // MS-T7-1: each model's load time, apart from the cards' time.
      modelLoads: meter.loads(),
      cache: cache.summary(),
      memory: { level: watchdog.state.level, reason: watchdog.state.reason },
      // RUN-57: every blob retention pruned at this run's start, with its card.
      ...(startPass.retention ? { retention: startPass.retention } : {}),
    };
    // RUN-56: the report is a ledger event; the files are its cache.
    const path = await recordQueueReport(log, config.repoPath, report);

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
    await sendPush(
      config.repoPath,
      {
        event: "run_report",
        title: eventually < cardIds.length ? "Run finished with failures" : "Run finished",
        message: `${firstTry}/${cardIds.length} first try, ${eventually}/${cardIds.length} after retry, ${(report.totalDurationMs / 60000).toFixed(1)} min.`,
        priority: eventually < cardIds.length ? 4 : 3,
      },
      { log },
    ).catch(() => undefined);
    // Push whatever the run's last events deserve, then stop tailing.
    await notifier.tick().catch(() => 0);
    notifier.stop();
    if (eventually < cardIds.length) process.exitCode = 1;
    return;
  }

  printFrontDoorHelp();
}

/** The eight commands a user meets (design: "The command surface"). */
function printFrontDoorHelp(): void {
  const width = Math.max(...FRONT_DOOR.map((c) => c.usage.length)) + 2;
  console.log("Sekhemet — a local coding harness that builds projects one gated card at a time.\n");
  for (const c of FRONT_DOOR) console.log(`  ${c.usage.padEnd(width)}${c.what}`);
  console.log("\nEverything else: sekhemet dev --help");
}

/** Every other command, for whoever develops the harness itself. */
function printDevHelp(): void {
  const lines: [string, string][] = [
    ["plan <spec>", "Decompose a spec into cards without running them"],
    ["queue [--worker m] [--manager m]", "Run Ready cards"],
    ["resume <card>", "Continue a card that stopped part-way"],
    ["gate [card]", "Run the verification gates"],
    ["gates init", "Write the gate template for this project's language"],
    ["replay <card>", "Replay a card's trajectory from the log"],
    ["abort <card>", "Stop a running card before its next turn"],
    ["rewind <card> <n> / fork <card> <n>", "Back to, or branch from, step n"],
    ["log", "The event log and its hash chain"],
    ["backup <path> / restore <path>", "Back the ledger up; restore it, re-applying erasures"],
    ["export --ledger [--no-private]", "The ledger as NDJSON a verifier checks alone"],
    ["erase --secret --rotated", "Erase a secret found after the fact (stdin or --secret-file)"],
    ['research "<q>" [--deep]', "Ask the Researcher directly"],
    ["overnight [--until 07:00]", "Queue rounds while the machine is free"],
    ["bake-off --workers a,b", "Compare workers on a release gate"],
    ["serve / ui", "The web dashboard server"],
    ["mcp / acp", "Stdio servers for editors"],
    ["calibrate / tune / explore / daemon / traces / init", "Machine and runtime tooling"],
    [`${WAVE2_COMMANDS.join(" / ")}`, "Planner, evaluation and sync tooling"],
  ];
  console.log("sekhemet dev <command> — harness development. These also run without `dev`.\n");
  for (const [u, w] of lines) console.log(`  ${u}\n      ${w}`);
  console.log(`\n${CRAWL4AI_CREDIT}`);
}

/**
 * `sekhemet` with nothing after it is the product: derive the gates on first
 * run, say in one paragraph what it will use, then open the board.
 */
async function openHome(flags: string[]): Promise<void> {
  const { repoPath } = parseCliArgs(flags);
  const gatesFile = join(repoPath, ".sekhemet", "gates.toml");
  const firstRun = !existsSync(gatesFile);
  if (firstRun) await main(["gates", "init", ...flags]);
  let gates = "none yet";
  try {
    gates =
      loadGatesConfig(repoPath)
        .gates.map((g) => g.id)
        .join(", ") || gates;
  } catch {
    // An unreadable gates.toml is reported by doctor, not here.
  }
  console.log(
    `${firstRun ? "Set up. " : ""}Gates: ${gates}.\nReady. Ask for work with: sekhemet "add rate limiting to the API"`,
  );
  return main(["board", ...flags]);
}

type TriageRoute = Extract<
  ReturnType<typeof routeFrontDoor>,
  { kind: "review" | "send-back" | "park" | "unpark" | "reopen" | "reject" | "revert" }
>;

/** The board's decisions, from the command line (triage.ts is shared with it). */
async function runTriage(route: TriageRoute, repoPath: string): Promise<void> {
  const { db, log, cardStore, boardService } = initLocalKernel(repoPath);
  const ctx = { repoPath, cardStore, boardService, log };
  try {
    if (route.kind === "review") {
      const card = route.cardId
        ? ((await cardStore.getCard(route.cardId)) ?? undefined)
        : await nextForReview(ctx);
      if (!card) {
        console.log(
          route.cardId ? `sekhemet: no card ${route.cardId}` : "Nothing is waiting on you.",
        );
        return;
      }
      console.log(`${card.id} — ${card.title}`);
      // The evidence the ledger names (K-S7-7), and each Implementation file's
      // diff, shown once and recorded as shown (review-git §2.4.3, RG-S6-6).
      const e = await ledgerBundle(ctx, card.id);
      if (e) {
        const gates = (e.rungResults ?? []).map((r) => `${r.passed ? "✓" : "✗"} ${r.gate}`);
        console.log(`  gates: ${gates.join("  ") || "none recorded"}`);
        console.log(
          `  changed: ${(e.filesTouched ?? []).join(", ") || "nothing"} (+${e.linesAdded ?? 0} −${e.linesRemoved ?? 0})`,
        );
        const files = implementationFiles(e);
        if (files.length > 0 && card.status === "review") {
          const diff = await new NodeGitSyncAdapter(repoPath).structuralDiff(
            card.id,
            integrationBranch(repoPath),
          );
          console.log(`\n${diff.text}`);
          await recordReviewOpened(ctx, card, files);
        }
      }
      console.log(
        `\n  sekhemet accept ${card.id}\n  sekhemet send-back ${card.id} "<what to change>"\n  sekhemet park ${card.id}`,
      );
      return;
    }
    const card = await cardStore.getCard(route.cardId);
    if (!card) {
      console.error(`sekhemet: no card ${route.cardId}`);
      process.exitCode = 1;
      return;
    }
    if (route.kind === "send-back") {
      if (!route.reason.trim()) {
        console.error(
          `sekhemet: a send-back needs a reason — it is what the Worker is told next.\n  sekhemet send-back ${card.id} "<what to change>"`,
        );
        process.exitCode = 2;
        return;
      }
      await sendBack(ctx, card, route.reason);
      console.log(`${card.id} is back in Ready. Its next attempt is told: ${route.reason}`);
    } else if (route.kind === "park") {
      await park(ctx, card, route.reason);
      console.log(`${card.id} is parked. Undo: sekhemet unpark ${card.id}`);
    } else if (route.kind === "reopen") {
      await reopen(ctx, card, route.reason);
      console.log(`${card.id} is back in Ready.`);
    } else if (route.kind === "reject") {
      if (!route.reason.trim()) {
        console.error(
          `sekhemet: a rejection needs a reason.\n  sekhemet reject ${card.id} "<why>"`,
        );
        process.exitCode = 2;
        return;
      }
      await reject(ctx, card, route.reason);
      console.log(`${card.id} is rejected. Undo: sekhemet reopen ${card.id}`);
    } else if (route.kind === "revert") {
      const sha = await revertAccept(ctx, card, route.reason);
      console.log(
        `${card.id}'s accept is reverted (${sha.slice(0, 10)} on ${integrationBranch(repoPath)}); the card is back in Ready.`,
      );
    } else {
      const to = await unpark(ctx, card);
      console.log(
        `${card.id} is back in ${to === "ready" ? "Ready" : to === "backlog" ? "Backlog" : "Planning"}.`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * `sekhemet card message|pause|hand-back|take-over <card> …` (worker-loop
 * NEW-worker-loop-10): the dashboard's four actions over the same functions.
 * Exit 0 done, 1 refused (no such card, not paused, its agent running), 2 a
 * usage error (a message with no text) — surface S10.
 */
async function runCardVerb(
  route: Extract<FrontDoorRoute, { kind: "card" }>,
  repoPath: string,
): Promise<void> {
  const { db, cardStore, boardService } = initLocalKernel(repoPath);
  const ctx = { repoPath, restrictedMode: false, cardStore, boardService };
  try {
    const card = await cardStore.getCard(route.cardId);
    if (!card) {
      console.error(`sekhemet: no card ${route.cardId}`);
      process.exitCode = 1;
      return;
    }
    if (route.verb === "message") {
      if (!route.text.trim()) {
        console.error(
          `sekhemet: a message needs text.\n  sekhemet card message ${card.id} "<what to tell the agent>"`,
        );
        process.exitCode = 2;
        return;
      }
      await postCardMessage(cardStore, card.id, route.text);
      console.log(`Posted to ${card.id}: its agent reads it at its next step.`);
    } else if (route.verb === "pause") {
      await requestPause(cardStore, card.id);
      console.log(
        `${card.id} pauses at its agent's next step. Then: sekhemet card hand-back ${card.id} "<note>", or sekhemet card take-over ${card.id}`,
      );
    } else if (route.verb === "hand-back") {
      await handBack(ctx, card.id, route.text);
      console.log(`${card.id} is back in Ready; its next run resumes from its checkpoint.`);
    } else {
      const { worktreePath } = await takeOver(ctx, card.id);
      console.log(`${card.id} is yours, In Progress. Work in: ${worktreePath}`);
    }
  } catch (err) {
    // A refusal the collaborate functions give (not paused, agent running, closed).
    console.error(`sekhemet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

/** A yes/no question on the terminal; anything but y or yes is no. */
async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

/** The harness's own version, from its package.json (SUR-13). */
export function harnessVersion(): string {
  try {
    return (
      (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version?: string;
        }
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("sekhemet")) {
  // SUR-26: an older install's ~/.config/sekhemet moves into the one user
  // directory, once; `doctor` reports it. `--version` writes nothing (SUR-13).
  if (routeFrontDoor(process.argv.slice(2)).kind !== "version") {
    try {
      migrateLegacyUserDir();
    } catch (err) {
      console.error(
        `sekhemet: could not move ~/.config/sekhemet: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // SUR-14: an uncaught error is printed and exits 1 — once the event loop
  // drains, or shortly after if a server or timer would hold it open.
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  });
}
