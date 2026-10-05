import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import {
  type Combination,
  type ItemRun,
  type OvernightRunner,
  type RunProfile,
  type RunSettings,
  type ScreenRunner,
  type ScreeningItem,
  type SettingsCombination,
  loadAssetManifest,
  prepareIndependentCard,
  seededCards,
  writeMeasurementMarker,
} from "@sekhemet/eval";
import { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  type ModelRole,
  plannerCopy,
  stripReasoning,
} from "@sekhemet/models";
import { runConfined } from "@sekhemet/sandbox";
import { gitEnvFor } from "@sekhemet/sync";
import { type ExecutionContext, executeCard } from "./execute.js";
import { reviewCard } from "./learning/review.js";
import { type SeededDefect, loadSeededDefects, reviewSeededItem } from "./learning/review_eval.js";

/**
 * The runner that drives real work for the combination benchmark
 * (measurement NEW-measurement-5, rules 8, 31, 37; B4.1 part (c)): the
 * frozen suite's own machinery, card by card.
 *
 * - **A repository per card**, prepared as `scripts/run_suite.mjs` prepares
 *   one in independent mode (MS-T7-3): the fixture copied, committed and
 *   seeded by its seeder, marked for measurement, and every earlier card's
 *   registered reference solution committed to `main`, so the card runs from
 *   its reference `main` (rule 8) and depends on no other card's outcome.
 * - **The card run by `executeCard`** with the combination's model for the
 *   role, its gates deciding; a quick screen caps it by `secondsBudget`, so a
 *   capped card stops with `time_budget_exhausted` (MS-N5-3); an overnight
 *   card carries its run's fixed seed (rule 10) and stops at the window's end.
 * - **Its score** is the fraction of its acceptance tests passing in the
 *   card's worktree when it ended; the tool calls that succeeded and the
 *   steps are its secondary measures.
 * - **The end-to-end check** runs a card through the Planner (a plan the
 *   Worker is given), the Worker, and the Reviewer (a review against the
 *   card's acceptance criteria; a send-back fails it) (MS-N5-7).
 *
 * The caller wraps every use in `withMeasurementRun` (DEC-45); `release`
 * unloads what this runner loaded. The Reviewer's items are seeded defects,
 * reviewed as the product builds a review's input (MS-N8-5); the Planner's
 * and Researcher's are not built yet (rule 30a) and are refused.
 *
 * A combination's settings (rule 39, MS-N8-1) apply to the run only:
 * temperature on every request and the reasoning level and cap through the
 * role's settings as the adapter's registry reads them (`withRunSettings`),
 * the thinking policy, working method, evidence check and step budget
 * through the run's `RunProfile` (`profileWithSettings`). Nothing is written
 * to the registry.
 */

/**
 * The adapter a run uses with its role's run-level settings (rule 39): the
 * same adapter — its server, its registry, its health — with temperature set
 * on every request, the tool arm it offers, and the role's reasoning level
 * and thinking cap as `roleSettings` reads them (the Reviewer's
 * `reviewReasoning`). No settings: the adapter itself.
 */
