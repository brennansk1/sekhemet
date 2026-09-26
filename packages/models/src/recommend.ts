import { signTestP } from "./calibration.js";
import type {
  ConfigRole,
  FitLabel,
  FoundModel,
  Graded,
  NumberGrade,
  RoleRecommendation,
} from "./library_types.js";
import type { ModelSource } from "./registry.js";
import { MODEL_ROLES, type ModelRole } from "./types.js";

/**
 * Recommending models (models rule 4c, MD-N12-4, MD-N12-5, MD-N14-42;
 * dashboard DB-NM14-6; DEC-45). Per role, the best candidate that fits:
 * from the role's quick-benchmark scores on this host when they exist, and
 * otherwise from the qualification record and the registry. Two candidates
 * the paired sign test cannot separate are said to be indistinguishable,
 * and the one with the least time per card including swaps is preferred,
 * then the smaller footprint, then the registry default. The Reviewer's
 * candidates exclude the Worker's family and any unknown family (rule 3).
 * Combinations are ordered by every role's quality floor, then the least
 * time per card, then the smaller footprint — never a weighted score.
 *
 * Everything here is a pure function of its inputs: computing a
 * recommendation assigns, loads and downloads nothing (MD-N12-5).
 */

export interface ItemScore {
  id: string;
  score: number;
}

/** What is known of a model for a role on this host. */
export interface RoleEvidence {
  qualification: "qualified" | "overridden" | "failed" | "invalidated" | "missing";
  /** The role's cached quick score for the current cache key (measurement MS-N5-2). */
  quick?: { items: readonly ItemScore[] };
  /** A managed default in the registry. */
  registryDefault?: boolean;
  /** Time per card including swaps (rule 20k), when estimated. */
  timePerCardMs?: number;
}

/** The paired sign test on the same items (measurement rule 35, MS-N5-4): part (c)'s `compareOnItems`. */
export type PairedCompare = (
  a: { model: string; items: readonly ItemScore[] },
  b: { model: string; items: readonly ItemScore[] },
) => { better: number; worse: number; indistinguishable: boolean };

/** The exact two-sided sign test, ties set aside, at 0.05 — the fallback when no comparer is passed. */
export const signTestCompare: PairedCompare = (a, b) => {
  const theirs = new Map(b.items.map((i) => [i.id, i.score]));
  let better = 0;
  let worse = 0;
  for (const i of a.items) {
    const t = theirs.get(i.id);
    if (t === undefined) continue;
    if (i.score > t) better++;
    else if (i.score < t) worse++;
  }
  const n = better + worse;
  const p = n === 0 ? 1 : Math.min(1, 2 * signTestP(Math.max(better, worse), n));
  return { better, worse, indistinguishable: !(p < 0.05) };
};

const ROLE_NAME: Record<ConfigRole, string> = {
  worker: "the Worker",
  planner: "the Planner",
  reviewer: "the Reviewer",
  researcher: "the Researcher",
  vision: "vision",
};

/** The models a role may take (MD-N12-4): those that fit, and for the Reviewer another known family. */
export function candidatesFor(
  role: ConfigRole,
  models: readonly FoundModel[],
  ctx: { workerFamily?: string | undefined } = {},
): { eligible: FoundModel[]; excluded: { model: string; reason: string }[] } {
  const eligible: FoundModel[] = [];
  const excluded: { model: string; reason: string }[] = [];
  for (const m of models) {
    if (m.noEngine) {
      excluded.push({ model: m.name, reason: `${m.name}: ${m.noEngine}` });
      continue;
    }
    if (m.fits[role] === "no") {
      excluded.push({
        model: m.name,
        reason: m.fitReason[role] ?? "Needs more memory than this machine has",
      });
      continue;
    }
    if (role === "reviewer") {
      if (!m.family) {
        excluded.push({
          model: m.name,
          reason: `${m.name}'s family is unknown, so it cannot be shown to differ from the Worker's`,
        });
        continue;
      }
      if (ctx.workerFamily && m.family === ctx.workerFamily) {
        excluded.push({
          model: m.name,
          reason: `${m.name} is of the Worker's family (${m.family}); the Reviewer needs another`,
        });
        continue;
      }
    }
    eligible.push(m);
  }
  return { eligible, excluded };
}

