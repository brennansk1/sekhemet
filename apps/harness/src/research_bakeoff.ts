import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEASURE_BENCHMARKED,
  type ResearchGoldenSet,
  binomialTailAtLeast,
  clopperPearson,
  compareOnItems,
  gradeResearchAnswer,
  loadResearchGoldenSet,
} from "@sekhemet/eval";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import {
  AssignmentRefusal,
  type BakeOffEvidence,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  ModelRegistry,
  RESEARCHER_CANDIDATES,
  ROLE_EVALUATION_SET,
  type ResearcherCandidate,
  assignRole,
  createDarwinHeadroomProbe,
  currentAssignment,
  hostFingerprintHash,
  llamaBuildNumber,
  resolveModelPath,
  withMeasurementRun,
} from "@sekhemet/models";
import { type CombinationDeps, qualificationCombination } from "./qualify.js";
import { EFFORT_CAPS } from "./research/effort.js";
import {
  type ResearchAnswer,
  type ResearchDeps,
  apodexResearch,
  research,
} from "./research/researcher.js";
import { researchSources } from "./research/service.js";

/**
 * The research golden set run and the Researcher bake-off (design-stage
 * DS-N2-9; models NEW-models-11, MD-N11-1..3).
 *
 * Each model the bake-off names runs the 25 golden questions on the
 * reference host, one model at a time inside a measurement run, on each
 * research pipeline asked for; every answer is graded by the set's
 * deterministic rubric (`gradeResearchAnswer`, no model judge). Per model and
 * pipeline it records the questions answered correctly, accuracy, citation
 * precision, unverified citations, peak resident memory and seconds per
 * question, versioned with the set's hash. Pipelines on one model, and each
 * candidate against the incumbent Apodex-1.1-mini, are compared by the exact
 * paired (McNemar) test at 0.05. A candidate is adopted only as MD-N11-2
 * allows, as the Researcher's shipped default on this host, and the previous
 * default stays restorable with `sekhemet models restore researcher --default`.
 */

/** The ledger record of one golden-set run: per pipeline, its verdicts and adoption. */
export const RESEARCH_GOLDEN_RUN = "research/golden_run";

/** The incumbent Researcher every candidate is compared against (MD-N11-2). */
export const INCUMBENT_RESEARCHER = "apodex-1.1-mini";

const ALPHA = 0.05;

/**
 * The research pipelines: `native`, the Apodex loop on the model's trained
 * tools (`apodexResearch`); `tool-loop`, the harness's own tool loop
 * (`research`), which routes an Apodex model to its native loop instead.
 */
export type ResearchPipeline = "native" | "tool-loop";
export const RESEARCH_PIPELINES: readonly ResearchPipeline[] = ["native", "tool-loop"];

/** The pipeline the product runs a model on today (`research()`'s dispatch). */
export function productPipeline(modelId: string): ResearchPipeline {
  return /apodex/i.test(modelId) ? "native" : "tool-loop";
}

/** What the rubric reads from one answer. */
export interface GoldenAnswer {
  text: string;
  /** Citations the one reference checker matched to text read (DS-N2-4). */
  verifiedCitations: number;
  /** Citations to nothing read: `badCitations`. */
  unverifiedCitations: number;
}

/** One answer as the rubric reads it, from the reference checker's verdicts. */
export function goldenAnswerOf(a: ResearchAnswer): GoldenAnswer {
  const read = new Set((a.references ?? []).filter((r) => r.read).map((r) => r.n));
  return {
    text: a.answer,
    verifiedCitations: read.size,
    unverifiedCitations: a.badCitations.length,
  };
}

/** One model on one pipeline, answering golden questions. */
export interface Contender {
  model: string;
  pipeline: ResearchPipeline;
  /** Answer one question; it is given the question and nothing of its answer (MS-T11-3). */
  ask(question: string): Promise<GoldenAnswer>;
  /** The model server's resident memory now, in bytes; undefined when unreadable. */
  residentBytes?(): Promise<number | undefined>;
}

export interface GoldenItemResult {
  id: string;
  grade: 0 | 0.5 | 1;
  correct: boolean;
  verified: number;
  unverified: number;
  seconds: number;
  /**
   * The pipeline failed on this question: the failure kept, and the
   * contender's run is not measured (never a wrong answer, never a loss).
   */
  error?: string;
}

export interface ContenderResult {
  model: string;
  pipeline: ResearchPipeline;
  setHash: string;
  setVersion: string;
  items: GoldenItemResult[];
  /** Questions answered correctly under the rubric (grade 1). */
  correct: number;
  n: number;
  accuracy: number;
  /** Verified citations over all citations; null when it cited nothing. */
  citationPrecision: number | null;
  verifiedCitations: number;
  unverifiedCitations: number;
  /** The highest resident memory sampled around its questions; absent when unreadable. */
  peakResidentBytes?: number;
  secondsPerQuestion: number;
}