export function withRunSettings(
  adapter: LocalInferenceAdapter,
  role: ModelRole,
  values: RunSettings | undefined,
): LocalInferenceAdapter {
  if (!values || Object.keys(values).length === 0) return adapter;
  const reasoning = {
    ...(values.reasoningLevel !== undefined ? { reasoningLevel: values.reasoningLevel } : {}),
    ...(values.reasoningCapTokens !== undefined
      ? { reasoningCapTokens: values.reasoningCapTokens }
      : {}),
  };
  const target = adapter as LocalInferenceAdapter & {
    registry?: { roleSettings?: (id: string, r: ModelRole) => unknown };
  };
  const overlay = (real: typeof target.registry) => ({
    roleSettings(id: string, r: ModelRole) {
      const had = real?.roleSettings?.(id, r) as
        | { values: Record<string, unknown>; by: string; at: string }
        | undefined;
      if (r !== role || Object.keys(reasoning).length === 0) return had;
      return {
        values: { ...(had?.values ?? {}), ...reasoning },
        by: had?.by ?? "benchmark",
        at: had?.at ?? new Date(0).toISOString(),
      };
    },
  });
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "generate")
        return (req: Parameters<LocalInferenceAdapter["generate"]>[0]) =>
          t.generate({
            ...req,
            ...(values.temperature !== undefined ? { temperature: values.temperature } : {}),
          });
      if (prop === "registry") return overlay(t.registry);
      if (prop === "preferredToolArm" && values.toolArm && values.toolArm !== "auto")
        return values.toolArm;
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** A run's `RunProfile` with its role's run-level settings (rule 39) and its seed. */
export function profileWithSettings(
  profile: RunProfile,
  values: (RunSettings & { seed?: number }) | undefined,
): RunProfile {
  if (!values) return profile;
  return {
    ...profile,
    policies: {
      ...profile.policies,
      ...(values.stepBudget !== undefined ? { stepCap: values.stepBudget } : {}),
    },
    switches: {
      ...profile.switches,
      ...(values.reasoningPolicy !== undefined ? { thinking: values.reasoningPolicy } : {}),
      ...(values.method !== undefined ? { workerMethod: values.method } : {}),
      ...(values.evidenceGate !== undefined ? { evidenceGate: values.evidenceGate } : {}),
      ...(values.seed !== undefined ? { seed: values.seed } : {}),
    },
  };
}

export interface SuiteRunnerDeps {
  /** The harness checkout: its fixtures, reference solutions, seeders and node_modules. */
  harnessRoot: string;
  /** Where each card's repository is prepared; removed after it is scored. */
  workDir: string;
  /** The combination's model for a role: the role assignment the run measures. */
  adapterFor: (
    role: ModelRole,
    model: string,
  ) => LocalInferenceAdapter | Promise<LocalInferenceAdapter>;
  /**
   * Unload one model this runner loaded, through whatever loaded it (the
   * residency scheduler's lease); without it the adapter unloads itself.
   */
  releaseModel?: (role: ModelRole, model: string) => Promise<void>;
  /** The run's settings; the overnight run's seed is set per run on top. */
  runProfile: (c?: Combination) => RunProfile;
  /** Count the acceptance tests passing in a directory; default Vitest's JSON report. */
  countTests?: (dir: string, files: string[]) => Promise<{ passed: number; total: number }>;
  /** `false` skips the per-turn swap-growth check (tests); the watchdog still applies. */
  headroomCheck?: boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Keep each card's repository for inspection instead of removing it. */
  keep?: boolean;
}

/** One card's result: what the score and the secondary measures are made from. */
export interface SuiteCardRun {
  passed: boolean;
  testsPassed: number;
  testsTotal: number;
  seconds: number;
  stopReason: string;
  capped: boolean;
  toolCalls: number;
  validToolCalls: number;
  steps: number;
  worktreePath: string;
  cardId: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/** The frozen suite's declared card count per fixture (`fixtures/suite.json`). */
function declaredCards(root: string, fixture: string): number {
  const manifest = JSON.parse(readFileSync(join(root, "fixtures", "suite.json"), "utf8")) as {
    fixtures: { name: string; tasks: number }[];
  };
  const f = manifest.fixtures.find((x) => x.name === fixture);
  if (!f) throw new Error(`${fixture} is not a frozen-suite fixture`);
  return f.tasks;
}

/**
 * A fresh repository for one frozen-suite card in independent mode, prepared
 * as `scripts/run_suite.mjs` prepares it (`prepareRepo` then `prepareCard`).
 */
export async function prepareCardRepo(
  root: string,
  fixture: string,
  cardId: string,
  dir: string,
): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "fixtures", fixture), dir, { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "suite@sekhemet.local");
  git("config", "user.name", "Frozen Suite");
  git("add", "-A");
  git("commit", "-q", "-m", `seed: ${fixture}`);
  const seeder = existsSync(join(root, "fixtures", fixture, "cards.json"))
    ? [join(root, "scripts", "seed_project.mjs"), join(root, "fixtures", fixture), dir]
    : [join(root, "scripts", "seed_chronicle.mjs"), dir];
  execFileSync(process.execPath, seeder, { stdio: "ignore" });
  // Frozen-suite cards marked for measurement (independent mode needs it), as
  // the benchmark's: SUITE_RUNS never counts them as a suite run's.
  writeMeasurementMarker(dir, "benchmark", "benchmark_runner.ts");
  appendFileSync(join(dir, ".git", "info", "exclude"), "\n.sekhemet/measurement.json\n");
  const cards = seededCards(dir, declaredCards(root, fixture));
  const refs = loadAssetManifest(root).assets.find((a) => a.name === "reference-solutions");
  if (!refs)
    throw new Error(
      "the reference solutions are not registered; a card cannot run from its reference main",
    );
  await prepareIndependentCard(dir, {
    fixture,
    cardId,
    cardOrder: cards.map((c) => c.id),
    acceptanceTests: Object.fromEntries(cards.map((c) => [c.id, c.info.tests])),
    referencesDir: join(root, refs.path),
  });
  return dir;
}

