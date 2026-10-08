import { freemem, totalmem } from "node:os";
import { type RunProfile, profileArgs } from "@sekhemet/eval";
import { createSourceIndex } from "@sekhemet/gates";
import { remedyFor } from "@sekhemet/gates";
import { type CardRecord, STOP_REASONS } from "@sekhemet/kernel";
import { planRepair } from "@sekhemet/loop";
import {
  PrefixCacheMonitor,
  ThroughputMeter,
  type UnloadableAdapter,
  type WorkerOverride,
  describeOverride,
  escalationWindow,
  measureThroughput,
  readSwapUsedBytes,
} from "@sekhemet/models";
import { plural } from "@sekhemet/ui";
import { enableAutoAccept } from "../accept.js";
import { resolveVisionModel, visionPrePass } from "../attachments.js";
import { cardStepCap, defaultWorkerName, effectiveConfig, queueDefaults } from "../config_apply.js";
import { DiskLowError } from "../disk_space.js";
import {
  type QueueEntry,
  type QueueReport,
  QueuedWorkerQuestions,
  acceptCard,
  closeRunLspPool,
  collectCardFiles,
  ensureRepoProject,
  executeCard,
  nextAttemptNumber,
  queueEntryOf,
  queueHaltReason,
  recordDependencies,
  recordQueueProgress,
  recordQueueReport,
  recordQueueStarted,
  runLspPool,
} from "../execute.js";
import {
  externalReviewerFor,
  reviewPosterFromEnv,
  runExternalReviews,
} from "../external_review.js";
import { runDependencyVerifications } from "../github_sync.js";
import { notifySlack } from "../integrations.js";
import { applyExploration } from "../learning/explore.js";
import { consolidateWithManager, reflectWithManager } from "../learning/reflect.js";
import { LearningStore } from "../learning/store.js";
import {
  applyProfileSwitches,
  autoAcceptRefusal,
  measurementHolder,
  profileForQueue,
  readMeasurementMarker,
  withoutProfileFlags,
} from "../measure_cmd.js";
import {
  ModelAccess,
  type QueueSpec,
  describeModel,
  roleModelName,
  weightsKey,
} from "../model_access.js";
import { sendPush, startNotifier } from "../notify.js";
import { setupFor } from "../planner_live.js";
import { audienceFromAccess } from "../pm/audience.js";
import { WORKER_QUESTION_COPY } from "../pm/pm_copy.js";
import { DEFAULT_PM_MODEL, answerQueued, dailyStandup } from "../pm/service.js";
import { PmStore } from "../pm/store.js";
import { seshatWait } from "../pm/while_worker.js";
import { applyWorkerOverride, gateWorker, verifiedQueueRoles } from "../qualify.js";
import { isResearchCard, runResearchCard } from "../research/cards.js";
import type {} from "../research/packet.js";
import { type FailingCard, type RepairResearch, researchBeforeRepair } from "../research/repair.js";
import { ResearchService, researchSources } from "../research/service.js";
import { mayStartCard, reservationNow, unattendedStartRefusal } from "../reservation.js";
import {
  ReviewFlow,
  acceptAfterReview,
  familyOf,
  learnedFrom,
  resolveReviewerRole,
} from "../review_flow.js";
import { candidateRuleFromEnv, researchRuleScope } from "../rule_scopes.js";
import { type LiveLeaseInfo, acquireRunnerLease, leaseRefusal } from "../runner_lease.js";
import { isReserved, parseHours } from "../scheduler.js";
import { awakeReport, sleptNote, startRunClock } from "../sleep_assertion.js";
import { qualifiedSlotCapacity } from "../slot_lease.js";
import { SlotPool } from "../slot_pool.js";
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
} from "../smart_swap.js";
import { describeSupervisorStart, supervisorStart } from "../supervisor.js";
import { Access } from "../team/access.js";
import { agentRefusalFor, runnableByTheirPeople } from "../team/ai_teammates.js";
import { fairOrder } from "../team/fair_queue.js";
import { hookEngineFor } from "../user_hooks.js";
import { PressureControls, createCardWatchdog } from "../watchdog_actions.js";
import {
  appliedStepBudget,
  modelRegistry,
  queuePrelude,
  replanOnRung3,
  roleForCard,
} from "../wave2.js";
import type { CliExit } from "./cli_result.js";
import type { CommandHandler } from "./registry.js";
import { gateStartStop } from "./run.js";

/**
 * `sekhemet queue` (and `sekhemet run` with no issue): run every Ready issue
 * in board order, moved into the command registry from `main` in C5
 * (surface items 17 and 19a, strangler fig; the body is `main`'s, unchanged
 * but for where the workspace, the ledger and the command line come from).
 */
