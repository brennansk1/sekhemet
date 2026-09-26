/**
 * The release gate's context-version check (context rule 21a, CX-N6-2): the
 * built context version must be the one stamped on the newest adopted A/B in
 * `SUITE_RUNS.md` — admitted, or "not established — simpler/cheaper"
 * (measurement rule 16c). A prompt, tool or budget-policy change that no
 * paired suite A/B measured fails the gate, naming both versions.
 *
 * An A/B's verdict is stamped in `SUITE_RUNS.md` as one line, which
 * `sekhemet measure admit` prints (`abVerdictLine`):
 *
 *     A/B verdict: not established — cheaper; context version 0123456789abcdef; recorded 2026-09-25
 */
import type { HarnessVerdict } from "@sekhemet/eval";

export interface MeasuredContextVersion {
  verdict: HarnessVerdict;
  version: string;
  /** YYYY-MM-DD. */
  recorded: string;
}

const VERDICTS: readonly HarnessVerdict[] = [
  "admitted",
  "not established — simpler",
  "not established — cheaper",
  "not adopted",
];
const ADOPTED = new Set<HarnessVerdict>(VERDICTS.slice(0, 3));
const LINE =
  /A\/B verdict: (admitted|not established — simpler|not established — cheaper|not adopted); context version ([0-9a-f]{16}); recorded (\d{4}-\d{2}-\d{2})/g;

/** The line an A/B's verdict is recorded with in SUITE_RUNS.md. */
export function abVerdictLine(verdict: HarnessVerdict, version: string, recorded: string): string {
  return `A/B verdict: ${verdict}; context version ${version}; recorded ${recorded}`;
}

/** Every stamped A/B verdict, in file order. */
export function measuredContextVersions(suiteRuns: string): MeasuredContextVersion[] {
  return [...suiteRuns.matchAll(LINE)].map((m) => ({
    verdict: m[1] as HarnessVerdict,
    version: m[2] as string,
    recorded: m[3] as string,
  }));
}

export interface ContextVersionGateResult {
  ok: boolean;
  built: string;
  /** The newest adopted A/B, by recorded date (the first in the file on a tie). */
  newest?: MeasuredContextVersion;
  reason: string;
}

export function contextVersionGate(suiteRuns: string, built: string): ContextVersionGateResult {
  const adopted = measuredContextVersions(suiteRuns).filter((m) => ADOPTED.has(m.verdict));
  const newest = adopted.reduce<MeasuredContextVersion | undefined>(
    (best, m) => (!best || m.recorded > best.recorded ? m : best),
    undefined,
  );
  if (!newest) {
    return {
      ok: false,
      built,
      reason: `context version ${built} is built, and SUITE_RUNS.md records no adopted A/B: run the paired suite A/B (rule 16c) and stamp its verdict`,
    };
  }
  if (newest.version === built) {
    return {
      ok: true,
      built,
      newest,
      reason: `context version ${built} was measured: ${newest.verdict}, ${newest.recorded}`,
    };
  }
  return {
    ok: false,
    built,
    newest,
    reason: `context version ${built} is built, and the newest measured one is ${newest.version} (${newest.verdict}, ${newest.recorded}): the change needs its paired suite A/B (rule 21a)`,
  };
}
