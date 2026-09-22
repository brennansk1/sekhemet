import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  playbookDiagnostics,
  qualifyCandidates,
  runM0Protocol,
  siftSlice,
  synthesizeTasksFromHistory,
  validateToolProposal,
  writeToolCandidate,
} from "@sekhemet/eval";
import { loadGatesConfig } from "@sekhemet/gates";
import { type CardRecord, type CardStore, type EventLog, parseToml } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  ModelRegistry,
  assertModelRunnable,
  loadMachineProfile,
  planWorkWindow,
  scheduleNow,
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
/** No tracked source yet: a project that does not exist. */
function isGreenfield(repoPath: string): boolean {
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

export async function planCommand(
  k: Kernel,
  spec: string,
  options: { sketcher?: LocalInferenceAdapter; print?: (line: string) => void } = {},
): Promise<{ epicId: string; created: number; decisionId?: string }> {
  const print = options.print ?? ((l: string) => console.log(l));
  // The design stage decides how much conversation this spec deserves, says
  // it, and proceeds: quality words become constraints with defaults, not
  // cards, and a spec with money or identity at stake gets a written brief.
  const design = designStage(spec, { greenfield: isGreenfield(k.repoPath) });
  for (const line of design.say) print(line);
  const briefPath = join(k.repoPath, ".sekhemet", "brief.md");
  if (design.proportion === "brief" && !existsSync(briefPath)) {
    // Never over a brief a person has written or edited.
    mkdirSync(dirname(briefPath), { recursive: true });
    writeFileSync(briefPath, renderBrief(design, { gates: tryGateIds(k.repoPath) }));
  }
  const epicId = `epic_${Date.now().toString(16)}`;
  await k.cardStore.createCard({
    id: epicId,
    tier: "epic",
    title: design.buildSpec,
    status: "in_progress",
  });
  const planner = await repoPlanner(k);
  const plan = await planner.decomposeSpec({
    parentId: epicId,
    parentTier: "epic",
    spec: design.buildSpec,
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

  // Y16: advance open Sekhemet PRs (ready once checks pass, auto-merge by policy).
  const { githubAppFromEnv } = await import("./wave2_server.js");
  const app = githubAppFromEnv();
  if (app) {
    const { advancePullRequests } = await import("./wave2_github.js");
    for (const p of await advancePullRequests(app, k.repoPath, k.log, {
      autoMerge: process.env.SEKHEMET_GITHUB_AUTOMERGE === "1",
    }).catch(() => [])) {
      say(`PR #${p.number}: ${p.state}`);
    }
  }

  const ordering = orderReadyCards(ready, loadPrioritizationConfig(k.repoPath), now);
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
  | "ci";
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
    case "airgap": {
      // X10-X14: mirror, model manifest, doc bundles, signed updates, self-test.
      const { airgapCommand } = await import("./airgap.js");
      return airgapCommand(k.repoPath, args, { log: k.log, registry: modelRegistry(), print });
    }
    case "onboard": {
      // `sekhemet onboard [--apply] [--models a,b]` (X1): the seven steps.
      const { runOnboard } = await import("./onboard.js");
      const names = (flag(args, "--models") ?? "").split(",").filter(Boolean);
      await runOnboard(k.repoPath, {
        apply: args.includes("--apply"),
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
  if (args.includes("--mutants")) {
    // E16: `sekhemet improve --mutants [--limit 3] [--max-mutants 8]`, loop 10.
    const { mutateAcceptedCards } = await import("./mutation_step.js");
    const runs = await mutateAcceptedCards(k.repoPath, k.cardStore, k.log, {
      limit: Number(flag(args, "--limit") ?? 3),
      maxMutants: Number(flag(args, "--max-mutants") ?? 8),
    });
    for (const r of runs)
      print(
        `mutation ${r.cardId} ${r.sha.slice(0, 10)}: ${r.killed}/${r.total} killed (score ${r.score})${r.proposalCardId ? `; test proposals on ${r.proposalCardId}` : ""}`,
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
    const v = await gateRuleOnFixtures(k, gateRule, {
      fixtures: (flag(args, "--fixtures") ?? "chronicle").split(",").filter(Boolean),
      runFixture: (fixture, rule) =>
        runFixtureGate(harnessRoot, fixture, rule, worker ? ["--worker", worker] : []),
    });
    for (const p of v.perSuite)
      print(`${p.suite}: ${p.baseline} -> ${p.candidate} (${p.delta >= 0 ? "+" : ""}${p.delta})`);
    print(`${v.accepted ? "ACCEPTED" : "REJECTED"}: ${v.reason}`);
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
 * removed ones that have not started are parked with the reason.
 */
export async function replanOnRung3(
  k: Kernel,
  card: CardRecord,
  reason: string,
): Promise<string | undefined> {
  if (!card.parentId) return undefined;
  const { latestPlan, replanSession, formatPlanDiff } = await import("@sekhemet/planner");
  const ledger = ledgerOf(k);
  if (!(await latestPlan(ledger, card.parentId))) return undefined;
  const epic = await k.cardStore.getCard(card.parentId);
  if (!epic) return undefined;
  const r = await replanSession(ledger, await repoPlanner(k), {
    epicId: epic.id,
    spec: epic.spec ?? epic.title,
    reason: `${card.id} failed at rung 3: ${reason}`,
    trigger: "rung3_failure",
    apply: true,
  });
  return `Replanned ${epic.id} to v${r.version}:\n${formatPlanDiff(r.diff)}`;
}

// ------------------------------------------------ doctor diagnostics (E19, C12)

/**
 * The doctor's playbook check (E19, C12): net gain per rule, context bloat
 * against the system-prompt budget, skills that never trigger on recent
 * cards, and pruning recommendations. Warns when anything should be
 * retired or measured, or when rules and skills overflow the budget.
 */
export function playbookDoctorCheck(repoPath: string): {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
} {
  const d = playbookDiagnostics({ repoPath });
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
 * fixture run adopts `SEKHEMET_CANDIDATE_RULE` for that run only), and the
 * rule may be approved only when no fixture loses a passing card. The
 * verdict is recorded on the ledger; approval checks it.
 */
export async function gateRuleOnFixtures(
  k: Kernel,
  ruleId: string,
  options: {
    fixtures: string[];
    runFixture: (
      fixture: string,
      candidateRule?: string,
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
      ...(await options.runFixture(suite, variant === "candidate" ? rule.text : undefined)),
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
 * Run one fixture through scripts/run_gate.sh (the same path as bake-off)
 * and read its queue report.
 */
export async function runFixtureGate(
  harnessRoot: string,
  fixture: string,
  candidateRule: string | undefined,
  queueArgs: string[] = [],
): Promise<{ passed: number; total: number }> {
  const { spawn } = await import("node:child_process");
  const { readdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const runRoot = mkdtempSync(join(tmpdir(), `sekhemet-e5-${fixture}-`));
  await new Promise<number>((resolve) => {
    const child = spawn(
      "bash",
      [join(harnessRoot, "scripts", "run_gate.sh"), fixture, ...queueArgs],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          GATE_RUN_DIR: runRoot,
          ...(candidateRule ? { SEKHEMET_CANDIDATE_RULE: candidateRule } : {}),
        },
      },
    );
    child.on("exit", (c) => resolve(c ?? 1));
  });
  const runDir = readdirSync(runRoot).map((d) => join(runRoot, d))[0];
  const report = runDir ? join(runDir, ".sekhemet", "queue_report.json") : "";
  if (!report || !existsSync(report)) return { passed: 0, total: 0 };
  const r = JSON.parse(readFileSync(report, "utf8")) as {
    entries: { cardId: string; passed: boolean; attempt: number }[];
  };
  const cards = new Set(r.entries.map((e) => e.cardId));
  const passed = new Set(r.entries.filter((e) => e.passed).map((e) => e.cardId));
  return { passed: passed.size, total: cards.size };
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
      role: c.modelRoute?.executor === "escalation" ? ("escalation" as const) : ("worker" as const),
      modelId: c.modelRoute?.executor === "escalation" ? "escalation" : "worker",
      minutes: Math.max(1, Math.round((c.secondsBudget ?? 600) / 60)),
      priority: cards.length - i,
    })),
    { start: now, end: new Date(now.getTime() + 365 * 86_400_000) },
    { residentModelId: "worker" },
  );
  return plan.batches.flatMap((b) => b.items.map((it) => byId.get(it.cardId) as CardRecord));
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
      role: c.modelRoute?.executor === "escalation" ? ("escalation" as const) : ("worker" as const),
      modelId: c.modelRoute?.executor === "escalation" ? "escalation" : "worker",
      minutes: Math.max(1, Math.round((c.secondsBudget ?? 600) / 60)),
    })),
    { residentModelId: "worker" },
  );
  if (r.state === "user_time")
    return `Declared hours: the machine is yours until ${r.resumesAt?.toISOString() ?? "later"}.`;
  const s = r.schedule;
  return `Plan: ${s.batches.map((b) => `${b.modelId}/${b.project} x${b.items.length}`).join(", ")}; ${s.swaps} model load(s)${s.deferred.length ? `, ${s.deferred.length} card(s) deferred past the window` : ""}.`;
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
): Promise<{ package: string; rung: string; passed: boolean; output: string }[]> {
  const { gatesForChange } = await import("@sekhemet/sync");
  const { execFileSync } = await import("node:child_process");
  const { relative } = await import("node:path");
  const results: { package: string; rung: string; passed: boolean; output: string }[] = [];
  for (const g of gatesForChange(cwd, changedFiles)) {
    const dir = g.cwd;
    let passed = true;
    let output = "";
    try {
      output = execFileSync(g.command, g.args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 600_000,
        stdio: "pipe",
      });
    } catch (e) {
      passed = false;
      output = String((e as { stdout?: string }).stdout ?? e);
    }
    print(`  ${passed ? "pass" : "FAIL"} ${g.package}:${g.rung} (${relative(root, dir) || "."})`);
    results.push({ package: g.package, rung: g.rung, passed, output: output.slice(-2000) });
  }
  return results;
}