export const queueCommand: CommandHandler = async (_args, env) => {
  // The queue edits its own command line (the profile's flags stand in for
  // the ones given), so it works on a copy.
  const argv = [...env.argv];
  const config = { repoPath: env.repoPath, restrictedMode: env.restrictedMode };
  const workspace = {
    workspaceFolder: env.workspaceFolder,
    ...(env.projectId ? { projectId: env.projectId } : {}),
  };
  const { db, log, cardStore, boardService } = await env.kernel("write");
  // The repository is a project (K14), as `env.kernel("write")` recorded it.
  const project = await ensureRepoProject(cardStore, config.repoPath).catch(() => undefined);
  const body = async (): Promise<void> => {
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
      // MD-N10-3 (C5): the person's assignment stands before config.toml's
      // executor — the profile's config layer carried the executor, whose
      // `--worker` then outranked the assignment.
      const configuredDefaults = queueDefaults(effectiveConfig(config.repoPath, argv).config, []);
      const assignedWorker = roleModelName("worker", undefined, { registry: modelRegistry() });
      queueProfile = profileForQueue(
        argv,
        process.env,
        { ...configuredDefaults, ...(assignedWorker ? { worker: assignedWorker } : {}) },
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
    // RUN-66, RUN-67: what keeps the machine awake, said once; and the run's
    // two clocks, so a sleep is reported rather than charged.
    const runClock = startRunClock();
    // A tool refused its assertion exits at once: not "kept awake" (RUN-66).
    await queueLease.awake.settled;
    const awake = awakeReport(queueLease.awake);
    if (!queueLease.awake.held) console.log(awake);
    // The supervisor's start (items 10, 33, 34): reap what a killed runner
    // left, sweep crashed attempts back to Ready, and prune by retention as a
    // recorded erasure — before the Ready cards are read.
    const startPass = await supervisorStart(
      { repoPath: config.repoPath, cardStore, log, boardService },
      // RUN-59: the day's first queue writes the automatic backup (an
      // overnight round's queue too; its night already wrote today's).
      { backup: { db } },
    );
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
          systemPrompt: WORKER_QUESTION_COPY.system,
          prompt: WORKER_QUESTION_COPY.prompt(
            card?.title ?? cardId,
            card?.spec ?? "(none)",
            (card?.acceptanceCriteria ?? []).join("; "),
            question,
          ),
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
      // MD-N2-4: the high stage's masking request reaches the runner.
      pressure,
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
    /** RUN-69: why the round ended before a card started, for the run report. */
    let diskLow: string | undefined;

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
      let result: Awaited<ReturnType<typeof executeCard>>;
      try {
        result = await executeCard(ctx, rawCard, worker, guidance, {
          attempt: attemptNo,
          signal: queueStop.signal,
          ...(cap ? { maxSteps: cap } : {}),
          ...(serverSlot !== undefined ? { serverSlot } : {}),
          // Models rule 20e, C8: each step is admitted at the drain barrier.
          beginStep: () => router.beginStep(role),
          // RG-P8-1: a passing card waits in Verify for its AI review.
          reviewFirst: (id) => reviewFlow.decide(id),
        });
      } catch (err) {
        // RUN-69, RUN-83: a volume below the free-space floor: the card did
        // not start (it stays Ready, `machine/disk_low` names the volume) and
        // the round ends with no further card.
        if (!(err instanceof DiskLowError)) throw err;
        console.log(`\n--- ${rawCard.id} not started: ${err.message} ---`);
        console.log("   queue halted: the disk is nearly full");
        halted = true;
        diskLow = err.message;
        return undefined;
      }
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
      // Memory pressure, and the machine's stops (WL-N11-2, WL-N12-2): the
      // round ends and no further card starts.
      const halt = queueHaltReason(result.stopReason);
      if (halt) {
        console.log(`   queue halted: ${halt}`);
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
          // MD-N9-3 (C5): a load refused for memory keeps its work queued,
          // and nothing in this pass would start it: the card stops instead.
          const researcher = servedOrRefused(router, "researcher");
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
          // RUN-69: not started for space; the round is over.
          if (!result) return;
          // A parked card (repair rung 4, vacuous tests) waits for a person; it
          // is not re-planned automatically. The machine's stops are not the
          // Worker's to repair (WL-N11-2, WL-N12-2).
          if (!result.passed && !result.parked && !STOP_REASONS[result.stopReason].holdsInReady)
            failed.push({ card, result });
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
            // Models rule 20e: the batch is one queued request, held until it
            // ends; a load refused for memory ends the wait (MD-N9-3).
            const researcher = servedOrRefused(router, "researcher");
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
        // WL-N7-4: the run's language servers stop with it.
        await closeRunLspPool();
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
    const slept = sleptNote(runClock.sleptMs());
    if (slept) console.log(`\nDuring this run ${slept}.`);
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
      machine: {
        awake,
        ...(slept ? { slept } : {}),
        ...(diskLow ? { diskLow } : {}),
      },
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
  };
  await body();
  return (process.exitCode ?? 0) as CliExit;
};

/** A load refused for memory (MD-N9-3): a research stop reads it as the model being unavailable. */
class LoadRefusedError extends Error {
  public readonly code = "MODEL_LOAD_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "LoadRefusedError";
  }
}

/**
 * A queued request for a queue's model, held until released — or, when the
 * scheduler refuses its load for memory (MD-N9-3: the footprint above usable
 * memory, or unknown), a rejection naming the refusal, so the caller's
 * error path runs and the pass goes on to its report rather than waiting
 * for a load nothing in this pass will start (C5, finding MD-N9-3). The
 * request itself stays queued, as the rule says; if it is ever served, its
 * hold is given straight back.
 */
function servedOrRefused(
  router: ModelAccess,
  queue: string,
): { model: () => Promise<UnloadableAdapter>; release: () => Promise<void> } {
  const held = router.queuedModel(queue);
  let refused = false;
  return {
    model: async () => {
      const served = held.model();
      let timer: NodeJS.Timeout | undefined;
      const refusal = new Promise<never>((_, reject) => {
        const look = () => {
          const why = router.refusal(queue);
          if (why) {
            refused = true;
            reject(new LoadRefusedError(why));
          } else timer = setTimeout(look, 250);
        };
        look();
      });
      try {
        return await Promise.race([served, refusal]);
      } finally {
        clearTimeout(timer);
      }
    },
    release: async () => {
      if (refused) void held.release();
      else await held.release();
    },
  };
}