/** A registry model that is not in any folder, with its registered source (MD-N12-6). */
export interface RemoteCandidate {
  id: string;
  name: string;
  family?: string;
  fits: FitLabel;
  footprintBytes: number;
  registryDefault?: boolean;
  source?: ModelSource;
}

export interface RecommendInput {
  role: ConfigRole;
  present: readonly FoundModel[];
  remote?: readonly RemoteCandidate[];
  evidence: (model: string, role: ConfigRole) => RoleEvidence;
  workerFamily?: string | undefined;
  compare?: PairedCompare;
  /** False while the role's screen is not built (MS-N5-4b): quick scores are not read. */
  screenBuilt?: boolean;
}

interface Scored {
  id: string;
  name: string;
  family?: string | undefined;
  footprint: number;
  fits: FitLabel;
  fitReason?: string | undefined;
  present: boolean;
  ev: RoleEvidence;
  mean?: number | undefined;
  remote?: RemoteCandidate;
}

const qualified = (e: RoleEvidence) =>
  e.qualification === "qualified" || e.qualification === "overridden";
const mean = (items: readonly ItemScore[]) =>
  items.length ? items.reduce((n, i) => n + i.score, 0) / items.length : undefined;
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** The tie-break (rule 4c, DEC-45): time per card including swaps, then footprint, then the registry default. */
function tieBreak(a: Scored, b: Scored): number {
  const ta = a.ev.timePerCardMs ?? Number.POSITIVE_INFINITY;
  const tb = b.ev.timePerCardMs ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  if (a.footprint !== b.footprint) return a.footprint - b.footprint;
  return Number(Boolean(b.ev.registryDefault)) - Number(Boolean(a.ev.registryDefault));
}

/** One sentence naming the evidence (MD-N12-4). */
function sentence(
  role: ConfigRole,
  s: Scored,
  extra: string[],
  screenBuilt: boolean,
  workerFamily?: string,
): string {
  const parts: string[] = [];
  if (role === "reviewer" && s.family && workerFamily) {
    parts.push("a different family from the Worker, which the Reviewer needs");
  }
  parts.push(
    s.fits === "swaps"
      ? `it fits at ${gb(s.footprint)}, swapping with the other roles`
      : `it fits at ${gb(s.footprint)}`,
  );
  if (!screenBuilt) parts.push(`${ROLE_NAME[role]}'s quick benchmark is not measured yet`);
  else if (s.mean !== undefined) parts.push(`quick score ${s.mean.toFixed(2)}`);
  else parts.push("no quick score yet");
  if (qualified(s.ev)) parts.push("qualified on this machine");
  else if (s.ev.registryDefault) parts.push("the registry's default");
  parts.push(...extra);
  if (!s.present) parts.push("not in your folders yet, so it can be downloaded");
  return `${s.name}: ${parts.join("; ")}.`;
}

/**
 * The recommendation for one role (MD-N12-4), or why the role is unfilled.
 * Pure: it assigns, loads and downloads nothing (MD-N12-5).
 */
