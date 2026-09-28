import type { EventLog } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import {
  type QueryOrigin,
  REUSE_QUERIES_MEASURED,
  reuseQueriesPromptHash,
} from "./capability_queries.js";
import { planResearch } from "./plan_research.js";
import { reuseSurvey } from "./reuse.js";
import {
  type LabelledNeed,
  REUSE_LABELLED_SET,
  normalisedPackage,
  reuseSetHash,
} from "./reuse_set.js";

/**
 * The reuse survey measured on its labelled set (design-stage DS-P7-7):
 * `sekhemet research --reuse-eval [--baseline]`. Each need is surveyed the
 * way `plan` surveys it — the same sources, the same filters, the project's
 * ecosystem — against the real registries, so it runs only with the
 * person's research consent and refuses, sending nothing, without it.
 *
 * - **precision@1**: of the needs labelled with packages, the share whose
 *   first recommended package is one of its labels;
 * - **correct-silence rate**: of the needs labelled none, the share for
 *   which no package is recommended;
 * - **searched silence**: the same, over the none needs the survey searched
 *   (not decided from its built-in words), which is what the relevance,
 *   popularity and licence filters earn.
 *
 * Without `planner` the queries are the fallback's (the need's keywords),
 * so the ranking and filters are measured apart from any model.
 *
 * A need whose search could not run is reported as not measured and left
 * out of both rates — never counted as silence. Every run is recorded as
 * `research/reuse_eval`; `--baseline` marks the run the later ones are
 * compared with, on the same set (its hash) only.
 */

export interface ReuseEvalNeed {
  id: string;
  /** The first package recommended, if any. */
  top?: string;
  correct: boolean;
  /** A source could not be searched: left out of both rates. */
  unmeasured: boolean;
  /** A query was sent for it: not decided from the built-in words. */
  searched: boolean;
  /** Who wrote the queries sent for it, when any were. */
  origin?: QueryOrigin;
}

