import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Mutant, generateMutants, runMutationCampaign } from "@sekhemet/eval";
import {
  BASELINE_EVENT,
  type BaselineEntry,
  DeterministicGateRunner,
  type GateRung,
  type GateRunner,
  type MutationMeasure,
  baselineFromEvents,
  loadGatesConfig,
  mutationNotMeasured,
  readMutationQueue,
  runNightlyMutation,
  withBaseline,
} from "@sekhemet/gates";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";

/**
 * Loop 10, gate hardening (E16, design "The ten self-improvement loops"):
 * the diff of each accepted card is mutated in a throwaway checkout of the
 * accepted commit, the project's test gates run against every mutant, and
 * each surviving mutant becomes a concrete test proposal. The proposals go
 * on one backlog card labelled `advisory`: generated tests stay advisory
 * until a person promotes them (the loop's rollback). The signal (mutation
 * score, survivors) is on the ledger as `improve/mutation`.
 *
 * Run by `sekhemet improve --mutants` and at the end of `sekhemet overnight`.
 */
export interface MutationRun {
  cardId: string;
  sha: string;
  total: number;
  killed: number;
  /**
   * Killed over total (M10): `null` when it is not measured — the tests fail
   * on the unmutated checkout (`refused`) or the change has no mutable
   * lines — never 1.
   */
  score: number | null;
  survived: (Pick<Mutant, "line" | "original" | "replacement" | "operator"> & { file: string })[];
  /** Why the campaign was not scored (MS-M10-1). */
  refused?: string;
  /** Changed code files in a language the campaign cannot mutate (MS-M10-3). */
  notMeasured?: string[];
  proposalCardId?: string;
}

export interface MutationStepOptions {
  /** Accepted cards per run (most recent first). */
  limit?: number;
  /** Mutants per card. */
  maxMutants?: number;
  /** True when the tests pass in `cwd` (the mutant survived). Default: the test gates. */
  runTests?: (cwd: string) => Promise<boolean>;
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
/** Changed code files the campaign cannot mutate, sorted. */
export function unmutableCodeFiles(repo: string, sha: string): string[] {
  return (
    git(repo, "show", "--name-only", "--format=", sha)
      .split("\n")
      // One rule with the mutation gate (MS-M10-3).
      .filter((f) => mutationNotMeasured(f) !== undefined)
      .sort()
  );
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

/** Lines each source file gained in a commit. */
export function addedSourceLines(repo: string, sha: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file = "";
  for (const line of git(repo, "show", "--unified=0", "--format=", sha).split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : "";
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!h || !file || !SOURCE.test(file) || TEST.test(file)) continue;
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    const lines = out.get(file) ?? [];
    for (let i = 0; i < count; i++) lines.push(start + i);
    out.set(file, lines);
  }
  return out;
}

/** The onboarding baseline in force, as the card's own verification reads it (rule 15a). */
interface BaselineInForce {
  entries: BaselineEntry[];
  gatesSha256?: string;
}

function testGates(
  repo: string,
  rung: GateRung = "test",
  baseline?: BaselineInForce,
): (cwd: string) => Promise<boolean> {
  return async (cwd) => {
    const config = loadGatesConfig(existsSync(join(cwd, ".sekhemet", "gates.toml")) ? cwd : repo);
    let runner: GateRunner = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: cwd,
      expectedConfigSha256: config.sha256,
    });
    // A pre-existing failure the baseline records is not the tree's to answer for.
    if (baseline && baseline.entries.length > 0) {
      runner = withBaseline(runner, {
        baseline: baseline.entries,
        gatesSha256: baseline.gatesSha256,
        currentGatesSha256: config.sha256,
      });
    }
    return (await runner.runGates([rung], cwd)).passed;
  };
}

/** The ledger event carrying a card's completed nightly mutation score (GT-N5-5). */
export const MUTATION_COMPLETED = "card/mutation_completed";

export interface NightlyMutationRun {
  /** The queue file, repository-relative. */
  queue: string;
  cardId?: string;
  /** The full score, written back to the queue and onto the card's ledger. */
  measure?: MutationMeasure;
  /** Why the queue was not run tonight; it stays queued. */
  skipped?: string;
}

