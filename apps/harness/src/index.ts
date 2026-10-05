#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import { type RunProfile, type SuiteRunResult, profileArgs, runScore } from "@sekhemet/eval";
import {
  DeterministicGateRunner,
  type PipelineResult,
  createSourceIndex,
  declaredStage,
  detectGateTemplate,
  gateStartProblems,
  gateTemplate,
  generateGateHostCerts,
  loadGatesConfig,
  npmRegistry,
  renderGatesToml,
  runGatePipeline,
  startGateHost,
  summarizeEvidence,
  verificationRungs,
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
  ModelRegistry,
  NAIL_WORKER_PROFILE,
  PrefixCacheMonitor,
  ThroughputMeter,
  type UnloadableAdapter,
  type WorkerOverride,
  defaultRegistryPath,
  describeOverride,
  escalationWindow,
  measureThroughput,
  readSwapUsedBytes,
  resolveWorkerModelId,
} from "@sekhemet/models";
import { DESIGN_COPY, SpidrFeaturePlanner, resolvePlannerModel } from "@sekhemet/planner";
import {
  ProcessSandbox,
  confinedSandbox,
  mergeNetworkConfigs,
  policyFetch,
} from "@sekhemet/sandbox";
import {
  NodeGitSyncAdapter,
  hardenGitForProcess,
  rememberRepoAsGiven,
  resolvedPath,
} from "@sekhemet/sync";
import { plural } from "@sekhemet/ui";
import {
  AcceptRefusedError,
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
import { bakeOffTaskPlan } from "./bakeoff_tasks.js";
import { watchBoardHooks } from "./board_hooks.js";
import { parseModelList, promptNeedFromLedgers, runCalibrate, runMtpAb } from "./calibrate_cmd.js";
import {
  baselineInput,
  gateBaseBranch,
  lastToolApplied,
  verifyCardWorktree,
} from "./card_gates.js";
import { projectRootOf } from "./card_root.js";
import {
  COMMANDS,
  type FrontDoorRoute,
  PRIMARY_COMMANDS,
  firstWord,
  routeFrontDoor,
  runExitCode,
  wantsJson,
} from "./cli_commands.js";
import { handBack, postCardMessage, requestPause, takeOver } from "./collaborate.js";
import { acceptRuleFor } from "./commands/accept.js";
import {
  type CliCommandName,
  type CliExit,
  type CliResult,
  baseResult,
  enterJsonMode,
  jsonFatal,
  printJsonResult,
} from "./commands/cli_result.js";
import { setProjectRunning } from "./commands/project_pause.js";
import {
  COMMAND_REGISTRY,
  type CommandEnv,
  type CommandSpec,
  commandHelpLines,
  findCommand,
  parseCommandArgs,
} from "./commands/registry.js";
import { gateStartStop } from "./commands/run.js";
import { resolveConfig, userConfigPath } from "./config.js";
import {
  cardStepCap,
  configOverrideLines,
  defaultWorkerName,
  effectiveConfig,
  networkConfigs,
  queueDefaults,
  reviewLimit,
} from "./config_apply.js";
import { configRenamesDue, upgradeConfigKeys } from "./config_upgrade.js";
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
  nextAttemptNumber,
  plannerDifficulty,
  queueEntryOf,
  recordDependencies,
  recordQueueProgress,
  recordQueueReport,
  recordQueueStarted,
  requestAbort,
  rewindCard,
  runLspPool,
} from "./execute.js";
import { externalReviewerFor, reviewPosterFromEnv, runExternalReviews } from "./external_review.js";
import { homeDestination, roleWeightsFinder, runFirstRun } from "./first_run.js";
import { runDependencyVerifications } from "./github_sync.js";
import { deriveGates, runInit } from "./init.js";
import { notifySlack } from "./integrations.js";
import { readSettings } from "./integrations.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { consolidateWithManager, reflectWithManager } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import {
  LEDGER_COMMANDS,
  checkLedgerAnchor,
  ledgerCommand,
  ledgerHeadTrailers,
  openLocalLedger,
} from "./ledger_cmds.js";
import { cardBranchHead, ledgerEvidenceSummary } from "./ledger_evidence.js";
import { runMcpStdioServer } from "./mcp.js";
import { McpHub, loadMcpConfig, plannerToolsOf } from "./mcp_client.js";
import {
  applyProfileSwitches,
  autoAcceptRefusal,
  measurementHolder,
  profileForQueue,
  profileForRun,
  readMeasurementMarker,
  withoutProfileFlags,
} from "./measure_cmd.js";
import {
  ModelAccess,
  type QueueSpec,
  describeModel,
  resolveWorkerName,
  roleModelName,
  weightsKey,
  workerZone3Fit,
} from "./model_access.js";
import { sendPush, startNotifier } from "./notify.js";
import { nightModelServer, runOvernight } from "./overnight.js";
import { setupFor } from "./planner_live.js";
import { audienceFromAccess } from "./pm/audience.js";
import { DEFAULT_PM_MODEL, answerQueued, dailyStandup, pmModelFor } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { seshatWait } from "./pm/while_worker.js";
import {
  installProcessErrorHandlers,
  reportFatal,
  safeContext,
  takeDebugFlag,
} from "./process_errors.js";
import { runPromptScreen } from "./prompt_screen_cmd.js";
import { applyWorkerOverride, gateWorker, verifiedQueueRoles } from "./qualify.js";
import { diffTrajectories, formatDiff, formatTrajectory, trajectories } from "./replay.js";
import { isResearchCard, runResearchCard } from "./research/cards.js";
import { CRAWL4AI_CREDIT, runResearchCommand } from "./research/cli.js";
import { deepPriorArtFor, planResearch, planResearcher } from "./research/plan_research.js";
import { type FailingCard, type RepairResearch, researchBeforeRepair } from "./research/repair.js";
import { ResearchService, researchSources } from "./research/service.js";
import { oneShotResearcher } from "./research/service.js";
import { runResearchBakeoffCommand } from "./research_bakeoff.js";
import {
  mayStartCard,
  parseUntil,
  releaseMachine,
  reservationNow,
  reserveMachine,
  unattendedStartRefusal,
} from "./reservation.js";
import {
  REVIEW_WAIT,
  ReviewFlow,
  acceptAfterReview,
  familyOf,
  learnedFrom,
  recordNotReviewed,
  releaseUnreviewed,
  resolveReviewerRole,
  reviewAndRelease,
} from "./review_flow.js";
import { candidateRuleFromEnv, researchRuleScope } from "./rule_scopes.js";
import {
  LEASE_TOKEN_ENV,
  type LiveLeaseInfo,
  acquireRunnerLease,
  leaseRefusal,
} from "./runner_lease.js";
import { isReserved, parseHours } from "./scheduler.js";
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js";
import { qualifiedSlotCapacity } from "./slot_lease.js";
import { SlotPool } from "./slot_pool.js";
import {
  QueuedCardWork,
  beginCalibrationNight,
  calibrationHostReading,
  cardOverlapTasks,
  headroomProbeFor,
  presenceTracker,
  queueSwapMode,
  quickAnswererFor,
  refreshPlan,
} from "./smart_swap.js";
import { bakeOffOnSuitePath } from "./suite_path.js";
import { describeSupervisorStart, removeWorktreesOnClose, supervisorStart } from "./supervisor.js";
import { Access } from "./team/access.js";
import { agentRefusalFor, runnableByTheirPeople } from "./team/ai_teammates.js";
import { configWriter, recordConfigWrite } from "./team/config_audit.js";
import { identityDir } from "./team/credential_store.js";
import { fairOrder } from "./team/fair_queue.js";
import { newSetupTokenCommand, recordSwitchToSolo } from "./team/serve.js";
import { terminalBoardLines } from "./terminal_board.js";
import { tracesCommand } from "./tracing.js";
import { nextForReview, park, reject, reopen, revertAccept, sendBack, unpark } from "./triage.js";
import {
  describeTuning,
  globalTuningPath,
  loadAttempts,
  tuneForRepo,
  writeTuningReport,
} from "./tune.js";
import { migrateLegacyUserDir, userDir, userPaths } from "./user_dir.js";
import { hookEngineFor } from "./user_hooks.js";
import { approveBaseline, describeCandidate, visualCandidates } from "./visual_baseline.js";
import { PressureControls, createCardWatchdog, workerFloorRefusal } from "./watchdog_actions.js";
import {
  DEV_COMMANDS,
  type DevCommand,
  appliedStepBudget,
  applyTunedPolicy,
  childSettings,
  isGreenfield,
  modelRegistry,
  planCommand,
  queuePrelude,
  recordBakeOff,
  replanOnRung3,
  roleForCard,
  runDevCommand,
} from "./wave2.js";
import {
  holdsLedger,
  ledgerPathOf,
  realPath,
  resolveWorkspace,
  workspaceFolderOf,
} from "./workspace_locator.js";
import {
  agentConfigFiles,
  approveAgentConfig,
  describeUntrusted,
  isWorkspaceTrusted,
  recordAgentConfigApprovals,
  setInvocationTrust,
  trustAuthorityFor,
  trustFiles,
  trustWorkspace,
  untrustedFiles,
} from "./workspace_trust.js";
import { readWorkspaces, runningServerFor } from "./workspaces.js";

export interface CliConfig {
  command:
    | "status"
    | "backup"
    | "restore"
    | "reserve"
    | "pause"
    | "trust"
    | "ask"
    | "benchmark"
    | "take-over"
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
    | "research-bakeoff"
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
    | "models"
    | "project"
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

