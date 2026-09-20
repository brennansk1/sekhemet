import type { LocalInferenceAdapter, ModelRegistry, ToolArm } from "@sekhemet/models";
import { type QualificationResult, checkExecutionHeadroom, qualifyModel } from "@sekhemet/models";

/**
 * Phase 0: the go/no-go.
 *
 * The design opens its build phases with a sentence the rest of the document
 * depends on — "nothing is built before the reliability spike answers whether
 * a local model can execute a card unattended on this hardware" — and every
 * quality claim after it assumes the answer was yes. This is the measurement
 * that answers it.
 *
 * It asks one question: **on its best arm, how often does this model emit a
 * tool call that is valid and correct?** Not how often it solves a task —
 * that is M0, it is downstream of this, and it cannot be interpreted until
 * this number exists. A model that cannot reliably call a tool cannot run a
 * card unattended whatever its reasoning is like, and no amount of harness
 * scaffolding fixes it.
 *
 * The thresholds are the design's, and the verdicts are about the product
 * rather than the model:
 *
 * - **go** at 90%: build the harness as specified.
 * - **rework** between 70 and 90: a smaller tool set, or a different model.
 *   The thesis holds, this candidate or this catalog does not.
 * - **pivot** below 70: the Worker cannot run unattended, and the product
 *   narrows to planning and review assistance.
 *
 * The verdict is recorded with the arm that earned it, because the number is
 * meaningless without it: the same model measures differently across arms,
 * and picking the arm by reputation instead of by measurement is the mistake
 * this whole exercise exists to avoid.
 */

export type Phase0Verdict = "go" | "rework" | "pivot" | "inconclusive";

export const PHASE0_GO = 0.9;
export const PHASE0_REWORK = 0.7;

export interface Phase0Result {
  modelId: string;
  /** The arm that scored highest; the verdict belongs to this arm alone. */
  arm: ToolArm;
  verdict: Phase0Verdict;
  /** Valid-and-correct rate on the winning arm, in [0, 1]. */
  rate: number;
  byCategory: Record<string, number>;
  /** Every arm tried, best first, so a close second is visible. */
  arms: { arm: ToolArm; rate: number }[];
  /** What the verdict means for the build, in one sentence. */
  consequence: string;
  cases: number;
  at: string;
}

export function verdictFor(rate: number): Phase0Verdict {
  if (rate >= PHASE0_GO) return "go";
  return rate >= PHASE0_REWORK ? "rework" : "pivot";
}

const CONSEQUENCE: Record<Phase0Verdict, string> = {
  inconclusive:
    "Nothing was measured: the requests did not reach a model. Fix the endpoint and run it again — this is not a result about the model.",
  go: "Build the harness as specified: the Worker can be trusted to run a card unattended.",
  rework:
    "The thesis holds but this configuration does not. Try a smaller tool set or a different candidate before building further on it.",
  pivot:
    "The Worker cannot run unattended on this hardware. The product narrows to planning and review assistance, and the autonomous path is not viable as specified.",
};

/**
 * Run the qualification suite across every arm the adapter supports and
 * return the verdict. All three arms are measured rather than the usual two:
 * this is the one run whose whole purpose is to find the best arm, so
 * excluding one to save time would beg the question it exists to answer.
 */
export async function runPhase0(
  adapter: LocalInferenceAdapter,
  options: { registry?: ModelRegistry; arms?: ToolArm[]; force?: boolean } = {},
): Promise<Phase0Result> {
  // Phase 0 loads a model and holds it for the whole suite. On a machine
  // already under pressure that is how a measurement takes the host with it,
  // so the same guard the card loop uses runs before the first request
  // rather than after the first stall.
  const headroom = checkExecutionHeadroom(undefined);
  if (!headroom.ok && options.force !== true) {
    throw new Error(
      `Phase 0 refused to start: ${headroom.reason}. Free memory and retry, or pass force to override.`,
    );
  }
  const arms = options.arms ?? adapter.supportedArms;
  const { results, best } = await qualifyModel(adapter, {
    arms,
    ...(options.registry ? { registry: options.registry } : {}),
  });
  // A run where every case failed to reach the model scores 0% and reads as
  // the worst possible verdict about the model, when it is a verdict about
  // the wiring. Phase 0's number is the one the whole product thesis rests
  // on, so it must never be reportable from a broken endpoint.
  const unreachable = best.cases.every((c) => c.detail?.startsWith("request failed"));
  const verdict: Phase0Verdict = unreachable ? "inconclusive" : verdictFor(best.passRate);
  if (unreachable) {
    const why = best.cases[0]?.detail ?? "every request failed";
    throw new Error(`Phase 0 measured nothing: ${why}. ${CONSEQUENCE.inconclusive}`);
  }
  return {
    modelId: adapter.modelId,
    arm: best.arm,
    verdict,
    rate: best.passRate,
    byCategory: best.byCategory,
    arms: [...results]
      .sort((a: QualificationResult, b: QualificationResult) => b.passRate - a.passRate)
      .map((r) => ({ arm: r.arm, rate: r.passRate })),
    consequence: CONSEQUENCE[verdict],
    cases: best.cases.length,
    at: new Date().toISOString(),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The report, written so that the verdict cannot be missed or softened. */
export function formatPhase0(r: Phase0Result): string {
  const lines = [
    `Phase 0 — ${r.modelId}`,
    "",
    `  Verdict:  ${r.verdict.toUpperCase()}  (${pct(r.rate)} valid-and-correct on ${r.arm})`,
    `  Means:    ${r.consequence}`,
    "",
    `  Thresholds: go >= ${pct(PHASE0_GO)}, rework >= ${pct(PHASE0_REWORK)}, pivot below`,
    `  Cases:      ${r.cases}`,
    "",
    "  By arm:",
    ...r.arms.map(
      (a) => `    ${a.arm.padEnd(14)} ${pct(a.rate)}${a.arm === r.arm ? "  <- best" : ""}`,
    ),
    "",
    "  By category, on the winning arm:",
    ...Object.entries(r.byCategory).map(([k, v]) => `    ${k.padEnd(20)} ${pct(v)}`),
  ];
  return lines.join("\n");
}