export function recommendRole(input: RecommendInput): {
  recommendation?: RoleRecommendation;
  unfilledReason?: string;
  excluded: { model: string; reason: string }[];
} {
  const role = input.role;
  const screenBuilt = input.screenBuilt !== false;
  const compare = input.compare ?? signTestCompare;
  const { eligible, excluded } = candidatesFor(role, input.present, {
    workerFamily: input.workerFamily,
  });
  const scored: Scored[] = eligible.map((m) => {
    const ev = input.evidence(m.id, role);
    return {
      id: m.id,
      name: m.name,
      family: m.family,
      footprint: m.fit?.[role]?.requiredBytes.value ?? m.sizeBytes,
      fits: m.fits[role] ?? "yes",
      fitReason: m.fitReason[role],
      present: true,
      ev,
      mean: screenBuilt && ev.quick ? mean(ev.quick.items) : undefined,
    };
  });
  if (scored.length === 0 || !scored.some((s) => qualified(s.ev) || s.mean !== undefined)) {
    // "Up to the strongest this machine can run" (rule 4c): a registered
    // model not present, offered for download, when it fits and no present
    // candidate has evidence of its own.
    const remote = (input.remote ?? [])
      .filter((r) => r.fits !== "no" && r.source)
      .filter(
        (r) => role !== "reviewer" || (r.family !== undefined && r.family !== input.workerFamily),
      )
      .filter((r) => r.registryDefault)
      .sort((a, b) => a.footprintBytes - b.footprintBytes)[0];
    if (remote) {
      const s: Scored = {
        id: remote.id,
        name: remote.name,
        family: remote.family,
        footprint: remote.footprintBytes,
        fits: remote.fits,
        present: false,
        ev: { qualification: "missing", registryDefault: true },
        remote,
      };
      const src = remote.source as ModelSource;
      return {
        recommendation: {
          model: remote.id,
          reason: sentence(role, s, [], screenBuilt, input.workerFamily),
          present: false,
          download: {
            source: src.host,
            sizeBytes: src.sizeBytes ?? remote.footprintBytes,
            sha256: src.sha256,
          },
        },
        excluded,
      };
    }
  }
  if (scored.length === 0) {
    const unfilledReason =
      role === "reviewer"
        ? "No model outside the Worker's family is configured."
        : input.present.length === 0
          ? `No model is in your folders for ${ROLE_NAME[role]}.`
          : `No model in your folders fits this machine for ${ROLE_NAME[role]}.`;
    return { unfilledReason, excluded };
  }
  // (1) Quick scores for the role, where they exist and the screen is built.
  const withScores = scored.filter((s) => s.mean !== undefined);
  let pick: Scored;
  let tied: Scored[] = [];
  if (withScores.length > 0) {
    const byMean = [...withScores].sort((a, b) => (b.mean as number) - (a.mean as number));
    const top = byMean[0] as Scored;
    tied = byMean.slice(1).filter((o) => {
      const c = compare(
        { model: top.id, items: top.ev.quick?.items ?? [] },
        { model: o.id, items: o.ev.quick?.items ?? [] },
      );
      return c.indistinguishable;
    });
    pick = [top, ...tied].sort(tieBreak)[0] as Scored;
    tied = [top, ...tied].filter((s) => s !== pick);
  } else {
    // (2) The qualification record and the registry.
    pick = [...scored].sort((a, b) => {
      const q = Number(qualified(b.ev)) - Number(qualified(a.ev));
      if (q !== 0) return q;
      const d = Number(Boolean(b.ev.registryDefault)) - Number(Boolean(a.ev.registryDefault));
      if (d !== 0) return d;
      return tieBreak(a, b);
    })[0] as Scored;
  }
  const extra =
    tied.length > 0
      ? [
          `indistinguishable on the quick benchmark from ${tied.map((t) => t.name).join(" and ")}, and ${pick.ev.timePerCardMs !== undefined ? "less time per card including swaps" : "the smaller footprint"}`,
        ]
      : [];
  return {
    recommendation: {
      model: pick.id,
      reason: sentence(role, pick, extra, screenBuilt, input.workerFamily),
      present: true,
      ...(tied.length > 0 ? { indistinguishableFrom: tied.map((t) => t.id) } : {}),
    },
    excluded,
  };
}

// ── combinations (MD-N14-42, DB-NM14-6) ──────────────────────────────────

/**
 * Time per card including swaps (rule 20k): E[attempts] × compute +
 * E[swaps] × C_pair. *Estimated* while fewer than 20 of the person's cards
 * were replayed; with none, our design values.
 */