/**
 * Run the golden set on each contender in turn (DS-N2-9, MD-N11-1). The set
 * must be the registered, person-labelled asset; a pipeline that throws
 * scores that question 0 and the error is kept. Memory is sampled before and
 * after each question: a llama-server allocates its KV cache at load, so its
 * footprint is flat while it answers.
 */
export async function runGoldenSet(
  set: ResearchGoldenSet,
  contenders: readonly Contender[],
  opts: { now?: () => number; say?: (line: string) => void } = {},
): Promise<ContenderResult[]> {
  if (set.state !== "ready" || !set.hash)
    throw new Error(set.reason ?? "the research golden set is not built");
  const now = opts.now ?? Date.now;
  const results: ContenderResult[] = [];
  for (const c of contenders) {
    let peak: number | undefined;
    const sample = async () => {
      const b = await c.residentBytes?.().catch(() => undefined);
      if (typeof b === "number" && (peak === undefined || b > peak)) peak = b;
    };
    const items: GoldenItemResult[] = [];
    for (const q of set.items) {
      await sample();
      const t0 = now();
      let answer: GoldenAnswer;
      let error: string | undefined;
      try {
        answer = await c.ask(q.question);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        answer = { text: "", verifiedCitations: 0, unverifiedCitations: 0 };
      }
      const seconds = (now() - t0) / 1000;
      await sample();
      const g = gradeResearchAnswer(q, answer);
      items.push({
        id: q.id,
        grade: g.grade,
        correct: g.correct,
        verified: answer.verifiedCitations,
        unverified: answer.unverifiedCitations,
        seconds,
        ...(error ? { error } : {}),
      });
    }
    const correct = items.filter((i) => i.correct).length;
    const verified = items.reduce((s, i) => s + i.verified, 0);
    const unverified = items.reduce((s, i) => s + i.unverified, 0);
    const r: ContenderResult = {
      model: c.model,
      pipeline: c.pipeline,
      setHash: set.hash,
      setVersion: set.version ?? "1",
      items,
      correct,
      n: items.length,
      accuracy: items.length ? correct / items.length : 0,
      citationPrecision: verified + unverified ? verified / (verified + unverified) : null,
      verifiedCitations: verified,
      unverifiedCitations: unverified,
      ...(peak !== undefined ? { peakResidentBytes: peak } : {}),
      secondsPerQuestion: items.length
        ? items.reduce((s, i) => s + i.seconds, 0) / items.length
        : 0,
    };
    opts.say?.(describeResult(r));
    results.push(r);
  }
  return results;
}

const GB = 1024 ** 3;
const pct = (x: number | null) => (x === null ? "no citations" : `${Math.round(x * 100)}%`);

/** How many of a contender's questions its pipeline failed on: any, and its run is not measured. */
export const failuresOf = (r: ContenderResult): number =>
  r.items.filter((i) => i.error !== undefined).length;

/** One line per model and pipeline, for the command's output. */
export function describeResult(r: ContenderResult): string {
  const failed = failuresOf(r);
  if (failed > 0)
    return `${r.model} (${r.pipeline}): not measured — its pipeline failed on ${failed} of ${r.n} question(s) (first: ${r.items.find((i) => i.error)?.error ?? ""})`;
  return `${r.model} (${r.pipeline}): ${r.correct}/${r.n} right, citation precision ${pct(r.citationPrecision)}, ${r.unverifiedCitations} unverified citation(s), ${r.secondsPerQuestion.toFixed(1)} s a question, peak memory ${r.peakResidentBytes === undefined ? "not measured" : `${(r.peakResidentBytes / GB).toFixed(1)} GB`}`;
}

/** Correct/incorrect per item, as the paired comparison reads it. */
const scored = (r: ContenderResult) => ({
  model: `${r.model}/${r.pipeline}`,
  items: r.items.map((i) => ({ id: i.id, score: i.correct ? 1 : 0 })),
});

/** The exact paired test of two results on the same items (two-sided McNemar). */
export function pairedTest(a: ContenderResult, b: ContenderResult) {
  if (a.setHash !== b.setHash)
    throw new Error("two results compare only when scored on the same set hash (MS-T11-2)");
  return compareOnItems("researcher", scored(a), scored(b), ALPHA);
}

export interface PipelineVerdict {
  model: string;
  /** The pipeline research routes to by default; undefined when no test rejected. */
  recommended?: ResearchPipeline;
  /** Pipelines the paired test found worse: "not recommended" in `doctor`. */
  notRecommended: ResearchPipeline[];
  tests: {
    a: ResearchPipeline;
    b: ResearchPipeline;
    aRight: number;
    bRight: number;
    better: number;
    worse: number;
    p: number;
  }[];
}