/** Runs the card's tests confined; `runConfined` by default (tests pass a fake). */
export type ConfinedRun = (command: string, args: string[], root: string) => Promise<unknown>;

/**
 * Vitest's JSON report of the named test files, run where the card's code
 * is. The Worker can write anywhere in that tree, so the report's name is
 * fresh and unguessable each time and any file there of that name is
 * removed before the run: a report planted or left over is never read as the
 * result. (The confined run may write only inside the card's repository, so
 * the report cannot be written outside it.)
 */
export async function vitestCount(
  root: string,
  dir: string,
  files: string[],
  run: ConfinedRun = (command, args, where) =>
    runConfined(command, args, { root: where, timeoutMs: 300_000 }),
): Promise<{ passed: number; total: number }> {
  const out = join(dir, `.sekhemet-bench-report-${randomUUID()}.json`);
  rmSync(out, { force: true });
  // The Worker wrote this code: its tests run confined (SEC-18, security
  // item 5), writing only inside the card's repository. Failing tests exit
  // non-zero; the report says how many passed.
  await run(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      ...files,
      "--reporter=json",
      `--outputFile=${out}`,
    ],
    dir,
  ).catch(() => undefined);
  try {
    const r = JSON.parse(readFileSync(out, "utf8")) as {
      numPassedTests?: number;
      numTotalTests?: number;
    };
    return { passed: r.numPassedTests ?? 0, total: r.numTotalTests ?? 0 };
  } catch {
    return { passed: 0, total: 0 };
  } finally {
    rmSync(out, { force: true });
  }
}

/** `fixture/card` → its parts. */
function splitId(id: string, item?: ScreeningItem): { fixture: string; card: string } {
  const fixture = item?.fixture ?? id.split("/")[0] ?? "";
  const card = item?.card ?? id.split("/").slice(1).join("/");
  if (!fixture || !card) throw new Error(`${id} does not name a frozen-suite card (fixture/card)`);
  return { fixture, card };
}

/** The runs this process's cards are prepared under, to keep their directories apart. */
let counter = 0;

