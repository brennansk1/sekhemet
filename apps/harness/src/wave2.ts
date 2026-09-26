import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import { readSkillLock, revokeSkill, skillProtectedWrites } from "@sekhemet/context";
import {
  BudgetPolicyStore,
  LearningGuard,
  type SuiteRunResult,
  type TaskHistory,
  type Trajectory,
  bakeOffEvidence,
  checkSkillCandidate,
  distillSkill,
  mineToolProposals,
  namesAModel,
  playbookDiagnostics,
  siftSlice,
  validateToolProposal,
  writeToolCandidate,
} from "@sekhemet/eval";
import { loadGatesConfig } from "@sekhemet/gates";
import {
  type CardRecord,
  type CardStore,
  type EventLog,
  defaultSecondsBudget,
  parseToml,
} from "@sekhemet/kernel";
import {
  type AssignedRole,
  AssignmentRefusal,
  type BakeOffEvidence,
  type CandidateSettings,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  ModelRegistry,
  NAIL_WORKER_PROFILE,
  QUALIFICATION_BAR,
  type QualificationCombination,
  assignRole,
  currentAssignment,
  describeCombination,
  describeOverride,
  fillReviewerDefault,
  hostFingerprintHash,
  planWorkWindow,
  qualifyModel,
  restoreRole,
  scheduleNow,
  thinkingPolicyFromEnv,
  withMeasurementRun,
} from "@sekhemet/models";
import {
  DEFAULT_TIER_BUDGET,
  DecisionStore,
  GoalStore,
  type PlannerLedger,
  type PlannerTools,
  SpidrFeaturePlanner,
  approveGoal,
  briefBaseline,
  ceremoniesDue,
  codebaseMapFromRepo,
  computeSignals,
  defaultRequirementProject,
  designStage,
  formatPlanReport,
  intakeGoal,
  loadCalibrationLog,
  loadPrioritizationConfig,
  loggedAssumptions,
  orderReadyCards,
  persistPlan,
  processProfileFromConfig,
  rankGoals,
  recordAssumptionOutcome,
  renderBrief,
  triggeredResponses,
} from "@sekhemet/planner";
import { type ProcessSandbox, runConfined, runTrusted } from "@sekhemet/sandbox";
import { gitEnvFor, planRelease, publishRelease, runActGate } from "@sekhemet/sync";
import { airgapSkillApproval, approveVerifiedSkill } from "./airgap.js";
import { effectiveConfig, queueDefaults } from "./config_apply.js";
import { pendingM0, recordM0Pending } from "./m0_path.js";
import { resolvedWorkerWindowTokens } from "./model_access.js";
import { approveCommand, planningInputs, upgradeCommand } from "./plan_approval.js";
import {
  type Setup,
  evaluateGoals,
  gatedReplan,
  plannedEpics,
  postReplan,
  respondToSignals,
  setupFor,
} from "./planner_live.js";
import {
  type CombinationDeps,
  qualificationCombination,
  qualificationRefusal,
  speculativeProbe,
} from "./qualify.js";
import {
  type ReuseDeps,
  type ReuseFinding,
  dossierNote,
  priorArtLines,
  reuseSurvey,
  withPriorArt,
} from "./research/reuse.js";
import { workerFloorRefusal } from "./watchdog_actions.js";
import { loadRepoSkills, skillsLockPath } from "./workspace_trust.js";

/**
 * Production wiring for the planner, eval and sync APIs (wave 2, Builder C):
 * `sekhemet plan`, the queue's per-pass planning hooks and the commands
 * `goal`, `decide`, `m0`, `qualify`, `improve`, `skills`, `release`, `ci`.
 * Kept in one module so the large CLI entry file only grows by call sites.
 */
export interface Kernel {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
  /** The harness's board; every status change goes through it (kernel K-S4-3). */
  boardService?: Pick<BoardService, "transitionCard">;
}

const ledgerOf = (k: Kernel): PlannerLedger => ({
  store: k.cardStore,
  log: k.log,
  ...(k.boardService ? { board: k.boardService } : {}),
});