/**
 * DS-N2-9: per model run on more than one pipeline, each pair compared by
 * the exact paired test; a pipeline another beats at 0.05 is not
 * recommended, and research routes to the best one no test marked. A pair
 * where either pipeline failed on a question marks nothing.
 */
export function pipelineVerdicts(results: readonly ContenderResult[]): PipelineVerdict[] {
  const models = [...new Set(results.map((r) => r.model))];
  return models.flatMap((model): PipelineVerdict[] => {
    const mine = results.filter((r) => r.model === model);
    if (mine.length < 2) return [];
    const worse = new Set<ResearchPipeline>();
    const tests: PipelineVerdict["tests"] = [];
    for (let i = 0; i < mine.length; i++)
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i] as ContenderResult;
        const b = mine[j] as ContenderResult;
        const t = pairedTest(a, b);
        tests.push({
          a: a.pipeline,
          b: b.pipeline,
          aRight: a.correct,
          bRight: b.correct,
          better: t.better,
          worse: t.worse,
          p: t.p,
        });
        // A pipeline that threw lost on a failure, not on quality: never routed on it.
        const failed = [a, b].some((r) => r.items.some((i) => i.error !== undefined));
        if (!t.indistinguishable && !failed)
          worse.add(t.better > t.worse ? b.pipeline : a.pipeline);
      }
    const best = mine
      .filter((r) => !worse.has(r.pipeline))
      .sort((x, y) => y.correct - x.correct)[0];
    return [
      {
        model,
        ...(worse.size && best ? { recommended: best.pipeline } : {}),
        notRecommended: [...worse],
        tests,
      },
    ];
  });
}

export interface AdoptionVerdict {
  model: string;
  allowed: boolean;
  /**
   * `better`: the paired test resolved a gain; `not established`: allowed on
   * memory alone; `not measured`: a pipeline in the run failed, so the run is
   * no quality result either way.
   */
  quality: "better" | "not established" | "worse" | "not measured";
  reason: string;
  /** Two-sided exact paired p against the incumbent. */
  p: number;
  /** One-sided exact p that the candidate is worse (a loss). */
  pLoss: number;
}

/**
 * Each model's best pipeline, standing for the model in the bake-off: a
 * measured pipeline before one that failed, then the most questions right.
 */
function bestPerModel(results: readonly ContenderResult[]): ContenderResult[] {
  const best = new Map<string, ContenderResult>();
  for (const r of results) {
    const had = best.get(r.model);
    const measured = failuresOf(r) === 0;
    const hadMeasured = had !== undefined && failuresOf(had) === 0;
    if (!had || (measured && !hadMeasured) || (measured === hadMeasured && r.correct > had.correct))
      best.set(r.model, r);
  }
  return [...best.values()];
}

/**
 * MD-N11-2: a candidate may be adopted when it answers more questions
 * correctly than the incumbent by a margin the paired exact test resolves at
 * 0.05; when the comparison is inconclusive, only if its peak resident memory
 * is lower and the paired test shows no significant loss (one-sided), with
 * quality recorded "not established"; otherwise the Researcher stays
 * Apodex-1.1-mini. `adopt` is the first allowed: resolved gains by questions
 * right, then the rest by memory.
 */