export interface ReuseEvalResult {
  setHash: string;
  needs: number;
  measured: number;
  /** Undefined when no labelled need could be measured. */
  precisionAt1?: number;
  /** Undefined when no none need could be measured. */
  correctSilence?: number;
  /** Correct silence over the none needs that were searched; undefined when none was. */
  searchedSilence?: number;
  perNeed: ReuseEvalNeed[];
  /** The latest baseline recorded on the same set, when there is one. */
  baseline?: { precisionAt1?: number; correctSilence?: number; seq: number };
  /** Either rate is lower than the baseline's. */
  belowBaseline: boolean;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Unauthenticated GitHub search allows ten requests a minute; a need may send one. */
const DEFAULT_PACE_MS = 6500;

const rate = (hits: number, of: number) => (of === 0 ? undefined : hits / of);

export async function runReuseEval(o: {
  repoPath: string;
  log: EventLog;
  print: (line: string) => void;
  offline?: boolean;
  /** Record this run as the baseline later runs are compared with. */
  baseline?: boolean;
  set?: readonly LabelledNeed[];
  /** Injectable for tests; the product uses the research fetch (network policy, logged). */
  fetchImpl?: Fetch;
  /** Pause between needs, for the registries' rate limits. */
  paceMs?: number;
  /**
   * The Planning model, to measure its capability queries; omitted, the
   * survey's deterministic fallback (the need's keywords) is measured.
   */
  planner?: LocalInferenceAdapter;
  /**
   * False for one arm of `measureReuseQueries`: nothing is recorded as
   * `research/reuse_eval`, and no baseline is compared or said.
   */
  record?: boolean;
}): Promise<ReuseEvalResult | { refused: string }> {
  // Consent first: the same decision as `plan`'s survey, never asked here.
  const said: string[] = [];
  const deps = await planResearch({
    repoPath: o.repoPath,
    log: o.log,
    newProject: false,
    print: (l) => said.push(l),
    ...(o.offline ? { offline: true } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  if (!deps) {
    const refused = `The reuse measurement queries public registries and needs your research consent; nothing was sent. ${said.join(" ")}`;
    o.print(refused);
    return { refused };
  }
  const set = o.set ?? REUSE_LABELLED_SET;
  const setHash = reuseSetHash(set);
  const pace = o.paceMs ?? DEFAULT_PACE_MS;
  const perNeed: ReuseEvalNeed[] = [];
  for (const [i, n] of set.entries()) {
    if (i > 0 && pace > 0) await new Promise((r) => setTimeout(r, pace));
    const [f] = await reuseSurvey([n.need], deps, {
      stack: n.stack,
      ...(o.planner ? { planner: o.planner } : {}),
    });
    const top = f?.libraries[0]?.name;
    const unmeasured = (f?.unsearched.length ?? 0) > 0;
    const searched = f !== undefined && !f.noneNeeded;
    const correct =
      n.expect === "none"
        ? top === undefined
        : top !== undefined && n.expect.map(normalisedPackage).includes(normalisedPackage(top));
    perNeed.push({
      id: n.id,
      ...(top ? { top } : {}),
      correct,
      unmeasured,
      searched,
      ...(f?.origin ? { origin: f.origin } : {}),
    });
    o.print(
      `${n.id}: ${unmeasured ? "not measured (a source could not be searched)" : `${top ?? "nothing recommended"} — ${correct ? "right" : "wrong"}`}`,
    );
  }
  const measured = perNeed.filter((p) => !p.unmeasured);
  const labelled = measured.filter((p) => set.find((n) => n.id === p.id)?.expect !== "none");
  const silent = measured.filter((p) => set.find((n) => n.id === p.id)?.expect === "none");
  const precisionAt1 = rate(labelled.filter((p) => p.correct).length, labelled.length);
  const correctSilence = rate(silent.filter((p) => p.correct).length, silent.length);
  const searchedNone = silent.filter((p) => p.searched);
  const searchedSilence = rate(searchedNone.filter((p) => p.correct).length, searchedNone.length);

  const record = o.record !== false;
  const earlier = (record ? await o.log.getEventsByTypes(["research/reuse_eval"]) : [])
    .filter((e) => {
      const p = e.payload as { setHash?: string; baseline?: boolean };
      return p.setHash === setHash && p.baseline === true;
    })
    .at(-1);
  const b = earlier?.payload as { precisionAt1?: number; correctSilence?: number } | undefined;
  const baseline = earlier
    ? {
        ...(b?.precisionAt1 !== undefined ? { precisionAt1: b.precisionAt1 } : {}),
        ...(b?.correctSilence !== undefined ? { correctSilence: b.correctSilence } : {}),
        seq: earlier.seq,
      }
    : undefined;
  const lower = (now: number | undefined, then: number | undefined) =>
    then !== undefined && (now === undefined || now < then);
  const belowBaseline =
    baseline !== undefined &&
    (lower(precisionAt1, baseline.precisionAt1) || lower(correctSilence, baseline.correctSilence));

  const result: ReuseEvalResult = {
    setHash,
    needs: set.length,
    measured: measured.length,
    ...(precisionAt1 !== undefined ? { precisionAt1 } : {}),
    ...(correctSilence !== undefined ? { correctSilence } : {}),
    ...(searchedSilence !== undefined ? { searchedSilence } : {}),
    perNeed,
    ...(baseline ? { baseline } : {}),
    belowBaseline,
  };
  if (!record) return result;
  await o.log.append({
    actor: "harness",
    type: "research/reuse_eval",
    payload: {
      setHash,
      needs: set.length,
      measured: measured.length,
      ...(precisionAt1 !== undefined ? { precisionAt1 } : {}),
      ...(correctSilence !== undefined ? { correctSilence } : {}),
      ...(searchedSilence !== undefined ? { searchedSilence } : {}),
      baseline: o.baseline === true,
      ...(baseline ? { comparedWith: baseline.seq, belowBaseline } : {}),
    },
    private: { perNeed },
  });
  const pct = (x: number | undefined) =>
    x === undefined ? "not measured" : `${(x * 100).toFixed(0)}%`;
  o.print(
    `precision@1 ${pct(precisionAt1)} on ${labelled.length} labelled needs; correct silence ${pct(correctSilence)} on ${silent.length} none needs (${pct(searchedSilence)} on the ${searchedNone.length} searched); ${set.length - measured.length} not measured.`,
  );
  if (baseline) {
    o.print(
      belowBaseline
        ? `Lower than the baseline (event ${baseline.seq}): precision@1 ${pct(baseline.precisionAt1)}, correct silence ${pct(baseline.correctSilence)}.`
        : `No lower than the baseline (event ${baseline.seq}).`,
    );
  } else if (!o.baseline) {
    o.print("No baseline recorded on this set yet: run with --baseline to record one.");
  }
  return result;
}

/** One arm's scores: `p1` precision@1, `silence` correct silence, null when not measured. */
export interface ReuseQueriesArm {
  p1: number | null;
  silence: number | null;
  measured: number;
}

export interface ReuseQueriesMeasurement {
  model: string;
  promptHash: string;
  setHash: string;
  n: number;
  keywords: ReuseQueriesArm;
  modelQueries: ReuseQueriesArm;
  /** Needs the model's own queries were sent for (the rest fell back to keywords). */
  fromModel: number;
  admitted: boolean;
}

const pct = (x: number | null) => (x === null ? "not measured" : `${(x * 100).toFixed(0)}%`);

/**
 * DS-S8-3 as the owner amended it on 2026-09-28, and DS-P7-7:
 * `sekhemet research --reuse-eval --planner <model>`. The labelled set is
 * surveyed twice, with the keyword queries and then with the Planning
 * model's (`capabilityQueries`), and one `research/reuse_queries_measured`
 * is recorded. The model is admitted — its queries may then leave the
 * machine in `plan` — only when every need was measured in both runs, its
 * precision@1 beats the keywords' and its correct silence does not fall.
 * Consent is checked before the model is loaded (`loadPlanner`).
 */
export async function measureReuseQueries(o: {
  repoPath: string;
  log: EventLog;
  print: (line: string) => void;
  /** Loads the Planning model; called once, after consent and the keyword run. */
  loadPlanner: () => Promise<LocalInferenceAdapter>;
  offline?: boolean;
  set?: readonly LabelledNeed[];
  fetchImpl?: Fetch;
  paceMs?: number;
}): Promise<ReuseQueriesMeasurement | { refused: string }> {
  const arm = (label: string, planner?: LocalInferenceAdapter) =>
    runReuseEval({
      repoPath: o.repoPath,
      log: o.log,
      print: (l) => o.print(`${label}: ${l}`),
      record: false,
      ...(o.offline ? { offline: true } : {}),
      ...(o.set ? { set: o.set } : {}),
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.paceMs !== undefined ? { paceMs: o.paceMs } : {}),
      ...(planner ? { planner } : {}),
    });
  const keywords = await arm("Keyword queries");
  if ("refused" in keywords) return keywords;
  const planner = await o.loadPlanner();
  const label = `${planner.modelId}'s queries`;
  const withModel = await arm(label, planner);
  if ("refused" in withModel) return withModel;
  const scores = (r: ReuseEvalResult): ReuseQueriesArm => ({
    p1: r.precisionAt1 ?? null,
    silence: r.correctSilence ?? null,
    measured: r.measured,
  });
  const k = scores(keywords);
  const m = scores(withModel);
  const n = keywords.needs;
  const admitted =
    k.measured === n &&
    m.measured === n &&
    k.p1 !== null &&
    m.p1 !== null &&
    m.p1 > k.p1 &&
    (k.silence === null || (m.silence !== null && m.silence >= k.silence));
  const fromModel = withModel.perNeed.filter((p) => p.origin === "planning-model").length;
  const result: ReuseQueriesMeasurement = {
    model: planner.modelId,
    promptHash: reuseQueriesPromptHash(),
    setHash: keywords.setHash,
    n,
    keywords: k,
    modelQueries: m,
    fromModel,
    admitted,
  };
  await o.log.append({ actor: "harness", type: REUSE_QUERIES_MEASURED, payload: { ...result } });
  const line = (name: string, a: ReuseQueriesArm) =>
    `${name}: precision@1 ${pct(a.p1)}, correct silence ${pct(a.silence)}; ${a.measured} of ${n} needs measured.`;
  o.print(line("Keyword queries", k));
  o.print(`${line(label, m)} The model wrote the queries for ${fromModel} needs.`);
  o.print(
    admitted
      ? `${planner.modelId} is admitted: plan now sends its queries to the registries.`
      : `${planner.modelId} is not admitted: plan keeps sending the keyword queries. It is admitted only when every need is measured in both runs, its precision@1 is higher and its correct silence is no lower.`,
  );
  return result;
}
