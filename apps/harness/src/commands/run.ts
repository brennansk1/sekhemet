import type { RunProfile } from "@sekhemet/eval";
import { gateStartProblems, loadGatesConfig, summarizeEvidence } from "@sekhemet/gates";
import { describeOverride } from "@sekhemet/models";
import { projectRootOf } from "../card_root.js";
import { runExitCode } from "../cli_commands.js";
import { cardStepCap, configOverrideLines, defaultWorkerName } from "../config_apply.js";
import { executeCard, runLspPool } from "../execute.js";
import { LearningStore } from "../learning/store.js";
import { applyProfileSwitches, profileForRun } from "../measure_cmd.js";
import { ModelAccess, roleModelName } from "../model_access.js";
import { setupFor } from "../planner_live.js";
import { gateWorker } from "../qualify.js";
import {
  REVIEW_WAIT,
  familyOf,
  learnedFrom,
  recordNotReviewed,
  releaseUnreviewed,
  resolveReviewerRole,
  reviewAndRelease,
} from "../review_flow.js";
import { acquireRunnerLease, leaseRefusal } from "../runner_lease.js";
import { describeSupervisorStart, supervisorStart } from "../supervisor.js";
import { Access } from "../team/access.js";
import { agentRefusalFor } from "../team/ai_teammates.js";
import { PressureControls, createCardWatchdog, workerFloorRefusal } from "../watchdog_actions.js";
import { modelRegistry } from "../wave2.js";
import { type CliExit, type RunResult, baseResult, issueRef } from "./cli_result.js";
import { findProject, setProjectRunning } from "./project_pause.js";
import type { CommandHandler } from "./registry.js";

/**
 * SUR-12: a derived test gate that cannot start (its script missing or
 * wrong, its program absent) stops the run before any card or model,
 * naming the file to edit; the lines to print, or none.
 */
export function gateStartStop(repoPath: string): string[] {
  return gateStartProblems(loadGatesConfig(repoPath), repoPath).map(
    (p) => `The ${p.gate} check cannot start: ${p.reason}. Edit ${p.file}; no issue was run.`,
  );
}

/**
 * `sekhemet run <issue>` and `sekhemet resume <issue>` (surface items 13,
 * 18): run one issue on the Coding model, or continue one that stopped
 * part-way — the runner restarts from its last checkpoint with the steps
 * replayed from the log (H17). Exit 0 when the issue reached Review or Done,
 * 1 when it stopped without passing (SUR-16). Moved from `main` into the
 * registry unchanged (T4); `--json` prints the outcome as one object
 * (NEW-surface-10), the progress going to stderr.
 */