  // One list for the parser and the front door (cli_commands.ts).
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
    // Live-test F18: one spelling (absolute, real) for every path recorded or compared.
    rememberRepoAsGiven(nextRepo);
    repoPath = resolvedPath(nextRepo);
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

/**
 * Why the queue would refuse its Coding model here, or undefined (MD-N8-1):
 * the model the queue resolves — `--worker`, else the person's assignment,
 * else `config.toml`, else the default — not verified on this machine for
 * its exact combination. Nothing loads.
 */
function queueWorkerRefusal(repoPath: string, argv: string[]): string | undefined {
  const registry = modelRegistry();
  const flagged = argv.includes("--worker") ? argv[argv.indexOf("--worker") + 1] : undefined;
  const name =
    roleModelName("worker", flagged, { registry }) ??
    queueDefaults(effectiveConfig(repoPath, argv).config, []).worker ??
    defaultWorkerName();
  return gateWorker(registry, describeModel(name, "worker", { registry }), name).refusal;
}

/** The repository's measurement marker, as the board's option (rule 24). */
function measurementOption(repoPath: string): { measurementMarker?: { purpose: string } } {
  const marker = readMeasurementMarker(repoPath);
  return marker ? { measurementMarker: marker } : {};
}

/** A project named by id or by name (`dev pause|resume <project>`). */
/**
 * Surface item 8a, NEW-surface-11: the folder a command acts on. In a
 * workspace it is the project whose root holds the folder (or the workspace
 * folder when no project's does); `serve` and `daemon` serve the whole
 * workspace from its folder (SUR-76). A first run keeps the folder.
 */
export function cliWorkspace(
  repoPath: string,
  command?: string,
):
  | { repoPath: string; workspaceFolder: string; projectId?: string; firstRun?: true }
  | { refused: string } {
  const found = resolveWorkspace(repoPath);
  if (found.kind === "refused") return { refused: found.message };
  // No ledger here or above: a first run (FINDINGS_C1 CLI-05 reads it).
  if (found.kind === "first-run") return { repoPath, workspaceFolder: repoPath, firstRun: true };
  const target =
    command === "serve" || command === "daemon" || command === "ui" || command === "board"
      ? found.workspaceFolder
      : (found.project?.rootPath ?? found.workspaceFolder);
  return {
    // One spelling of the folder as given (F18) when it is already the target.
    repoPath: realPath(repoPath) === realPath(target) ? repoPath : target,
    workspaceFolder: found.workspaceFolder,
    ...(found.project ? { projectId: found.project.id } : {}),
  };
}

/**
 * SUR-79: why a first run here would start a second workspace for a
 * repository that belongs to one: its history carries `Ledger-Head`
 * trailers. Names the workspace on this machine whose ledger holds the
 * newest trailer's hash — the machine's list only as a hint (RUN-86) — or
 * says it is not on this machine, with the fixes. Undefined when none.
 */
function belongsElsewhere(repoPath: string): string | undefined {
  const trailers = ledgerHeadTrailers(repoPath);
  if (trailers.length === 0) return undefined;
  const home = readWorkspaces(userPaths().workspaces)
    .map((w) => w.folder)
    .filter((f): f is string => typeof f === "string" && holdsLedger(f))
    .find((folder) => {
      try {
        const db = new DatabaseSync(ledgerPathOf(folder), { readOnly: true });
        try {
          return trailers.some(
            (t) =>
              (
                db.prepare("SELECT hash FROM events WHERE seq = ?").get(t.seq) as
                  | { hash: string }
                  | undefined
              )?.hash === t.hash,
          );
        } finally {
          db.close();
        }
      } catch {
        return false;
      }
    });
  const where = home
    ? `its workspace is in ${home}: open it there (\`sekhemet\` in that folder), or add this clone to it from New project`
    : "its workspace is not on this machine: restore its backup (`sekhemet dev restore`)";
  return `This repository belongs to a Sekhemet workspace already (its history carries Ledger-Head trailers), so nothing was written: ${where}. To start a new workspace here anyway, run \`sekhemet --new-workspace\`.`;
}

/** SUR-80: a refused locator acts on no workspace, exit 1, the fix named. */
function refuseWorkspace(message: string): void {
  console.error(`sekhemet: ${message}`);
  process.exitCode = 1;
}

/**
 * FINDINGS_C1 CLI-05: a command that reads or changes a project's board, in
 * a folder that holds no ledger and belongs to no workspace, says so in one
 * line and exits 2, before anything is opened or written.
 */
function noProjectLine(folder: string): string {
  return `${folder} is not a Sekhemet project yet, so nothing was read or written. Run \`sekhemet\` there to set it up, or pass --repo <project folder>.`;
}
function refuseNoProject(folder: string): void {
  console.error(`sekhemet: ${noProjectLine(folder)}`);
  process.exitCode = 2;
}

/**
 * Run a command the registry holds (surface item 17, T4): its flags parsed
 * from its own schema (a usage error exits 2), the workspace found as for
 * every command (item 8a), a project required where the entry says so
 * (CLI-05), then its handler. Under `--json` (item 20c, NEW-surface-10)
 * stdout holds only the one result object; everything else goes to stderr.
 */
async function runRegistered(spec: CommandSpec, argv: string[]): Promise<void> {
  // SUR-70: `--json=<value>` asks for the object too (and is a usage error, as an object).
  const json = spec.json && wantsJson(argv);
  if (json) enterJsonMode();
  const finish = (outcome: CliResult | CliExit): void => {
    if (typeof outcome === "number") {
      // SUR-70: under --json every outcome is the one object, a bare exit code too.
      if (json)
        printJsonResult(
          baseResult(
            spec.name as CliCommandName,
            outcome,
            outcome === 0 ? "Done." : `Exited ${outcome}; what happened is on stderr.`,
          ),
        );
      process.exitCode = outcome;
      return;
    }
    if (json) printJsonResult(outcome);
    process.exitCode = outcome.exitCode;
  };
  const refused = (exitCode: CliExit, message: string): void => {
    console.error(`sekhemet: ${message}`);
    finish(json ? baseResult(spec.name as CliCommandName, exitCode, message) : exitCode);
  };
  const parsed = parseCommandArgs(spec, argv);
  if ("error" in parsed) return refused(2, parsed.error);
  const config = parseCliArgs(argv);
  const at = cliWorkspace(config.repoPath, spec.name);
  if ("refused" in at) return refused(1, at.refused);
  if (spec.needsProject && at.firstRun) return refused(2, noProjectLine(at.repoPath));
  // S9, item 40: `--trust` trusts the repository's configuration for this invocation only.
  setInvocationTrust(parsed.values.trust === true);
  let opened: ReturnType<typeof initLocalKernel> | undefined;
  let recorded = false;
  const env: CommandEnv = {
    command: spec.name,
    argv,
    repoPath: at.repoPath,
    workspaceFolder: at.workspaceFolder,
    ...(at.projectId ? { projectId: at.projectId } : {}),
    restrictedMode: config.restrictedMode,
    json,
    kernel: async (mode) => {
      opened ??= initLocalKernel(at.repoPath);
      if (mode === "write" && !recorded) {
        recorded = true;
        // The repository is a project (K14); cards created without one join it.
        const project = await ensureRepoProject(opened.cardStore, at.repoPath).catch(
          () => undefined,
        );
        // ReviewWIP from this person's measured review minutes (B3).
        if (project) {
          await opened.boardService
            .calibrateReviewWip(project.reviewMinutesPerDay)
            .catch(() => undefined);
        }
      }
      return opened;
    },
  };
  finish(await (await spec.load())(parsed, env));
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

  // SUR-43 (surface item 32): renamed config keys are rewritten after a
  // backup in the same step as the ledger migration; doctor reports them.
  upgradeConfigKeys(join(dotSekhemet, "config.toml"));

  // The design and the permission engine's protected-path list both name
  // .sekhemet/events.db; opening a differently-named file meant the deny rule
  // guarded a database nothing used.
  // The install's person, the erasure register and the schema check (RUN-44).
  const { db, log } = openLocalLedger(repoPath);
  // TEAM-44: the user config's upgrade is Sekhemet's own write, recorded as
  // `config/changed` (no person asked), so the next start does not report
  // it as a change made outside Sekhemet. Keys only, never a value.
  const userConfig = userConfigPath();
  if (configRenamesDue(userConfig).length > 0) {
    recordConfigWrite({ db, log, path: userConfig, identityDir: identityDir() }, () =>
      upgradeConfigKeys(userConfig),
    );
  }
  const cardStore = new CardStore(db, log);
  // K-N12-3: a card recorded with no project reads as the workspace folder's.
  cardStore.workspaceFolder = workspaceFolderOf(repoPath);
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
    // PM-N7-4: an approval holds only for the staged file as it is on disk now;
    // a path outside the repository reads as missing, so its approval is void.
    readStagedFile: (path) => {
      const abs = resolve(repoPath, path);
      if (isAbsolute(path) || !abs.startsWith(resolve(repoPath) + sep)) return undefined;
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    },
    // PM-12..14: INVEST's Small at the resolved Worker's W, the planner's computation.
    zone3Fit: workerZone3Fit(repoPath, {
      registry: modelRegistry(),
      configured: queueDefaults(effectiveConfig(repoPath).config, []).worker,
    }),
    // Rule 24: the harness accepts a leaf card only where a measured run
    // prepared the repository (--auto-accept's bound); elsewhere a person does.
    ...measurementOption(repoPath),
  });

  // NEW-extensibility-1: the team's board-lifecycle hooks (a card moved, was
  // accepted, had a pull request opened) run after each such ledger event.
  watchBoardHooks(log, cardStore, repoPath);

  // RUN-16: a closed card's worktree goes, its branch stays — on every path
  // that closes a card through this kernel.
  removeWorktreesOnClose(repoPath, log, cardStore);
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
    "                      Sekhemet Activity log: hash chain and write-ahead log              ",
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
    const message = `unknown flag ${route.flag}. \`sekhemet --help\` lists the commands.`;
    console.error(`sekhemet: ${message}`);
    // SUR-70: a command that takes --json, asked for it, gets its object for a usage error too.
    const named = findCommand(firstWord(rawArgv));
    if (named?.json && wantsJson(rawArgv)) {
      enterJsonMode();
      printJsonResult(baseResult(named.name as CliCommandName, 2, message));
    }
    process.exitCode = 2;
    return;
  }
  hardenGitForProcess();
  if (route.kind === "help") return printHelp();
  if (route.kind === "dev-help") return printDevHelp();
  if (route.kind === "command-help") {
    const spec = findCommand(route.name);
    if (spec) for (const line of commandHelpLines(spec)) console.log(line);
    return;
  }
  if (route.kind === "unknown") {
    console.error(
      route.suggest
        ? `sekhemet: no command "${route.word}". Did you mean \`sekhemet ${route.suggest}\`?`
        : `sekhemet: ${route.word.includes(" ") ? route.word : `no command "${route.word}"`}. \`sekhemet --help\` lists them; to ask for work, describe it in a sentence.`,
    );
    process.exitCode = 2;
    return;
  }
  // Surface item 20c: `--json` is one issue's outcome (`run <issue>`); the
  // queue (`run` with no issue, or a spec planned then run) has no object
  // yet, so it is refused before anything runs rather than printing prose
  // where a script expects JSON.
  if (
    (route.kind === "spec" ||
      (route.kind === "argv" && parseCliArgs(route.argv).command === "queue")) &&
    rawArgv.includes("--json")
  ) {
    enterJsonMode();
    const message =
      "--json needs an issue: `sekhemet run <issue> --json`; the queue (`sekhemet run` with no issue) prints no JSON";
    console.error(`sekhemet: ${message}`);
    printJsonResult(baseResult("run", 2, message));
    process.exitCode = 2;
    return;
  }
  if (route.kind === "spec") {
    // FINDINGS_C1 CLI-07: the Coding model the queue would run is checked
    // first, as the queue checks it (MD-N8-1), so a spec whose issues cannot
    // run writes none.
    const at = cliWorkspace(parseCliArgs(route.flags).repoPath);
    const refusal = "refused" in at ? undefined : queueWorkerRefusal(at.repoPath, route.flags);
    if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
      return;
    }
    // One verb for "plan this and build it": the plan, then the queue.
    await main(["plan", route.spec, ...route.flags]);
    if (process.exitCode) return;
    return main(["queue", ...route.flags]);
  }
  if (route.kind === "home") return openHome(route.flags);
  if (route.kind === "review") {
    // T4: `review` runs from the command registry (commands/review.ts).
    return runRegistered(findCommand("review") as CommandSpec, [
      "review",
      ...(route.cardId ? [route.cardId] : []),
      ...route.flags,
    ]);
  }
  if (
    route.kind === "send-back" ||
    route.kind === "park" ||
    route.kind === "unpark" ||
    route.kind === "reopen" ||
    route.kind === "reject" ||
    route.kind === "revert"
  ) {
    const at = cliWorkspace(parseCliArgs(route.flags).repoPath);
    if ("refused" in at) return refuseWorkspace(at.refused);
    if (at.firstRun) return refuseNoProject(at.repoPath);
    return runTriage(route, at.repoPath);
  }
  if (route.kind === "card") {
    const at = cliWorkspace(parseCliArgs(route.flags).repoPath);
    if ("refused" in at) return refuseWorkspace(at.refused);
    if (at.firstRun) return refuseNoProject(at.repoPath);
    return runCardVerb(route, at.repoPath);
  }
  const argv = route.argv;
  const config = parseCliArgs(argv);
  // T4 (surface item 17, NAM-02): a command the registry holds runs from it.
  const registered = findCommand(config.command);
  if (registered) return runRegistered(registered, argv);
  // Surface item 8a (SUR-73, SUR-80): the workspace and project this folder
  // belongs to, found from its ledger or its project's locator; a locator its
  // ledger does not confirm is refused before anything opens.
  const workspace = cliWorkspace(config.repoPath, config.command);
  if ("refused" in workspace) return refuseWorkspace(workspace.refused);
  config.repoPath = workspace.repoPath;
  // S9, item 40: `--trust` trusts the repository's configuration for this
  // invocation only; nothing is ever trusted implicitly.
  setInvocationTrust(argv.includes("--trust"));
  // FINDINGS_C1 CLI-06: the checks of a folder that is no project, and
  // declares none, are not run (they would be a package manager's errors).
  if (
    config.command === "gate" &&
    workspace.firstRun &&
    !existsSync(join(config.repoPath, ".sekhemet", "gates.toml"))
  ) {
    return refuseNoProject(config.repoPath);
  }

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
    const model = describeModel(flag("--worker") ?? "cyber-tiel", "worker", {
      registry: modelRegistry(),
    });
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
    // MD-N1-2: `--from <repo,...>` reads the Worker's recorded prompt sizes,
    // below whose p99 (plus the answer and thinking caps) no window is set.
    const needFrom = (flag("--from") ?? "").split(",").filter(Boolean);
    const promptNeed = needFrom.length ? promptNeedFromLedgers(needFrom) : undefined;
    await runCalibrate({
      models: parseModelList(flag("--models")),
      ...(buckets?.length ? { buckets } : {}),
      ...(promptNeed ? { promptNeed } : {}),
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

  if (config.command === "research-bakeoff") {
    // `sekhemet research-bakeoff [--models …] [--pipelines …] [--adopt] |
    // --adopt-from <run>`: the Researcher bake-off on the research golden set
    // (DS-N2-9, MD-N11-1..3), recorded on this repository's ledger.
    mkdirSync(join(config.repoPath, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(config.repoPath, ".sekhemet", "events.db"));
    initSchema(db);
    const bakeoffLog = new EventLog(db);
    const code = await runResearchBakeoffCommand(
      argv.slice(argv.indexOf("research-bakeoff") + 1),
      { repoPath: config.repoPath, log: bakeoffLog, cardStore: new CardStore(db, bakeoffLog) },
      { print: (l) => console.log(l) },
    );
    // Exit explicitly: model servers and research sidecars must not keep the CLI alive.
    process.exit(code);
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
      `\n${plural(found.length, "constraint")} found; ${plural(r.proposed, "new rule")}, ${r.activated} activated.${r.activated === 0 && r.proposed > 0 ? " Approve them in Playbook, or rerun with --activate." : ""}`,
    );
    return;
  }

  if (config.command === "tune" && argv[argv.indexOf("tune") + 1] === "settings") {
    // `sekhemet tune settings --role <r> [--model <id>] [--yes] | --apply <runId>`
    // (measurement rule 38, NEW-measurement-7): Find best settings, the page's
    // service; nothing loads without --yes, and Apply is the person's.
    const { db, log, cardStore } = initLocalKernel(config.repoPath);
    const { defaultBenchmarkEnv, scannedFit } = await import("./benchmark_cmd.js");
    const { tuneSettingsCommand } = await import("./tune_settings.js");
    const fit = await scannedFit({ repoPath: config.repoPath, log });
    try {
      process.exitCode = await tuneSettingsCommand(
        argv
          .slice(argv.indexOf("tune") + 1)
          .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
        defaultBenchmarkEnv({ repoPath: config.repoPath, log, cardStore, fit: fit.fit }),
        (l) => console.log(l),
        cardStore.localPrincipal(),
      );
    } finally {
      db.close();
    }
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
      console.log(`Replayed ${attempts.length} attempts on ${report.current.cards} issues.`);
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

  const { db, log, cardStore, boardService } = initLocalKernel(config.repoPath);
  // The repository is a project (K14); cards created without one join it.
  const project = await ensureRepoProject(cardStore, config.repoPath).catch(() => undefined);
  // ReviewWIP from this person's measured review minutes (B3).
  if (project) {
    await boardService.calibrateReviewWip(project.reviewMinutesPerDay).catch(() => undefined);
  }

  if (config.command === "project") {
    // `sekhemet project list [--json]`, `sekhemet project move <id> <path>`
    // (surface item 20d, SUR-77, SUR-81; kernel K-N12-7).
    const { projectCommand } = await import("./project_cmd.js");
    process.exitCode = await projectCommand(
      argv
        .slice(argv.indexOf("project") + 1)
        .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
      {
        workspaceFolder: workspace.workspaceFolder,
        ...(workspace.projectId ? { folderProjectId: workspace.projectId } : {}),
        cardStore,
        log,
        principal: cardStore.localPrincipal(),
        print: (l) => console.log(l),
        printErr: (l) => console.error(l),
      },
    );
    db.close();
    return;
  }

  if (config.command === "benchmark") {
    // `sekhemet dev benchmark estimate|quick|overnight|status|stop|report`
    // (measurement NEW-measurement-5): the Configuration page's two-tier
    // benchmark from the terminal, the same service.
    const { benchmarkCommand, defaultBenchmarkEnv, scannedFit } = await import(
      "./benchmark_cmd.js"
    );
    // FINDINGS CFG-15: the page's fit over the scanned models, never "every model fits".
    const fit = await scannedFit({ repoPath: config.repoPath, log });
    process.exitCode = await benchmarkCommand(
      argv
        .slice(argv.indexOf("benchmark") + 1)
        .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
      defaultBenchmarkEnv({ repoPath: config.repoPath, log, cardStore, fit: fit.fit }),
      (l) => console.log(l),
      cardStore.localPrincipal(),
    );
    return;
  }

  if (config.command === "models" && argv[argv.indexOf("models") + 1] === "add") {
    // `sekhemet models add <path> [--id <id>] [--sampling …]` (MD-N12-9, F16): register a GGUF a
    // person already has, so it can run as a role.
    const { modelsAdd } = await import("./models_cmd.js");
    const path = argv[argv.indexOf("add") + 1];
    if (!path || path.startsWith("-")) {
      console.log(
        "Usage: sekhemet models add <path-to.gguf> [--id <id>] [--sampling temperature=,top_p=,top_k=,min_p=]",
      );
      process.exitCode = 2;
      return;
    }
    const idAt = argv.indexOf("--id");
    const id = idAt === -1 ? undefined : argv[idAt + 1];
    // Live-test F16: the model card's sampling, recorded in the registry.
    const samplingAt = argv.indexOf("--sampling");
    const sampling = samplingAt === -1 ? undefined : (argv[samplingAt + 1] ?? "");
    process.exitCode = await modelsAdd(path, {
      registry: modelRegistry(),
      ...(id ? { id } : {}),
      ...(sampling !== undefined ? { sampling } : {}),
    });
    return;
  }

  if (config.command === "models" && argv[argv.indexOf("models") + 1] === "fetch") {
    // `sekhemet dev models fetch <model> | --role <role> | --recommended [--yes]
    // [--folder <path>]` (MD-N12-6, MD-N18-3, MD-N22-2/-3): the page's
    // Download… in the terminal, the same verified implementation.
    const { modelsFetchCommand } = await import("./models_cmd.js");
    process.exitCode = await modelsFetchCommand(
      argv
        .slice(argv.indexOf("fetch") + 1)
        .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
      {
        repoPath: config.repoPath,
        log,
        principal: cardStore.localPrincipal(),
        registry: modelRegistry(),
      },
    );
    return;
  }

  if ((DEV_COMMANDS as readonly string[]).includes(config.command)) {
    // goal, decide, m0, qualify, improve, skills, release, ci (wave2.ts).
    const cmd = config.command as DevCommand;
    const wave2Registry = modelRegistry();
    process.exitCode = await runDevCommand(
      cmd,
      argv
        .slice(argv.indexOf(cmd) + 1)
        .filter((a, i, all) => a !== "--repo" && all[i - 1] !== "--repo"),
      { repoPath: config.repoPath, cardStore, log, boardService },
      {
        print: (l) => console.log(l),
        model: (name) => describeModel(name, "worker", { registry: wave2Registry }),
      },
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
    // `--calibration-night --permit-loads` passes to each round's queue: a
    // calibration night (measurement rule 16d) runs Smart Swap's policy as
    // designed, recording `measure/calibration`; the queue refuses it without
    // the owner's `--permit-loads` or in a repository marked for a measurement.
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
    // Models rule 20b (MD-N3-4/5): the queued overnight benchmark runs before
    // the queue when a person put it first, after it otherwise, only inside
    // the overnight window; one service for both phases.
    const { BenchmarkService, defaultBenchmarkEnv, scannedFit } = await import(
      "./benchmark_cmd.js"
    );
    // FINDINGS CFG-15: the night refuses a model that does not fit, as the page does.
    const nightFit = await scannedFit({ repoPath: config.repoPath, log });
    const nightBench = new BenchmarkService(
      defaultBenchmarkEnv({ repoPath: config.repoPath, log, cardStore, fit: nightFit.fit }),
    );
    const summary = await runOvernight({
      repoPath: config.repoPath,
      log,
      cardStore,
      benchmark: (phase) => nightBench.runNight(phase, { say: (l) => console.log(l) }),
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
          resolveWorkerName(
            flag("--worker"),
            queueDefaults(effectiveConfig(config.repoPath, argv).config, argv).worker,
            { registry: modelRegistry() },
          ),
        );
        const quant = new ModelRegistry(defaultRegistryPath()).get(modelId)?.quant ?? "unknown";
        return { modelId, quant };
      })(),
      // RUN-18a: the night owns the Worker's server; every round attaches to it.
      ...(() => {
        try {
          const name = resolveWorkerName(
            flag("--worker"),
            queueDefaults(effectiveConfig(config.repoPath, argv).config, argv).worker,
            { registry: modelRegistry() },
          );
          const held = nightModelServer(
            describeModel(name, "worker", { registry: modelRegistry() }),
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
    // `sekhemet dev trust [--yes]` (S9, items 38–40; surface item 9, SUR-56):
    // exactly what the repository would run — its configuration outside the
    // sandbox, and the install, build and test a take-over or onboarding
    // runs confined — then the person's yes, recorded in the user directory.
    // `--approve <file>` approves another agent's configuration file by its
    // SHA-256 (security item 38a, SEC-54). In the Team setup only an Admin may.
    const principal = cardStore.localPrincipal();
    const authority = trustAuthorityFor(db, principal);
    if (argv.includes("--approve")) {
      const file = argv[argv.indexOf("--approve") + 1];
      if (!file || !agentConfigFiles(config.repoPath).includes(file)) {
        console.error(
          `Usage: sekhemet dev trust --approve <file>, one of: ${agentConfigFiles(config.repoPath).join(", ") || "(none here)"}`,
        );
        process.exitCode = 2;
        return;
      }
      try {
        const approved = approveAgentConfig(config.repoPath, [file], principal, authority);
        await recordAgentConfigApprovals(cardStore, config.repoPath, approved, principal);
        console.log(
          `Approved ${file} as it is now (sha256 ${approved[0]?.sha256.slice(0, 12)}); any change unapproves it.`,
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      return;
    }
    const files = untrustedFiles(config.repoPath);
    const workspace = isWorkspaceTrusted(config.repoPath);
    if (files.length === 0 && workspace) {
      console.log("Nothing in this repository waits for your trust.");
      return;
    }
    if (files.length) {
      console.log("This repository's configuration would run code outside the sandbox:");
      for (const line of describeUntrusted(config.repoPath, files)) console.log(line);
    }
    if (!workspace) {
      // Review M2: the gates the baseline will run, from the file it loads —
      // a repository-shipped gates.toml is listed as the repository's.
      const { trustPlanLines } = await import("./takeover.js");
      console.log("Trusting it lets Sekhemet run, confined and with no network:");
      for (const l of trustPlanLines(config.repoPath)) console.log(`   ${l}`);
      console.log("   and its language servers.");
    }
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
    try {
      if (!workspace) trustWorkspace(config.repoPath, principal, authority);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const trusted = trustFiles(config.repoPath, files, principal);
    // The decision on the ledger too: who trusted what, by SHA-256 (item 39).
    await cardStore.recordLedgerEvent({
      type: "workspace/trusted",
      actor: "human",
      principal,
      payload: { principal, files: trusted },
    });
    console.log(
      `Trusted${workspace ? "" : " this repository and"} ${plural(files.length, "file")} as they are now; any change to one untrusts it again.`,
    );
    return;
  }

  if (config.command === "take-over" && argv.includes("--approve")) {
    // `sekhemet dev take-over --approve TOP-n [--project <id>]` (DS-TO-14):
    // the local person approves the plan; its cards go through the one
    // planning pipeline (PM-P1-1).
    const proposalId = argv[argv.indexOf("--approve") + 1];
    const projectAt = argv.indexOf("--project");
    const projectId = projectAt === -1 ? undefined : argv[projectAt + 1];
    if (!proposalId || proposalId.startsWith("-")) {
      console.error(DESIGN_COPY.takeover.usage);
      process.exitCode = 1;
      return;
    }
    const { approveTakeoverPlan } = await import("./takeover_backlog.js");
    try {
      const r = await approveTakeoverPlan(
        { repoPath: config.repoPath, cardStore, log, boardService },
        { proposalId, ...(projectId ? { projectId } : {}) },
        cardStore.localPrincipal(),
      );
      console.log(
        DESIGN_COPY.takeover.approved(proposalId, r.cards.length, r.defaultsApplied.length),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  if (config.command === "take-over") {
    // `sekhemet dev take-over [--yes]` (design-stage §2.10 steps 1–3,
    // NEW-design-stage-6): trust first, recon without a model, and — once
    // trusted — install with scripts off, build and the suite twice, confined.
    const { runTakeover } = await import("./takeover.js");
    const report = await runTakeover(config.repoPath, {
      store: cardStore,
      log,
      principal: cardStore.localPrincipal(),
      ...(config.restrictedMode ? { restricted: true } : {}),
      researchAllowed: effectiveConfig(config.repoPath).config.network.mode !== "offline",
    });
    if (!report.trusted) {
      console.log(
        "Trust it with `sekhemet dev trust` to run the install, build and tests above, then take it over again.",
      );
    }
    return;
  }

  if (config.command === "ask") {
    // `sekhemet ask "<question>"` (surface item 16a, NEW-surface-6; O23
    // approved under DEC-42): Seshat's thread, from the terminal.
    const { runAsk } = await import("./ask_cmd.js");
    // The words after `ask`, up to the first flag.
    const rest = argv.slice(argv.indexOf("ask") + 1);
    const firstFlag = rest.findIndex((a) => a.startsWith("-"));
    const question = (firstFlag === -1 ? rest : rest.slice(0, firstFlag)).join(" ");
    process.exitCode = await runAsk(question, {
      repoPath: config.repoPath,
      cardStore,
      pmStore: new PmStore(log),
      pmModel: DEFAULT_PM_MODEL,
      acquire: pmModelFor(DEFAULT_PM_MODEL, modelRegistry(), log),
      board: boardService,
    });
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
        ? `Reserved${until ? ` until ${until.toISOString()}` : " until you run `sekhemet dev reserve --release`"}: no unattended issue or benchmark starts meanwhile.`
        : "The machine is already reserved.",
    );
    return;
  }

  if (config.command === "pause") {
    // `sekhemet dev pause <project>` (item 17a, RUN-48); `resume` is the registry's.
    process.exitCode = await setProjectRunning(cardStore, "pause", config.targetArg);
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
      acquire: pmModelFor(DEFAULT_PM_MODEL, modelRegistry(), log),
      board: boardService,
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
    // SUR-76: `sekhemet` where the workspace is already served names that server.
    const running = await runningServerFor(userPaths().workspaces, {
      folder: workspace.workspaceFolder,
      id: log.workspaceId(),
    });
    if (running) {
      console.log(`Sekhemet board: ${running}/#/${homePage}  (already running for this workspace)`);
      db.close();
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
    const url = `http://127.0.0.1:${server.port}/#/${homePage}`;
    console.log(
      homePage === "configuration"
        ? `Sekhemet Configuration: ${url}  (no model is set up yet; Ctrl+C to stop)`
        : `Sekhemet board: ${url}  (Ctrl+C to stop; --terminal for the text board)`,
    );
    // Surface item 7: --yes prints the address and never opens a browser.
    if (argv.includes("--yes")) return;
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
        ` Activity log truncated: git's newest Ledger-Head trailer names entry ${anchor.seq}, and the Activity log ends at entry ${anchor.lastSeq}.`,
      );
      process.exitCode = 1;
    } else if (anchor.status === "mismatch") {
      console.log(
        ` Activity log rewritten: entry ${anchor.seq} no longer has the hash git's Ledger-Head trailer recorded.`,
      );
      process.exitCode = 1;
    } else if (anchor.status === "ok") {
      console.log(` The Ledger-Head trailer at entry ${anchor.seq} matches.`);
    }
    // K8: the projections must be exactly what the ledger derives.
    const verdict = await cardStore.verifyProjections();
    console.log(
      verdict.identical
        ? ` Projections: rebuilt from ${verdict.eventsApplied} events, byte-identical.`
        : ` Projections differ from the Activity log: ${verdict.mismatched.join(", ")}.${argv.includes("--rebuild") ? "" : " Run `sekhemet log --rebuild` to rebuild them from the Activity log."}`,
    );
    if (!verdict.identical && argv.includes("--rebuild")) {
      await cardStore.rebuildProjections();
      console.log(" Projections rebuilt from the Activity log.");
    }
    if (!verdict.identical && !argv.includes("--rebuild")) process.exitCode = 1;
    return;
  }

  if (config.command === "serve") {
    // teams TEAM-31: a new setup token, voiding the old, while no Admin
    // exists; with an Admin, nothing is written and serve does not start.
    if (argv.includes("--new-setup-token")) {
      const code = newSetupTokenCommand(db, log, config.repoPath);
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    // teams M6: a Team install starts in Solo only after the switch back is
    // recorded, by the person at this machine.
    if (argv.includes("--switch-to-solo")) {
      recordSwitchToSolo(log);
      console.log("Recorded the switch back to Solo: every request here is this machine's person.");
    }
    // SUR-76: one server per workspace; a running one is named, not doubled.
    const running = await runningServerFor(userPaths().workspaces, {
      folder: workspace.workspaceFolder,
      id: log.workspaceId(),
    });
    if (running) {
      console.log(`This workspace is already served at ${running}/`);
      db.close();
      return;
    }
    // runtime item 26: `--host` binds another address, which only the Team setup allows.
    const host = argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : undefined;
    const server = await startDashboardServer({
      db,
      log,
      boardService,
      cardStore,
      repoPath: config.repoPath,
      port: config.port,
      ...(host ? { host } : {}),
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
    // `sekhemet plan "<spec>" [--planner <model>|none] [--researcher <model>]`: SPIDR against the real
    // codebase map, persisted with the whole contract, INVEST enforced and
    // the batched decision parked (wave2.ts planCommand).
    const spec = config.targetArg || "New feature specification";
    console.log(`\nPlanning feature: "${spec}"`);
    // Model first (planner-pm §2.1.2, PM-P1-2): --planner (or the older
    // --sketcher), else an explicit [models] planner, else Seshat's model.
    // It is loaded before the Worker and unloaded after planning, so the two
    // never share memory.
    const flagged = (name: string) =>
      argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
    // `--planner none` plans heuristically on purpose (and loads nothing);
    // the plan's first line says it was planned without a model.
    const registry = modelRegistry();
    const named = flagged("--planner") ?? flagged("--sketcher");
    const configured = effectiveConfig(config.repoPath).config.models.planner;
    const plannerName = resolvePlannerModel({
      flag: named,
      configured,
      seshatModel: DEFAULT_PM_MODEL,
      isRegistered: (m) => registry.get(m) !== undefined,
    });
    if (!plannerName && named !== "none" && configured !== "none") {
      console.error(
        `Planning model: ${DEFAULT_PM_MODEL}, Seshat's model, is not in Sekhemet's model list; planning without a model.`,
      );
    }
    // MD-N9-4: the Planner's model through the scheduler, loaded when first asked.
    const planAccess = plannerName
      ? ModelAccess.forQueues([{ queue: "plan", role: "planner", name: plannerName }], {
          registry,
          ledger: log,
        })
      : undefined;
    // Kept synchronous (`acquire`): `plan` owns this scheduler, one queue only.
    // PM-P1-3: a model that cannot be loaded plans nothing — the heuristic
    // does, and the plan's first line says so.
    const loaded = planAccess
      ? await planAccess
          .measure()
          .then(() => planAccess.use("plan"))
          .then(() => true)
          .catch((err: unknown) => {
            console.error(
              `Planning model: ${plannerName} could not be loaded (${err instanceof Error ? err.message : String(err)}); planning without a model.`,
            );
            return false;
          })
      : false;
    const sketcher = loaded ? planAccess?.adapterFor("plan") : undefined;
    // design-stage S8: the reuse survey reads public registries, GitHub and
    // paper indexes with short keyword queries only when a person allowed
    // research — asked once, on a new project's first plan, before any
    // request (DS-S8-2) — through the network policy, each query logged.
    // Otherwise, and under --offline, it makes no request and says so.
    const offline = argv.includes("--offline") || process.env.SEKHEMET_OFFLINE === "1";
    const research = await planResearch({
      repoPath: config.repoPath,
      log,
      // TEAM-44: the research answer's write to the user config is the person's, recorded.
      recordConfigWrite: configWriter({
        db,
        log,
        path: userConfigPath(),
        identityDir: identityDir(),
        principal: log.localPrincipal(),
      }),
      offline,
      newProject: isGreenfield(config.repoPath),
      print: (l) => console.log(l),
      ...(process.stdin.isTTY ? { ask: askYesNo } : {}),
    });
    // DS-P7-10: at the brief level, one deep question to the Researcher —
    // when research is allowed, a Researcher is configured and no card is
    // running — asked after the plan, with the Planner's model released
    // first, so the two never share memory; otherwise the brief says why not.
    const researcherName =
      roleModelName("researcher", flagged("--researcher"), { registry }) ??
      process.env.SEKHEMET_RESEARCHER;
    const deep = deepPriorArtFor({
      repoPath: config.repoPath,
      allowed: research !== undefined,
      offline,
      researcher: researcherName,
      ask: async (question) => {
        await planAccess?.release("plan").catch(() => undefined);
        return planResearcher({
          repoPath: config.repoPath,
          log,
          cardStore,
          model: researcherName as string,
        })(question);
      },
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
        deep,
        // DS-P14-1: the depth offer is answered only by a person at a terminal.
        ...(process.stdin.isTTY ? { ask: askLine } : {}),
        ...(offline ? { offline } : {}),
      });
    } finally {
      await hub?.close();
    }
    await (sketcher as { unload?: () => Promise<void> } | undefined)?.unload?.();
    console.log("View the issues with 'sekhemet board'.\n");
    return;
  }

  if (config.command === "gate") {
    // `sekhemet gate [<card>]`: run every gate declared in gates.toml, in the
    // card's own worktree when one exists, and report typed failures with
    // their remedies plus the 3-file / 200-line bounds.
    const cardId = config.targetArg;
    const card = cardId ? await cardStore.getCard(cardId) : null;
    // Runtime item 2a (SUR-75): a card key from any project of the workspace
    // runs that card's checks in its own project's root.
    const { contextForCard, isolateCheckout } = await import("./card_root.js");
    const place = contextForCard({ repoPath: config.repoPath, cardStore }, card ?? {});
    const root = place.repoPath;
    const worktree = cardId ? join(root, ".sekhemet", "worktrees", cardId) : undefined;
    const cwd = worktree && existsSync(worktree) ? worktree : root;
    if (cardId && cwd === root) {
      console.log(`No worktree for ${cardId}; running the checks in the repository instead.`);
    }
    const gatesConfig = loadGatesConfig(root);
    for (const w of gatesConfig.warnings ?? []) console.log(`  warning: ${w}`);
    // Security item 10a: a card's checks see only its own project.
    const releaseIsolation = cardId ? isolateCheckout(place, cwd) : () => {};
    let res: PipelineResult;
    try {
      if (cardId && cwd !== root) {
        // The card's own verification — the same pipeline, runner, rungs,
        // branch, bounds and built-in layers as the card run (gates rule 8, T1).
        const base = gateBaseBranch(root, gatesConfig);
        console.log(`\nVerifying ${cardId} against ${base} in ${cwd}`);
        res = await verifyCardWorktree({
          repoPath: root,
          gatesConfig,
          restricted: config.restrictedMode,
          card: card ?? {},
          worktree: cwd,
          base,
          // The same inputs as the card run: the onboarding baseline (GT-BF-2)
          // and what a tool applied on its last run (GT-BF-3).
          ...(await (
            await import("./onboard.js")
          )
            .loadBaseline({
              getEventsByTypes: (types: string[]) => cardStore.eventsOfType(types),
            })
            .then((b) => baselineInput(b))
            .catch(() => ({}))),
          ...(lastToolApplied(config.repoPath, cardId)
            ? { toolApplied: lastToolApplied(config.repoPath, cardId) }
            : {}),
          // Air-gapped: only mirrored packages exist (X10).
          registry: isAirgapped(root)
            ? mirrorRegistry(root)
            : npmRegistry(root, {
                // Through the one network policy (security item 32, SEC-14).
                fetchImpl: policyFetch(
                  (() => {
                    const n = networkConfigs(root);
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
      } else {
        // No card: the declared gates of the repository as it stands.
        const rungs = verificationRungs(gatesConfig.gates, config.restrictedMode);
        console.log(`\nRunning ${rungs.join(", ")} in ${cwd}`);
        res = await runGatePipeline(
          [
            declaredStage(
              new DeterministicGateRunner(confinedSandbox(config.restrictedMode), {
                repoRoot: root,
                expectedConfigSha256: gatesConfig.sha256,
                maxFailuresReported: Number.POSITIVE_INFINITY,
              }),
              rungs,
              cwd,
            ),
          ],
          { cwd },
        );
      }
    } finally {
      releaseIsolation();
    }
    for (const a of res.advisories) console.log(`  advisory: ${a}`);
    // Y19, RG-N3-1: each package the card touches runs its own gates inside
    // the card's verification, so this verdict is the card run's.
    const passed = res.passed;
    for (const r of res.rungResults) {
      const mark = r.unavailable ? "!" : r.passed ? "✓" : r.skipped ? "-" : "✗";
      const why = r.reason ? ` — ${r.reason}` : "";
      console.log(`  ${mark} ${r.gate} (${r.durationMs} ms)${why}`);
    }
    if (passed) {
      console.log("All checks passed.\n");
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
      console.log(`Check host certificates in ${certDir} (ca.pem, server.*, client.*).`);
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
      `Sekhemet check host on https://127.0.0.1:${host.port} (mutual TLS; Ctrl+C to stop)`,
    );
    return;
  }

  if (config.command === "gates") {
    // `sekhemet gates approve-baseline <key> --sha256 <hash> [--card <id>]`:
    // a person makes the visual candidate they saw the baseline, recorded
    // with their principal (gates rule 31, GT-N4-1); with no key, the
    // candidates waiting are listed with their card and SHA-256.
    if (config.targetArg === "approve-baseline") {
      const rest = argv.slice(argv.indexOf("approve-baseline") + 1);
      const flag = (name: string) => {
        const at = rest.indexOf(name);
        return at >= 0 ? rest[at + 1] : undefined;
      };
      const key = rest.find(
        (a, i) => !a.startsWith("--") && rest[i - 1] !== "--card" && rest[i - 1] !== "--sha256",
      );
      if (!key) {
        const waiting = visualCandidates(config.repoPath);
        console.log(
          waiting.length
            ? `Visual candidates waiting for approval:\n${waiting.map((c) => `  ${describeCandidate(c)}`).join("\n")}\nLook at one, then approve it with: sekhemet gates approve-baseline <key> --card <id> --sha256 <hash>`
            : "No visual candidate is waiting for approval.",
        );
        return;
      }
      const r = await approveBaseline(cardStore, {
        repoPath: config.repoPath,
        key,
        principal: cardStore.localPrincipal(),
        cardId: flag("--card"),
        sha256: flag("--sha256"),
      });
      if (!r.approved) {
        console.error(`Not approved: ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Approved ${r.key} as the baseline (sha256 ${r.sha256.slice(0, 12)}).`);
      return;
    }
    // `sekhemet gates init [--force]`: write the gate template detected from
    // the project's manifests to .sekhemet/gates.toml (G27).
    if (config.targetArg !== "init") {
      console.error(
        "Usage: sekhemet gates init [--force] | sekhemet gates approve-baseline <key> --sha256 <hash> [--card <id>]",
      );
      process.exitCode = 1;
      return;
    }
    const target = join(config.repoPath, ".sekhemet", "gates.toml");
    if (existsSync(target) && !argv.includes("--force")) {
      console.error(`${target} exists; pass --force to replace it.`);
      process.exitCode = 1;
      return;
    }
    // The one gate deriver (surface item 5.3, P10), as the first run uses.
    const derived = deriveGates(config.repoPath);
    if (derived.defs.length === 0) {
      console.error("No manifest recognised (package.json, pyproject.toml, Cargo.toml, go.mod).");
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, derived.toml);
    console.log(`Wrote ${target} (${derived.gates.join("; ")}).`);
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
        console.error(`Issue not found: ${cardId}`);
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
      const adapter = describeModel(as, "worker", { registry });
      const gate = gateWorker(registry, adapter, as);
      if (gate.refusal) {
        console.error(gate.refusal);
        process.exit(1);
      }
      if (gate.override)
        console.log(`Coding model ${adapter.modelId}: ${describeOverride(gate.override)}`);
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
    // MD-N4-7: without --fixture, the tasks come from this repository's
    // history (fail-to-pass fixes and reconstructions), and it says when too
    // few exist. Running mined tasks needs the suite runner to take a task
    // set; until then the mined set is recorded and the fixture runs.
    if (!flag("--fixture")) {
      const mined = await bakeOffTaskPlan(config.repoPath, fixture);
      console.log(mined.message);
      if (mined.tasks) {
        const file = join(config.repoPath, ".sekhemet", "bakeoff", "history_tasks.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(mined.tasks, null, 2)}\n`);
      }
      if (mined.source === "history") {
        console.log(
          `The suite runner cannot run mined tasks yet; recorded them in .sekhemet/bakeoff/history_tasks.json and running the ${fixture} fixture.`,
        );
      }
    }
    const manager = flag("--manager");
    const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // The one measurement path (measurement MS-M9-1): each Worker runs the
    // fixture through the suite runner, and so through the product's queue.
    const base = join(tmpdir(), `sekhemet-bakeoff-${Date.now()}`);
    const rows = await bakeOffOnSuitePath({ harnessRoot, workers, fixture, manager, dir: base });

    console.log(`\nBake-off on ${fixture}${manager ? ` (manager: ${manager})` : ""}`);
    console.log(
      "coding model                             passed/measured  first try  minutes  tokens",
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
    // Each record's settings as the run had them: a Worker under a person's
    // override is marked, so its record says so (review medium 2). The suite
    // runner already refused an unqualified one.
    const bakeAdapter = (worker: string) => {
      const adapter = describeModel(worker, "worker", { registry: bakeRegistry });
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
            // MD-N4-6: the settings the child's evidence recorded.
            settings: childSettings(res),
            passed: res.firstTry,
            total: runScore(res).measured,
            minutes: res.cost.wallClockSeconds / 60,
            tokens: res.cost.tokens,
            stepBudget: appliedStepBudget(config.repoPath) ?? DEFAULT_STEP_BUDGET,
          };
        }),
      harnessRoot,
    );
    console.log(`Matrix: ${recorded.matrix} (${plural(recorded.recorded, "record")})`);
    for (const m of recorded.inadmissible) console.log(`   inadmissible: ${m}`);
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
    // SUR-12: a derived test gate that cannot start stops the run before any
    // card, naming the file to edit — rather than failing every card on it.
    const queueCannotStart = gateStartStop(config.repoPath);
    if (queueCannotStart.length) {
      for (const line of queueCannotStart) console.error(line);
      process.exitCode = 1;
      return;
    }
    // Smart Swap this run (measurement rule 16d, models rule 20b): a
    // measurement run in a marked repository (the frozen suite, a bake-off),
    // a calibration night only when the owner permits loads, else live.
    const swapMode = queueSwapMode(config.repoPath, argv);
    if ("refused" in swapMode) {
      console.error(swapMode.refused);
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
    const managerAsked =
      roleModelName("planner", managerIdx !== -1 ? argv[managerIdx + 1] : undefined, {
        registry: modelRegistry(),
      }) ?? configured.manager;
    const researcherIdx = argv.indexOf("--researcher");
    const researcherAsked =
      roleModelName("researcher", researcherIdx !== -1 ? argv[researcherIdx + 1] : undefined, {
        registry: modelRegistry(),
      }) ?? process.env.SEKHEMET_RESEARCHER;
    const reviewerIdx = argv.indexOf("--reviewer");
    const reviewerAsked = roleModelName(
      "reviewer",
      reviewerIdx !== -1 ? argv[reviewerIdx + 1] : undefined,
      { registry: modelRegistry() },
    );
    const workerIdx = argv.indexOf("--worker");
    // MD-N10-3: the flag, else the person's assignment, else config.toml.
    const assignedFrom = modelRegistry();
    const workerModel =
      roleModelName("worker", workerIdx !== -1 ? argv[workerIdx + 1] : undefined, {
        registry: assignedFrom,
      }) ?? configured.worker;
    // MD-N8-1, rule 23 (W11): every role's combination is verified before the
    // pass, as the Coding model's is below; an unverified one is left out and
    // named with its fallback (`queuePrelude`). The Planning model's weights
    // serve the manager, Seshat and escalation queues, so they go together.
    const pmModelName = managerAsked ?? DEFAULT_PM_MODEL;
    const quickName = effectiveConfig(config.repoPath, argv).config.models.quickAnswerer.trim();
    const roleRegistry = modelRegistry();
    const roles = verifiedQueueRoles<QueueSpec>(
      roleRegistry,
      [
        { queue: "worker", role: "worker", name: workerModel ?? defaultWorkerName() },
        // The Planner doubles as the PM you chat with during the run.
        { queue: "manager", role: "planner", name: pmModelName },
        // Seshat answering a person: the same weights, the interactive class
        // (models rule 20e: a person waiting; its swaps are interactive, C7).
        { queue: "seshat", role: "planner", name: pmModelName },
        // The Planner's (stronger, dense) model as a coder, for --escalate-retries.
        { queue: "escalation", role: "planner", name: pmModelName, window: escalationWindow() },
        ...(researcherAsked
          ? [{ queue: "researcher", role: "researcher" as const, name: researcherAsked }]
          : []),
        // Rule 20f (b): the Planner role's quick answerer, when a person named one.
        ...(quickName ? [{ queue: "quick", role: "planner" as const, name: quickName }] : []),
      ],
      // review-git §2.3.7, RG-P8-10: the Review model, never of the Coding
      // model's family; unfilled, each passing issue says why in Review.
      resolveReviewerRole({
        reviewer: reviewerAsked,
        planner: pmModelName,
        worker: workerModel ?? defaultWorkerName(),
        familyOf: (m) => familyOf(m, roleRegistry),
      }),
      (name, role) => describeModel(name, role, { registry: roleRegistry }),
    );
    const managerModel = roles.has("manager") ? managerAsked : undefined;
    const researcherModel = roles.has("researcher") ? researcherAsked : undefined;
    const reviewerRole = roles.reviewer;
    const reviewerModel =
      reviewerRole.state === "filled" && reviewerRole.queue === "reviewer"
        ? reviewerRole.model
        : undefined;

    if (project && project.status !== "active") {
      console.log(
        `Project ${project.name} is ${project.status}; resume it on the dashboard (or pause another: at most ${cardStore.activeProjectCap} run at once).`,
      );
      releaseLease();
      return;
    }
    // SUR-75: the folder's project's Ready issues, or every active project's
    // in turn (RUN-81) from a workspace folder that is no project's root.
    const inScope = (c: CardRecord) =>
      !workspace.projectId || (c.projectId ?? workspace.projectId) === workspace.projectId;
    const readyRaw = ((await cardStore.listCards({ status: "ready" })) as CardRecord[]).filter(
      inScope,
    );
    if (readyRaw.length === 0) {
      console.log("No Ready issues.");
      releaseLease();
      return;
    }
    // Planning before the pass (wave2.ts): decision deadlines, the seven
    // signals, ceremonies, goals, the throughput floor, and WSJF/RICE order.
    let ready: CardRecord[];
    // TEAM-16: the Team setup's access, checked again between the Agent's steps.
    let agentAccess: Access | undefined;
    // Rule 27, MD-N4-4: the person's override the Worker runs under, if any.
    let workerOverride: WorkerOverride | undefined;
    // RUN-35: the Worker's qualified parallel slots (`-np`) bound the cards that run at once.
    let qualifiedSlots = 1;
    try {
      // MD-N8-1: the Worker's combination must have qualified on this host;
      // resolving it builds the adapter without starting a server.
      const workerName = workerModel ?? defaultWorkerName();
      const registry = modelRegistry();
      const workerProbe = describeModel(workerName, "worker", { registry });
      const gate = gateWorker(registry, workerProbe, workerName);
      workerOverride = gate.override;
      if (!gate.refusal) qualifiedSlots = gate.combination.settings.parallelSlots;
      // PM-N9-2, TEAM-41: a signal's suggestion under an Admin's auto-apply rule is applied now.
      const team = new Access({
        db,
        setup: setupFor(config.repoPath),
        localPrincipal: () => log.localPrincipal(),
      });
      ({ ordered: ready } = await queuePrelude(
        { repoPath: config.repoPath, cardStore, log },
        readyRaw,
        {
          autoApply: (project, kind) => team.autoApplier(project, kind),
          workerRefusal: gate.refusal,
          roleRefusals: roles.refusals,
          workerModelId: workerModel ?? defaultWorkerName(),
          reviewWip: (await boardService.getBoardState()).wipLimits.review,
        },
      ));
      // TEAM-16: the Agent runs an issue only for a person who may start it there.
      ready = await runnableByTheirPeople(ready, {
        access: team,
        store: cardStore,
        log,
        say: (line) => console.log(line),
      });
      agentAccess = team;
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
        `Coding model ${workerModel ?? defaultWorkerName()}: ${describeOverride(workerOverride)}`,
      );
    }

    // Every queue's model comes from the one residency scheduler over the
    // roster (MD-N9-4, M5, C3): queues on the same weights share one adapter
    // at the largest window they need; every load is checked against usable
    // memory and every eviction proven. The registry pins chat templates and
    // supplies measured tool arms (M11).
    /** Every adapter the scheduler built, for the watchdog's actions. */
    const loaded = new Set<UnloadableAdapter>();
    // Prefill/decode speed per model and the Worker's prefix-cache hit rate (M3, M18).
    const meter = new ThroughputMeter();
    const cache = new PrefixCacheMonitor();
    const router = ModelAccess.forQueues(
      // Only the verified roles (MD-N8-1); the quick answerer's queue is added below.
      roles.verified.filter((q) => q.queue !== "quick"),
      {
        registry: modelRegistry(),
        ledger: log,
        // Rule 20g: the headroom probe, off until a calibration night sets its
        // reserves (`[models] headroom_probe`, models §4).
        ...(() => {
          const probe = headroomProbeFor(
            effectiveConfig(config.repoPath, argv).config.models.headroomProbe,
          );
          return probe ? { headroom: probe } : {};
        })(),
        wrap: (adapter, queues) => {
          loaded.add(adapter);
          if (queues.includes("worker") || queues.includes("escalation"))
            measureThroughput(adapter, meter, cache);
          // Every bundle and card/repro made under a person's override says so.
          return queues.includes("worker") && workerOverride
            ? applyWorkerOverride(adapter, workerOverride)
            : adapter;
        },
        log: (line) => console.log(`   ${line}`),
      },
    );
    // The memory watchdog (M20, NEW-models-2): polls every 2 s and acts
    // through the adapters, the language servers, the router and the queue;
    // the card runner checks it before every turn.
    const pressure = new PressureControls({
      adapters: () => loaded,
      lspPool: () => runLspPool(),
      releaseModels: async () => {
        await router.releaseAll();
      },
      log: (line) => console.log(`   ${line}`),
    });
    const { watchdog } = createCardWatchdog(pressure, {
      log: (line) => console.log(`   ${line}`),
    });
    // Smart Swap's snapshot (models rule 20e): presence from the dashboard's
    // sessions, reserve-now and the reserved hours (C6); the watchdog's level
    // (rule 19); and, while a model loads, the next Ready cards' CPU-side
    // work (C9). The plan is read from the board at each card's start and end.
    const presence = presenceTracker(log, {
      hours: () => effectiveConfig(config.repoPath, argv).config.machine.hours,
    });
    const queuedWork = new QueuedCardWork({
      next: async () =>
        ((await cardStore.listCards({ status: "ready" })) as CardRecord[]).filter(inScope),
      tasks: (card) => cardOverlapTasks(config.repoPath, card),
      log: (line) => console.log(`   ${line}`),
    });
    router.setSwapInputs({
      presence: presence.current,
      watchdogLevel: () => watchdog.state.level,
      overlap: (loading) => queuedWork.run(loading),
    });
    await refreshPlan(router, cardStore).catch(() => undefined);
    // Rule 20f (b): the Planner role's quick answerer, when a person named one.
    const quick = roles.has("quick") ? quickAnswererFor(router, quickName) : undefined;
    // Residency: every model's footprint against this host's usable memory
    // (MD-N9-3); a model of unknown size is refused when first asked for.
    const plan = await router.measure();
    console.log(
      `Residency: ${(plan.usableBytes / 1024 ** 3).toFixed(0)} GB usable; ${Object.entries(
        plan.footprints,
      )
        .map(([k, b]) => `${k} ${(b / 1024 ** 3).toFixed(1)} GB`)
        .join(
          ", ",
        )}${plan.unknown.length ? `; size unknown, refused until measured: ${plan.unknown.join(", ")}` : ""}.`,
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
            // Kept synchronous (`acquire`): it runs only inside Seshat's answer,
            // which holds the manager; a queued request would wait behind the
            // hold that waits for it. It refuses rather than evict a held model.
            model: () => router.use("researcher"),
          }).ask(question, opts);
          // Synchronous for the same reason: Seshat's answer continues on the manager.
          await router.use("manager");
          return r;
        }
      : undefined;
    /** Struggles the playbook had no remedy for: the Researcher's queue. */
    const unexplained: { cardId: string; text: string }[] = [];
    const pmStore = new PmStore(log);
    // H20, INT-17 to INT-20a: the one notifier (push and Slack, budgeted, and
    // Seshat's daily standup) while the queue runs.
    const standupAccess = new Access({
      db,
      setup: setupFor(config.repoPath),
      localPrincipal: () => log.localPrincipal(),
    });
    const standupAudience = audienceFromAccess(() => standupAccess, db);
    const notifier = await startNotifier(log, config.repoPath, {
      // PM-N9-8: each recipient's standup names only what they can see.
      standup: (person) =>
        dailyStandup({
          repoPath: config.repoPath,
          cardStore,
          pmStore,
          pmModel,
          person,
          audience: standupAudience,
        }),
    });
    // Tells the dashboard this process holds the Worker, so PM messages are
    // answered here, between steps, instead of loading a second large model.
    // The lease also publishes the model roster and which role is resident,
    // for the dashboard's Machine view.
    queueLive.current = () => ({
      pmModel,
      roster: [
        { role: "worker", model: workerModel ?? defaultWorkerName() },
        { role: "manager", model: pmModel },
        ...(reviewerModel ? [{ role: "reviewer" as const, model: reviewerModel }] : []),
        ...(researcherModel ? [{ role: "researcher" as const, model: researcherModel }] : []),
      ],
      ...(router.activeRole
        ? { active: router.activeRole === "escalation" ? "manager" : router.activeRole }
        : {}),
      resident: router.residentRoles().map((r) => (r === "escalation" ? "manager" : r)),
      coResident: router.residentRoles().length > 1,
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
        // Kept synchronous (`acquire`): only when the manager is already
        // resident, inside the Worker's own step, so it loads nothing; a
        // queued request would wait for the step that waits for it.
        const res = await (await router.use("manager")).generate({
          systemPrompt:
            "You are Seshat, the project manager. A teammate (the coding Worker) is mid-card and asks a question its card's spec does not answer. Answer in at most three sentences, concretely, consistent with the spec and acceptance tests. If it is genuinely the lead's call, say so and give the most conservative choice.",
          prompt: `Card: ${card?.title ?? cardId}\nSpec: ${card?.spec ?? "(none)"}\nDone when: ${(card?.acceptanceCriteria ?? []).join("; ")}\n\nQuestion: ${question}`,
          toolArm: "arm_a_flat",
          temperature: 0.2,
          maxTokens: 300,
          role: "seshat",
          task: "worker_question",
        });
        // Synchronous: `prior` was resident beside the manager, so this loads nothing.
        if (prior) await router.use(prior);
        // MD-N4-8: the adapter stripped the reasoning.
        return res.text.trim() || undefined;
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
      if (filed > 0)
        console.log(`   filed ${plural(filed, "answer")} from Seshat in the issues' dossiers`);
    };

    /**
     * One answer at a time: with parallel slots (RUN-35) two cards' step
     * boundaries may both find the person's message; the second waits and
     * finds it answered.
     */
    let answering: Promise<void> = Promise.resolve();
    const answerPm = (step?: number, batch = false): Promise<void> => {
      const next = answering.then(() => answerPmNow(step, batch));
      answering = next.catch(() => undefined);
      return next;
    };
    const answerPmNow = async (step?: number, batch = false): Promise<void> => {
      // Rule 23: with the Planning model unverified, Seshat does not answer during the run.
      if (!router.has("manager")) return;
      const queuedNow = await pmStore.queued();
      if (queuedNow.length === 0) return;
      // Only the human's messages pause the Worker; Worker questions wait for
      // the next manager batch instead of forcing a swap each.
      if (!batch && queuedNow.every(isWorkerQuestion)) return;
      console.log(
        `   Seshat: pausing the Agent${step !== undefined ? ` after step ${step}` : ""} to answer`,
      );
      const workerWasActive = router.activeRole === "worker";
      // Models rule 20e: the answer is a queued request — interactive when a
      // person wrote (the `seshat` queue), a planner batch for Worker questions
      // only — so `decide()` places it (C4, C5, C7) and it holds the model.
      const seshatQueue = queuedNow.every(isWorkerQuestion) ? "manager" : "seshat";
      await answerQueued({
        repoPath: config.repoPath,
        cardStore,
        pmStore,
        pmModel,
        acquire: () => router.submitHold(seshatQueue),
        board: boardService,
        // Smart Swap (models rule 20f): the full answer's predicted wait, and
        // whether it would break the Worker's floor mid-card (C5).
        predictWait: () => seshatWait(router, seshatQueue, { homeBacklog: step !== undefined }),
        ...(quick ? { quick } : {}),
        ...(step !== undefined ? { step } : {}),
        team: [
          `Coding model (${workerModelId}): ${router.isResident("worker") ? "resident" : "swapped out"}; it asks you questions its issues' descriptions do not answer.`,
          router.has("researcher")
            ? `Researcher: ${router.isResident("researcher") ? "resident, asking is cheap" : "swapped out, asking costs a model load (~40 s): batch questions into one"}.`
            : "No Researcher configured: use find_library for packages.",
          router.has("reviewer")
            ? "Review model (different model family): reviews passing issues at the end of a pass."
            : "You review passing issues yourself at the end of a pass.",
          `Residency: ${router.residentRoles().join(", ") || "none"} loaded now.`,
        ].join("\n"),
        ...(askResearcher ? { researcher: askResearcher } : {}),
      });
      if (workerWasActive) {
        await pmStore.setStatus({
          phase: "resuming_worker",
          detail: "Reloading the Coding model",
          workerPaused: true,
          ...(step !== undefined ? { step } : {}),
        });
        // The Worker's return goes through `decide()`'s queue too (its home, C5).
        const worker = (await router.useQueued("worker")) as {
          ensureRunning?: () => Promise<void>;
        };
        await worker.ensureRunning?.();
        await pmStore.setStatus({ phase: "idle" });
      }
    };
    /** Rules learned during this run from verified signals: in force for this run. */
    const runRules = new Set<string>();
    // E5: a frozen-fixture regression run carries one candidate rule for this run only.
    // CX-N4-1: it carries the gated rule's own scope; unscoped, it is not proposed.
    const candidateRule = candidateRuleFromEnv(process.env);
    if (candidateRule) {
      const candidate = await new LearningStore(log)
        .propose({
          role: "worker",
          text: candidateRule.text,
          scope: candidateRule.scope,
          source: "seed",
          evidence: [],
        })
        .catch(() => undefined);
      if (candidate) runRules.add(candidate.id);
    } else if (process.env.SEKHEMET_CANDIDATE_RULE) {
      console.log("   E5: the candidate rule came without its scope; not proposed");
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
      ...(agentAccess?.setup === "team"
        ? { agentRefusal: agentRefusalFor(agentAccess, cardStore) }
        : {}),
      watchdog,
      runProfile: queueProfile,
      ...(measurement ? { measurement } : {}),
      // GT-N4-2: a qualified vision model answers the visual gate's
      // checklist, loaded on its first question on the queue the image
      // pre-pass uses (a scheduled swap), released with the queue's models.
      loadVisionModel: async (name: string) => {
        router.ensureQueue({ queue: "vision", role: "reviewer", name });
        return router.use("vision");
      },
      afterTurn: async (_cardId: string, turn: { turnIndex: number }) => {
        // RUN-35, C8: a swap to Seshat while other cards run waits at the drain
        // barrier until every running step reaches its boundary, and no card
        // starts a step until the Worker is back (`beginStep`).
        await answerPm(turn.turnIndex).catch((err) =>
          console.log(`   Seshat: could not answer (${err instanceof Error ? err.message : err})`),
        );
      },
    };
    // X15: review cards for PRs the harness did not open run the reviewer
    // procedure on a checkout (never an edit) and do not reach the Worker.
    // Models rule 20e (C6): the external reviews are one queued review request,
    // held for the batch and released after it.
    // RG-P8-10: the run's Review role, never the Coding model's family; unfilled,
    // each review records why and none runs on Seshat's weights.
    const externalReviewer = externalReviewerFor(reviewerRole, router);
    ready = await runExternalReviews(config.repoPath, ready, {
      store: cardStore,
      board: boardService,
      learning: ctx.learning,
      ...(externalReviewer.reviewer ? { reviewer: externalReviewer.reviewer } : {}),
      ...(externalReviewer.notReviewed ? { notReviewed: externalReviewer.notReviewed } : {}),
      ...(() => {
        const poster = reviewPosterFromEnv(config.repoPath, cardStore);
        return poster ? { github: poster } : {};
      })(),
      say: (line) => console.log(line),
    }).finally(() => externalReviewer.release());
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
        router.ensureQueue({ queue: "vision", role: "reviewer", name });
        // Kept synchronous (`acquire`): a pre-pass before the first card, when
        // no other queue has work, and it releases its model itself.
        return router.use("vision");
      },
      release: async () => {
        await router.release("vision");
      },
      say: (line) => console.log(`   ${line}`),
    }).catch((err) => console.log(`   vision: ${err instanceof Error ? err.message : err}`));
    const started = Date.now();
    // DB-N2-11: Runs shows this run as running until its report lands.
    await recordQueueStarted(log, {
      startedAt: new Date(started).toISOString(),
      cards: ready.map((c) => c.id),
      model: workerModel ?? defaultWorkerName(),
      pid: process.pid,
    }).catch(() => undefined);
    // RUN-34, TEAM-30: tokens each person's cards spend from here on decide the next pick.
    const queueSinceSeq = (await log.getLastEvent())?.seq ?? 0;
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

    let workerModelId = workerModel ?? defaultWorkerName();
    // --max-turns caps every card's step budget (the tuner's recommendation).
    const escalateRetries = argv.includes("--escalate-retries");
    // Rule 23: with the Planning model unverified, nothing is escalated to it.
    const routeFor = (card: CardRecord, attempt: number): ReturnType<typeof roleForCard> => {
      const role = roleForCard(card, attempt, escalateRetries);
      return role === "escalation" && !router.has("escalation") ? "worker" : role;
    };
    if (argv.includes("--explore")) {
      // Constraints read from the project's own config are facts, so they are
      // activated directly; heuristic rules still wait for a human.
      const r = await applyExploration(ctx.learning, config.repoPath, true, ready);
      console.log(`Explored the project: ${plural(r.activated, "constraint rule")} active.`);
    }
    const maxTurnsIdx = argv.indexOf("--max-turns");
    // Without --max-turns, the budget `tune --apply` set (E8), if any.
    const maxTurns =
      maxTurnsIdx !== -1 ? Number(argv[maxTurnsIdx + 1]) : appliedStepBudget(config.repoPath);
    const passedResults: { card: CardRecord; diff: string }[] = [];
    /**
     * The AI review (review-git §2.3, P8): each passing card waits in Verify
     * while its review is queued on the Review model's queue, and Smart
     * Swap's `decide()` chooses when the Review model visits — one tour for
     * every review due, never more round trips than the storm cap — while the
     * Worker keeps working (models rule 20e, C2, C4, C6, C7; RG-P8-3). The
     * review records its findings, then moves the card to Review (RG-P8-1).
     * It runs with or without learned preferences (RG-P8-4).
     */
    const reviewFlow = new ReviewFlow({
      ctx: { repoPath: config.repoPath, cardStore, boardService },
      role: reviewerRole,
      access: router,
      learned: () => learnedFrom(ctx.learning),
      log: (line) => console.log(`   ${line}`),
    });
    if (reviewerRole.state === "unfilled") console.log(`   ${reviewerRole.reason}`);
    // Cards a stopped run left waiting for their review are reviewed in this one.
    for (const id of await reviewFlow.resume().catch(() => []))
      console.log(`   ${id} is waiting for its AI review`);
    const attempt = async (
      rawCard: CardRecord,
      n: number,
      guidance?: string,
      /** RUN-35: the card's slot lease, its server slot (models rule 20i). */
      serverSlot?: number,
    ) => {
      // SUR-40: a --max-turns flag, else the card's own step budget override, else the run's.
      const cap = cardStepCap(
        rawCard,
        maxTurnsIdx !== -1 ? { flag: maxTurns } : { otherwise: maxTurns },
      );
      const card = cap && rawCard.stepBudget > cap ? { ...rawCard, stepBudget: cap } : rawCard;
      // A retry of a card the worker could not do runs on the stronger model
      // when asked: capability-based routing, not the same model again.
      // The planner's route (P6) sends hard cards to the escalation model up front.
      const role = routeFor(rawCard, n);
      // Models rule 20e: the card's model through `decide()`'s queue, so a
      // tour under way finishes first. An escalated card runs on a visitor's
      // weights (the Planner's): held for the attempt, so the policy (C3, the
      // shortened keep-alive at elevated) never unloads them between its
      // steps — a pin only the policy respects: the watchdog's emergency
      // unloads them between steps (rule 19).
      // An escalated card runs alone (the pass drained the slots): the Worker
      // has no step meanwhile, so its request is not held back by C1.
      if (role !== "worker") router.setHomeBacklog(undefined);
      const visitorHold =
        role === "worker"
          ? undefined
          : await router
              .submitHold(role, { yieldsToWatchdog: true })
              .finally(() => router.setHomeBacklog(true));
      try {
        const worker = visitorHold?.adapter ?? (await router.useQueued(role));
        return await attemptOn(worker, { rawCard, card, role, cap, guidance, serverSlot });
      } finally {
        visitorHold?.release();
      }
    };
    const attemptOn = async (
      worker: UnloadableAdapter,
      a: {
        rawCard: CardRecord;
        card: CardRecord;
        role: string;
        cap: number | undefined;
        guidance: string | undefined;
        serverSlot: number | undefined;
      },
    ) => {
      const { rawCard, card, role, cap, guidance, serverSlot } = a;
      if (role === "worker") workerModelId = worker.modelId;
      // The real attempt number (across queue runs), not the round.
      const attemptNo = Math.max(
        nextAttemptNumber(config.repoPath, card.id),
        cardStore.runs.nextAttemptNumber(card.id),
      );
      console.log(`\n=== ${card.id} (attempt ${attemptNo}): ${card.title} ===`);
      // What earlier attempts learned reaches this one through the card's
      // dossier (lessons, answers, reviews, send-backs), read by the runner.
      // C5 (models rule 20e): while a card runs the Worker has work, so its
      // absences count against its floor of each rolling hour.
      router.setHomeBacklog(true);
      await refreshPlan(router, cardStore).catch(() => undefined);
      const result = await executeCard(ctx, rawCard, worker, guidance, {
        attempt: attemptNo,
        signal: queueStop.signal,
        ...(cap ? { maxSteps: cap } : {}),
        ...(serverSlot !== undefined ? { serverSlot } : {}),
        // Models rule 20e, C8: each step is admitted at the drain barrier.
        beginStep: () => router.beginStep(role),
        // RG-P8-1: a passing card waits in Verify for its AI review.
        reviewFirst: (id) => reviewFlow.decide(id),
      });
      await refreshPlan(router, cardStore).catch(() => undefined);
      if (result.passed) {
        const passedCard = { card, diff: result.evidence.diff ?? "" };
        passedResults.push(passedCard);
        // Rule 20e (C6): its review is queued now; `decide()` batches the Review model's visits.
        await reviewFlow.afterRun(card.id);
      }
      for (const st of result.lessons.struggles) {
        const code = /\b(TS\d{4}|lint\/[\w/]+)\b/.exec(st.text)?.[1];
        if (!code || !remedyFor(code, st.text))
          unexplained.push({ cardId: card.id, text: st.text });
      }

      let accepted = false;
      if (result.passed && autoAccept && !result.held) {
        // RG-P8-2: the AI review runs before the merge, and its findings stay
        // on the card when it merges. --auto-accept is the harness's verdict,
        // not a person's: the ledger must not credit a human with the merge.
        // While it waits the Worker has no card (C5): the tour may come now.
        if (reviewFlow.role.state === "filled") router.setHomeBacklog(undefined);
        const sha = await acceptAfterReview(reviewFlow, { cardStore }, card.id, (reviewed) =>
          acceptCard(
            // DS-N3-1: the project documents follow the accept.
            { ...ctx, eventLog: log },
            reviewed,
            "harness",
            autoRun ? { autoRun } : {},
          ),
        );
        if (sha) {
          accepted = true;
          console.log(`   accepted -> main ${sha.slice(0, 10)}`);
        } else if (reviewFlow.reviewFailed(card.id)) {
          console.log("   not merged: its AI review could not run, so it waits in Review for you");
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
    // with their reason — declared, named or imported per the source index
    // (K15, B5, PM-N8-1, -2): an edge that would close a cycle is refused and reported.
    for (const s of await recordDependencies(cardStore, ready, {
      index: createSourceIndex(config.repoPath),
    })) {
      console.log(`   dependency ${s.cardId} -> ${s.dependsOnId} skipped: ${s.why}`);
    }
    /** Prerequisites not done yet, from the dependency table. */
    const blockedBy = async (card: CardRecord): Promise<string[]> => cardStore.waitingOn(card.id);
    const deferred: CardRecord[] = [];
    // RUN-35: at most N cards at once (N the qualified slots on a team server,
    // one on a single-user install), each under its own slot lease.
    const slots = new SlotPool(
      config.repoPath,
      qualifiedSlotCapacity({
        mode: effectiveConfig(config.repoPath, argv).config.team.mode,
        parallelSlots: qualifiedSlots,
      }),
    );

    /** Run every runnable card; defer those whose prerequisites have not merged. */
    const pass = async (cards: CardRecord[], n: number, plans?: Map<string, string>) => {
      // C5, C1 (models rule 20e): while the pass has cards the Worker has work,
      // so other queues wait for their threshold or cap, and its absences count.
      router.setHomeBacklog(true);
      try {
        await passCards(cards, n, plans);
      } finally {
        router.setHomeBacklog(undefined);
      }
    };
    const passCards = async (cards: CardRecord[], n: number, plans?: Map<string, string>) => {
      // Fair share per person, the per-person cap and aging (RUN-34, TEAM-30),
      // with the planner's order breaking ties.
      const fair = effectiveConfig(config.repoPath, argv).config;
      for await (const queued of fairOrder(cards, {
        db,
        cardStore,
        cap: fair.queue.agentIssuesPerPerson,
        maxWaitS: fair.scheduler.maxWaitS,
        fairShare: fair.scheduler.fairShare,
        sinceSeq: queueSinceSeq,
      })) {
        if (halted) break;
        // MD-N2-4: at the watchdog's high stage, one card at a time.
        await pressure.beforeNextCard(slots);
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
        // MD-N3-1: an unattended round (overnight, the daemon) starts only an
        // urgent card while the machine is reserved, read now from the ledger
        // and the reserved hours, so a reserve-now mid-round takes effect.
        if (!refusal && process.env.SEKHEMET_OVERNIGHT_ROUND === "1") {
          refusal = unattendedStartRefusal(card, {
            unattended: true,
            reservedNow: (await reservationNow(log)).reserved,
            inReservedHours: isReserved(
              parseHours(effectiveConfig(config.repoPath, argv).config.machine.hours),
              new Date(),
            ),
          });
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
              `\n--- ${card.id} is a research spike; start the queue with --researcher to run it ---`,
            );
            continue;
          }
          // It loads the Researcher's model: no Worker card may be mid-step.
          await slots.drain();
          console.log(`\n=== ${card.id} (research): ${card.title} ===`);
          const { web } = await researchSources(config.repoPath, { log });
          // Models rule 20e: one queued request for the card's questions, held
          // until it ends. The Worker waits meanwhile (the pass runs it alone).
          const researcher = router.queuedModel("researcher");
          router.setHomeBacklog(undefined);
          const service = new ResearchService({
            repoPath: config.repoPath,
            web,
            cardStore,
            log,
            model: researcher.model,
          });
          const r = await runResearchCard(
            card,
            (q, cardId) => service.ask(q, { deep: true, cardId }),
            cardStore,
            config.repoPath,
            boardService,
          )
            .catch((err) => {
              console.log(
                `   research failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return undefined;
            })
            .finally(async () => {
              await researcher.release();
              router.setHomeBacklog(true);
            });
          if (r)
            console.log(
              `   ${r.passed ? "cited note ready for review" : "on hold: not settled"}: ${r.notePath}`,
            );
          continue;
        }
        // RUN-35: an escalated card runs on another model, so it runs alone.
        const alone = routeFor(card, n) !== "worker";
        if (alone) await slots.drain();
        // Its own slot lease; a card whose files a running card declared waits.
        const claim = await slots.claim(card);
        if ("waiting" in claim) {
          console.log(`\n--- ${card.id} ${claim.waiting}: deferred ---`);
          if (!deferred.some((d) => d.id === card.id)) deferred.push(card);
          continue;
        }
        slots.start(card.id, claim, async () => {
          const result = await attempt(card, n, plans?.get(card.id), claim.slot);
          // A parked card (repair rung 4, vacuous tests) waits for a person; it
          // is not re-planned automatically.
          if (!result.passed && !result.parked) failed.push({ card, result });
        });
        await (alone ? slots.drain() : slots.whileFull());
      }
      await slots.drain();
    };

    // Measurement rule 16d, MS-NM14-3: a calibration night runs the policy as
    // designed, recording its protocol before the first load and checking
    // DEC-42's host limits before each; it unloads everything at its end.
    let calibration: { end: () => Promise<{ hostRefusals: string[] }> } | undefined;
    const runQueuePass = async (): Promise<void> => {
      try {
        if (swapMode.mode === "calibration") {
          const night = await beginCalibrationNight(router, {
            record: (e) => {
              log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
            },
            runnerHolder: () => measurementHolder(readMeasurementMarker(config.repoPath)),
            host: () =>
              calibrationHostReading({
                swapUsedBytes: readSwapUsedBytes() ?? 0,
                freeBytes: freemem(),
                totalBytes: totalmem(),
                warmedBytes: router.warmedBytes(),
              }),
            models: [
              ...new Set(
                [workerModel ?? defaultWorkerName(), pmModelName, researcherModel, reviewerModel]
                  .filter((m): m is string => Boolean(m))
                  .map((m) => weightsKey(m)),
              ),
            ],
            probes: router.headroomOn
              ? ["read_probe", "drive_check", "headroom"]
              : ["read_probe", "drive_check"],
          });
          if ("refused" in night) {
            console.error(night.refused);
            process.exitCode = 1;
            halted = true;
          } else {
            calibration = night;
            console.log("Calibration night: the policy runs as designed; every load is recorded.");
          }
        }
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

          // Researcher batch, before any plan (NEW-design-stage-5): one load, up
          // to four cards with an unexplained struggle, failing cards first. Each
          // is asked with its spec, criteria, scope files, the failing gate's
          // typed failure and the detected stack (DS-N5-1); the answer is stored
          // whole on the card's dossier (DS-N5-3) and goes to the plan's author
          // (DS-N5-2).
          const researched = new Map<string, RepairResearch>();
          if (askResearcher && unexplained.length > 0) {
            const struggles = unexplained.splice(0, unexplained.length);
            const byCard = new Map<string, string[]>();
            for (const u of struggles)
              byCard.set(u.cardId, [...(byCard.get(u.cardId) ?? []), u.text]);
            const failing = toRepair.flatMap(({ card, result }) =>
              byCard.has(card.id)
                ? [
                    {
                      card,
                      failures: result.replan?.failures ?? result.evidence.failures,
                      struggle: (byCard.get(card.id) ?? []).join("\n"),
                    },
                  ]
                : [],
            );
            const passedStruggles: FailingCard[] = [];
            for (const [cardId, texts] of byCard) {
              if (failing.some((f) => f.card.id === cardId)) continue;
              const struggled = await cardStore.getCard(cardId);
              if (struggled)
                passedStruggles.push({ card: struggled, failures: [], struggle: texts.join("\n") });
            }
            const chosen = [...failing, ...passedStruggles].slice(0, 4);
            // Struggles not asked about this round wait for the next.
            unexplained.push(
              ...struggles.filter((u) => !chosen.some((c) => c.card.id === u.cardId)),
            );
            const { web } = await researchSources(config.repoPath, { log });
            // Models rule 20e: the batch is one queued request, held until it ends.
            const researcher = router.queuedModel("researcher");
            const service = new ResearchService({
              repoPath: config.repoPath,
              web,
              cardStore,
              log,
              model: researcher.model,
            });
            try {
              // The question carries the card and the gate's output: asked
              // only of a Researcher on this machine (DS-N5-1).
              const answers = await researchBeforeRepair(config.repoPath, chosen, (q, cardId) =>
                service.ask(q, { cardId, localOnly: true }),
              );
              for (const c of chosen) {
                const r = answers.get(c.card.id);
                if (!r) continue;
                researched.set(c.card.id, r);
                const rule = await ctx.learning.propose({
                  role: "worker",
                  text: r.answer.slice(0, 500),
                  // CX-N4-1: scoped to the struggle's error code and the card's kind.
                  scope: researchRuleScope(c.card, c.struggle ?? ""),
                  source: "research",
                  // The struggle is the executed signal; the Researcher's answer
                  // is a synthesis (MS-T8-9). The candidate waits for a person:
                  // probation is off (O15, MS-T8-15).
                  evidence: [
                    {
                      cardId: c.card.id,
                      note: c.struggle ?? "",
                      source: "gate",
                      verified: "execution",
                    },
                    {
                      cardId: c.card.id,
                      note: `Researcher, sources: ${r.sources.join("; ")}`,
                      source: "researcher",
                      verified: "none",
                    },
                  ],
                });
                if (rule) console.log(`   Researcher proposed a candidate rule for ${c.card.id}`);
              }
            } finally {
              await researcher.release();
            }
          }

          // Manager batch: plans (the research is now in the playbook), answers.
          // Models rule 20e: one queued request, held for the batch.
          const managerHold = await router.submitHold("manager");
          const manager = managerHold.adapter;
          const plans = new Map<string, string>();
          try {
            for (const { card, result } of toRepair) {
              console.log(`\n--- manager reviewing ${card.id} ---`);
              const research = researched.get(card.id);
              if (research) {
                console.log(
                  `   researched first: ${plural(research.sources.length, "source")}, on the issue's dossier`,
                );
              }
              // A rung-3 re-plan request carries the Worker's own account of the
              // standing failures; otherwise the evidence's failures.
              const plan = await planRepair(manager, {
                card,
                stopReason: result.replan
                  ? `${result.stopReason}: ${result.replan.summary}`
                  : result.stopReason,
                failures: result.replan?.failures ?? result.evidence.failures,
                files: collectCardFiles(result.worktreePath, card),
                // DS-N5-2: what the Researcher found goes to the Planner whole.
                ...(research ? { research } : {}),
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
          } finally {
            managerHold.release();
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
          // Models rule 20e: reflection and consolidation are one queued request,
          // held for both; the reviews still queued join the same tour (C2).
          const managerHold = await router.submitHold("manager");
          try {
            const manager = managerHold.adapter;
            const learned = await reflectWithManager(manager, ctx.learning, reflections).catch(
              () => 0,
            );
            if (learned > 0)
              console.log(`\n--- Seshat proposed ${plural(learned, "rule")} from this run ---`);
            const c = await consolidateWithManager(manager, ctx.learning).catch(() => undefined);
            if (c && c.merged + c.contradictions + c.duplicates > 0) {
              console.log(
                `--- Seshat consolidated rules: ${c.merged} merged, ${plural(c.contradictions, "contradiction")} flagged, ${plural(c.duplicates, "duplicate")} retired ---`,
              );
            }
          } finally {
            managerHold.release();
          }
          await answerPm(undefined, true).catch(() => undefined);
        }
        // The reviews queued as cards passed (C6): the rest are served now,
        // when `decide()` next lets the Reviewer visit (C7 may make them wait).
        // A halted run (memory pressure, a stop) does not wait for them.
        if (!halted) await reviewFlow.drain();
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
        presence.stop();
        if (calibration) {
          const night = await calibration.end().catch(() => ({ hostRefusals: [] as string[] }));
          for (const why of night.hostRefusals) console.log(`   ${why}`);
        }
        await router.releaseAll();
        releaseLease();
      }
    };
    // Rule 20b: a measurement run (the frozen suite, a bake-off) bypasses C9
    // and C10 and unloads its models when it ends, even when it fails.
    await (swapMode.mode === "measurement" ? router.measurementRun(runQueuePass) : runQueuePass());

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
      `\nScorecard: Pass@1 ${firstTry}/${cardIds.length} (${(report.passAt1 * 100).toFixed(0)}%), after escalation ${eventually}/${cardIds.length}, ${plural(router.swapCount, "model swap")}, ${(report.totalDurationMs / 60000).toFixed(1)} min`,
    );
    console.log(`Report: ${path}`);
    // The run report goes to Slack when the user connected it; a no-op otherwise.
    await notifySlack(
      config.repoPath,
      log,
      "run_report",
      `Run finished: ${firstTry}/${cardIds.length} issues passed on the first try, ${eventually}/${cardIds.length} after a Planning model retry, in ${(report.totalDurationMs / 60000).toFixed(1)} min.`,
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

  printHelp();
}

/** The eight commands a user meets (design: "The command surface"). */
function printHelp(): void {
  const width = Math.max(...PRIMARY_COMMANDS.map((c) => c.usage.length)) + 2;
  console.log(
    "Sekhemet — a local coding harness that builds projects one checked issue at a time.\n",
  );
  for (const c of PRIMARY_COMMANDS) console.log(`  ${c.usage.padEnd(width)}${c.what}`);
  console.log("\nEverything else: sekhemet dev --help");
}

/** Every other command, for whoever develops the harness itself. */
function printDevHelp(): void {
  const lines: [string, string][] = [
    ["board [--terminal]", "The board (the bare `sekhemet` opens it; --terminal for text)"],
    ["take-over", "Take over an unfinished project: trust, recon, then what runs"],
    [
      "project list [--json] | project move <id> <path> [--yes]",
      "The workspace's projects; record that a project's repository moved",
    ],
    [
      "take-over --approve TOP-<n> [--project <id>]",
      "Approve a take-over plan: its issues are planned",
    ],
    [
      "trust [--yes] | trust --approve <file>",
      "Trust this repository; approve another agent's config file",
    ],
    ["plan <spec>", "Decompose a spec into issues without running them"],
    [
      "depth [<type>] [--project <id>]",
      "Show the project's Type, or choose one (Prototype, Internal tool, Production, Regulated)",
    ],
    ["queue [--worker m] [--manager m]", "Run Ready issues"],
    ["gate [issue]", "Run the checks"],
    ["gates init", "Write the checks template for this project's language"],
    ["replay <issue>", "Replay an issue's trajectory from the log"],
    ["abort <issue>", "Stop a running issue before its next step"],
    ["rewind <issue> <n> / fork <issue> <n>", "Back to, or branch from, step n"],
    ["log", "The Activity log and its hash chain"],
    [
      "backup <path> / restore <path>",
      "Back the Activity log up; restore it, re-applying erasures",
    ],
    ["export --ledger [--no-private]", "The Activity log as NDJSON a verifier checks alone"],
    ["erase --secret --rotated", "Erase a secret found after the fact (stdin or --secret-file)"],
    ['research "<q>" [--deep]', "Ask the Research model directly"],
    [
      "research-bakeoff [--models a,b] [--pipelines native,tool-loop] [--adopt] | --adopt-from <run>",
      "Compare Research models on the research golden set; adopt one only when the comparison allows it",
    ],
    ["overnight [--until 07:00]", "Queue rounds while the machine is free"],
    ["bake-off --workers a,b", "Compare Coding models on a release's checks"],
    ["serve / ui", "The web dashboard server"],
    ["mcp / acp", "Stdio servers for editors"],
    ["calibrate / tune / explore / daemon / traces / init", "Machine and runtime tooling"],
    [`${DEV_COMMANDS.join(" / ")}`, "Planning model, evaluation and sync tooling"],
    // T4: the registry's dev entries (surface item 17), each in this screen only.
    ...COMMAND_REGISTRY.filter((c) => c.visibility === "dev").map((c): [string, string] => [
      c.usage,
      c.what,
    ]),
  ];
  console.log("sekhemet dev <command> — harness development. These also run without `dev`.\n");
  for (const [u, w] of lines) console.log(`  ${u}\n      ${w}`);
  console.log(`\n${CRAWL4AI_CREDIT}`);
}

/** Where the next `board` opens and whether a browser may be opened (surface items 5b, 7). */
let homePage: "board" | "configuration" = "board";

/**
 * `sekhemet` with nothing after it is the product (surface items 5–8, P10):
 * on first run — no `.sekhemet/config.toml` — the one first run of
 * `first_run.ts`; then the board, or the Configuration page while no
 * role's weights are found (item 5b). `--yes` never opens a browser.
 */
async function openHome(flags: string[]): Promise<void> {
  const { repoPath } = parseCliArgs(flags);
  const modelsDir = flags.includes("--models-dir")
    ? flags[flags.indexOf("--models-dir") + 1]
    : undefined;
  const findRoleWeights = await roleWeightsFinder(modelsDir);
  const yes = flags.includes("--yes");
  // Surface item 8a: a folder of a workspace's project is no first run
  // (SUR-73); a locator its ledger does not confirm is refused (SUR-80); a
  // repository whose history carries `Ledger-Head` trailers belongs to a
  // workspace already, so its first run is refused unless --new-workspace (SUR-79).
  const found = resolveWorkspace(repoPath);
  if (found.kind === "refused") return refuseWorkspace(found.message);
  const firstRun =
    found.kind === "first-run" && !existsSync(join(repoPath, ".sekhemet", "config.toml"));
  if (firstRun && !flags.includes("--new-workspace")) {
    const refusal = belongsElsewhere(repoPath);
    if (refusal) {
      console.error(`sekhemet: ${refusal}`);
      process.exitCode = 1;
      return;
    }
  }
  if (firstRun) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const out = await runFirstRun(repoPath, {
      findRoleWeights,
      yes,
      interactive,
      ...firstRunPrompts(),
    });
    if (out.code !== 0) {
      process.exitCode = out.code;
      return;
    }
    homePage = out.opens ?? "board";
  } else {
    homePage = await homeDestination(findRoleWeights);
  }
  return main(["board", ...flags]);
}

type TriageRoute = Extract<
  ReturnType<typeof routeFrontDoor>,
  { kind: "send-back" | "park" | "unpark" | "reopen" | "reject" | "revert" }
>;

/** The board's decisions, from the command line (triage.ts is shared with it). */
async function runTriage(route: TriageRoute, repoPath: string): Promise<void> {
  const { db, log, cardStore, boardService } = initLocalKernel(repoPath);
  const ctx = { repoPath, cardStore, boardService, log };
  try {
    const card = await cardStore.getCard(route.cardId);
    if (!card) {
      console.error(`sekhemet: no issue ${route.cardId}`);
      process.exitCode = 1;
      return;
    }
    if (route.kind === "send-back") {
      if (!route.reason.trim()) {
        console.error(
          `sekhemet: requesting changes needs a reason — it is what the Agent is told next.\n  sekhemet request-changes ${card.id} "<what to change>"`,
        );
        process.exitCode = 2;
        return;
      }
      await sendBack(ctx, card, route.reason);
      console.log(`${card.id} is back in To do. Its next attempt is told: ${route.reason}`);
    } else if (route.kind === "park") {
      await park(ctx, card, route.reason);
      console.log(`${card.id} is on hold. Undo: sekhemet unpark ${card.id}`);
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
      // SEC-03, surface rule 16: the reversal verbs share the dashboard's
      // who-may-accept rule — the card's project's Accept rule, as `accept` reads it.
      const { acceptHolders } = acceptRuleFor(db, log, cardStore, card, repoPath);
      const sha = await revertAccept(ctx, card, route.reason, undefined, acceptHolders).catch(
        (err: unknown) => {
          if (err instanceof AcceptRefusedError) {
            console.error(`sekhemet: ${err.message}`);
            process.exitCode = 1;
            return undefined;
          }
          throw err;
        },
      );
      if (sha === undefined) return;
      console.log(
        `${card.id}'s accept is reverted (${sha.slice(0, 10)} on ${integrationBranch(repoPath)}); the issue is back in Ready.`,
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
      console.error(`sekhemet: no issue ${route.cardId}`);
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

/** One line's answer on the terminal. */
async function askLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The first run's questions at a terminal: yes/no, where Enter is yes, and,
 * in an empty directory, the sentence of what to build (DS-P2-4), raw.
 */
export function firstRunPrompts(): {
  ask: (question: string) => Promise<boolean>;
  askText: (question: string) => Promise<string>;
} {
  return {
    ask: async (q) => {
      const answer = (await askLine(q)).trim();
      return answer === "" || /^y(es)?$/i.test(answer);
    },
    askText: askLine,
  };
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
  // SUR-57: `--debug` is taken off the command line before any parser reads
  // it; an error nothing handled — in a command or the server it runs — is
  // one plain line, a redacted report, the children stopped and exit 1.
  const debug = takeDebugFlag(process.argv);
  const errorContext = () => ({
    debug,
    version: harnessVersion(),
    argv: process.argv.slice(2),
    // Resolved only when a report is written; it may throw, and then the
    // one line still prints (G4, SUR-57).
    userDir,
    // Surface item 20c: under --json, stdout's object carries the same line.
    onFatalLine: jsonFatal,
  });
  installProcessErrorHandlers(errorContext);
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
  // SUR-14: an error a command throws is reported as SUR-57 says and exits
  // 1 — once the event loop drains, or shortly after if a server or timer
  // would hold it open.
  main().catch((err: unknown) => {
    reportFatal(err, "command", safeContext(errorContext));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  });
}