export function researcherAdoption(
  results: readonly ContenderResult[],
  incumbent = INCUMBENT_RESEARCHER,
): { incumbent: string; verdicts: AdoptionVerdict[]; adopt?: string } {
  const models = bestPerModel(results);
  const inc = models.find((r) => r.model === incumbent);
  if (!inc)
    throw new Error(
      `the Research model bake-off compares every candidate with the incumbent ${incumbent} on the same run; it did not run`,
    );
  const verdicts = models
    .filter((r) => r !== inc)
    .map((cand): AdoptionVerdict => {
      const t = pairedTest(cand, inc);
      const discordant = t.better + t.worse;
      const pLoss = discordant ? binomialTailAtLeast(t.worse, discordant) : 1;
      const base = { model: cand.model, p: t.p, pLoss };
      const score = `${cand.correct}/${cand.n} against ${inc.correct}/${inc.n}, p = ${t.p.toFixed(3)}`;
      if (!t.indistinguishable)
        return cand.correct > inc.correct
          ? { ...base, allowed: true, quality: "better", reason: `more questions right: ${score}` }
          : {
              ...base,
              allowed: false,
              quality: "worse",
              reason: `fewer questions right: ${score}`,
            };
      if (pLoss < ALPHA)
        return {
          ...base,
          allowed: false,
          quality: "worse",
          reason: `a loss the one-sided paired test resolves: ${score}, one-sided p = ${pLoss.toFixed(3)}`,
        };
      const lower =
        cand.peakResidentBytes !== undefined &&
        inc.peakResidentBytes !== undefined &&
        cand.peakResidentBytes < inc.peakResidentBytes;
      return lower
        ? {
            ...base,
            allowed: true,
            quality: "not established",
            reason: `inconclusive (${score}) with lower peak memory and no significant loss; quality not established`,
          }
        : {
            ...base,
            allowed: false,
            quality: "not established",
            reason: `inconclusive (${score}) and its peak memory is ${cand.peakResidentBytes === undefined || inc.peakResidentBytes === undefined ? "not measured for both" : "not lower"}`,
          };
    });
  // A pipeline that threw: that is a failure of the run (a server that never
  // came up, one that died), not a quality result — never a win and never a
  // loss. A run where any contender failed is not measured and adopts
  // nothing (fails closed).
  const failed = results.filter((r) => failuresOf(r) > 0);
  if (failed.length) {
    const said = failed
      .map((r) => `${r.model} (${r.pipeline}) failed on ${failuresOf(r)} question(s)`)
      .join("; ");
    return {
      incumbent,
      verdicts: verdicts.map((v) => ({
        ...v,
        allowed: false,
        quality: "not measured",
        reason: `${said}: a failure is not a quality result, so this run is not measured and nothing is adopted from it; run it again once every pipeline answers`,
      })),
    };
  }
  const allowed = verdicts.filter((v) => v.allowed);
  const byModel = new Map(models.map((m) => [m.model, m]));
  const pick =
    allowed
      .filter((v) => v.quality === "better")
      .sort(
        (a, b) => (byModel.get(b.model)?.correct ?? 0) - (byModel.get(a.model)?.correct ?? 0),
      )[0] ??
    allowed.sort(
      (a, b) =>
        (byModel.get(a.model)?.peakResidentBytes ?? 0) -
        (byModel.get(b.model)?.peakResidentBytes ?? 0),
    )[0];
  return { incumbent, verdicts, ...(pick ? { adopt: pick.model } : {}) };
}

// ── the ledger ────────────────────────────────────────────────────────────