function readConfigToml(repoPath: string) {
  const p = join(repoPath, ".sekhemet", "config.toml");
  if (!existsSync(p)) return undefined;
  try {
    return parseToml(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** A planner grounded in this repository and its calibration history (P1, P15). */
export async function repoPlanner(
  k: Kernel,
  adapter?: LocalInferenceAdapter,
): Promise<SpidrFeaturePlanner> {
  return new SpidrFeaturePlanner({
    codebaseMap: codebaseMapFromRepo(k.repoPath),
    calibration: await loadCalibrationLog(ledgerOf(k)),
    ...(adapter ? { adapter } : {}),
  });
}

/** No tracked source yet: a project that does not exist. */
/** The separate things a spec asks for, as the design stage split them. */
function needsOf(buildSpec: string): string[] {
  return buildSpec
    .split(/,\s*/)
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** A card built from a need carries the need's opening words in its title. */
function coversNeed(title: string, need: string): boolean {
  const head = need.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
  return title.toLowerCase().includes(head);
}

/** What a PM would say having looked: the best candidate per need, briefly. */
function reuseSummary(findings: readonly ReuseFinding[]): string[] {
  const lines: string[] = [];
  const unreachable = [...new Set(findings.flatMap((f) => f.unsearched))];
  for (const f of findings) {
    const lib = f.libraries[0];
    const repo = f.repos[0];
    if (lib)
      lines.push(`  ${f.need}: ${lib.name} (${lib.license}) may already cover this — ${lib.url}`);
    else if (repo)
      lines.push(
        `  ${f.need}: ${repo.fullName} (${repo.license}) is worth reading first — ${repo.url}`,
      );
    if (f.papers[0])
      lines.push(`  ${f.need}: the literature has ${f.papers[0].title} — ${f.papers[0].url}`);
  }
  const out = lines.length
    ? [
        "Before planning, I looked for what already exists. Worth checking before writing it:",
        ...lines,
        "Each card is told about the options for its part; licences are checked.",
      ]
    : unreachable.length === 0
      ? [
          "I looked for existing packages and repositories and found nothing that fits better than writing it.",
        ]
      : [];
  if (unreachable.length) {
    out.push(
      `I could not reach ${unreachable.join(" or ")}, so I have not checked whether this already exists there.`,
    );
  }
  return out;
}

/** No source file in git yet: a new project (design-stage S8 asks there). */
export function isGreenfield(repoPath: string): boolean {
  try {
    const files = execFileSync("git", ["ls-files"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !files.split("\n").some((f) => /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb)$/.test(f));
  } catch {
    return true;
  }
}

function tryGateIds(repoPath: string): string[] {
  try {
    return loadGatesConfig(repoPath).gates.map((g) => g.id);
  } catch {
    return [];
  }
}

/**
 * `sekhemet plan "<spec>"` (P1, P2, P4-P9, P15, P24, P25, P7, defect 6):
 * decompose against the real codebase map, then persist every story with
 * its whole contract, INVEST enforced, the batched decision parked.
 */
export async function planCommand(
  k: Kernel,
  spec: string,
  options: {
    sketcher?: LocalInferenceAdapter;
    /** An approved MCP server's tools for the Planner (EXT-20). */
    plannerTools?: PlannerTools;
    print?: (line: string) => void;
    /** Where to look for what already exists; omitted, nothing is searched. */
    research?: ReuseDeps;
    /** The resolved Worker's window; omitted, read from the registry (PM-13). */
    workerWindowTokens?: number;
  } = {},
): Promise<{ epicId: string; created: number; decisionId?: string }> {
  const print = options.print ?? ((l: string) => console.log(l));
  // The design stage decides how much conversation this spec deserves, says
  // it, and proceeds: quality words become constraints with defaults, not
  // cards, and a spec with money or identity at stake gets a written brief.
  const design = designStage(spec, { greenfield: isGreenfield(k.repoPath) });
  for (const line of design.say) print(line);
  const briefPath = join(k.repoPath, ".sekhemet", "brief.md");
  // Reuse before rebuild: look for what already exists before any card is
  // written, whenever the design stage has anything to say at all.
  const findings =
    options.research && design.proportion !== "none"
      ? await reuseSurvey(needsOf(design.buildSpec), options.research)
      : undefined;
  if (findings) for (const line of reuseSummary(findings)) print(line);
  if (design.proportion === "brief" && !existsSync(briefPath)) {
    // Never over a brief a person has written or edited.
    mkdirSync(dirname(briefPath), { recursive: true });
    const brief = renderBrief(design, { gates: tryGateIds(k.repoPath) });
    writeFileSync(briefPath, findings ? withPriorArt(brief, priorArtLines(findings)) : brief);
  }
  const epicId = `epic_${Date.now().toString(16)}`;
  await k.cardStore.createCard({
    id: epicId,
    tier: "epic",
    title: design.buildSpec,
    // The person's own words: a re-plan starts from them again (PM-P1-8).
    spec,
    status: "in_progress",
  });
  // With a planning model, slices and their behaviours come from it; the
  // heuristics remain the fallback when it is absent or answers badly.
  const planner = await repoPlanner(k, options.sketcher);
  // PM-12..14: INVEST's Small at the resolved Worker's window, as the board checks it.
  const tierBudget = {
    ...DEFAULT_TIER_BUDGET,
    workerWindowTokens:
      options.workerWindowTokens ??
      resolvedWorkerWindowTokens({
        registry: modelRegistry(),
        configured: queueDefaults(effectiveConfig(k.repoPath).config, []).worker,
      }),
  };
  // PM-P13-2: once a person accepted the brief, a story traces to its
  // requirements or is offered as a proposed change — none is derived.
  const requirementProject = await defaultRequirementProject(ledgerOf(k));
  const briefAccepted =
    requirementProject !== undefined &&
    (await briefBaseline(ledgerOf(k), requirementProject)) !== undefined;
  // PM-N3-2, PM-N7: the Worker's measured record and the depth profile.
  const inputs = await planningInputs(k);
  const plan = await planner.decomposeSpec({
    parentId: epicId,
    parentTier: "epic",
    spec: design.buildSpec,
    tierBudget,
    capability: inputs.capability,
    // The riskiest assumption is proven right after the contract.
    ...(design.riskiest ? { riskiest: design.riskiest } : {}),
  });
  const now = new Date().toISOString();
  plan.ambiguity.assumptions.push(
    ...design.assumptions.map((statement, i) => ({
      id: `asm_design_${epicId}_${i}`,
      cardId: epicId,
      category: "vagueness" as const,
      statement,
      basis: "design stage default",
      excerpt: spec.slice(0, 120),
      createdAt: now,
    })),
  );
  if (plan.rejected) {
    print(`The spec is under-specified: ${plan.rejectionReason ?? "too many open questions"}.`);
    for (const f of plan.ambiguity.findings.filter((x) => x.disposition === "ask")) {
      print(`  ? ${f.excerpt}`);
    }
    return { epicId, created: 0 };
  }
  const result = await persistPlan(ledgerOf(k), plan, {
    epicId,
    repoRoot: k.repoPath,
    tierBudget,
    deriveRequirements: !briefAccepted,
    ...inputs,
    ...(options.sketcher ? { sketcher: options.sketcher } : {}),
    ...(options.plannerTools ? { plannerTools: options.plannerTools } : {}),
  });
  print(formatPlanReport(result));
  if (result.created.length > 0) {
    print(`Approve the criteria before any card leaves Planning: sekhemet approve ${epicId}`);
  }
  // Each card is told what already exists for the part it builds.
  for (const story of findings ? result.created : []) {
    const finding = findings?.find((f) => coversNeed(story.title, f.need));
    const note = finding ? dossierNote(finding) : undefined;
    if (note) {
      await k.cardStore
        .recordDossierEntry({ cardId: story.id, kind: "note", text: note, actor: "planner" })
        .catch(() => undefined);
    }
  }
  return {
    epicId,
    created: result.created.length,
    ...(result.decisionId ? { decisionId: result.decisionId } : {}),
  };
}

/**
 * The queue's planning hooks, run before each pass:
 *   P10/P11 decision deadlines; P3 WSJF/RICE order of Ready; P20 the seven
 *   signals and their automatic responses; P16 ceremonies due; P19/P21/P22
 *   the goal loop, the ranked goals; M15 the throughput floor.
 * Returns the Ready cards in the order to run them.
 */
export async function queuePrelude(
  k: Kernel,
  ready: CardRecord[],
  options: {
    workerModelId?: string;
    /**
     * Why the Worker may not run cards (MD-N8-1): its exact combination has
     * not qualified on this host. The caller computes it (`qualificationRefusal`);
     * the pass does not start.
     */
    workerRefusal?: string | undefined;
    reviewWip?: number;
    print?: (line: string) => void;
    now?: Date;
    /** Solo or Team (`[team] mode`); read from the config when absent (PM-N9-9). */
    setup?: Setup;
  } = {},
): Promise<{ ordered: CardRecord[]; lines: string[] }> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    (options.print ?? ((x: string) => console.log(x)))(l);
  };
  const ledger = ledgerOf(k);
  const now = options.now ?? new Date();

  // MD-N8-1: refuse a Worker whose combination has not qualified on this host.
  if (options.workerRefusal) throw new Error(options.workerRefusal);
  // M15: refuse a worker measured below the overnight floor.
  // MD-N2-1: named measured and required rates; read from this host's profile only (MD-N1-3).
  if (options.workerModelId) {
    const floor = workerFloorRefusal(options.workerModelId);
    if (floor) throw new Error(floor);
  }

  for (const d of await new DecisionStore(ledger).sweepDeadlines(now)) {
    say(
      d.state === "default_applied"
        ? `Decision ${d.id}: no answer by the deadline, the safe default was applied.`
        : `Decision ${d.id}: deadline passed, the card stays parked (default_deny).`,
    );
  }

  const cards = await k.cardStore.listCards();
  const events = await k.log.getEventsByTypes([
    "card/status_changed",
    "gate/result",
    "assumption/logged",
    "assumption/outcome",
  ]);
  const setup = options.setup ?? setupFor(k.repoPath);
  const signals = computeSignals({
    now,
    cards,
    events,
    reviewWip: options.reviewWip ?? 3,
    plans: await plannedEpics(k),
  });
  const fired = triggeredResponses(signals);
  for (const s of fired) {
    say(`Signal ${s.id}: ${s.detail} -> ${s.response?.action} (${s.response?.mode})`);
  }
  // Every response is carried out, as a proposal where a person owns the
  // field (NEW-planner-pm-2, -5); held cards sit out this pass.
  const signalled = await respondToSignals(k, fired, { setup, now, say }).catch((err) => {
    say(`Signal responses not carried out: ${err instanceof Error ? err.message : String(err)}`);
    return { held: new Set<string>() };
  });

  const cfg = readConfigToml(k.repoPath);
  const profile = processProfileFromConfig(cfg);
  const closed = cards.filter((c) => c.status === "done").length;
  for (const c of ceremoniesDue(profile, {
    now,
    closedSinceRetro: closed % (profile.retroEveryCards ?? 10 ** 9),
    intakePending: cards.some((c) => c.status === "backlog" && c.tier === "epic"),
  })) {
    say(`Ceremony due (${profile.name}): ${c.kind}, ${c.reason}.`);
  }

  // Goals: re-evaluate every active goal with its metrics, marks and
  // environment (NEW-planner-pm-4), then work the top-ranked one first.
  await evaluateGoals(k, { planner: () => repoPlanner(k), setup, say });
  const ranking = rankGoals(await new GoalStore(ledger).all(), await k.cardStore.listCards());
  const top = ranking[0];
  if (top) say(`Working goal ${top.goalId} first: ${top.why}.`);

  // Y16, INT-12b: advance open Sekhemet PRs (ready once checks pass, the
  // code owners asked to review, auto-merge by policy), on either transport.
  const { advanceOpenPullRequests } = await import("./wave2_github.js");
  for (const p of await advanceOpenPullRequests(k.repoPath, k.cardStore, k.log).catch((err) => {
    say(`PRs not advanced: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  })) {
    say(`PR #${p.number}: ${p.state}`);
  }

  // planner-pm P13: main is checked when it moved, a card whose requirement
  // was revised is held in Planning, and a slice at its appetite stops its
  // cards until the person chooses (PM-P13-4, -9, -11).
  const { projectDonePass } = await import("./project_done.js");
  const doneness = await projectDonePass(k).catch((err) => {
    say(`Requirements not checked: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  for (const l of doneness?.lines ?? []) say(l);
  const schedulable = ready.filter(
    (c) => !signalled.held.has(c.id) && !(doneness?.held.has(c.id) ?? false),
  );

  const ordering = orderReadyCards(schedulable, loadPrioritizationConfig(k.repoPath), now);
  let ordered = batchBySwaps(ordering.cards, now);
  if (ordering.model !== "unconfigured") say(`Ready ordered by ${ordering.model.toUpperCase()}.`);
  if (top) {
    const goal = (await new GoalStore(ledger).get(top.goalId)) as { strategy: string };
    const epic = goal.strategy.split("@")[0];
    ordered = [
      ...ordered.filter((c) => c.parentId === epic),
      ...ordered.filter((c) => c.parentId !== epic),
    ];
  }
  return { ordered, lines };
}

/** P6: the role a card's first attempt runs on, from the planner's route. */
export function roleForCard(
  card: CardRecord,
  attempt: number,
  escalateRetries: boolean,
): "worker" | "escalation" {
  if (card.modelRoute?.executor === "escalation") return "escalation";
  return attempt >= 2 && escalateRetries ? "escalation" : "worker";
}

/** A model's family and the assigned Worker's, as the registry records them (MD-N4-9). */
function familiesFor(
  registry: ModelRegistry,
  host: string,
  modelId: string,
): { model?: string; worker?: string } {
  const model = registry.get(modelId)?.family;
  const workerId = currentAssignment(registry, host, "worker")?.model;
  const worker = workerId ? registry.get(workerId)?.family : undefined;
  return { ...(model ? { model } : {}), ...(worker ? { worker } : {}) };
}

/** The model registry the roster pins templates and arms in (M11). */
export function modelRegistry(): ModelRegistry {
  return new ModelRegistry();
}

// ------------------------------------------------------------------ commands

export type Wave2Command =
  | "airgap"
  | "onboard"
  | "drift"
  | "recurring"
  | "register"
  | "trailers"
  | "fixture"
  | "attach"
  | "goal"
  | "decide"
  | "assume"
  | "m0"
  | "qualify"
  | "improve"
  | "skills"
  | "release"
  | "ci"
  | "measure"
  | "models"
  | "approve"
  | "upgrade";
export const WAVE2_COMMANDS: readonly Wave2Command[] = [
  "airgap",
  "onboard",
  "drift",
  "recurring",
  "register",
  "trailers",
  "fixture",
  "attach",
  "goal",
  "decide",
  "assume",
  "m0",
  "qualify",
  "improve",
  "skills",
  "release",
  "ci",
  "measure",
  "models",
  "approve",
  "upgrade",
];

export interface CommandIO {
  print: (line: string) => void;
  /** Resolve a model name to an adapter (the queue's roster). */
  model?: (name: string) => LocalInferenceAdapter;
  /** How `qualify` reads a combination's elements; tests pass fakes (qualify.ts). */
  combinationDeps?: CombinationDeps;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Run a wave-2 command; returns the exit code. */
export async function runWave2Command(
  command: Wave2Command,
  args: string[],
  k: Kernel,
  io: CommandIO = { print: (l) => console.log(l) },
): Promise<number> {
  const { print } = io;
  const done = (message: string, code: number): number => {
    print(message);
    return code;
  };
  const ledger = ledgerOf(k);
  switch (command) {
    case "airgap": {
      // X10-X14: mirror, model manifest, doc bundles, signed updates, self-test.
      const { airgapCommand } = await import("./airgap.js");
      return airgapCommand(k.repoPath, args, { log: k.log, registry: modelRegistry(), print });
    }
    case "onboard": {
      // `sekhemet onboard [--apply [--yes]] [--models a,b] [--no-baseline]` (X1): the
      // eight steps, the last the onboarding baseline (gates rule 15a).
      const { runOnboard } = await import("./onboard.js");
      const names = (flag(args, "--models") ?? "").split(",").filter(Boolean);
      await runOnboard(k.repoPath, {
        apply: args.includes("--apply"),
        // SUR-7: a different live gates.toml is replaced only with --yes, after its diff.
        confirm: args.includes("--yes"),
        baseline: !args.includes("--no-baseline"),
        store: { log: k.log, cardStore: k.cardStore },
        say: print,
        ...(names.length && io.model
          ? {
              models: names.map((n) => (io.model as (n: string) => LocalInferenceAdapter)(n)),
              registry: modelRegistry(),
              release: async (a: LocalInferenceAdapter) => {
                await (a as { unload?: () => Promise<void> }).unload?.();
              },
            }
          : {}),
      });
      return 0;
    }
    case "drift": {
      // `sekhemet drift [--days 7]` (X2): conventions of recent commits vs onboarding.
      const { postConventionDrift } = await import("./onboard.js");
      const drift = await postConventionDrift(k.repoPath, k.log, Number(flag(args, "--days") ?? 7));
      if (drift.length === 0) return done("No convention drift.", 0);
      for (const d of drift) print(`drift: ${d.aspect}: was ${d.was}, now ${d.now}`);
      return 0;
    }
    case "recurring": {
      // `sekhemet recurring add|list|tick|trigger` (X16): scheduled and recurring cards.
      const { recurringCommand } = await import("./recurring.js");
      const { resolveConfig } = await import("./config.js");
      return recurringCommand(k.repoPath, args, {
        store: k.cardStore,
        ...(k.boardService ? { board: k.boardService } : {}),
        log: k.log,
        hours: resolveConfig({ repoPath: k.repoPath }).config.machine.hours,
        print,
      });
    }
    case "register": {
      // `sekhemet register check | licenses | advance <id> <state> [--threshold t] [--evidence e]`
      // (X17, X18, X20): the provenance, research and licence registers.
      const { advanceResearchEntry, checkRegisters } = await import("./registers.js");
      const { repoLicenseAudit } = await import("./license_gate.js");
      const [sub, id, state] = args;
      if (sub === "check") {
        const problems = checkRegisters(k.repoPath);
        for (const p of problems) print(`problem: ${p}`);
        return done(
          problems.length ? `${problems.length} problem(s).` : "Registers are valid.",
          problems.length ? 1 : 0,
        );
      }
      if (sub === "licenses") {
        const audit = repoLicenseAudit(k.repoPath);
        for (const a of audit)
          print(
            `${a.ok ? "ok  " : "FAIL"} ${a.dep} (${a.license ?? "unknown"}) ${a.why} [${a.manifest}]`,
          );
        return audit.every((a) => a.ok) ? 0 : 1;
      }
      if (sub === "advance" && id && state) {
        const threshold = flag(args, "--threshold");
        const evidence = flag(args, "--evidence");
        const e = advanceResearchEntry(k.repoPath, id, state, {
          ...(threshold ? { threshold } : {}),
          ...(evidence ? { evidence } : {}),
        });
        return done(`${e.id} ${e.technique}: ${e.state}.`, 0);
      }
      return done(
        "Usage: sekhemet register check | licenses | advance <id> <state> [--threshold ...] [--evidence ...]",
        1,
      );
    }
    case "trailers": {
      // `sekhemet trailers [<range>]` (X26): the attribution contract, for CI and people.
      const { checkTrailers } = await import("./trailer_gate.js");
      const bad = checkTrailers(k.repoPath, args[0] ?? "main..HEAD");
      for (const v of bad)
        print(`${v.sha.slice(0, 10)} ${v.subject}: missing ${v.missing.join(", ")}`);
      return bad.length
        ? done(`${bad.length} commit(s) without the attribution trailers.`, 1)
        : done("Every commit carries the attribution trailers.", 0);
    }
    case "fixture": {
      // `sekhemet fixture <typescript|python|rust> <dir> [--bug]` (X21): a miniature repository.
      const { FIXTURE_LANGUAGES, generateFixture } = await import("@sekhemet/eval");
      const [lang, dir] = args;
      if (!lang || !dir || !(FIXTURE_LANGUAGES as readonly string[]).includes(lang))
        return done(`Usage: sekhemet fixture <${FIXTURE_LANGUAGES.join("|")}> <dir> [--bug]`, 1);
      const files = generateFixture(lang as "typescript", dir, { bug: args.includes("--bug") });
      return done(`Wrote a ${lang} fixture (${files.length} files) to ${dir}.`, 0);
    }
    case "attach": {
      // `sekhemet attach <card> <image...>` (X3): screenshots and mockups for a card.
      const { attachImage } = await import("./attachments.js");
      const { readFileSync } = await import("node:fs");
      const [cardId, ...files] = args;
      if (!cardId || files.length === 0) return done("Usage: sekhemet attach <card> <image...>", 1);
      for (const f of files) {
        const a = await attachImage(k.repoPath, k.cardStore, cardId, {
          name: f,
          bytes: readFileSync(f),
        });
        print(`Attached ${a.name} (${a.mime}, ${a.bytes} bytes) to ${cardId}.`);
      }
      return done("The vision model describes them before the card runs.", 0);
    }
    case "goal": {
      // `sekhemet goal "<statement>"` | `goal approve <id>` | `goal status`
      const [sub, ...rest] = args;
      if (sub === "approve") {
        const id = rest[0];
        if (!id) return done("Usage: sekhemet goal approve <goal-id>", 1);
        const { goal, plan } = await approveGoal(ledger, await repoPlanner(k), id);
        print(
          `Goal ${goal.id} is active: strategy ${goal.strategy}, ${plan.created.length} cards.`,
        );
        return 0;
      }
      if (sub === "mark") {
        // `sekhemet goal mark <goal> <criterion> met|unmet` (PM-N4-3): a
        // person's mark of a human criterion, used at the next evaluation.
        const [id, criterion, verdict] = rest;
        if (!id || !criterion || (verdict !== "met" && verdict !== "unmet"))
          return done("Usage: sekhemet goal mark <goal-id> <criterion-id> met|unmet", 1);
        try {
          await new GoalStore(ledger).markHuman(
            id,
            criterion,
            verdict === "met",
            k.log.localPrincipal(),
          );
        } catch (err) {
          return done(err instanceof Error ? err.message : String(err), 1);
        }
        return done(`Marked ${criterion} of ${id} ${verdict}; the next evaluation uses it.`, 0);
      }
      if (sub === "status" || sub === undefined) {
        const goals = await new GoalStore(ledger).all();
        if (goals.length === 0) return done('No goals. Set one with: sekhemet goal "<outcome>"', 0);
        for (const g of goals) {
          print(`${g.id} [${g.state}] ${g.statement}`);
          for (const c of g.criteria)
            print(`   ${c.status === "met" ? "x" : " "} [${c.kind}] ${c.text} (${c.status})`);
          if (g.diagnosis) print(`   ${g.diagnosis}`);
        }
        for (const r of rankGoals(goals, await k.cardStore.listCards()))
          print(`rank: ${r.goalId} ${r.score} (${r.why})`);
        return 0;
      }
      const statement = [sub, ...rest.filter((a) => !a.startsWith("--"))].join(" ");
      const intake = await intakeGoal(ledger, await repoPlanner(k), statement);
      print(intake.restatement);
      if (intake.goal.assumptions.length)
        print(`Assumptions: ${intake.goal.assumptions.join(" ")}`);
      if (intake.unverifiableWarning) print(intake.unverifiableWarning);
      print(
        `Draft ${intake.goal.id} saved. Nothing runs until you approve: sekhemet goal approve ${intake.goal.id}`,
      );
      return 0;
    }
    case "approve":
      // PM-N7-3/4/5: a person approves a plan's criteria (and tests, by profile).
      return approveCommand(k, args, print);
    case "upgrade":
      // PM-N6-4: an upgrade as a tool step, then fix cards from its failing gates.
      return upgradeCommand(k, args, print);
    case "decide": {
      // `sekhemet decide` lists; `sekhemet decide <id> <option-number>` answers.
      const store = new DecisionStore(ledger);
      const [id, opt] = args;
      if (!id) {
        const waiting = await store.waiting();
        if (waiting.length === 0) return done("No decisions waiting.", 0);
        for (const d of waiting) {
          print(`${d.id} (${d.record.cardId ?? "-"}) [${d.state}] ${d.request.question}`);
          d.request.options.forEach((o, i) =>
            print(
              `   ${i + 1}. ${o.label}${i === d.request.recommendation.optionIndex ? " (recommended)" : ""}: ${o.consequence}`,
            ),
          );
        }
        return 0;
      }
      const n = Number(opt);
      if (!Number.isInteger(n) || n < 1)
        return done("Usage: sekhemet decide <id> <option-number>", 1);
      const d = await store.answer(id, n - 1, "human");
      print(
        `Answered ${d.id}: ${d.request.options[n - 1]?.label}. The card resumes on the next queue pass.`,
      );
      return 0;
    }
    case "assume": {
      // `sekhemet assume` lists what the planner decided on the human's behalf;
      // `sekhemet assume keep|override <id> [--answer "..."]` records the verdict (P15).
      //
      // Until something records these, the trust calibration is a table of
      // zeroes and the assume-to-ask shift can never fire, so the planner keeps
      // assuming in a category the human has silently corrected every time.
      const [sub, id] = args;
      if (!sub || sub === "list") {
        const logged = await loggedAssumptions(ledger, flag(args, "--card"));
        if (logged.length === 0) return done("No assumptions logged.", 0);
        const decided = new Set(
          (await k.log.getEventsByTypes(["assumption/outcome"])).map(
            (e) => (e.payload as { assumptionId: string }).assumptionId,
          ),
        );
        for (const a of logged) {
          print(
            `${a.id} (${a.cardId}) [${a.category}]${decided.has(a.id) ? " decided" : ""} ${a.statement}`,
          );
          print(`   basis: ${a.basis}`);
        }
        return 0;
      }
      if ((sub !== "keep" && sub !== "override") || !id) {
        return done("Usage: sekhemet assume [list] | keep <id> | override <id> [--answer ...]", 1);
      }
      const assumption = (await loggedAssumptions(ledger)).find((a) => a.id === id);
      if (!assumption) return done(`No logged assumption ${id}.`, 1);
      const answer = flag(args, "--answer");
      const calibration = await recordAssumptionOutcome(ledger, {
        assumptionId: assumption.id,
        cardId: assumption.cardId,
        category: assumption.category,
        overridden: sub === "override",
        recordedAt: new Date().toISOString(),
        ...(answer ? { humanAnswer: answer } : {}),
      });
      const rate = calibration.calibrationFor(assumption.category);
      print(
        `Recorded ${assumption.id} as ${sub === "override" ? "overridden" : "kept"}. ${assumption.category}: ${rate.overridden}/${rate.observed} overridden, the planner will ${rate.disposition}.`,
      );
      return 0;
    }
    case "m0": {
      // `sekhemet m0 --worker <name> [--runs 3] [--budgets 50,150] [--max-commits 200]`:
      // a person may run it any time; a complete run clears M0 pending (MS-M9-6).
      const worker = flag(args, "--worker");
      if (!worker || !io.model) return done("Usage: sekhemet m0 --worker <model>", 1);
      const { runM0 } = await import("./m0_path.js");
      const { sendPush } = await import("./notify.js");
      const r = await runM0(k, {
        worker,
        adapter: io.model(worker),
        runs: Number(flag(args, "--runs") ?? 3),
        budgets: (flag(args, "--budgets") ?? "50,150").split(",").map(Number),
        maxCommits: Number(flag(args, "--max-commits") ?? 200),
        print,
        notify: async (title, message) => {
          await sendPush(
            k.repoPath,
            { event: "run_report", title, message, priority: 5 },
            { log: k.log },
          );
        },
      });
      return r === "no tasks" ? 1 : 0;
    }
    case "models": {
      // `sekhemet models assign <role> <model> [--baseline | --default --bake-off <event>]`
      // and `sekhemet models restore <role>` (models rule 30a, NEW-models-10):
      // a person assigns any model qualified here for the role; the recorded
      // baseline and the shipped defaults change only with a recorded
      // overnight bake-off on this host; every change is restorable in one step.
      const [sub, roleArg, modelArg] = args;
      const roles: AssignedRole[] = ["worker", "planner", "reviewer", "researcher"];
      const role = roles.find((r) => r === roleArg);
      const scope = args.includes("--baseline")
        ? "baseline"
        : args.includes("--default")
          ? "default"
          : "personal";
      const registry = modelRegistry();
      const host = (io.combinationDeps?.host ?? hostFingerprintHash)();
      const principal = k.cardStore.localPrincipal();
      if (sub === "list") {
        // MD-N4-9: the Reviewer default, or unfilled when no other family qualified here.
        const worker = currentAssignment(registry, host, "worker")?.model;
        fillReviewerDefault(registry, host, worker ? registry.get(worker)?.family : "qwen");
        for (const r of roles) {
          const a = currentAssignment(registry, host, r);
          const b = currentAssignment(registry, host, r, "baseline");
          print(
            `${r}: ${a ? `${a.model} (${a.scope}, ${a.by}, ${a.date.slice(0, 10)})` : "unassigned"}${b ? `; baseline ${b.model}` : ""}`,
          );
        }
        return 0;
      }
      if (sub === "restore" && role) {
        try {
          const r = restoreRole(registry, host, role, { by: "person", scope });
          await k.log.append({
            actor: "human",
            principal,
            type: "models/restored",
            payload: {
              role,
              model: r.assignment.model,
              scope,
              ...(r.replaced ? { replaced: r.replaced.model } : {}),
            },
          });
          return done(
            `${role}: restored ${r.assignment.model}${r.replaced ? ` (replacing ${r.replaced.model})` : ""}.`,
            0,
          );
        } catch (err) {
          if (err instanceof AssignmentRefusal) return done(err.message, 1);
          throw err;
        }
      }
      if (sub !== "assign" || !role || !modelArg || modelArg.startsWith("--") || !io.model) {
        return done(
          "Usage: sekhemet models assign <worker|planner|reviewer|researcher> <model> [--baseline | --default --bake-off <event id>] | models restore <role> | models list",
          2,
        );
      }
      const adapter = (io.model as (n: string) => LocalInferenceAdapter)(modelArg);
      const combination = qualificationCombination(adapter, { ...io.combinationDeps, registry });
      const look = registry.lookupQualification(adapter.modelId, combination);
      // MD-N10-1: the bake-off is a recorded `measure/benchmarked` event.
      const bakeOffId = flag(args, "--bake-off");
      let bakeOff: BakeOffEvidence | undefined;
      if (bakeOffId) {
        const found = (await k.log.getEventsByTypes(["measure/benchmarked"])).find(
          (e) => e.id === bakeOffId,
        );
        const p = found?.payload as { tier?: string; host?: string } | undefined;
        if (!found || !p) return done(`No recorded benchmark ${bakeOffId} on this ledger.`, 1);
        // A finished overnight role on its full set is the evidence; anything
        // else (a quick screen, a partial night) is refused by assignRole.
        bakeOff = bakeOffEvidence(found, role) ?? {
          id: found.id,
          host: String(p.host ?? ""),
          role,
          model: "",
          tier: p.tier === "overnight" ? "overnight" : "quick",
          evaluationSet: "",
          date: found.createdAt,
        };
      }
      try {
        const r = assignRole(registry, {
          role,
          model: adapter.modelId,
          scope,
          by: "person",
          host,
          qualification: look.status,
          ...(bakeOff ? { bakeOff } : {}),
          // MD-N4-9: families as the registry records them.
          families: familiesFor(registry, host, adapter.modelId),
        });
        await k.log.append({
          actor: "human",
          principal,
          type: "models/assigned",
          payload: {
            role,
            model: r.assignment.model,
            scope,
            qualification: look.status,
            ...(r.previous ? { previous: r.previous.model } : {}),
            ...(bakeOff ? { bakeOff: bakeOff.id } : {}),
          },
        });
        return done(
          `${role}: ${r.assignment.model} assigned (${scope})${r.previous ? `, replacing ${r.previous.model}; restore it with: sekhemet models restore ${role}${scope === "personal" ? "" : ` --${scope}`}` : ""}.`,
          0,
        );
      } catch (err) {
        if (err instanceof AssignmentRefusal) return done(err.message, 1);
        throw err;
      }
    }
    case "qualify": {
      // `sekhemet qualify --models a,b [--speculative on] [--check]` (models
      // rule 27a, MD-N8-1): the deterministic suite per model and arm,
      // recorded under the exact combination each model runs as on this host.
      // --speculative on qualifies a managed model with its speculative method
      // forced on, with prefix caching on (MD-N8-2). --check only reports
      // whether each model's combination has qualified; it loads nothing.
      // `--override <model> --by "<person>" --reason "<text>"` (models rule 27,
      // MD-N4-4): a person's decision to run the Worker whose exact current
      // combination failed qualification. The failure and the bar stay.
      if (args.includes("--override")) {
        const name = flag(args, "--override");
        // A bare name is a person, stored as asset labels are (review low 6).
        const given = flag(args, "--by")?.trim();
        const by = given && !/^person:/i.test(given) ? `person: ${given}` : given;
        const why = flag(args, "--reason")?.trim();
        if (!name || name.startsWith("--") || !by || !why || !io.model)
          return done(
            'Usage: sekhemet qualify --override <model> --by "<person>" --reason "<text>"',
            1,
          );
        const registry = modelRegistry();
        if (
          namesAModel(
            by,
            registry.list().map((e) => e.id),
          )
        )
          return done(
            `Refusing the override: "${by}" names a model, not a person. A person records an override (models rule 27).`,
            1,
          );
        const a = (io.model as (n: string) => LocalInferenceAdapter)(name);
        const combination = qualificationCombination(a, { ...io.combinationDeps, registry });
        let recorded: ReturnType<ModelRegistry["recordQualificationOverride"]>;
        try {
          recorded = registry.recordQualificationOverride(
            a.modelId,
            combination,
            { by, reason: why },
            QUALIFICATION_BAR,
          );
        } catch (err) {
          return done(
            `Refusing the override: ${err instanceof Error ? err.message : String(err)}`,
            1,
          );
        }
        await k.log.append({
          actor: "human",
          type: "models/override",
          payload: { worker: name, modelId: a.modelId, ...recorded, combination },
        });
        return done(
          `${a.modelId}: ${describeOverride(recorded)}. Recorded for ${describeCombination(combination)}; any change to it ends the override.`,
          0,
        );
      }
      const names = (flag(args, "--models") ?? "").split(",").filter(Boolean);
      if (names.length === 0 || !io.model)
        return done("Usage: sekhemet qualify --models <a,b> [--speculative on] [--check]", 1);
      const registry = modelRegistry();
      const speculative = flag(args, "--speculative") === "on";
      const adapterFor = (n: string) => {
        const a = (io.model as (n: string) => LocalInferenceAdapter)(n);
        return speculative && a instanceof ManagedLlamaServerAdapter
          ? speculativeProbe(a, registry)
          : a;
      };
      if (args.includes("--check")) {
        // --json: one structured line for scripts (run_suite, injection
        // fixtures), with the same WorkerOverride shape the evidence carries.
        const json = args.includes("--json");
        let refused = false;
        const rows: Record<string, unknown>[] = [];
        for (const n of names) {
          const a = adapterFor(n);
          const combination = qualificationCombination(a, { ...io.combinationDeps, registry });
          const why = qualificationRefusal(registry, a, combination, n);
          refused ||= why !== undefined;
          // An override runs, and says so; the failure it overrides is still shown.
          const look = registry.lookupQualification(a.modelId, combination);
          const failure =
            look.status === "overridden"
              ? (look.record?.reason ??
                `pass rate ${Math.round((look.record?.passRate ?? 0) * 100)}%`)
              : undefined;
          const owed = (await pendingM0(k.log)).find((p) => p.worker === n);
          if (json) {
            rows.push({
              model: n,
              modelId: a.modelId,
              status: look.status,
              runnable: why === undefined,
              reason: why ?? look.reason,
              ...(look.override ? { workerOverride: look.override } : {}),
              ...(failure ? { failure } : {}),
              ...(owed ? { m0Pending: owed.combination } : {}),
            });
            continue;
          }
          print(
            why ??
              (failure
                ? `${a.modelId}: ${look.reason} (the qualification itself failed: ${failure})`
                : `${a.modelId}: qualified for this combination on this host.`),
          );
          // MS-M9-6: the M0 protocol this Worker still owes.
          if (owed)
            print(
              `M0 pending for ${n} (${owed.combination}): sekhemet overnight runs it, or run sekhemet m0 --worker ${n}`,
            );
        }
        if (json) print(JSON.stringify(rows));
        return refused ? 1 : 0;
      }
      let anyQualified = false;
      for (const n of names) {
        const a = adapterFor(n);
        // Read after the run: its first request pins the chat template.
        let combination: QualificationCombination | undefined;
        // A measurement run (measurement MS-NM14-3, DEC-42): the model is
        // unloaded when it ends, even when it fails, and no Smart Swap rule
        // reorders it (models rule 20b).
        const { best } = await withMeasurementRun(
          {
            releaseAll: async () => {
              await (a as { unload?: () => Promise<void> }).unload?.();
            },
          },
          () =>
            qualifyModel(a, {
              registry,
              bar: QUALIFICATION_BAR,
              combination: () => {
                combination = qualificationCombination(a, { ...io.combinationDeps, registry });
                return combination;
              },
              thinking: thinkingPolicyFromEnv(),
            }),
        );
        combination ??= qualificationCombination(a, { ...io.combinationDeps, registry });
        const look = registry.lookupQualification(a.modelId, combination);
        anyQualified ||= look.status === "qualified";
        // MS-M9-6: a Worker qualified (or re-qualified) for a combination owes
        // the M0 protocol for it; the overnight run does it first.
        if (look.status === "qualified")
          await recordM0Pending(k.log, {
            worker: n,
            combination: describeCombination(combination),
            reason: "qualified for this combination on this host",
          });
        print(
          `${a.modelId}: ${(best.passRate * 100).toFixed(1)}% on ${best.arm} ${look.status === "qualified" ? "QUALIFIED" : "not qualified"} for ${describeCombination(combination)} (${Object.entries(
            best.byCategory,
          )
            .map(([c, v]) => `${c} ${(v * 100).toFixed(0)}%`)
            .join(
              ", ",
            )}; ${best.speed.decodeTokensPerSecond} tok/s)${look.status === "qualified" ? "" : `: ${look.reason}`}`,
        );
      }
      return anyQualified ? 0 : 1;
    }
    case "skills": {
      // `sekhemet skills [list] | approve <name> | revoke <name>` (C10).
      const dir = join(k.repoPath, ".sekhemet", "skills");
      // S9, SEC-31: the lock lives in the user directory, never the repository.
      const lockPath = skillsLockPath(k.repoPath);
      const [sub, name] = args;
      if (sub === "approve" && name) {
        // EXT-27: a skill whose scripts would write a gate file, the loop
        // driver or sandbox configuration is rejected before anything runs.
        const writes = skillProtectedWrites(join(dir, name));
        if (writes.length)
          return done(
            `${name} is rejected: ${writes.map((w) => `${w.script} names ${w.target} (${w.what})`).join("; ")} — a skill never changes gates, the loop driver or the sandbox`,
            1,
          );
        // EXT-27a: a skill with evals runs them confined, with no network,
        // before a person's approval is taken; a failing one is refused.
        if (existsSync(join(dir, name, "evals"))) {
          const checked = await checkSkillCandidate(join(dir, name), { discard: false });
          await k.log.append({
            actor: "harness",
            type: "learning/skill_checked",
            payload: { name, ...checked },
          });
          if (checked.status !== "checked")
            return done(`${name} is not approved: ${checked.reason}`, 1);
          print(`${name}: ${checked.reason}.`);
        }
        // MS-T8-5: a skill whose own checks were run is approved only when
        // they passed; a hand-written skill with no such record stays approvable.
        const last = (await k.log.getEventsByTypes(["learning/skill_checked"]))
          .map((e) => e.payload as { name?: string; status?: string })
          .filter((p) => p.name === name)
          .at(-1);
        if (last && last.status !== "checked")
          return done(
            `${name} is not approved: its own checks are ${last.status ?? "unrecorded"} (a skill is admitted by its checks passing, rule 18)`,
            1,
          );
        // SEC-46: offline, only the content a signed update bundle carried.
        const gate = airgapSkillApproval(k.repoPath, dir, name);
        if (!gate.ok) return done(gate.reason ?? "refused", 1);
        // The approval must pin the very content that was verified (B1 review).
        const e = approveVerifiedSkill(dir, name, lockPath, gate.sha256);
        if (!e.ok) return done(`${name} changed while it was being approved; approve it again.`, 1);
        print(`Approved ${name} at ${e.sha256.slice(0, 12)}.`);
        return 0;
      }
      if (sub === "revoke" && name) {
        revokeSkill(dir, name, lockPath);
        print(`Revoked ${name}; it will not load until approved again.`);
        return 0;
      }
      const lock = readSkillLock(lockPath);
      for (const [n, e] of Object.entries(lock?.skills ?? {}))
        print(`${n} pinned ${e.sha256.slice(0, 12)} by ${e.approvedBy}`);
      for (const a of (lock?.audit ?? [])
        .filter((x) => x.action.startsWith("rejected"))
        .slice(-10)) {
        print(
          `rejected ${a.skill} (${a.action}) at ${a.at}: approve with sekhemet skills approve ${a.skill}`,
        );
      }
      return 0;
    }
    case "release": {
      // planner-pm P13 (§2.15): a slice's status, acceptance, cut, extension,
      // revision, re-confirmation and release report; its release is tagged
      // on confirmation (`--confirm <SLICE>`).
      const pd = await import("./project_done.js");
      const sub = await pd.releaseSubcommand(k, args, print);
      if (sub !== undefined) return sub;
      const slices = await k.cardStore.slices.list();
      if (slices.length > 0) {
        const named = args.find((a) => /^SLICE-/.test(a) || slices.some((s) => s.id === a));
        if (!args.includes("--confirm")) {
          return (await pd.releaseSubcommand(k, ["status"], print)) ?? 0;
        }
        const pending = named ?? (await pd.latestUntaggedRelease(k));
        if (!pending) return done("No slice release is waiting to be tagged.", 1);
        try {
          const t = await pd.confirmSliceRelease(k, pending);
          return done(`Tagged ${t.tag} at ${t.sha.slice(0, 7)} for ${pending}.`, 0);
        } catch (err) {
          return done(err instanceof Error ? err.message : String(err), 1);
        }
      }
      // `sekhemet release [--confirm]` (Y17): propose, then tag on confirmation.
      const plan = planRelease(k.repoPath);
      print(
        `${plan.previousTag ?? "(no tag)"} -> ${plan.nextVersion} (${plan.bump}, ${plan.commits.length} commits, changelog by ${plan.engine})`,
      );
      print(plan.changelog);
      if (!args.includes("--confirm")) return done("Tag it with: sekhemet release --confirm", 0);
      const r = await publishRelease(k.repoPath, plan);
      print(`Tagged ${r.tag}.`);
      return 0;
    }
    case "ci": {
      // `sekhemet ci [--job <id>] [--workflow <file>]` (Y18): the project's CI as a gate.
      const r = runActGate(k.repoPath, {
        ...(flag(args, "--job") ? { job: flag(args, "--job") as string } : {}),
        ...(flag(args, "--workflow") ? { workflow: flag(args, "--workflow") as string } : {}),
      });
      if (!r.available) return done(`CI gate unavailable: ${r.reason}`, 2);
      for (const j of r.jobs)
        print(
          `${j.passed ? "pass" : "FAIL"} ${j.job}${j.failedSteps.length ? `: ${j.failedSteps.join(", ")}` : ""}`,
        );
      return r.passed ? 0 : 1;
    }
    case "improve":
      return improveCommand(k, args, io);
    case "measure": {
      // `sekhemet measure footprint | admit | rule-credit` (measurement rules 16b, 16c).
      const { runMeasureCommand } = await import("./measure_cmd.js");
      return runMeasureCommand(args, k, print);
    }
  }
}

/**
 * `sekhemet improve` (E10, E11-adjacent, E14, E15, E17): mine the
 * ledger for candidates. Skills and tools are written as candidates only;
 * nothing becomes live without approval, and the learning guard's state is
 * reported.
 */
async function improveCommand(k: Kernel, args: string[], io: CommandIO): Promise<number> {
  const { print } = io;
  if (args.includes("--mutants")) {
    // E16: `sekhemet improve --mutants [--limit 3] [--max-mutants 8]`, loop 10.
    const { mutateAcceptedCards } = await import("./mutation_step.js");
    const runs = await mutateAcceptedCards(k.repoPath, k.cardStore, k.log, {
      limit: Number(flag(args, "--limit") ?? 3),
      maxMutants: Number(flag(args, "--max-mutants") ?? 8),
    });
    for (const r of runs)
      print(
        `mutation ${r.cardId} ${r.sha.slice(0, 10)}: ${
          r.refused
            ? `not scored: ${r.refused}`
            : `${r.killed}/${r.total} killed (score ${r.score ?? "not applicable: nothing to mutate"})`
        }${r.notMeasured?.length ? `; not measured (language): ${r.notMeasured.join(", ")}` : ""}${r.proposalCardId ? `; test proposals on ${r.proposalCardId}` : ""}`,
      );
    if (runs.length === 0) print("No accepted cards left to mutate.");
    return 0;
  }
  const gateRule = flag(args, "--gate-rule");
  if (gateRule) {
    // E5: `sekhemet improve --gate-rule <id> [--fixtures chronicle,onyx] [--worker m]`
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const worker = flag(args, "--worker");
    let v: RuleGateVerdict;
    try {
      v = await gateRuleOnFixtures(k, gateRule, {
        fixtures: (flag(args, "--fixtures") ?? "chronicle").split(",").filter(Boolean),
        runFixture: (fixture, rule, scope) =>
          runFixtureGate(
            harnessRoot,
            fixture,
            rule,
            [
              ...(worker ? ["--worker", worker] : []),
              ...(flag(args, "--settings")
                ? ["--settings", flag(args, "--settings") as string]
                : []),
            ],
            undefined,
            scope,
          ),
      });
    } catch (err) {
      // A fixture run that failed is named, never scored as 0 of 0.
      print(`The rule gate did not run: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    for (const p of v.perSuite)
      print(`${p.suite}: ${p.baseline} -> ${p.candidate} (${p.delta >= 0 ? "+" : ""}${p.delta})`);
    print(
      `Diagnostic only: ${v.accepted ? "no fixture lost a card" : "a fixture lost cards"} (${v.reason}). A project rule is admitted by a person's approval; the frozen suite never admits one (DEC-28).`,
    );
    return v.accepted ? 0 : 1;
  }
  const cards = await k.cardStore.listCards();
  const steps = await k.log.getEventsByTypes(["card/step"]);
  const dot = join(k.repoPath, ".sekhemet");

  // E15: command shapes the Worker ran by hand on several cards.
  const runs = steps.flatMap((e) =>
    ((e.payload as { calls?: { name: string; target?: string }[] }).calls ?? [])
      .filter((c) => c.name === "run_cmd" && c.target)
      .map((c) => ({ cardId: e.cardId ?? "", command: c.target as string })),
  );
  for (const p of mineToolProposals(runs)) {
    const validated = args.includes("--validate-tools")
      ? await validateToolProposal(p, (cmd) =>
          validateInScratch(k.repoPath, cmd, { base: flag(args, "--base") ?? "main" }),
        )
      : p;
    print(
      `tool candidate ${p.name}: ${p.template} (used on ${p.cards.length} cards) [${validated.status}]`,
    );
    if (validated.status === "validated")
      writeToolCandidate(join(dot, "tool-candidates"), validated);
  }

  // E10: distil skills from passing cards per class.
  const byCard = new Map<string, Trajectory["steps"]>();
  for (const e of steps) {
    const list = byCard.get(e.cardId ?? "") ?? [];
    for (const c of (e.payload as { calls?: { name: string; target?: string; summary?: string }[] })
      .calls ?? []) {
      // A call the ledger holds without its result was never closed (MS-T8-6).
      list.push({
        action: `${c.name}${c.target ? ` ${c.target}` : ""}`,
        result: c.summary ?? "",
        closed: c.summary !== undefined,
      });
    }
    byCard.set(e.cardId ?? "", list);
  }
  const { cardClassOf } = await import("@sekhemet/context");
  const trajectories: Trajectory[] = cards
    .filter((c) => byCard.has(c.id))
    .map((c) => ({
      cardId: c.id,
      title: c.title,
      cardClass: cardClassOf(c),
      passed: c.status === "done",
      steps: byCard.get(c.id) ?? [],
    }));
  const classes = [...new Set(trajectories.map((t) => t.cardClass))];
  for (const cls of classes) {
    const skill = await distillSkill(
      trajectories.filter((t) => t.cardClass === cls),
      { outDir: join(dot, "skill-candidates") },
    );
    if (skill?.path) {
      // MS-T8-5: its own checks, confined, before anyone sees it.
      const { dirname } = await import("node:path");
      const checked = await checkSkillCandidate(dirname(skill.path));
      await k.log.append({
        actor: "harness",
        type: "learning/skill_checked",
        payload: { name: skill.name, ...checked },
      });
      print(
        `skill candidate ${skill.name} (${skill.triggers.join(", ")}): ${checked.status} — ${checked.reason}${checked.status === "discarded" ? "" : ` (${skill.path})`}`,
      );
    }
  }

  // E14: the informative slice for the next quick evaluation.
  const hist = new Map<string, TaskHistory>();
  for (const c of cards.filter((x) => x.stepsUsed > 0)) {
    const h = hist.get(c.id) ?? { taskId: c.id, cardClass: cardClassOf(c), passes: 0, runs: 0 };
    h.runs++;
    if (c.status === "done") h.passes++;
    hist.set(c.id, h);
  }
  const slice = siftSlice([...hist.values()], 5);
  if (slice.length) print(`SIFT slice: ${slice.map((s) => s.taskId).join(", ")}`);

  // E17: what the guard is watching.
  const guard = new LearningGuard(join(dot, "learning_guard.json"));
  const w = guard.watching();
  print(
    w
      ? `learning guard: watching ${w.id} (${w.outcomes.length}/10 cards)`
      : "learning guard: no change being measured",
  );
  return 0;
}

// ------------------------------------------------------------ tune --apply (E8)

export function applyTunedPolicy(
  repoPath: string,
  recommended: { stepBudget: number; maxFailedChecks: number },
  reason: string,
): { stepBudget: number; maxFailedChecks: number; clamped: boolean; id: string } {
  const dot = join(repoPath, ".sekhemet");
  const store = new BudgetPolicyStore(join(dot, "budget_policy.json"));
  const guard = new LearningGuard(join(dot, "learning_guard.json"));
  const entry = store.apply(recommended, reason, guard);
  return { ...entry.policy, clamped: entry.reason.includes("clamped"), id: entry.id };
}

/** The applied step budget, when `tune --apply` set one (E8). */
export function appliedStepBudget(repoPath: string): number | undefined {
  const p = join(repoPath, ".sekhemet", "budget_policy.json");
  return existsSync(p) ? new BudgetPolicyStore(p).current().stepBudget : undefined;
}

// -------------------------------------------------- bake-off records (M23, E4)

/**
 * Record each candidate's bake-off result with its full settings (M23) and
 * regenerate MODEL_MATRIX.md from every admissible record (E4).
 */
/**
 * The settings a bake-off child's cards ran with, as their evidence recorded
 * them (MD-N4-6): the suite runner copies the first card's evidence settings
 * into its result as `candidateSettings`.
 */
export function childSettings(result: SuiteRunResult): Partial<CandidateSettings> | undefined {
  const s = (result as { candidateSettings?: Partial<CandidateSettings> }).candidateSettings;
  return s && typeof s === "object" ? s : undefined;
}

export async function recordBakeOff(
  repoPath: string,
  fixture: string,
  rows: {
    adapter: LocalInferenceAdapter;
    /** The settings the child run's evidence recorded (MD-N4-6); they win over the adapter's. */
    settings?: Partial<CandidateSettings> | undefined;
    passed: number;
    total: number;
    minutes: number;
    tokens: number;
    stepBudget: number;
  }[],
  harnessRoot: string,
): Promise<{ matrix: string; recorded: number; inadmissible: string[] }> {
  const { appendBakeOffRecord, bakeOffRecord, readBakeOffRecords, validateBakeOffRecord } =
    await import("@sekhemet/models");
  const { writeBakeOffMatrix } = await import("@sekhemet/eval");
  const path = join(repoPath, ".sekhemet", "bakeoff", "records.jsonl");
  const inadmissible: string[] = [];
  let recorded = 0;
  for (const r of rows) {
    const rec = bakeOffRecord({
      adapter: r.adapter,
      fixture,
      stepBudget: r.stepBudget,
      passed: r.passed,
      total: r.total,
      minutes: r.minutes,
      tokens: r.tokens,
      repoPath: harnessRoot,
      overrides: r.settings
        ? { ...r.settings, settingsFrom: "child evidence" }
        : { settingsFrom: "parent adapter (the child recorded none)" },
    });
    const missing = validateBakeOffRecord(rec);
    if (missing.length)
      inadmissible.push(`${rec.candidate.modelId}: missing ${missing.join(", ")}`);
    appendBakeOffRecord(path, rec, { allowIncomplete: true });
    recorded++;
  }
  const matrix = join(repoPath, "MODEL_MATRIX.md");
  await writeBakeOffMatrix(matrix, readBakeOffRecords(path));
  return { matrix, recorded, inadmissible };
}

// ------------------------------------------------------------ Seshat (P13)

/**
 * The planner's half of a standup (P13): decisions waiting on the human
 * with their wait times, and the next window's cards with each estimate's
 * range and basis. Appended to Seshat's ledger standup.
 */
export async function plannerStandupSection(cardStore: CardStore, log: EventLog): Promise<string> {
  const { standupReport } = await import("@sekhemet/planner");
  const r = await standupReport({ store: cardStore, log });
  const lines: string[] = [];
  if (r.decisionsWaiting.length) {
    lines.push(
      `Decisions waiting on you: ${r.decisionsWaiting.map((d) => `${d.question} (${d.id}${d.cardId ? `, ${d.cardId}` : ""}, ${d.waitingHours} h)`).join("; ")}.`,
    );
  }
  if (r.nextWindow.length) {
    lines.push(`Next window: ${r.nextWindow.map((n) => `${n.title} (${n.estimate})`).join("; ")}.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------- Replan on rung 3 (P12)

/**
 * A card stopped at repair rung 3 asking for a re-plan: when it belongs to
 * a planned epic, run the Replan session. The epic gets a new plan version
 * with a diff against the previous one; new stories become cards and
 * removed ones that have not started return to Backlog with the reason.
 * The plan is made again from the original spec — the person's words the
 * epic keeps, through the design stage as `sekhemet plan` did — with its
 * riskiest assumption, and the riskiest-assumption card is carried into the
 * new plan, never removed (PM-P1-8). In the Team setup a removal from an
 * issue someone else owns is a suggestion to them (PM-N9-9). The re-plan and
 * its diff are posted in Seshat's thread.
 */
export async function replanOnRung3(
  k: Kernel,
  card: CardRecord,
  reason: string,
  options: { setup?: Setup } = {},
): Promise<string | undefined> {
  if (!card.parentId) return undefined;
  const { latestPlan } = await import("@sekhemet/planner");
  const ledger = ledgerOf(k);
  if (!(await latestPlan(ledger, card.parentId))) return undefined;
  const epic = await k.cardStore.getCard(card.parentId);
  if (!epic) return undefined;
  const original = epic.spec ?? epic.title;
  const design = designStage(original, { greenfield: false });
  const why = `${card.id} failed at rung 3: ${reason}`;
  const r = await gatedReplan(k, await repoPlanner(k), {
    epicId: epic.id,
    spec: epic.spec ? design.buildSpec : epic.title,
    reason: why,
    trigger: "rung3_failure",
    ...(design.riskiest ? { riskiest: design.riskiest } : {}),
    setup: options.setup ?? setupFor(k.repoPath),
  });
  const kept = r.carried.length
    ? ` Carried into v${r.version} as it stood: ${r.carried.join(", ")}.`
    : "";
  await postReplan(k, `Replanned ${epic.id} to v${r.version}: ${why}.${kept}`, r.diff, r.suggested);
  const { formatPlanDiff } = await import("@sekhemet/planner");
  return `Replanned ${epic.id} to v${r.version}:\n${formatPlanDiff(r.diff)}`;
}

// ------------------------------------------------ doctor diagnostics (E19, C12)

/** Cards that ran and finished, newest first, as the ledger's projection recorded them. */
const OUTCOME_CARDS = 50;

/**
 * The recorded outcomes skill diagnostics are measured on (EXT-26): recent
 * cards that ran (steps used) and finished — passed in Review or Done,
 * failed when parked or rejected. Read-only; no board, no outcomes.
 */
export function recentCardOutcomes(
  repoPath: string,
): { title: string; scopeFiles: string[]; passed: boolean }[] {
  const path = join(repoPath, ".sekhemet", "events.db");
  if (!existsSync(path)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT title, scope_files, status FROM cards
         WHERE steps_used > 0 AND status IN ('review','done','parked','rejected')
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(OUTCOME_CARDS) as { title: string; scope_files: string; status: string }[];
    return rows.map((r) => ({
      title: r.title,
      scopeFiles: (() => {
        try {
          return JSON.parse(r.scope_files) as string[];
        } catch {
          return [];
        }
      })(),
      passed: r.status === "review" || r.status === "done",
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * The doctor's playbook check (E19, C12): net gain per rule, context bloat
 * against the system-prompt budget, per skill its token cost, trigger count
 * and net gain over the recorded outcomes of recent cards (EXT-26), skills
 * that never trigger, and pruning recommendations. Warns when anything should be
 * retired or measured, or when rules and skills overflow the budget.
 */
export function playbookDoctorCheck(repoPath: string): {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
} {
  const d = playbookDiagnostics({
    repoPath,
    skills: loadRepoSkills(repoPath).getAllSkills(),
    cardOutcomes: recentCardOutcomes(repoPath),
  });
  const actionable = d.recommendations.filter(
    (r) => r.action === "retire" || r.action === "measure",
  );
  return {
    name: "Playbook and skills",
    status: d.bloat.over || actionable.length > 0 ? "warn" : "pass",
    detail: d.lines.join(" | "),
  };
}

// ------------------------------------------- frozen regression gate (E5)

export const REGRESSION_EVENT = "learning/regression_gate";

export interface RuleGateVerdict {
  ruleId: string;
  accepted: boolean;
  reason: string;
  perSuite: { suite: string; baseline: number; candidate: number; delta: number }[];
}

/**
 * Run a candidate rule against the frozen fixtures (E5): each fixture is
 * run by `runFixture` without the rule and with it (the queue in the
 * fixture run adopts `SEKHEMET_CANDIDATE_RULE` for that run only). A
 * diagnostic only (DEC-28, measurement rule 16a): the frozen suite never
 * admits a project rule — its fixtures cannot exercise one repository's
 * paths and error codes — so a person's approval admits it, and this
 * verdict, recorded on the ledger, is shown beside the approval, never
 * enforced.
 */
export async function gateRuleOnFixtures(
  k: Kernel,
  ruleId: string,
  options: {
    fixtures: string[];
    runFixture: (
      fixture: string,
      candidateRule?: string,
      candidateScope?: import("./learning/store.js").RuleScope,
    ) => Promise<{ passed: number; total: number }>;
  },
): Promise<RuleGateVerdict> {
  const { LearningStore } = await import("./learning/store.js");
  const { runFrozenRegressionGate } = await import("@sekhemet/eval");
  const rule = (await new LearningStore(k.log).rules()).find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No rule ${ruleId}`);
  const verdict = await runFrozenRegressionGate({
    suites: options.fixtures,
    runSuite: async (suite, variant) => ({
      suite,
      ...(await (variant === "candidate"
        ? options.runFixture(suite, rule.text, rule.scope)
        : options.runFixture(suite))),
    }),
  });
  const out: RuleGateVerdict = { ruleId, ...verdict };
  await k.log.append({ actor: "harness", type: REGRESSION_EVENT, payload: out });
  return out;
}

/** The latest recorded regression verdict for a rule, if it was gated (E5). */
export async function ruleGateVerdict(
  log: EventLog,
  ruleId: string,
): Promise<RuleGateVerdict | undefined> {
  const events = await log.getEventsByTypes([REGRESSION_EVENT]);
  return events
    .map((e) => e.payload as RuleGateVerdict)
    .filter((v) => v.ruleId === ruleId)
    .at(-1);
}

/**
 * Run one fixture on the one measurement path (measurement MS-M9-1): the
 * suite runner, and through it the product's queue, with the candidate rule
 * in force for that run only. Scored as passed over measured cards; a
 * blocked or never-run card is unmeasured (rule 3). `args` may name the
 * Worker (`--worker`) and a settings file (`--settings`); any other flag is
 * refused, since an arm is named only through the RunProfile. A run that
 * fails is an error, never a score of 0 of 0.
 */
export async function runFixtureGate(
  harnessRoot: string,
  fixture: string,
  candidateRule: string | undefined,
  args: string[] = [],
  spawn?: import("./suite_path.js").SuiteSpawn,
  /** The gated rule's own scope (CX-N4-1): the run proposes the candidate with it. */
  candidateScope?: import("./learning/store.js").RuleScope,
): Promise<{ passed: number; total: number }> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runSuitePath } = await import("./suite_path.js");
  const { runScore } = await import("@sekhemet/eval");
  let worker: string = NAIL_WORKER_PROFILE.modelId;
  let settingsFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const value = args[i + 1];
    if (a === "--worker" && value) worker = value;
    else if (a === "--settings" && value) settingsFile = value;
    else
      throw new Error(
        `the rule gate runs the suite path; ${a} is not one of its flags: name the arm in a settings file and pass --settings <file>`,
      );
    i++;
  }
  const out = join(mkdtempSync(join(tmpdir(), `sekhemet-e5-${fixture}-`)), "result.json");
  const r = await runSuitePath({
    harnessRoot,
    worker,
    fixtures: [fixture],
    out,
    ...(settingsFile ? { settingsFile } : {}),
    ...(candidateRule
      ? {
          env: {
            SEKHEMET_CANDIDATE_RULE: candidateRule,
            ...(candidateScope ? { SEKHEMET_CANDIDATE_SCOPE: JSON.stringify(candidateScope) } : {}),
          },
        }
      : {}),
    ...(spawn ? { spawn } : {}),
  });
  const score = runScore(r);
  return { passed: score.passed, total: score.measured };
}

// ---------------------------------------------- batched swaps (M25)

/**
 * Group the run order so each model loads once (M25): cards the planner
 * routed to the same executor run back to back, project by project, with
 * the resident worker first; priority order is kept inside each batch.
 */
export function batchBySwaps(cards: CardRecord[], now: Date = new Date()): CardRecord[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const plan = planWorkWindow(
    cards.map((c, i) => ({
      cardId: c.id,
      project: c.projectId ?? c.parentId ?? "board",
      // An escalated card runs on the Planner's weights, as execution, not planning.
      role: c.modelRoute?.executor === "escalation" ? ("planner" as const) : ("worker" as const),
      modelId: c.modelRoute?.executor === "escalation" ? "escalation" : "worker",
      minutes: Math.max(
        1,
        Math.round((c.secondsBudget ?? defaultSecondsBudget(c.stepBudget)) / 60),
      ),
      priority: cards.length - i,
    })),
    { start: now, end: new Date(now.getTime() + 365 * 86_400_000) },
    { residentModelId: "worker" },
  );
  const batched = plan.batches.flatMap((b) =>
    b.items.map((it) => byId.get(it.cardId) as CardRecord),
  );
  return prerequisitesFirst(batched);
}

/**
 * MD-N3-2: projects run as batches unless a dependency forces the order: a
 * prerequisite in the same queue moves to just before the first card that
 * needs it (its own prerequisites before it), everything else keeps its place.
 */
export function prerequisitesFirst(cards: CardRecord[]): CardRecord[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: CardRecord[] = [];
  const placed = new Set<string>();
  const place = (c: CardRecord, path: Set<string>) => {
    if (placed.has(c.id) || path.has(c.id)) return;
    path.add(c.id);
    for (const dep of c.dependsOn ?? []) {
      const pre = byId.get(dep);
      if (pre) place(pre, path);
    }
    placed.add(c.id);
    out.push(c);
  };
  for (const c of cards) place(c, new Set());
  return out;
}

/** The scheduler's reserved-hours windows as the planner's declared hours (M25). */
export function declaredHoursFromWindows(
  windows: { start: number; end: number; days: Set<number> }[],
): { userBlocks: { days: number[]; start: string; end: string }[] } {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    userBlocks: windows.map((w) => ({
      days: [...w.days].sort(),
      start: hhmm(w.start),
      end: hhmm(w.end),
    })),
  };
}

/** One line for the overnight log: the next work window and its batched swaps (M25). */
export function overnightPlanLine(
  windows: { start: number; end: number; days: Set<number> }[],
  cards: CardRecord[],
  now: Date = new Date(),
): string {
  const r = scheduleNow(
    now,
    declaredHoursFromWindows(windows),
    cards.map((c) => ({
      cardId: c.id,
      project: c.projectId ?? c.parentId ?? "board",
      // An escalated card runs on the Planner's weights, as execution, not planning.
      role: c.modelRoute?.executor === "escalation" ? ("planner" as const) : ("worker" as const),
      modelId: c.modelRoute?.executor === "escalation" ? "escalation" : "worker",
      minutes: Math.max(
        1,
        Math.round((c.secondsBudget ?? defaultSecondsBudget(c.stepBudget)) / 60),
      ),
    })),
    { residentModelId: "worker" },
  );
  if (r.state === "user_time")
    return `Declared hours: the machine is yours until ${r.resumesAt?.toISOString() ?? "later"}.`;
  const s = r.schedule;
  return `Plan: ${s.batches.map((b) => `${b.modelId}/${b.project} x${b.items.length}`).join(", ")}; ${s.swaps} model load(s)${s.deferred.length ? `, ${s.deferred.length} card(s) deferred past the window` : ""}.`;
}

// ---------------------------------------------- --validate-tools (item 4a)

/**
 * Run one mined command (Worker-written code, R6) for `--validate-tools`
 * (security item 4a, SEC-17a): in a scratch worktree created from the base
 * branch and deleted afterwards, through `runConfined()` with no network,
 * the allowlisted environment, a private HOME and a 60 s limit. Never in
 * the main checkout.
 */
export async function validateInScratch(
  repoPath: string,
  command: string,
  options: { base?: string; timeoutMs?: number; sandbox?: ProcessSandbox } = {},
): Promise<{ exitCode: number; output: string }> {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-validate-"));
  const worktree = join(scratch, "worktree");
  const home = join(scratch, "home");
  mkdirSync(home);
  const env = gitEnvFor(repoPath);
  const git = (argv: string[]) => runTrusted("git", argv, { cwd: repoPath, env });
  try {
    const added = await git(["worktree", "add", "--detach", worktree, options.base ?? "main"]);
    if (added.exitCode !== 0) {
      return { exitCode: 1, output: `no scratch worktree: ${added.stderr.trim()}` };
    }
    const [bin, ...rest] = command.trim().split(/\s+/);
    const r = await runConfined(bin as string, rest, {
      root: worktree,
      writable: [home],
      env: { HOME: home },
      // The real home is unreadable too, not just renamed (item 4a).
      denyHomeReads: true,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    });
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    return { exitCode: r.timedOut ? 124 : r.exitCode, output: output.slice(-2000) };
  } finally {
    await git(["worktree", "remove", "--force", worktree]);
    rmSync(scratch, { recursive: true, force: true });
    await git(["worktree", "prune"]);
  }
}

// ---------------------------------------------- per-package gates (Y19)

/**
 * The gates of every workspace package a card's diff touches (Y19): a card
 * touching two packages runs both gate sets. Returns the failures, empty
 * when the repository is not a monorepo or every package gate passes.
 */
export async function runPackageGates(
  root: string,
  cwd: string,
  changedFiles: string[],
  print: (line: string) => void = (l) => console.log(l),
  options: { restricted?: boolean; sandbox?: ProcessSandbox } = {},
): Promise<{ package: string; rung: string; passed: boolean; output: string }[]> {
  // SEC-19: an audit starts no package gate; they execute the project's code.
  if (options.restricted) return [];
  const { gatesForChange } = await import("@sekhemet/sync");
  const { relative } = await import("node:path");
  const results: { package: string; rung: string; passed: boolean; output: string }[] = [];
  for (const g of gatesForChange(cwd, changedFiles)) {
    const dir = g.cwd;
    // The package's gate is the project's code: confined to the card's
    // worktree, allowlisted environment, no network (S3a, SEC-17).
    const r = await runConfined(g.command, g.args, {
      root: cwd,
      cwd: dir,
      timeoutMs: 600_000,
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    });
    const passed = r.exitCode === 0 && !r.timedOut;
    const output = passed ? r.stdout : [r.stdout, r.stderr].filter(Boolean).join("\n");
    print(`  ${passed ? "pass" : "FAIL"} ${g.package}:${g.rung} (${relative(root, dir) || "."})`);
    results.push({ package: g.package, rung: g.rung, passed, output: output.slice(-2000) });
  }
  return results;
}
