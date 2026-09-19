import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveSkill, readSkillLock, revokeSkill } from "@sekhemet/context";
import {
  BudgetPolicyStore,
  LearningGuard,
  type TaskHistory,
  type Trajectory,
  VariantArchive,
  distillSkill,
  formatM0Report,
  mineToolProposals,
  qualifyCandidates,
  runM0Protocol,
  siftSlice,
  synthesizeTasksFromHistory,
  validateToolProposal,
  writeToolCandidate,
} from "@sekhemet/eval";
import { type CardRecord, type CardStore, type EventLog, parseToml } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  ModelRegistry,
  assertModelRunnable,
  loadMachineProfile,
} from "@sekhemet/models";
import {
  DecisionStore,
  GoalStore,
  type PlannerLedger,
  SpidrFeaturePlanner,
  approveGoal,
  ceremoniesDue,
  codebaseMapFromRepo,
  computeSignals,
  formatPlanReport,
  intakeGoal,
  loadCalibrationLog,
  loadPrioritizationConfig,
  orderReadyCards,
  persistPlan,
  processProfileFromConfig,
  rankGoals,
  runGoalLoop,
  triggeredResponses,
} from "@sekhemet/planner";
import { planRelease, publishRelease, runActGate } from "@sekhemet/sync";

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
}

const ledgerOf = (k: Kernel): PlannerLedger => ({ store: k.cardStore, log: k.log });

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

/**
 * `sekhemet plan "<spec>"` (P1, P2, P4-P9, P15, P24, P25, P7, defect 6):
 * decompose against the real codebase map, then persist every story with
 * its whole contract, INVEST enforced, the batched decision parked.
 */
export async function planCommand(
  k: Kernel,
  spec: string,
  options: { sketcher?: LocalInferenceAdapter; print?: (line: string) => void } = {},
): Promise<{ epicId: string; created: number; decisionId?: string }> {
  const print = options.print ?? ((l: string) => console.log(l));
  const epicId = `epic_${Date.now().toString(16)}`;
  await k.cardStore.createCard({ id: epicId, tier: "epic", title: spec, status: "in_progress" });
  const planner = await repoPlanner(k);
  const plan = await planner.decomposeSpec({ parentId: epicId, parentTier: "epic", spec });
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
    ...(options.sketcher ? { sketcher: options.sketcher } : {}),
  });
  print(formatPlanReport(result));
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
    reviewWip?: number;
    print?: (line: string) => void;
    now?: Date;
  } = {},
): Promise<{ ordered: CardRecord[]; lines: string[] }> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    (options.print ?? ((x: string) => console.log(x)))(l);
  };
  const ledger = ledgerOf(k);
  const now = options.now ?? new Date();

  // M15: refuse a worker measured below the overnight floor.
  if (options.workerModelId) assertModelRunnable(loadMachineProfile(), options.workerModelId);

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
  const signals = computeSignals({
    now,
    cards,
    events,
    reviewWip: options.reviewWip ?? 3,
  });
  const fired = triggeredResponses(signals);
  for (const s of fired) {
    say(`Signal ${s.id}: ${s.detail} -> ${s.response?.action} (${s.response?.mode})`);
    // Automatic responses within bounds: escalate blockers to the top.
    if (s.response?.action === "escalate_blockers") {
      for (const id of s.response.targets) {
        await k.cardStore.updateCard(id, { priority: 1 }, "planner").catch(() => undefined);
      }
    }
  }

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

  // Goals: re-evaluate every active goal, then work the top-ranked one first.
  const goals = await new GoalStore(ledger).all();
  const planner = goals.some((g) => g.state === "active") ? await repoPlanner(k) : undefined;
  for (const g of goals.filter((x) => x.state === "active")) {
    const r = await runGoalLoop(ledger, planner as SpidrFeaturePlanner, g.id);
    if (r.verdict.state !== "active")
      say(
        `Goal ${g.id} is ${r.verdict.state}.${r.verdict.diagnosis ? ` ${r.verdict.diagnosis}` : ""}`,
      );
    else if (r.replanned)
      say(`Goal ${g.id} replanned: ${r.evaluation.triggers.map((t) => t.detail).join("; ")}`);
  }
  const ranking = rankGoals(await new GoalStore(ledger).all(), await k.cardStore.listCards());
  const top = ranking[0];
  if (top) say(`Working goal ${top.goalId} first: ${top.why}.`);

  const ordering = orderReadyCards(ready, loadPrioritizationConfig(k.repoPath), now);
  let ordered = ordering.cards;
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

