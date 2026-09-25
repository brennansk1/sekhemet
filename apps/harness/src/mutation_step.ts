import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Mutant, generateMutants, runMutationCampaign } from "@sekhemet/eval";
import { DeterministicGateRunner, loadGatesConfig, mutationNotMeasured } from "@sekhemet/gates";
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

function testGates(repo: string): (cwd: string) => Promise<boolean> {
  return async (cwd) => {
    const config = loadGatesConfig(existsSync(join(cwd, ".sekhemet", "gates.toml")) ? cwd : repo);
    const runner = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: cwd,
      expectedConfigSha256: config.sha256,
    });
    return (await runner.runGates(["test"], cwd)).passed;
  };
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
