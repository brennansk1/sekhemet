#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BoardServiceImpl } from "@sekhemet/board";
import { type SuiteRunResult, runScore } from "@sekhemet/eval";
import {
  DeterministicGateRunner,
  type PipelineResult,
  declaredStage,
  generateGateHostCerts,
  loadGatesConfig,
  npmRegistry,
  runGatePipeline,
  startGateHost,
  verificationRungs,
} from "@sekhemet/gates";
import { CardStore, DEFAULT_STEP_BUDGET, EventLog, initSchema } from "@sekhemet/kernel";
import {
  ModelRegistry,
  NAIL_WORKER_PROFILE,
  defaultRegistryPath,
  describeOverride,
  resolveWorkerModelId,
} from "@sekhemet/models";
import { DESIGN_COPY, resolvePlannerModel } from "@sekhemet/planner";
import {
  ProcessSandbox,
  confinedSandbox,
  mergeNetworkConfigs,
  policyFetch,
} from "@sekhemet/sandbox";
import { hardenGitForProcess, rememberRepoAsGiven, resolvedPath } from "@sekhemet/sync";
import { plural } from "@sekhemet/ui";
import { AcceptRefusedError, integrationBranch } from "./accept.js";
import { runAcpStdio } from "./acp.js";
import { isAirgapped, mirrorRegistry } from "./airgap.js";
import { bakeOffTaskPlan } from "./bakeoff_tasks.js";
import { watchBoardHooks } from "./board_hooks.js";
import { parseModelList, promptNeedFromLedgers, runCalibrate, runMtpAb } from "./calibrate_cmd.js";
import {
  baselineInput,
  gateBaseBranch,
  lastToolApplied,
  verifyCardWorktree,
} from "./card_gates.js";
import {
  COMMANDS,
  type FrontDoorRoute,
  PRIMARY_COMMANDS,
  firstWord,
  routeFrontDoor,
  wantsJson,
} from "./cli_commands.js";
import { handBack, postCardMessage, requestPause, takeOver } from "./collaborate.js";
import { acceptRuleFor } from "./commands/accept.js";
import { setHomePage } from "./commands/board.js";
import {
  type CliCommandName,
  type CliExit,
  type CliResult,
  baseResult,
  enterJsonMode,
  jsonFatal,
  printJsonResult,
} from "./commands/cli_result.js";
import { devHelpRows, helpFor, helpLines } from "./commands/help_table.js";
import { setProjectRunning } from "./commands/project_pause.js";
import {
  type CommandEnv,
  type CommandSpec,
  findCommand,
  flagsTakenBy,
  parseCommandArgs,
} from "./commands/registry.js";
import { configParseRefusal, resolveConfig, userConfigPath } from "./config.js";
import {
  defaultWorkerName,
  effectiveConfig,
  networkConfigs,
  queueDefaults,
  reviewLimit,
} from "./config_apply.js";
import { configRenamesDue, upgradeConfigKeys } from "./config_upgrade.js";
import { rotateLog } from "./daemon.js";
import { egressEvent } from "./egress_event.js";
import {
  ensureRepoProject,
  executeCard,
  forkCard,
  plannerDifficulty,
  requestAbort,
  rewindCard,
} from "./execute.js";
import {
  homeDestination,
  offerWorkspaceRestore,
  roleWeightsFinder,
  runFirstRun,
} from "./first_run.js";
import { deriveGates, runInit } from "./init.js";
import { applyExploration, exploreProject } from "./learning/explore.js";
import { LearningStore } from "./learning/store.js";
import {
  LEDGER_COMMANDS,
  checkLedgerAnchor,
  ledgerCommand,
  ledgerHeadTrailers,
  openLocalLedger,
} from "./ledger_cmds.js";
import { cardBranchHead, ledgerEvidenceSummary } from "./ledger_evidence.js";
import { effectiveLogLevel, installLogLevels } from "./log_levels.js";
import { runMcpStdioServer } from "./mcp.js";
import { McpHub, loadMcpConfig, plannerToolsOf } from "./mcp_client.js";
import { readMeasurementMarker } from "./measure_cmd.js";
import {
  ModelAccess,
  describeModel,
  resolveWorkerName,
  roleModelName,
  workerZone3Fit,
} from "./model_access.js";
import { nightModelServer, runOvernight } from "./overnight.js";
import { DEFAULT_PM_MODEL, pmModelFor } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import {
  installProcessErrorHandlers,
  reportFatal,
  safeContext,
  takeDebugFlag,
} from "./process_errors.js";
import { runPromptScreen } from "./prompt_screen_cmd.js";
import { gateWorker } from "./qualify.js";
import { diffTrajectories, formatDiff, formatTrajectory, trajectories } from "./replay.js";
import { CRAWL4AI_CREDIT, runResearchCommand } from "./research/cli.js";
import type { PlanResearcherBatch } from "./research/packet.js";
import { deepPriorArtFor, planResearch, planResearcher } from "./research/plan_research.js";
import { oneShotResearcher } from "./research/service.js";
import { runResearchBakeoffCommand } from "./research_bakeoff.js";
import { parseUntil, releaseMachine, reserveMachine } from "./reservation.js";
import { LEASE_TOKEN_ENV, acquireRunnerLease, leaseRefusal } from "./runner_lease.js";
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js";
import { awakeReport } from "./sleep_assertion.js";
import { bakeOffOnSuitePath } from "./suite_path.js";
import {
  automaticBackup,
  describeSupervisorStart,
  removeWorktreesOnClose,
  supervisorStart,
} from "./supervisor.js";
import { configWriter, recordConfigWrite } from "./team/config_audit.js";
import { identityRoot } from "./team/credential_store.js";
import { newSetupTokenCommand, recordSwitchToSolo } from "./team/serve.js";
import { terminalBoardLines } from "./terminal_board.js";
import { tracesCommand } from "./tracing.js";
import { park, reject, reopen, revertAccept, sendBack, unpark } from "./triage.js";
import {
  describeTuning,
  globalTuningPath,
  loadAttempts,
  tuneForRepo,
  writeTuningReport,
} from "./tune.js";
import { migrateLegacyUserDir, userDir, userPaths } from "./user_dir.js";
import { approveBaseline, describeCandidate, visualCandidates } from "./visual_baseline.js";
import {
  DEV_COMMANDS,
  type DevCommand,
  appliedStepBudget,
  applyTunedPolicy,
  childSettings,
  isGreenfield,
  modelRegistry,
  planCommand,
  recordBakeOff,
  runDevCommand,
} from "./wave2.js";
import { showWhatsNew } from "./whats_new.js";
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
    | "uninstall"
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
    : "its workspace is not on this machine: restore its backup (`sekhemet restore --latest`)";
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
/**
 * The commands still in `main` that read a project's ledger (FINDINGS_C1
 * CLI-05): in a folder with no ledger and no workspace they are refused
 * by `refuseNoProject`, as the registry's `needsProject` commands are.
 */
