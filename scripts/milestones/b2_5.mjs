/**
 * B2.5 — the recorded baseline. Reads `~/.sekhemet/baseline` (results and
 * arms) only; the driver and its runs are never touched.
 */
import { summarizeBaseline } from "./baseline.mjs";

export async function run(flags = []) {
  const at = flags.indexOf("--baseline");
  const s = summarizeBaseline(at >= 0 ? { root: flags[at + 1] } : {});
  return {
    checks: s.checks,
    reason: s.reason,
    details: {
      arms: s.arms,
      runs: s.runs.map((r) => ({
        run: r.file,
        passed: r.passed,
        total: r.total,
        profileHash: r.profileHash,
        switches: r.switches,
        failures: r.failures,
        finishedAt: r.finishedAt,
      })),
      missingRounds: s.missingRounds,
      planningMeasure: s.planningMeasure ?? null,
    },
  };
}