/** Run one card in its prepared repository with a model, and count its acceptance tests. */
export async function runSuiteCard(
  deps: SuiteRunnerDeps,
  o: {
    repo: string;
    cardId: string;
    worker: LocalInferenceAdapter;
    runProfile: RunProfile;
    secondsBudget?: number;
    guidance?: string;
    expectedTests?: number;
  },
): Promise<SuiteCardRun> {
  const now = deps.now ?? (() => Date.now());
  const db = new DatabaseSync(join(o.repo, ".sekhemet", "events.db"));
  try {
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    const ctx: ExecutionContext = {
      repoPath: o.repo,
      restrictedMode: false,
      cardStore,
      boardService: new BoardServiceImpl(cardStore),
      log: deps.log ?? (() => undefined),
      runProfile: o.runProfile,
      measurement: {
        purpose: "benchmark",
        by: "benchmark_runner.ts",
        createdAt: new Date().toISOString(),
      },
      ...(deps.headroomCheck === false ? { headroomCheck: false } : {}),
      // Gates rule 6a (lead ruling): the suite's staged tests are external, as
      // the frozen suite names them — this run's own switch, never the process's.
      acceptanceTestsOrigin: "external",
    };
    const card = await cardStore.getCard(o.cardId);
    if (!card) throw new Error(`${o.cardId} is not on the prepared board`);
    const run = o.secondsBudget !== undefined ? { ...card, secondsBudget: o.secondsBudget } : card;
    const started = now();
    const result = await executeCard(ctx, run, o.worker, o.guidance);
    const seconds = Math.round((now() - started) / 100) / 10;
    const files = (card.acceptanceTests ?? []).map((t) => `tests/${t}`);
    const where = existsSync(result.worktreePath) ? result.worktreePath : o.repo;
    const counted = await (deps.countTests ?? ((d, f) => vitestCount(deps.harnessRoot, d, f)))(
      where,
      files,
    );
    // A file that fails to load reports no tests: the card's declared count is the denominator.
    const total = Math.max(counted.total, o.expectedTests ?? 0);
    const observations = result.turns.flatMap((t) => t.observations);
    return {
      passed: result.passed,
      testsPassed: Math.min(counted.passed, total),
      testsTotal: total,
      seconds,
      stopReason: String(result.stopReason),
      capped: result.stopReason === "time_budget_exhausted",
      toolCalls: result.turns.reduce((n, t) => n + t.toolCalls.length, 0),
      validToolCalls: observations.filter((ob) => ob.ok).length,
      steps: result.turns.length,
      worktreePath: result.worktreePath,
      cardId: o.cardId,
    };
  } finally {
    db.close();
  }
}

/** The adapters a runner loaded, one model resident at a time; `release` unloads them all. */
class Loaded {
  private readonly held = new Map<string, LocalInferenceAdapter>();

  constructor(private readonly deps: SuiteRunnerDeps) {}

  public async get(
    role: ModelRole,
    model: string,
    exclusive = false,
  ): Promise<LocalInferenceAdapter> {
    const key = `${role}\0${model}`;
    const have = this.held.get(key);
    if (have) return have;
    if (exclusive) await this.release();
    const a = await this.deps.adapterFor(role, model);
    this.held.set(key, a);
    return a;
  }

  public async release(): Promise<void> {
    const all = [...this.held.entries()];
    this.held.clear();
    for (const [key, a] of all) {
      const [role, model] = key.split("\0") as [ModelRole, string];
      if (this.deps.releaseModel) await this.deps.releaseModel(role, model).catch(() => undefined);
      else await (a as { unload?: () => Promise<void> }).unload?.().catch(() => undefined);
    }
  }
}

async function withCardRepo<T>(
  deps: SuiteRunnerDeps,
  id: string,
  item: ScreeningItem | undefined,
  fn: (repo: string, cardId: string) => Promise<T>,
): Promise<T> {
  const { fixture, card } = splitId(id, item);
  const repo = join(deps.workDir, `${safe(id)}-${process.pid}-${++counter}`);
  try {
    await prepareCardRepo(deps.harnessRoot, fixture, card, repo);
    return await fn(repo, card);
  } finally {
    if (!deps.keep) rmSync(repo, { recursive: true, force: true });
  }
}

/** A plan for the card from the combination's Planner, which the Worker is given (MS-N5-7). */
async function plannerPlan(
  planner: LocalInferenceAdapter,
  spec: string,
  title: string,
): Promise<string> {
  const res = await planner.generate({
    systemPrompt: plannerCopy.benchmarkPlanSystem,
    prompt: `Card: ${title}\n\n${spec}`,
    toolArm: "arm_a_flat",
    temperature: 0.1,
    maxTokens: 600,
  });
  // MD-N4-8: the one strip, in the models package.
  return stripReasoning(res.text).trim().slice(0, 4000);
}

