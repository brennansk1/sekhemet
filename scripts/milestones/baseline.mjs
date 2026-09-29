/**
 * B2.5's reading of the baseline (SUITE_RUNS "B2.5 baseline schedule"): the
 * driver's results under `~/.sekhemet/baseline/results`, read only — the
 * runner never writes there, never starts or touches the driver.
 *
 * The milestone is "one RunProfile, the full suite and the planning measure,
 * every failure named". So it passes only when every arm the schedule names
 * (`arms/<arm>.json`) has each of its rounds, every failed card carries a
 * named cause, a planning-measure result is present, and the frozen
 * RunProfile is recorded in SUITE_RUNS.md under a heading
 * `## Baseline RunProfile (frozen …)`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { check, verdictOf } from "./core.mjs";

const RUN = /^(.+)-r(\d+)(\.rescored)?\.json$/;

export function summarizeBaseline(options = {}) {
  const root = options.root ?? join(homedir(), ".sekhemet", "baseline");
  const rounds = options.rounds ?? 2;
  const results = join(root, "results");
  const armsDir = join(root, "arms");
  const arms = existsSync(armsDir)
    ? readdirSync(armsDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".ab.json"))
        .map((f) => f.slice(0, -".json".length))
        .sort()
    : [];
  const files = existsSync(results) ? readdirSync(results).sort() : [];

  // One run per arm and round; a rescored result replaces its original.
  const byRun = new Map();
  for (const f of files) {
    const m = RUN.exec(f);
    if (!m || f.startsWith("planning")) continue;
    const key = `${m[1]}-r${m[2]}`;
    if (!byRun.has(key) || m[3]) byRun.set(key, { file: f, arm: m[1], round: Number(m[2]) });
  }
  const runs = [];
  const unnamedFailures = [];
  const hashes = new Set();
  for (const [, run] of [...byRun].sort(([a], [b]) => a.localeCompare(b))) {
    const r = JSON.parse(readFileSync(join(results, run.file), "utf8"));
    const failed = (r.outcomes ?? []).filter((o) => !o.passed);
    for (const o of failed) {
      if (!o.stopReason) unnamedFailures.push(`${run.file}: ${o.task?.cardId ?? "?"}`);
    }
    if (r.suiteHash) hashes.add(r.suiteHash);
    runs.push({
      ...run,
      passed: r.passed,
      total: r.total,
      suiteHash: r.suiteHash,
      profileHash: r.runProfile?.hash,
      switches: r.runProfile?.switches,
      failures: failed.map((o) => `${o.task?.cardId ?? "?"}: ${o.stopReason ?? "unnamed"}`),
      startedAt: r.startedAt,
      finishedAt: r.at,
    });
  }
  const missingRounds = [];
  for (const arm of arms) {
    for (let n = 1; n <= rounds; n++) {
      if (!byRun.has(`${arm}-r${n}`)) missingRounds.push(`${arm}-r${n}`);
    }
  }
  const planningMeasure = files.find((f) => f.startsWith("planning"));
  const suiteRuns =
    options.suiteRuns ??
    readFileSync(
      join(import.meta.dirname, "..", "..", "docs", "reference", "SUITE_RUNS.md"),
      "utf8",
    );
  const frozenProfile = /^## Baseline RunProfile \(frozen/m.test(suiteRuns);

  const checks = [
    check(
      "every arm's rounds",
      arms.length === 0 ? null : missingRounds.length === 0 ? true : null,
      arms.length === 0
        ? "no arms found"
        : missingRounds.length === 0
          ? `${runs.length} runs over ${arms.length} arms`
          : `${runs.length} runs recorded; still to run: ${missingRounds.join(", ")}`,
    ),
    check(
      "every failure named",
      runs.length === 0 ? null : unnamedFailures.length === 0,
      unnamedFailures.length === 0
        ? `${runs.reduce((n, r) => n + r.failures.length, 0)} failures, each with its stop reason`
        : `unnamed: ${unnamedFailures.join(", ")}`,
    ),
    check(
      "one suite hash",
      hashes.size === 0 ? null : hashes.size === 1,
      [...hashes].map((h) => h.slice(0, 12)).join(", ") || "none",
    ),
    check(
      "the planning measure",
      planningMeasure ? true : null,
      planningMeasure ?? "no planning measure yet (it waits on the confirmed golden briefs)",
    ),
    check(
      "the frozen RunProfile in SUITE_RUNS.md",
      frozenProfile ? true : null,
      frozenProfile ? "recorded" : "not frozen yet (the schedule freezes it when it completes)",
    ),
  ];
  const verdict = verdictOf(checks);
  return {
    verdict,
    reason: checks
      .filter((c) => c.ok !== true)
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; "),
    checks,
    arms,
    runs,
    missingRounds,
    unnamedFailures,
    planningMeasure,
    frozenProfile,
  };
}
