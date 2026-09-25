import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type RunProfile,
  type SuiteRunResult,
  queueInvocation,
  scoreCardProfiles,
} from "@sekhemet/eval";
import { effectiveConfig, queueDefaults } from "./config_apply.js";
import { profileForQueue } from "./measure_cmd.js";

/**
 * The profile a fixture repository's queue resolves for a run (SUITE_RUNS,
 * B2.5 ref-r1): the run's settings as the suite passes them to the queue
 * (`queueInvocation`), plus that repository's configuration layer — the
 * same resolution `sekhemet queue` makes. A card whose recorded profile
 * differs from this ran with something other than the run's settings and
 * its repository's configuration, and is named.
 *
 * `tunedStepBudget` is the budget `tune --apply` left in the repository
 * before the run; a fresh fixture copy has none, and one applied during the
 * run is a divergence, so callers after the run leave it out.
 */
export function expectedQueueProfile(
  repo: string,
  run: RunProfile,
  tunedStepBudget?: number,
): RunProfile {
  const { args, env } = queueInvocation(run, repo);
  return profileForQueue(
    args,
    env,
    queueDefaults(effectiveConfig(repo, args).config, []),
    tunedStepBudget,
  );
}

/** The repositories a run's fixture used: its own copy, or one per card in independent mode. */
function fixtureRepos(workDir: string, fixture: string): string[] {
  if (!existsSync(workDir)) return [];
  return readdirSync(workDir)
    .filter((d) => d === fixture || d.startsWith(`${fixture}__`))
    .sort()
    .map((d) => join(workDir, d))
    .filter((d) => existsSync(join(d, ".sekhemet", "evidence")));
}

/**
 * `sekhemet measure rescore <result.json> --work <dir> [--out <file>]`:
 * recompute an existing suite result's `profileMismatch` and `cardProfiles`
 * from its work directory's card evidence, for runs the suite script scored
 * without each repository's configuration layer (ref-r1 and later). Reads
 * only; writes the rescored result next to the original
 * (`<name>.rescored.json`), never over it.
 *
 * The configuration read is the repository's and this host's user config as
 * they are now; a tuned budget found in the work dir was applied during the
 * run (fixture copies start without one) and is not part of the expectation.
 */
export function rescoreSuiteResult(
  resultPath: string,
  workDir: string,
  out = join(dirname(resultPath), `${basename(resultPath).replace(/\.json$/, "")}.rescored.json`),
): {
  out: string;
  cards: number;
  profileMismatch: string[];
  differences: Record<string, string[]>;
  previous: string[];
} {
  if (resolve(out) === resolve(resultPath))
    throw new Error(`rescore writes next to ${resultPath}, never over it`);
  const text = readFileSync(resultPath, "utf8");
  const result = JSON.parse(text) as SuiteRunResult;
  const run = result.runProfile;
  if (!run)
    throw new Error(`${resultPath} records no RunProfile (rule 9a); nothing to score against`);
  const fixtures = [...new Set(result.outcomes.map((o) => o.task.suite))];
  const cards: { card: string; expected: RunProfile; recorded?: RunProfile }[] = [];
  let repos = 0;
  for (const fixture of fixtures) {
    for (const repo of fixtureRepos(workDir, fixture)) {
      repos++;
      const expected = expectedQueueProfile(repo, run);
      const evidence = join(repo, ".sekhemet", "evidence");
      for (const f of readdirSync(evidence).sort()) {
        const m = /^latest-(.+)\.json$/.exec(f);
        if (!m) continue;
        const repro = JSON.parse(readFileSync(join(evidence, f), "utf8")).reproducibility;
        cards.push({ card: `${fixture}/${m[1]}`, expected, recorded: repro?.runProfile });
      }
    }
  }
  if (!repos)
    throw new Error(
      `${workDir} holds no fixture repository of this run (${fixtures.join(", ")}); pass the run's --work directory`,
    );
  const scored = scoreCardProfiles(cards);
  const { profileMismatch: previous = [], ...rest } = result;
  const rescored: SuiteRunResult = {
    ...rest,
    ...(scored.profileMismatch.length ? { profileMismatch: scored.profileMismatch } : {}),
    cardProfiles: scored.cardProfiles,
    rescored: {
      from: basename(resultPath),
      sha256: createHash("sha256").update(text).digest("hex"),
      at: new Date().toISOString(),
      previousProfileMismatch: previous,
    },
  };
  writeFileSync(out, `${JSON.stringify(rescored, null, 2)}\n`);
  return {
    out,
    cards: Object.keys(scored.cardProfiles).length,
    profileMismatch: scored.profileMismatch,
    differences: scored.differences,
    previous,
  };
}