/** The quick screen's runner (rule 31): Worker cards on real fixtures, the end-to-end check. */
export function suiteScreenRunner(deps: SuiteRunnerDeps): ScreenRunner {
  const loaded = new Loaded(deps);
  const now = deps.now ?? (() => Date.now());
  return {
    async load(role, model) {
      const t = now();
      const a = await loaded.get(role, model, true);
      await a.healthCheck?.();
      return { seconds: (now() - t) / 1000 };
    },
    async runItem({ role, model, item, capSeconds, settings }): Promise<ItemRun> {
      if (role === "reviewer") {
        if (!item.seeded || !item.fixture || !item.card)
          throw new Error(`${item.id} is not a seeded defect: the Reviewer's items are (MS-N8-5)`);
        const reviewer = withRunSettings(await loaded.get(role, model), role, settings);
        const t = now();
        const score = await reviewSeededItem(
          deps.harnessRoot,
          { id: item.id, fixture: item.fixture, card: item.card, ...item.seeded },
          reviewer,
        );
        const seconds = Math.round((now() - t) / 100) / 10;
        return {
          outcome: {
            kind: "detection",
            detectedAtLocation: score.caught,
            falseFindings: score.falsePositives,
          },
          seconds,
          ...(score.failed !== undefined ? { stopReason: "review_failed" } : {}),
        };
      }
      if (role !== "worker")
        throw new Error(
          `the ${role}'s screening items are not run by this runner until its set is built (rule 30a)`,
        );
      const worker = withRunSettings(await loaded.get(role, model), role, settings);
      return withCardRepo(deps, item.id, item, async (repo, cardId) => {
        const r = await runSuiteCard(deps, {
          repo,
          cardId,
          worker,
          runProfile: profileWithSettings(deps.runProfile(), settings),
          secondsBudget: capSeconds,
          ...(item.tests !== undefined ? { expectedTests: item.tests } : {}),
        });
        return {
          outcome: { kind: "tests", passed: r.testsPassed, total: r.testsTotal },
          seconds: r.seconds,
          capped: r.capped,
          stopReason: r.stopReason,
          toolCalls: r.toolCalls,
          validToolCalls: r.validToolCalls,
          steps: r.steps,
        };
      });
    },
    async endToEnd({ combination, card, capSeconds }) {
      await loaded.release();
      return withCardRepo(deps, card.id, card, async (repo, cardId) => {
        const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
        let record: Awaited<ReturnType<CardStore["getCard"]>>;
        try {
          record = await new CardStore(db, new EventLog(db)).getCard(cardId);
        } finally {
          db.close();
        }
        if (!record) throw new Error(`${cardId} is not on the prepared board`);
        const settings = (combination as SettingsCombination).settings ?? {};
        const planner = withRunSettings(
          await loaded.get("planner", combination.planner, true),
          "planner",
          settings.planner,
        );
        const guidance = await plannerPlan(planner, record.spec ?? "", record.title);
        const worker = withRunSettings(
          await loaded.get("worker", combination.worker, true),
          "worker",
          settings.worker,
        );
        const r = await runSuiteCard(deps, {
          repo,
          cardId,
          worker,
          runProfile: profileWithSettings(deps.runProfile(combination), settings.worker),
          secondsBudget: capSeconds,
          guidance,
          ...(card.tests !== undefined ? { expectedTests: card.tests } : {}),
        });
        let sentBack = false;
        let reviewFailed: string | undefined;
        if (r.passed && combination.reviewer) {
          const reviewer = withRunSettings(
            await loaded.get("reviewer", combination.reviewer, true),
            "reviewer",
            settings.reviewer,
          );
          let diff = "";
          try {
            // The card's worktree: the guarded git environment, no external diff or textconv (items 19, 20).
            diff = execFileSync(
              "git",
              ["-C", r.worktreePath, "diff", "--no-ext-diff", "--no-textconv", "main"],
              { encoding: "utf8", env: gitEnvFor(r.worktreePath) },
            );
          } catch {
            // No worktree left: the Reviewer reads the card without its diff.
          }
          // Judged against the card's criteria (RG-P8-1): an unmet finding sends it back.
          // A review that failed — cut off, unreadable, or not run — is a failed
          // card with its reason, never a clean pass (F25, RG-P8-16).
          try {
            const review = await reviewCard(reviewer, {
              card: record,
              diff,
              preferences: [],
              rules: [],
            });
            sentBack = review.findings.some((f) => f.verdict === "unmet");
          } catch (err) {
            reviewFailed = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          passed: r.passed && !sentBack && reviewFailed === undefined,
          seconds: r.seconds,
          capped: r.capped,
          stopReason:
            reviewFailed !== undefined
              ? "review_failed"
              : sentBack
                ? "review_send_back"
                : r.stopReason,
          ...(reviewFailed !== undefined ? { reviewFailed } : {}),
        };
      });
    },
    release: () => loaded.release(),
  };
}

/**
 * The overnight tier's runner (rule 37): the combination's Worker loaded once
 * per block, each frozen-suite card run with its run's fixed seed, cut at the
 * window's end.
 */
export function suiteOvernightRunner(deps: SuiteRunnerDeps): OvernightRunner {
  const loaded = new Loaded(deps);
  const now = deps.now ?? (() => Date.now());
  let defects: SeededDefect[] | undefined;
  return {
    async swapTo(combination) {
      await loaded.get("worker", combination.worker, true);
    },
    async runCard({ combination, card, run, seed, deadline }) {
      const settings = (combination as SettingsCombination).settings ?? {};
      if (card.role === "reviewer" && combination.reviewer) {
        // The Reviewer's full set: every registered seeded defect (MS-N8-5).
        defects ??= loadSeededDefects(deps.harnessRoot).items;
        const d = defects.find((x) => x.id === card.id);
        if (!d) throw new Error(`${card.id} is not in the registered seeded-defect set`);
        const reviewer = withRunSettings(
          await loaded.get("reviewer", combination.reviewer, true),
          "reviewer",
          settings.reviewer,
        );
        const t = now();
        const score = await reviewSeededItem(deps.harnessRoot, d, reviewer);
        deps.log?.(
          `overnight run ${run}: ${card.id} ${score.failed !== undefined ? `review failed (${score.failed})` : score.caught ? "caught" : "missed"}`,
        );
        return { passed: score.caught, seconds: Math.round((now() - t) / 100) / 10 };
      }
      if (card.role !== "worker")
        throw new Error(
          `the ${card.role}'s full evaluation set is not run by this runner yet (rule 30a)`,
        );
      const worker = withRunSettings(
        await loaded.get("worker", combination.worker, true),
        "worker",
        settings.worker,
      );
      const profile = profileWithSettings(deps.runProfile(combination), {
        ...settings.worker,
        seed,
      });
      const left =
        deadline !== undefined ? Math.max(1, Math.floor((deadline - now()) / 1000)) : undefined;
      return withCardRepo(deps, card.id, undefined, async (repo, cardId) => {
        const r = await runSuiteCard(deps, {
          repo,
          cardId,
          worker,
          runProfile: profile,
          ...(left !== undefined ? { secondsBudget: left } : {}),
        });
        deps.log?.(
          `overnight run ${run}: ${card.id} ${r.passed ? "passed" : `failed (${r.stopReason})`}`,
        );
        return {
          passed: r.passed,
          seconds: r.seconds,
          // Stopped by the window's end, not by its own work: it runs again next night.
          ...(left !== undefined && r.capped ? { cutAtWindowEnd: true } : {}),
        };
      });
    },
    release: () => loaded.release(),
  };
}