/** The model registry the roster pins templates and arms in (M11). */
export function modelRegistry(): ModelRegistry {
  return new ModelRegistry();
}

// ------------------------------------------------------------------ commands

export type Wave2Command =
  | "goal"
  | "decide"
  | "m0"
  | "qualify"
  | "improve"
  | "skills"
  | "release"
  | "ci";
export const WAVE2_COMMANDS: readonly Wave2Command[] = [
  "goal",
  "decide",
  "m0",
  "qualify",
  "improve",
  "skills",
  "release",
  "ci",
];

export interface CommandIO {
  print: (line: string) => void;
  /** Resolve a model name to an adapter (the queue's roster). */
  model?: (name: string) => LocalInferenceAdapter;
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
    case "m0": {
      // `sekhemet m0 --worker <name> [--runs 3] [--budgets 50,150] [--max-commits 200]`
      const worker = flag(args, "--worker");
      if (!worker || !io.model) return done("Usage: sekhemet m0 --worker <model>", 1);
      const synth = await synthesizeTasksFromHistory(k.repoPath, {
        maxCommits: Number(flag(args, "--max-commits") ?? 200),
      });
      print(
        `Synthesized ${synth.tasks.length} fail-to-pass task(s) from ${synth.scanned} candidate commit(s); ${synth.rejected.length} rejected.`,
      );
      if (synth.tasks.length === 0) return 1;
      const report = await runM0Protocol({
        tasks: synth.tasks,
        adapter: io.model(worker),
        runs: Number(flag(args, "--runs") ?? 3),
        budgets: (flag(args, "--budgets") ?? "50,150").split(",").map(Number),
        benchmark: { harnessRepoPath: k.repoPath, defaultRepoPath: k.repoPath },
      });
      print(formatM0Report(report));
      const out = join(k.repoPath, ".sekhemet", "m0", "latest.json");
      mkdirSync(join(k.repoPath, ".sekhemet", "m0"), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      print(`Report: ${out}`);
      return 0;
    }
    case "qualify": {
      // `sekhemet qualify --models a,b`: the deterministic suite per model and arm.
      const names = (flag(args, "--models") ?? "").split(",").filter(Boolean);
      if (names.length === 0 || !io.model) return done("Usage: sekhemet qualify --models <a,b>", 1);
      const adapters = names.map((n) => (io.model as (n: string) => LocalInferenceAdapter)(n));
      const results = await qualifyCandidates(adapters, {
        registry: modelRegistry(),
        release: async (a) => {
          await (a as { unload?: () => Promise<void> }).unload?.();
        },
      });
      for (const r of results) {
        print(
          `${r.modelId}: ${(r.best.passRate * 100).toFixed(1)}% on ${r.best.arm} ${r.qualified ? "QUALIFIED" : "not qualified"} (${Object.entries(
            r.best.byCategory,
          )
            .map(([c, v]) => `${c} ${(v * 100).toFixed(0)}%`)
            .join(", ")})`,
        );
      }
      return results.some((r) => r.qualified) ? 0 : 1;
    }
    case "skills": {
      // `sekhemet skills [list] | approve <name> | revoke <name>` (C10).
      const dir = join(k.repoPath, ".sekhemet", "skills");
      const lockPath = join(k.repoPath, ".sekhemet", "skills.lock.json");
      const [sub, name] = args;
      if (sub === "approve" && name) {
        const e = approveSkill(dir, name, "human", lockPath);
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
  }
}

/**
 * `sekhemet improve` (E10, E11-adjacent, E13, E14, E15, E17): mine the
 * ledger for candidates. Skills and tools are written as candidates only;
 * nothing becomes live without approval, and the learning guard's state is
 * reported.
 */
async function improveCommand(k: Kernel, args: string[], io: CommandIO): Promise<number> {
  const { print } = io;
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
      ? await validateToolProposal(p, async (cmd) => {
          const { execFileSync } = await import("node:child_process");
          try {
            const [bin, ...rest] = cmd.split(/\s+/);
            execFileSync(bin as string, rest, {
              cwd: k.repoPath,
              stdio: "ignore",
              timeout: 60_000,
            });
            return { exitCode: 0, output: "" };
          } catch (e) {
            return { exitCode: (e as { status?: number }).status ?? 1, output: "" };
          }
        })
      : p;
    print(
      `tool candidate ${p.name}: ${p.template} (used on ${p.cards.length} cards) [${validated.status}]`,
    );
    if (validated.status === "validated")
      writeToolCandidate(join(dot, "tool-candidates"), validated);
  }

  // E10: distil skills from passing cards per class.
  const byCard = new Map<string, { action: string; result: string }[]>();
  for (const e of steps) {
    const list = byCard.get(e.cardId ?? "") ?? [];
    for (const c of (e.payload as { calls?: { name: string; target?: string; summary?: string }[] })
      .calls ?? []) {
      list.push({ action: `${c.name}${c.target ? ` ${c.target}` : ""}`, result: c.summary ?? "" });
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
    if (skill)
      print(`skill candidate ${skill.name} (${skill.triggers.join(", ")}) at ${skill.path}`);
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

  // E13: archive the current harness configuration with its measured pass rate.
  const policy = new BudgetPolicyStore(join(dot, "budget_policy.json")).current();
  const done = cards.filter((c) => c.status === "done").length;
  const tried = cards.filter((c) => c.stepsUsed > 0).length;
  const archive = new VariantArchive(join(dot, "variants.json"));
  const config = { stepBudget: policy.stepBudget, maxFailedChecks: policy.maxFailedChecks };
  const existing = archive.all().find((v) => JSON.stringify(v.config) === JSON.stringify(config));
  if (!existing && tried > 0) {
    const parent = archive.best();
    archive.add({
      ...(parent ? { parentId: parent.id } : {}),
      description: `steps ${policy.stepBudget}, failed checks ${policy.maxFailedChecks}`,
      config,
      scores: { board: tried ? done / tried : 0 },
    });
  }
  print(
    `variant archive: ${archive.all().length} variant(s); best ${archive.best()?.description ?? "none"}`,
  );

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

/**
 * Card outcomes feed the learning guard (E17); a rollback of a budget change
 * restores the previous policy.
 */
export function observeOutcome(
  repoPath: string,
  cardId: string,
  passed: boolean,
): string | undefined {
  const dot = join(repoPath, ".sekhemet");
  const guardPath = join(dot, "learning_guard.json");
  if (!existsSync(guardPath)) return undefined;
  const r = new LearningGuard(guardPath).observe(cardId, passed);
  if (r.rollback?.kind === "budget") {
    new BudgetPolicyStore(join(dot, "budget_policy.json")).rollback(r.rollback.id);
    return `learning guard rolled back ${r.rollback.id}: ${r.rollback.reason}`;
  }
  if (r.rollback) return `learning guard: roll back ${r.rollback.id} (${r.rollback.reason})`;
  if (r.kept) return `learning guard kept ${r.kept.id}: ${r.kept.reason}`;
  return undefined;
}

// -------------------------------------------------- bake-off records (M23, E4)

/**
 * Record each candidate's bake-off result with its full settings (M23) and
 * regenerate MODEL_MATRIX.md from every admissible record (E4).
 */
export async function recordBakeOff(
  repoPath: string,
  fixture: string,
  rows: {
    adapter: LocalInferenceAdapter;
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