export function timePerCard(x: {
  attempts: number;
  computeMs: number;
  swaps: number;
  cPairMs: number;
  /** Cards replayed. */
  n: number;
  low?: number;
  high?: number;
}): Graded & { n: number } {
  const value = x.attempts * x.computeMs + x.swaps * x.cPairMs;
  const grade: NumberGrade = x.n === 0 ? "design" : x.n < 20 ? "estimated" : "measured";
  return {
    value,
    grade,
    n: x.n,
    ...(x.low !== undefined ? { low: x.low } : {}),
    ...(x.high !== undefined ? { high: x.high } : {}),
  };
}

export interface CombinationCandidate {
  id: string;
  family?: string;
  footprintBytes: number;
  fits: FitLabel;
  /** The role's quality floor (rule 4c): qualified, and not worse on its evidence than a candidate it cannot be told apart from. */
  floorOk: boolean;
}

export type RoleCombination = Partial<Record<ModelRole, string>>;

export interface CombinationEstimate {
  timePerCardMs: Graded;
  [k: string]: unknown;
}

export interface RankedCombination<E extends CombinationEstimate = CombinationEstimate> {
  combination: RoleCombination;
  floorsMet: boolean;
  /** The largest single footprint: one large model is resident at a time (rule 22). */
  peakBytes: number;
  excluded?: string;
  estimate?: E;
}

const COMBO_ROLES: readonly ModelRole[] = MODEL_ROLES;

/**
 * Every combination of the candidates per role (MD-N14-42): the hard filters
 * first, each exclusion with its reason (the Reviewer's family differs from
 * the Worker's; every model fits); then every role's floor, then the least
 * time per card including swaps, then the smaller footprint. No weighted
 * combined score is computed.
 */
export function rankCombinations<E extends CombinationEstimate>(input: {
  roles: Partial<Record<ModelRole, readonly CombinationCandidate[]>>;
  estimate: (c: RoleCombination) => E;
  /** Cap on the combinations enumerated. */
  limit?: number;
}): RankedCombination<E>[] {
  const roles = COMBO_ROLES.filter((r) => (input.roles[r] ?? []).length > 0);
  const out: RankedCombination<E>[] = [];
  const limit = input.limit ?? 500;
  const walk = (i: number, acc: RoleCombination, picked: CombinationCandidate[]) => {
    if (out.length >= limit) return;
    if (i === roles.length) {
      const byRole = new Map(roles.map((r, k) => [r, picked[k] as CombinationCandidate]));
      const worker = byRole.get("worker");
      const reviewer = byRole.get("reviewer");
      const peak = Math.max(0, ...picked.map((p) => p.footprintBytes));
      const floorsMet = picked.every((p) => p.floorOk);
      const noFit = roles.find((r) => byRole.get(r)?.fits === "no");
      let excluded: string | undefined;
      if (noFit) excluded = `${byRole.get(noFit)?.id} does not fit this machine for the ${noFit}`;
      else if (reviewer && (!reviewer.family || (worker && reviewer.family === worker.family))) {
        excluded = !reviewer.family
          ? `${reviewer.id}'s family is unknown, so the Reviewer cannot be shown to differ from the Worker`
          : `the Reviewer ${reviewer.id} is of the Worker's family (${reviewer.family})`;
      }
      const combination = { ...acc };
      out.push({
        combination,
        floorsMet,
        peakBytes: peak,
        ...(excluded ? { excluded } : { estimate: input.estimate(combination) }),
      });
      return;
    }
    const role = roles[i] as ModelRole;
    for (const c of input.roles[role] ?? []) walk(i + 1, { ...acc, [role]: c.id }, [...picked, c]);
  };
  walk(0, {}, []);
  const kept = out.filter((o) => !o.excluded);
  kept.sort((a, b) => {
    if (a.floorsMet !== b.floorsMet) return a.floorsMet ? -1 : 1;
    const ta = a.estimate?.timePerCardMs.value ?? Number.POSITIVE_INFINITY;
    const tb = b.estimate?.timePerCardMs.value ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.peakBytes - b.peakBytes;
  });
  return [...kept, ...out.filter((o) => o.excluded)];
}