export interface BakeoffRecord {
  runEventId: string;
  /** Each model's `measure/benchmarked` event id: its bake-off evidence (MD-N10-1). */
  benchmarkEvents: Record<string, string>;
  pipelines: PipelineVerdict[];
  adoption: ReturnType<typeof researcherAdoption>;
  host: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Record a run (DS-N2-9, MD-N11-1, MD-N10-1): one overnight
 * `measure/benchmarked` event per model — its best pipeline's items and
 * score on the full research golden set, the paired comparisons, the set's
 * hash — which is the Researcher's bake-off evidence on this host; then one
 * `research/golden_run` event with every pipeline's measures, the pipeline
 * verdicts and the adoption verdicts.
 */
export async function recordResearchBakeoff(
  log: EventLog,
  input: { host: string; set: ResearchGoldenSet; results: readonly ContenderResult[] },
): Promise<BakeoffRecord> {
  const { host, set, results } = input;
  const models = bestPerModel(results);
  const hasIncumbent = models.some((m) => m.model === INCUMBENT_RESEARCHER);
  const adoption = hasIncumbent
    ? researcherAdoption(results)
    : { incumbent: INCUMBENT_RESEARCHER, verdicts: [] };
  const pipelines = pipelineVerdicts(results);
  // A contender whose pipeline failed is not measured: it is compared with
  // nothing, so no comparison records a loss (or a win) it never had.
  const measured = models.filter((m) => failuresOf(m) === 0);
  const comparisons = measured.flatMap((a, i) =>
    measured.slice(i + 1).map((b) => {
      return compareOnItems(
        "researcher",
        { model: a.model, items: scored(a).items },
        { model: b.model, items: scored(b).items },
        ALPHA,
      );
    }),
  );
  const resolved = comparisons
    .filter((c) => !c.indistinguishable)
    .map((c) => ({
      role: "researcher",
      better: c.better > c.worse ? c.a : c.b,
      worse: c.better > c.worse ? c.b : c.a,
      p: c.p,
    }));
  const indistinguishable = comparisons
    .filter((c) => c.indistinguishable)
    .map((c) => ({ role: "researcher", a: c.a, b: c.b, p: c.p }));
  const benchmarkEvents: Record<string, string> = {};
  for (const m of models) {
    const definition = {
      evaluationSet: ROLE_EVALUATION_SET.researcher,
      setHash: m.setHash,
      setVersion: m.setVersion,
      model: m.model,
      pipeline: m.pipeline,
      host,
    };
    const ci = clopperPearson(m.correct, m.n);
    const ok = failuresOf(m) === 0;
    const e = await log.append({
      actor: "harness",
      type: MEASURE_BENCHMARKED,
      payload: {
        tier: "overnight",
        profileHash: sha256(JSON.stringify(definition)),
        host,
        combination: { researcher: m.model },
        partial: false,
        roles: [
          ok
            ? {
                role: "researcher",
                model: m.model,
                state: "measured",
                setHash: m.setHash,
                score: m.accuracy,
                low: ci.low,
                high: ci.high,
                items: m.items.map((i) => ({ id: i.id, score: i.correct ? 1 : 0 })),
                secondary: { secondsPerItem: m.secondsPerQuestion, fits: true },
              }
            : { role: "researcher", model: m.model, state: "not_measured", setHash: m.setHash },
        ],
        comparisons: comparisons.filter((c) => c.a === m.model || c.b === m.model),
        resolved: resolved.filter((c) => c.better === m.model || c.worse === m.model),
        indistinguishable: indistinguishable.filter((c) => c.a === m.model || c.b === m.model),
      },
      private: { runProfile: definition },
    });
    benchmarkEvents[m.model] = e.id;
  }
  const run = await log.append({
    actor: "harness",
    type: RESEARCH_GOLDEN_RUN,
    payload: {
      setHash: set.hash,
      setVersion: set.version,
      host,
      items: set.items.length,
      contenders: results.map((r) => ({
        model: r.model,
        pipeline: r.pipeline,
        correct: r.correct,
        n: r.n,
        accuracy: r.accuracy,
        citationPrecision: r.citationPrecision,
        verifiedCitations: r.verifiedCitations,
        unverifiedCitations: r.unverifiedCitations,
        secondsPerQuestion: r.secondsPerQuestion,
        ...(r.peakResidentBytes !== undefined ? { peakResidentBytes: r.peakResidentBytes } : {}),
        grades: r.items.map((i) => ({ id: i.id, grade: i.grade })),
        // The questions its pipeline failed on: any, and it is not measured.
        ...(failuresOf(r) > 0 ? { errors: failuresOf(r) } : {}),
        ...(benchmarkEvents[r.model] && models.includes(r)
          ? { benchmarkEvent: benchmarkEvents[r.model] }
          : {}),
      })),
      pipelines,
      adoption: {
        incumbent: adoption.incumbent,
        ...(adoption.adopt ? { adopt: adoption.adopt } : {}),
        verdicts: adoption.verdicts.map(({ reason: _r, ...v }) => v),
      },
    },
    private: { reasons: Object.fromEntries(adoption.verdicts.map((v) => [v.model, v.reason])) },
  });
  return { runEventId: run.id, benchmarkEvents, pipelines, adoption, host };
}

interface GoldenRunPayload {
  setHash: string;
  host: string;
  contenders: {
    model: string;
    pipeline: ResearchPipeline;
    correct: number;
    n: number;
    benchmarkEvent?: string;
  }[];
  pipelines: PipelineVerdict[];
  adoption: { incumbent: string; adopt?: string; verdicts: Omit<AdoptionVerdict, "reason">[] };
}

/** A recorded run as `adoptResearcher` reads it, so adopting needs no second run. */
export async function recordedBakeoff(
  log: EventLog,
  runEventId: string,
): Promise<BakeoffRecord | undefined> {
  const e = (await log.getEventsByTypes([RESEARCH_GOLDEN_RUN])).find((x) => x.id === runEventId) as
    | EventRecord<GoldenRunPayload>
    | undefined;
  if (!e) return undefined;
  const reasons = (e.private?.reasons ?? {}) as Record<string, unknown>;
  const p = e.payload;
  return {
    runEventId: e.id,
    host: p.host,
    benchmarkEvents: Object.fromEntries(
      p.contenders.flatMap((c) => (c.benchmarkEvent ? [[c.model, c.benchmarkEvent]] : [])),
    ),
    pipelines: p.pipelines,
    adoption: {
      incumbent: p.adoption.incumbent,
      ...(p.adoption.adopt ? { adopt: p.adoption.adopt } : {}),
      verdicts: p.adoption.verdicts.map((v) => ({
        ...v,
        reason: typeof reasons[v.model] === "string" ? (reasons[v.model] as string) : "",
      })),
    },
  };
}

async function latestRun(log: EventLog): Promise<EventRecord<GoldenRunPayload> | undefined> {
  const runs = await log.getEventsByTypes([RESEARCH_GOLDEN_RUN]);
  return runs.at(-1) as EventRecord<GoldenRunPayload> | undefined;
}

/**
 * The latest run's pipeline advice (DS-N2-9): per model, the pipeline research
 * routes to by default and those marked "not recommended".
 */
export async function researchPipelineAdvice(log: EventLog): Promise<PipelineVerdict[]> {
  return (await latestRun(log))?.payload.pipelines ?? [];
}

/** `doctor`'s lines for pipelines the latest golden-set run found worse (DS-N2-9). */
export async function researchDoctorLines(log: EventLog): Promise<string[]> {
  const run = await latestRun(log);
  if (!run) return [];
  return run.payload.pipelines.flatMap((v) =>
    v.notRecommended.map((bad) => {
      const t = v.tests.find((x) => x.a === bad || x.b === bad);
      const right = (p: ResearchPipeline) =>
        run.payload.contenders.find((c) => c.model === v.model && c.pipeline === p);
      const good = v.recommended ?? (t ? (t.a === bad ? t.b : t.a) : undefined);
      const g = good ? right(good) : undefined;
      const b = right(bad);
      return `research: ${v.model} on the ${bad} pipeline is not recommended — ${good ?? "another pipeline"} answered ${g?.correct ?? "?"}/${g?.n ?? "?"} of the research golden set, ${bad} ${b?.correct ?? "?"}/${b?.n ?? "?"} (exact paired p = ${t ? t.p.toFixed(4) : "?"}; set ${run.payload.setHash.slice(0, 12)})`;
    }),
  );
}

/**
 * Adopt a candidate as the Researcher's shipped default on this host
 * (MD-N11-2, MD-N11-3, MD-N10-1): only as the recorded run's adoption
 * verdict allows it, with that run's overnight benchmark as the bake-off
 * evidence, through `assignRole`, which refuses unless the qualification
 * the caller looked up for this host's combination is `qualified`. The
 * previous default is kept, restorable in one command; the Apodex profile is
 * never removed here.
 */
export async function adoptResearcher(
  log: EventLog,
  registry: ModelRegistry,
  record: BakeoffRecord,
  input: {
    model: string;
    host: string;
    principal: string;
    /** The model's qualification for this combination, looked up now (never assumed). */
    qualification: "qualified" | "overridden" | "failed" | "invalidated" | "missing";
  },
): Promise<{ model: string; previous?: string }> {
  const verdict = record.adoption.verdicts.find((v) => v.model === input.model);
  if (!verdict?.allowed)
    throw new AssignmentRefusal(
      `Refusing to adopt ${input.model} as the Research model: MD-N11-2 does not allow it${verdict ? ` (${verdict.reason})` : " (it was not in the bake-off)"}; the Research model stays ${currentAssignment(registry, input.host, "researcher", "default")?.model ?? INCUMBENT_RESEARCHER}.`,
    );
  const eventId = record.benchmarkEvents[input.model];
  if (!eventId) throw new AssignmentRefusal(`No recorded bake-off event for ${input.model}.`);
  const bakeOff: BakeOffEvidence = {
    id: eventId,
    host: record.host,
    role: "researcher",
    model: input.model,
    tier: "overnight",
    evaluationSet: ROLE_EVALUATION_SET.researcher,
    date: new Date().toISOString(),
  };
  const qualification = input.qualification;
  const r = assignRole(registry, {
    role: "researcher",
    model: input.model,
    scope: "default",
    by: "person",
    host: input.host,
    qualification,
    bakeOff,
  });
  await log.append({
    actor: "human",
    principal: input.principal,
    type: "models/assigned",
    payload: {
      role: "researcher",
      model: r.assignment.model,
      scope: "default",
      qualification,
      ...(r.previous ? { previous: r.previous.model } : {}),
      bakeOff: eventId,
    },
  });
  return { model: r.assignment.model, ...(r.previous ? { previous: r.previous.model } : {}) };
}

// ── the command ──────────────────────────────────────────────────────────

export const RESEARCH_BAKEOFF_USAGE =
  "Usage: sekhemet research-bakeoff [--models apodex-1.1-mini,spark-x2.5-4b,neohorse-1-4b] [--pipelines native,tool-loop] [--adopt] | research-bakeoff --adopt-from <run event id>";

export interface ResearchBakeoffIo {
  print: (line: string) => void;
  /** The harness repository, whose `fixtures/` hold the research golden set. */
  harnessRoot?: string;
  registry?: ModelRegistry;
  combinationDeps?: CombinationDeps;
  /** The adapter a model runs as: its managed profile in this host's models directory. */
  adapterFor?: (candidate: ResearcherCandidate) => LocalInferenceAdapter;
  /** A model on a pipeline, answering: the product's research pipelines. */
  contenderFor?: (adapter: LocalInferenceAdapter, pipeline: ResearchPipeline) => Contender;
  now?: () => number;
}

const flag = (args: readonly string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const defaultHarnessRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A llama-server's footprint on its port, read-only (`footprint -p`, as Smart Swap reads it). */
function residentOf(
  adapter: LocalInferenceAdapter,
): (() => Promise<number | undefined>) | undefined {
  if (!(adapter instanceof ManagedLlamaServerAdapter) || process.platform !== "darwin")
    return undefined;
  const port = adapter.launchProfile.port ?? 8098;
  const probe = createDarwinHeadroomProbe({
    watch: [{ port, name: adapter.modelId, ours: true }],
  });
  return async () => (await probe.read()).processes.find((p) => p.port === port)?.footprintBytes;
}

/** The product's pipelines on a model, at quick effort, over the repository's research sources. */
export function productContender(
  repoPath: string,
  log: EventLog,
): (adapter: LocalInferenceAdapter, pipeline: ResearchPipeline) => Contender {
  let sources: Promise<ResearchDeps["web"]> | undefined;
  return (adapter, pipeline) => {
    const resident = residentOf(adapter);
    return {
      model: adapter.modelId,
      pipeline,
      ask: async (question) => {
        sources ??= researchSources(repoPath, { log }).then((s) => s.web);
        const deps: ResearchDeps = {
          repoPath,
          web: await sources,
          maxPages: EFFORT_CAPS.quick.pagesPerSubQuestion,
          // The arm under test, never the model's default route (DS-N2-9).
          pipeline,
        };
        const a =
          pipeline === "native"
            ? await apodexResearch(adapter, question, deps)
            : await research(adapter, question, deps);
        return goldenAnswerOf(a);
      },
      ...(resident ? { residentBytes: resident } : {}),
    };
  };
}

/**
 * `sekhemet research-bakeoff` (DS-N2-9, MD-N11-1..3): refuses a golden set
 * a person has not labelled and registered; refuses, before loading anything,
 * a model whose combination has not qualified on this host or whose
 * llama.cpp build is older than it needs; then runs each model in turn inside
 * a measurement run (its server unloaded when its questions end), records
 * the run, prints each model's measures and the verdicts, and with `--adopt`
 * adopts the candidate MD-N11-2 allows.
 */
export async function runResearchBakeoffCommand(
  args: readonly string[],
  k: { repoPath: string; log: EventLog; cardStore: { localPrincipal(): string } },
  io: ResearchBakeoffIo,
): Promise<number> {
  const { print } = io;
  const registry = io.registry ?? new ModelRegistry();
  const host = (io.combinationDeps?.host ?? hostFingerprintHash)();
  const from = flag(args, "--adopt-from");
  if (args.includes("--adopt-from")) {
    const record = from ? await recordedBakeoff(k.log, from) : undefined;
    if (!record) {
      print(
        from
          ? `No recorded research golden-set run ${from} on this ledger.`
          : RESEARCH_BAKEOFF_USAGE,
      );
      return 1;
    }
    return adoptFromRecord(record, true, k, registry, host, print, qualificationOf(io, registry));
  }
  const set = loadResearchGoldenSet(io.harnessRoot ?? defaultHarnessRoot());
  if (set.state !== "ready") {
    print(`The research golden set is not ready: ${set.reason}`);
    return 1;
  }
  const wanted = (flag(args, "--models") ?? RESEARCHER_CANDIDATES.map((c) => c.modelId).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pipelines = flag(args, "--pipelines")
    ?.split(",")
    .map((s) => s.trim());
  const unknownPipeline = pipelines?.find(
    (p) => !RESEARCH_PIPELINES.includes(p as ResearchPipeline),
  );
  const candidates = wanted.map((id) => RESEARCHER_CANDIDATES.find((c) => c.modelId === id));
  const unknown = wanted.find((_, i) => !candidates[i]);
  if (unknown || unknownPipeline) {
    print(
      unknown
        ? `Unknown Researcher ${unknown}; the bake-off runs ${RESEARCHER_CANDIDATES.map((c) => c.modelId).join(", ")}.`
        : `Unknown pipeline ${unknownPipeline}; the pipelines are ${RESEARCH_PIPELINES.join(", ")}.`,
    );
    print(RESEARCH_BAKEOFF_USAGE);
    return 2;
  }
  const adapterFor =
    io.adapterFor ?? ((c: ResearcherCandidate) => c.create(resolveModelPath(c.file)));
  // MD-N11-1: each model qualified per combination, on the build it needs — checked before any load.
  const plan = (candidates as ResearcherCandidate[]).map((c) => {
    const adapter = adapterFor(c);
    const combination = qualificationCombination(adapter, { ...io.combinationDeps, registry });
    const look = registry.lookupQualification(adapter.modelId, combination);
    const build = llamaBuildNumber(combination.engine);
    const refusal =
      look.status !== "qualified"
        ? `${c.modelId} is not verified on this machine for this combination (${look.status}); verify it first: sekhemet qualify --models ${c.modelId}`
        : c.minLlamaBuild && (build === undefined || build < c.minLlamaBuild)
          ? `${c.modelId} needs llama.cpp b${c.minLlamaBuild} or later; this engine is ${combination.engine}`
          : undefined;
    const own = pipelines ?? [productPipeline(c.modelId)];
    const refusedPipeline =
      /apodex/i.test(c.modelId) && own.includes("tool-loop")
        ? `${c.modelId} runs only its native pipeline: the tool loop routes it there`
        : undefined;
    return {
      c,
      adapter,
      refusal: refusal ?? refusedPipeline,
      pipelines: own as ResearchPipeline[],
    };
  });
  const refused = plan.filter((p) => p.refusal);
  if (refused.length) {
    for (const p of refused) print(`Refusing the bake-off: ${p.refusal}.`);
    return 1;
  }
  const contenderFor = io.contenderFor ?? productContender(k.repoPath, k.log);
  const results: ContenderResult[] = [];
  for (const p of plan) {
    print(`Running the research golden set on ${p.c.modelId} (${p.pipelines.join(", ")}) …`);
    const mine = await withMeasurementRun(
      {
        releaseAll: async () => {
          await (p.adapter as { unload?: () => Promise<void> }).unload?.();
        },
      },
      () =>
        runGoldenSet(
          set,
          p.pipelines.map((pl) => contenderFor(p.adapter, pl)),
          { ...(io.now ? { now: io.now } : {}), say: print },
        ),
    );
    results.push(...mine);
  }
  const record = await recordResearchBakeoff(k.log, { host, set, results });
  print(
    `Recorded ${record.runEventId} on research golden set ${set.hash?.slice(0, 12)} (v${set.version}).`,
  );
  for (const v of record.pipelines)
    print(
      v.recommended
        ? `${v.model}: research routes to ${v.recommended}; not recommended: ${v.notRecommended.join(", ")}.`
        : `${v.model}: its pipelines show no clear difference on this set.`,
    );
  for (const v of record.adoption.verdicts)
    print(`${v.model}: ${v.allowed ? "may be adopted" : "not adopted"} — ${v.reason}.`);
  return adoptFromRecord(
    record,
    args.includes("--adopt"),
    k,
    registry,
    host,
    print,
    qualificationOf(io, registry),
  );
}

/**
 * A model's qualification for this host's combination, looked up when it is
 * adopted (MD-N11-1): the combination may have changed since the run (a
 * llama.cpp upgrade invalidates it), so a recorded run's verdict is never
 * enough on its own.
 */
function qualificationOf(
  io: ResearchBakeoffIo,
  registry: ModelRegistry,
): (model: string) => "qualified" | "overridden" | "failed" | "invalidated" | "missing" {
  const adapterFor =
    io.adapterFor ?? ((c: ResearcherCandidate) => c.create(resolveModelPath(c.file)));
  return (model) => {
    const c = RESEARCHER_CANDIDATES.find((x) => x.modelId === model);
    if (!c) return "missing";
    const combination = qualificationCombination(adapterFor(c), {
      ...io.combinationDeps,
      registry,
    });
    return registry.lookupQualification(model, combination).status;
  };
}

/** Adopt what a recorded run allows (MD-N11-2), or say how to. */
async function adoptFromRecord(
  record: BakeoffRecord,
  adoptNow: boolean,
  k: { log: EventLog; cardStore: { localPrincipal(): string } },
  registry: ModelRegistry,
  host: string,
  print: (line: string) => void,
  qualification: (
    model: string,
  ) => "qualified" | "overridden" | "failed" | "invalidated" | "missing",
): Promise<number> {
  const adopt = record.adoption.adopt;
  if (!adopt) {
    print(`The Research model stays ${INCUMBENT_RESEARCHER}.`);
    return 0;
  }
  if (!adoptNow) {
    print(`Adopt ${adopt} with: sekhemet research-bakeoff --adopt-from ${record.runEventId}`);
    return 0;
  }
  if (record.host !== host) {
    print(
      `The run ${record.runEventId} was recorded on another host; a bake-off counts only where it ran.`,
    );
    return 1;
  }
  const status = qualification(adopt);
  if (status !== "qualified") {
    print(
      `Refusing to adopt ${adopt}: ${adopt} is not verified on this machine for this combination (${status}); verify it first: sekhemet qualify --models ${adopt}`,
    );
    return 1;
  }
  try {
    const r = await adoptResearcher(k.log, registry, record, {
      model: adopt,
      host,
      principal: k.cardStore.localPrincipal(),
      qualification: status,
    });
    print(
      `${r.model} adopted as the Research model default on this machine${r.previous ? `, replacing ${r.previous}; restore it with: sekhemet models restore researcher --default` : ""}.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof AssignmentRefusal) {
      print(err.message);
      return 1;
    }
    throw err;
  }
}