/**
 * The nightly run of the mutants a card's verification deferred past
 * `mutation_max` (gates rule 32, GT-N5-5; runtime.md): each queue not yet
 * completed is run on the card's tree — its worktree while it exists, else
 * a throwaway checkout of its accepted commit — through `runNightlyMutation`
 * (the unmutated suite first; a mutant whose file changed is `stale`). The
 * full score is recorded on the card's ledger as `card/mutation_completed`
 * and only then written back to the queue as `completed`, so a run stopped
 * between the two runs the queue again. The card's evidence bundle, written
 * at verification, is not rewritten: it holds the partial score and the
 * queue's path, and the ledger event holds the full one. A queue with no tree
 * to run on is skipped, never scored.
 */
export async function runQueuedMutations(
  repo: string,
  log: EventLog,
  opts: {
    runTests?: (cwd: string) => Promise<boolean>;
    runTypecheck?: (cwd: string) => Promise<boolean>;
  } = {},
): Promise<NightlyMutationRun[]> {
  const dir = join(repo, ".sekhemet", "nightly", "mutation");
  if (!existsSync(dir)) return [];
  // The typecheck a stillborn verdict rests on is read through the onboarding
  // baseline, as the card's verification reads it; it must still pass on the
  // unmutated tree before any mutant is judged stillborn (GT-TQ-4).
  const baseline = baselineFromEvents(
    await log.getEventsByTypes([BASELINE_EVENT, "card/accepted"]),
  );
  const runTests = opts.runTests ?? testGates(repo, "test", baseline);
  const runTypecheck = opts.runTypecheck ?? testGates(repo, "typecheck", baseline);
  const accepted = new Map(
    (await log.getEventsByTypes(["card/accepted"]))
      .map((e) => [e.cardId ?? "", (e.payload as { sha?: string }).sha] as const)
      .filter((a): a is readonly [string, string] => !!a[0] && typeof a[1] === "string"),
  );
  const runs: NightlyMutationRun[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const path = join(dir, file);
    const queue = relative(repo, path);
    const q = readMutationQueue(path);
    if (!q || q.completed) continue;
    const cardId = q.cardId;
    const run: NightlyMutationRun = { queue, ...(cardId ? { cardId } : {}) };
    runs.push(run);
    if (!cardId) {
      run.skipped = "the queue names no issue";
      continue;
    }
    const worktree = join(repo, ".sekhemet", "worktrees", cardId);
    const sha = accepted.get(cardId);
    let tree: string | undefined = existsSync(worktree) ? worktree : undefined;
    let checkout: string | undefined;
    if (!tree && sha) {
      checkout = join(repo, ".sekhemet", "mutation", `nightly-${cardId}`);
      rmSync(checkout, { recursive: true, force: true });
      try {
        git(repo, "worktree", "add", "-q", "--detach", checkout, sha);
        tree = checkout;
      } catch {
        checkout = undefined;
      }
    }
    if (!tree) {
      run.skipped = "neither the issue's worktree nor an accepted commit to run on";
      continue;
    }
    const root = tree;
    // A mutant the typecheck rejects is stillborn only where the project
    // declares a typecheck: a rung with no gate is not run, never a verdict.
    const declared = loadGatesConfig(
      existsSync(join(root, ".sekhemet", "gates.toml")) ? root : repo,
    ).gates.some((g) => g.rung === "typecheck");
    try {
      run.measure = await runNightlyMutation({
        queue: path,
        root,
        runTests: () => runTests(root),
        ...(opts.runTypecheck || declared ? { runTypecheck: () => runTypecheck(root) } : {}),
        // The ledger first: the queue is marked complete only once its score is recorded.
        beforeComplete: async (measure) => {
          await log.append({
            actor: "system",
            type: MUTATION_COMPLETED,
            cardId,
            payload: { queue, measure },
          });
        },
      });
    } catch (err) {
      run.skipped = `the nightly run failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (checkout) {
        try {
          git(repo, "worktree", "remove", "--force", checkout);
        } catch {
          rmSync(checkout, { recursive: true, force: true });
        }
      }
    }
  }
  return runs;
}

export async function mutateAcceptedCards(
  repo: string,
  store: CardStore,
  log: EventLog,
  opts: MutationStepOptions = {},
): Promise<MutationRun[]> {
  const done = new Set(
    (await log.getEventsByTypes(["improve/mutation"])).map((e) => e.cardId ?? ""),
  );
  const accepted = (await log.getEventsByTypes(["card/accepted"]))
    .map((e) => ({ cardId: e.cardId ?? "", sha: (e.payload as { sha?: string }).sha }))
    .filter((a): a is { cardId: string; sha: string } => !!a.sha && !done.has(a.cardId))
    .reverse()
    .slice(0, opts.limit ?? 3);
  const runTests = opts.runTests ?? testGates(repo);
  const runs: MutationRun[] = [];

  for (const { cardId, sha } of accepted) {
    const checkout = join(repo, ".sekhemet", "mutation", cardId);
    rmSync(checkout, { recursive: true, force: true });
    const run: MutationRun = { cardId, sha, total: 0, killed: 0, score: null, survived: [] };
    const notMeasured = unmutableCodeFiles(repo, sha);
    if (notMeasured.length) run.notMeasured = notMeasured;
    const proposals: string[] = [];
    try {
      git(repo, "worktree", "add", "-q", "--detach", checkout, sha);
      // MS-M10-1: the baseline run. Tests that already fail kill every mutant,
      // and a broken checkout would score 1.0.
      if (!(await runTests(checkout))) {
        run.refused = `the tests fail on the unmutated checkout of ${sha.slice(0, 10)}, so no mutant can be scored`;
      }
      let budget = run.refused ? 0 : (opts.maxMutants ?? 8);
      for (const [file, lines] of addedSourceLines(repo, sha)) {
        if (budget <= 0) break;
        const abs = join(checkout, file);
        if (!existsSync(abs)) continue;
        const original = readFileSync(abs, "utf8");
        const mutants = generateMutants(original, { lines, max: budget, fileName: file });
        budget -= mutants.length;
        const report = await runMutationCampaign(file, mutants, async (source) => {
          writeFileSync(abs, source);
          try {
            return await runTests(checkout);
          } finally {
            writeFileSync(abs, original);
          }
        });
        run.total += report.total;
        run.killed += report.killed;
        for (const m of report.survived)
          run.survived.push({
            file,
            line: m.line,
            original: m.original,
            replacement: m.replacement,
            operator: m.operator,
          });
        proposals.push(...report.proposals);
      }
    } finally {
      try {
        git(repo, "worktree", "remove", "--force", checkout);
      } catch {
        rmSync(checkout, { recursive: true, force: true });
        try {
          git(repo, "worktree", "prune");
        } catch {
          // nothing registered
        }
      }
    }
    run.score =
      run.refused || run.total === 0 ? null : Math.round((run.killed / run.total) * 1000) / 1000;
    if (proposals.length > 0) {
      const card = await store.getCard(cardId);
      const proposal = await store.createCard(
        {
          tier: "task",
          title: `Pin the behaviour of ${card?.title ?? cardId} (${proposals.length} mutant(s) survive)`,
          status: "backlog",
          spec: [
            `Mutation testing of ${cardId} (${sha.slice(0, 10)}) found behaviour its tests do not pin down (score ${run.score}). Add one test per line below; they stay advisory until a person promotes them.`,
            ...proposals.map((p) => `- ${p}`),
          ].join("\n"),
          acceptanceCriteria: proposals,
          scopeFiles: [...new Set(run.survived.map((s) => s.file))],
          labels: ["mutation-hardening", "advisory", `mutants-of:${cardId}`],
        },
        "system",
      );
      run.proposalCardId = proposal.id;
    }
    await log.append({
      actor: "system",
      type: "improve/mutation",
      cardId,
      payload: {
        sha,
        total: run.total,
        killed: run.killed,
        score: run.score,
        survived: run.survived,
        ...(run.refused ? { refused: run.refused } : {}),
        ...(run.notMeasured ? { notMeasured: run.notMeasured } : {}),
        ...(run.proposalCardId ? { proposalCardId: run.proposalCardId } : {}),
      },
    });
    runs.push(run);
  }
  return runs;
}