export const runCommand: CommandHandler = async (args, env) => {
  const argv = env.argv;
  const cardId = args.positionals[0] as string;
  const { log, db, cardStore, boardService } = await env.kernel("write");
  // `resume <project>` resumes a paused project (RUN-48), as `pause` pauses one.
  if (env.command === "resume" && findProject(cardStore, cardId)) {
    return setProjectRunning(cardStore, "resume", cardId);
  }
  const stopped = (exitCode: CliExit, lines: string[], extra: Partial<RunResult> = {}) => {
    for (const line of lines) console.error(line);
    return { ...baseResult("run", exitCode, lines.join(" ")), ...extra };
  };
  const card = await cardStore.getCard(cardId);
  if (!card) return stopped(1, [`sekhemet: no issue ${cardId}`]);
  // Runtime item 2a, SUR-75: the card runs in its own project's root,
  // wherever in the workspace the command was started.
  const cardRoot = projectRootOf(cardStore, card) ?? env.repoPath;
  // SUR-12: a derived test gate that cannot start stops the run, naming the file.
  const cannotStart = gateStartStop(cardRoot);
  if (cannotStart.length) return stopped(1, cannotStart, { issue: issueRef(card) });

  // One recorded RunProfile (measurement MS-M9-4/5): resolved once from the
  // settings file, the experiment switches and the flags, written into the
  // card's evidence, and the switches the card runs with are read from it.
  let runProfile: RunProfile;
  try {
    runProfile = profileForRun(argv, process.env);
    applyProfileSwitches(runProfile);
  } catch (err) {
    return stopped(2, [err instanceof Error ? err.message : String(err)], {
      issue: issueRef(card),
    });
  }

  // One runner at a time (runtime item 3, RUN-3): a second is refused
  // naming the holder, and runs nothing.
  const leased = acquireRunnerLease(env.repoPath, { kind: "run", cardId });
  if ("holder" in leased)
    return stopped(1, [leaseRefusal(leased.holder)], { issue: issueRef(card) });
  const releaseRunLease = leased.release;
  // The supervisor's start-up pass (items 10, 33, 34), as `queue` makes it:
  // under the lease, before the card is read again to run.
  for (const line of describeSupervisorStart(
    await supervisorStart({ repoPath: env.repoPath, cardStore, log, boardService }),
  )) {
    console.log(line);
  }
  const swept = await cardStore.getCard(cardId);
  if (swept) Object.assign(card, swept);
  console.log(`\nRunning issue ${cardId}: "${card.title}"`);
  console.log(`Scope: [${card.scopeFiles.join(", ") || "unrestricted"}]`);
  console.log(`Budget: ${card.stepBudget} steps\n`);
  // SUR-40: the card's layer of the configuration, between the project's
  // and the command line's, shown and applied.
  const overrideLines = configOverrideLines(card.configOverrides);
  if (overrideLines.length) console.log(`Issue config overrides: ${overrideLines.join(", ")}`);
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
  const workerFlag = args.values.worker;
  const workerName =
    typeof workerFlag === "string" ? workerFlag.replace(/^ollama\//, "") : undefined;
  // Through the roster, as `qualify` and the queue build it, so the three
  // agree on the combination (B2.2 confirmation): one registry, read once.
  const registry = modelRegistry();
  // MD-N10-3: no --worker runs the person's assigned Worker, else the default;
  // MD-N9-4: its model comes from the scheduler (nothing loads here).
  const access = ModelAccess.forQueues(
    [
      {
        queue: "worker",
        role: "worker",
        name: roleModelName("worker", workerName, { registry }) ?? defaultWorkerName(),
      },
    ],
    { registry, ledger: log },
  );
  const model = access.adapterFor("worker");
  console.log(`Coding model: ${model.modelId}`);
  // review-git RG-P8-1, -10: the AI review reads the change before Review,
  // on a Review model outside the Coding model's family, or says why not.
  const runReviewer = resolveReviewerRole({
    reviewer: roleModelName("reviewer", undefined, { registry }),
    planner: roleModelName("planner", undefined, { registry }),
    worker: model.modelId,
    familyOf: (m) => familyOf(m, registry),
  });
  // MD-N8-1: the Worker runs cards only once its exact combination (engine,
  // model build, host, settings) has qualified on this host. Nothing loads.
  // Rule 27, MD-N4-4: a person's override runs the failed combination, and
  // every bundle and card/repro of this run says so (the adapter is marked).
  const gate = gateWorker(
    registry,
    model,
    roleModelName("worker", workerName, { registry }) ?? model.modelId,
  );
  if (gate.refusal) {
    releaseRunLease();
    return stopped(1, [gate.refusal], { issue: issueRef(card), model: model.modelId });
  }
  if (gate.override)
    console.log(`Coding model ${model.modelId}: ${describeOverride(gate.override)}`);
  // MD-N2-3: below the overnight throughput floor `run` refuses, as the queue does.
  const floorRefusal = workerFloorRefusal(model.modelId);
  if (floorRefusal) {
    releaseRunLease();
    return stopped(1, [floorRefusal], { issue: issueRef(card), model: model.modelId });
  }
  // MD-N2-2: the memory watchdog runs for the card's duration; at critical
  // no new step starts (the runner checks it before every turn).
  const pressure = new PressureControls({
    adapters: () => [model],
    lspPool: () => runLspPool(),
    // The one path to a model releases it too (minor 6).
    releaseModels: () => access.releaseAll(),
    log: (line) => console.log(`   ${line}`),
  });
  // MD-N9-3: the Worker loads only once its footprint is shown to fit.
  await access.measure();
  try {
    // Kept synchronous (`acquire`): `run` owns this scheduler and serves one
    // card on one model; no other queue exists for `decide()` to weigh.
    await access.use("worker");
  } catch (err) {
    releaseRunLease();
    return stopped(1, [err instanceof Error ? err.message : String(err)], {
      issue: issueRef(card),
      model: model.modelId,
    });
  }
  const cardWatchdog = createCardWatchdog(pressure, {
    log: (line) => console.log(`   ${line}`),
  });
  // TEAM-16: in the Team setup the Agent stops if its person may no longer start it here.
  const runAccess =
    setupFor(env.repoPath) === "team"
      ? new Access({ db, setup: "team", localPrincipal: () => log.localPrincipal() })
      : undefined;
  const ctx = {
    repoPath: cardRoot,
    workspaceFolder: env.workspaceFolder,
    restrictedMode: env.restrictedMode,
    cardStore,
    boardService,
    runProfile,
    watchdog: cardWatchdog.watchdog,
    ...(runAccess ? { agentRefusal: agentRefusalFor(runAccess, cardStore) } : {}),
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
      // Models rule 20e: each step is a step boundary on the scheduler.
      beginStep: () => access.beginStep("worker"),
      reviewFirst: async (id) => {
        if (runReviewer.state === "filled") return REVIEW_WAIT;
        await recordNotReviewed(ctx, id, runReviewer.reason).catch(() => undefined);
        return undefined;
      },
    });
  } finally {
    process.off("SIGINT", onSigint);
    cardWatchdog.stop();
    // Release the weights on every exit path, including a crash mid-card:
    // a resident 13GB checkpoint left behind by a failed run is how the host
    // ran out of memory overnight.
    await access.releaseAll();
    releaseRunLease();
  }

  // RG-P8-1: the Coding model has left; the Review model reads the change,
  // then the issue moves to Review. `run` owns this scheduler, so it loads
  // the Review model directly (`use`), as it loaded the Coding model.
  const waiting = await cardStore.getCard(cardId);
  if (
    runReviewer.state === "filled" &&
    waiting?.status === "verify" &&
    waiting.blockedReason === REVIEW_WAIT
  ) {
    console.log(`AI review on ${runReviewer.model}...`);
    access.ensureQueue({
      queue: runReviewer.queue,
      role: runReviewer.queue === "reviewer" ? "reviewer" : "planner",
      name: runReviewer.model,
    });
    try {
      await access.measure();
      const reviewer = await access.use(runReviewer.queue);
      const review = await reviewAndRelease(
        ctx,
        cardId,
        reviewer,
        await learnedFrom(new LearningStore(log)),
      );
      if (review) console.log(`${review.coverage}`);
    } catch (err) {
      await releaseUnreviewed(ctx, cardId, err);
    } finally {
      await access.releaseAll();
    }
    if (result.passed)
      result = {
        ...result,
        finalStatus: (await cardStore.getCard(cardId))?.status ?? result.finalStatus,
      };
  }

  console.log(`\n${summarizeEvidence(result.evidence)}\n`);
  const message = result.passed
    ? `Issue ${cardId}: all checks passed; moved to Review for a person's acceptance.`
    : `Issue ${cardId} stopped: ${result.stopReason}. Left in ${result.finalStatus} for inspection.`;
  console.log(message);

  // SUR-16: scripts read the card's outcome from the exit status.
  const after = (await cardStore.getCard(cardId)) ?? card;
  return {
    ...baseResult("run", runExitCode(result.finalStatus), message),
    issue: issueRef({ ...after, status: result.finalStatus }),
    passed: result.passed,
    stopReason: String(result.stopReason),
    steps: { used: result.evidence.turnsUsed ?? 0, budget: card.stepBudget },
    checks: (result.evidence.rungResults ?? []).map((r) => ({
      name: r.gate,
      passed: r.passed,
      ...(r.skipped ? { skipped: true } : {}),
      ...(r.unavailable ? { unavailable: true } : {}),
    })),
    model: model.modelId,
  };
};