const PROJECT_LEDGER_COMMANDS: ReadonlySet<string> = new Set([
  "replay",
  "log",
  "skills",
  "recurring",
  "depth",
  "export",
  "erase",
  "abort",
  "rewind",
  "fork",
]);
export function readsProjectLedger(command: string, argv: readonly string[]): boolean {
  if (PROJECT_LEDGER_COMMANDS.has(command)) return true;
  // `models list` reads the project's records; `models fetch` and `add` do not need one.
  return command === "models" && argv[argv.indexOf("models") + 1] === "list";
}
function refuseNoProject(folder: string): void {
  console.error(`sekhemet: ${noProjectLine(folder)}`);
  process.exitCode = 2;
}

/**
 * A usage error of a command still dispatched from `main` (surface item 19b,
 * FINDINGS_C1 CLI-04): one line naming what was wrong and the command's
 * synopsis from the help table, exit 2 — as the registry's commands say it.
 */
function usageError(command: string, what: string): void {
  const row = helpFor(command);
  console.error(`sekhemet: ${what}${row ? `: ${row.synopsis}` : ""}`);
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
  // SUR-92 (REL-06): a config.toml that does not parse starts no work.
  if (spec.name === "run" || spec.name === "resume" || spec.name === "queue") {
    const unparsed = configParseRefusal(at.repoPath);
    if (unparsed) return refused(2, unparsed);
  }
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
  /** Settles once every board-lifecycle hook started so far has run and been recorded. */
  hooksIdle: () => Promise<void>;
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
    recordConfigWrite({ db, log, path: userConfig, identityDir: identityRoot() }, () =>
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
  // accepted, had a pull request opened) run after each such ledger event;
  // a command that closes the ledger waits for them first (EXT-9, C5).
  const hooks = watchBoardHooks(log, cardStore, repoPath);

  // RUN-16: a closed card's worktree goes, its branch stays — on every path
  // that closes a card through this kernel.
  removeWorktreesOnClose(repoPath, log, cardStore);
  return { db, log, cardStore, boardService, hooksIdle: hooks.idle };
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
  // SUR-2, SUR-46 (C5): the bare `sekhemet` may be a first run, which writes
  // nothing before the person confirms it — git's identity file included —
  // so its hardening defers that file until `openHome` knows.
  hardenGitForProcess(route.kind === "home" ? { identity: "later" } : {});
  if (route.kind === "help") return printHelp();
  if (route.kind === "dev-help") return printDevHelp();
  if (route.kind === "command-help") {
    // Surface item 19a (CLI-03): every command's own help, from the one table.
    const row = helpFor(route.name);
    if (row) for (const line of helpLines(row)) console.log(line);
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
    // The queue takes only its own flags: the plan's (--planner, --offline) stay the plan's.
    return main(["queue", ...flagsTakenBy(findCommand("queue") as CommandSpec, route.flags)]);
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

  // FINDINGS_C1 CLI-05 (C5): a command that reads a project's ledger, run in
  // a folder that is none, says so and writes nothing — before its own usage
  // check, and before the kernel opens (which would create a stray ledger
  // that makes the folder look like a project).
  // As `gate` runs where the folder declares gates.toml (CLI-06), `skills`
  // acts where it declares the team's skills (`.sekhemet/skills/`, committed).
  if (
    workspace.firstRun &&
    readsProjectLedger(config.command, argv) &&
    !(config.command === "skills" && existsSync(join(config.repoPath, ".sekhemet", "skills")))
  ) {
    return refuseNoProject(config.repoPath);
  }

  if (config.command === "traces") {
    // `sekhemet traces [--since-hours N] [--out f.json] [--otlp http://host:4318]` (H22).
    process.exitCode = await tracesCommand(config.repoPath, argv.slice(argv.indexOf("traces") + 1));
    return;
  }

  if ((LEDGER_COMMANDS as readonly string[]).includes(config.command)) {
    // `sekhemet dev export`, `sekhemet erase` (kernel NEW-kernel-7,
    // runtime NEW-runtime-8, security NEW-security-7).
    process.exitCode = await ledgerCommand(
      config.command as (typeof LEDGER_COMMANDS)[number],
      argv,
      config.repoPath,
    );
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
      if (repos.length === 0) return usageError("calibrate", "--mtp-ab needs --from <repo>,…");
      const maxSteps = Number(flag("--max-steps")) || undefined;
      const thinking = flag("--thinking");
      if (thinking !== undefined && !["off", "surgical", "all"].includes(thinking))
        return usageError("calibrate", "--thinking takes off, surgical or all");
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
    if (!path || path.startsWith("-"))
      return usageError("models", "models add needs the path of a .gguf file");
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
    // SUR-92 (REL-06): a config.toml that does not parse starts no work
    // (the queue's own refusal is `runRegistered`'s).
    const unparsed = configParseRefusal(config.repoPath);
    if (unparsed) {
      console.error(`sekhemet: ${unparsed}`);
      process.exitCode = 2;
      return;
    }
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
    // RUN-66: said once for the night when nothing can keep the machine awake.
    await nightLease.awake.settled;
    if (!nightLease.awake.held) console.log(awakeReport(nightLease.awake));
    // The supervisor's start-up pass under the night's lease, before M0 and
    // the first round (items 10, 33, 34); each round's queue makes its own.
    for (const line of describeSupervisorStart(
      await supervisorStart(
        { repoPath: config.repoPath, cardStore, log, boardService },
        // RUN-59: the night's start writes the day's backup when it is due.
        { backup: { db } },
      ),
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
    // RUN-59: the end of every overnight writes a backup, due or not.
    const nightBackup = await automaticBackup({
      workspaceFolder: workspace.workspaceFolder,
      db,
      log,
      kind: "overnight",
    });
    if (nightBackup) console.log(nightBackup);
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
      if (!file || !agentConfigFiles(config.repoPath).includes(file))
        return usageError(
          "trust",
          `--approve takes one of this repository's agent config files (${agentConfigFiles(config.repoPath).join(", ") || "none here"})`,
        );
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
      // SUR-51 (C5): a server that answers but has not Seshat's model, in its words.
      whyNotServed: async () => {
        const health = await describeModel(DEFAULT_PM_MODEL, "planner", {
          registry: modelRegistry(),
        }).healthCheck?.();
        return health && !health.ok && health.reachable ? health.detail : undefined;
      },
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
    // Surface item 21a, SUR-91: started by `daemon start`, the server's console
    // is daemon.log, each line with its time and level, below the level unwritten.
    if (process.env.SEKHEMET_DAEMON_LOG) {
      installLogLevels(
        effectiveLogLevel(resolveConfig({ repoPath: config.repoPath }).config.log.level),
      );
    }
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
    // MD-N17-3: the address it bound, which may not be the port asked for.
    console.log(`   ${server.address}`);
    console.log(" Press Ctrl+C to stop.");
    console.log("=================================================\n");
    // RUN-59: the day's first serve writes the automatic backup.
    const served = await automaticBackup({
      workspaceFolder: workspace.workspaceFolder,
      db,
      log,
    });
    if (served) console.log(served);
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
        identityDir: identityRoot(),
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
    // DS-N9-16: the research packet's questions go in the same load.
    const researcherLoad: PlanResearcherBatch = async (q) => {
      await planAccess?.release("plan").catch(() => undefined);
      return planResearcher({
        repoPath: config.repoPath,
        log,
        cardStore,
        model: researcherName as string,
      })(q);
    };
    const deep = deepPriorArtFor({
      repoPath: config.repoPath,
      allowed: research !== undefined,
      offline,
      researcher: researcherName,
      ask: async (question) => {
        const d = (await researcherLoad({ deep: question, packet: [] })).deep;
        if (!d || "failed" in d) throw new Error(d?.failed ?? "no answer");
        return d;
      },
      batch: researcherLoad,
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
        // CLI-07 (surface item 19c): the details only when asked.
        ...(argv.includes("--verbose") ? { verbose: true } : {}),
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
    if (config.targetArg !== "init")
      return usageError(
        "gates",
        config.targetArg
          ? `no "${config.targetArg}" under sekhemet gates`
          : "sekhemet gates needs init or approve-baseline",
      );
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
    if (!cardId) return usageError("abort", "abort needs an issue ID");
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
    if (!cardId || !Number.isInteger(step) || step < 0)
      return usageError(
        config.command,
        cardId
          ? `${config.command} needs a step number (0 or more) after the issue ID`
          : `${config.command} needs an issue ID and a step number`,
      );
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
    if (!cardId) return usageError("replay", "replay needs an issue ID");
    const flagOf = (name: string) => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    // CLI-04 (surface item 19b, SUR-95): an attempt is a number the issue has,
    // never read as the latest one.
    const attemptArgs = [
      ...(argv.includes("--attempt") ? [flagOf("--attempt")] : []),
      ...(argv.includes("--diff") ? (flagOf("--diff") ?? "").split(",") : []),
    ];
    const notNumber = attemptArgs.find((a) => !a || !/^[1-9]\d*$/.test(a));
    if (notNumber !== undefined)
      return usageError(
        "replay",
        notNumber
          ? `"${notNumber}" is not an attempt number`
          : "--attempt and --diff take attempt numbers",
      );
    if (argv.includes("--diff") && attemptArgs.length !== 2)
      return usageError("replay", "--diff takes two attempt numbers, as 1,2");
    const as = flagOf("--as");
    if (as) {
      const card = await cardStore.getCard(cardId);
      if (!card) {
        console.error(`sekhemet: no issue ${cardId}`);
        process.exitCode = 1;
        return;
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
    const missing = attemptArgs.find((n) => !all.some((t) => String(t.attemptNumber) === n));
    if (missing)
      return usageError(
        "replay",
        `${cardId} has no attempt ${missing} (its attempts: ${all.map((t) => t.attemptNumber).join(", ")})`,
      );
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
  console.log(SUPPORT_LINE);
}

/**
 * Where to get help (W3 G5, FINDINGS_C1 INS-09): the guide, Discussions for
 * questions, Issues for bugs, and a vulnerability reported privately, never
 * in an issue. `.github/SUPPORT.md` and `.github/SECURITY.md` say the same.
 */
const SUPPORT_LINE = [
  "Help: the user guide (docs/guide) and SUPPORT.md at https://github.com/brennansk1/sekhemet",
  "  Questions: GitHub Discussions · Bugs: GitHub Issues, with `sekhemet doctor --report`",
  "  A vulnerability: report it privately, as SECURITY.md says; never in a public issue",
].join("\n");

/**
 * Every other command, for whoever develops the harness itself (rule 14):
 * each on its own line from the one help table (surface item 19a, CLI-03).
 */
function printDevHelp(): void {
  const front = new Set(["run", "review", "accept", "ask", "doctor"]);
  console.log("sekhemet dev <command> — harness development. These also run without `dev`.");
  console.log("`sekhemet <command> --help` shows a command's synopsis and an example.\n");
  for (const [, row] of devHelpRows(front)) console.log(`  ${row.usage}\n      ${row.what}`);
  console.log(`\n${CRAWL4AI_CREDIT}`);
}

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
  // RUN-62: a folder with no ledger that a backup set names is offered its
  // workspace back before anything empty is created.
  if (found.kind === "first-run") {
    const offer = await offerWorkspaceRestore(repoPath, {
      yes,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ...firstRunPrompts(),
    });
    if (offer === "restored") {
      setHomePage(await homeDestination(findRoleWeights));
      return main(["board", ...flags]);
    }
  }
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
    // Confirmed: git's identity-only global config may be written now.
    hardenGitForProcess();
    setHomePage(out.opens ?? "board");
  } else {
    setHomePage(await homeDestination(findRoleWeights));
  }
  return main(["board", ...flags]);
}

type TriageRoute = Extract<
  ReturnType<typeof routeFrontDoor>,
  { kind: "send-back" | "park" | "unpark" | "reopen" | "reject" | "revert" }
>;

/** The board's decisions, from the command line (triage.ts is shared with it). */
async function runTriage(route: TriageRoute, repoPath: string): Promise<void> {
  const { db, log, cardStore, boardService, hooksIdle } = initLocalKernel(repoPath);
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
    // EXT-9 (C5): the move's hooks run and their objections are recorded
    // before the ledger closes; closing first lost them.
    await hooksIdle();
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
  const { db, cardStore, boardService, hooksIdle } = initLocalKernel(repoPath);
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
    // EXT-9 (C5): the move's hooks are recorded before the ledger closes.
    await hooksIdle();
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
  // SUR-68: once after an upgrade, at a terminal, the bundled CHANGELOG's
  // note; never under --json, never for --version, never a network request.
  if (routeFrontDoor(process.argv.slice(2)).kind !== "version")
    showWhatsNew({ json: wantsJson(process.argv.slice(2)) });
  // SUR-14: an error a command throws is reported as SUR-57 says and exits
  // 1 — once the event loop drains, or shortly after if a server or timer
  // would hold it open.
  main().catch((err: unknown) => {
    reportFatal(err, "command", safeContext(errorContext));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  });
}
