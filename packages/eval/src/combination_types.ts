import type { ConfigRole } from "@sekhemet/models";

/**
 * The combination benchmark's shapes (B4.1 step 0; measurement NEW-measurement-5,
 * rules 30–37; PM_CONTRACT §3 *Configuration*). Types only; the quick and
 * overnight tiers (`combination_bench.ts`, `overnight_bench.ts`) arrive with
 * B4.1 part (c). The event is `measure/benchmarked` in the kernel's payload
 * registry.
 */

/** The two tiers (measurement rules 30, 37): minutes now, or a paired night. */
export type BenchTier = "quick" | "overnight";

/**
 * One model per role (measurement rule 30, PM_CONTRACT `Combination`); a role
 * may be left unfilled. Model ids are registry ids or found models' ids.
 */
export interface Combination {
  worker: string;
  planner: string;
  reviewer?: string;
  researcher?: string;
}

/**
 * A score (PM_CONTRACT `Score`): a rate carries its exact interval; a graded
 * quick-tier mean (rule 31, items graded 0–1) carries its item range.
 */
export interface Score {
  value: number;
  n: number;
  low?: number;
  high?: number;
  kind: "rate" | "graded";
}

/**
 * The key a role's quick score is cached under (measurement rule 33,
 * MS-N5-2): a combination that changes one role re-runs only that role.
 * `measure/benchmarked` records it as one stable string (`cacheKey`) with
 * `setHash` beside it.
 */
export interface CacheKey {
  model: string;
  quantisation: string;
  engine: string;
  /** A stable hash of the role's settings (context, KV type, speculation, template). */
  settings: string;
  host: string;
  /** The harness context version (`workerContextVersion()`, models §5 context version). */
  contextVersion: string;
  /** The screening set's SHA-256 (rule 29). */
  setHash: string;
}

/** One item's graded score, for the paired sign test (rules 31, 35; MS-N5-3, MS-N5-4). */
export interface ItemScore {
  id: string;
  /** 0–1: the fraction of a card's acceptance tests passing, ½ steps for a Researcher answer. */
  score: number;
}

/** The measures beside a role's score, where the quick tier tells close models apart (MS-N5-4a). */
export interface SecondaryMeasures {
  secondsPerItem?: number;
  validToolCallRate?: number;
  stepsToPass?: number;
  fits: boolean;
}

/**
 * One role's score for one model (PM_CONTRACT `RoleScore`; the event's
 * `roles[]`, measurement §3). `not_measured` when the role's screening set is
 * not built yet (rule 30a, MS-N5-4b), and then it is in no comparison.
 */
export interface RoleScore {
  role: ConfigRole;
  model: string;
  state: "measured" | "partial" | "not_measured";
  score?: Score;
  /** Cached: re-measured only when this role's model changes (rule 33). */
  measuredAt?: string;
  cacheKey?: CacheKey;
  items?: ItemScore[];
  /** Worker screening cards that hit the time cap (MS-N5-3). */
  capped?: number;
  secondary?: SecondaryMeasures;
}

/**
 * Two candidates compared on the same items by the exact two-sided sign test,
 * ties set aside (rule 35, MS-N5-4); `indistinguishable` when p ≥ 0.05, and
 * then neither is ranked above the other.
 */
export interface PairedComparison {
  role: ConfigRole;
  a: string;
  b: string;
  better: number;
  worse: number;
  ties: number;
  p: number;
  indistinguishable: boolean;
}

/** A combination's result in one tier (PM_CONTRACT `CombinationResult`). */
export interface CombinationResult {
  /** Derived from the four model ids and the host. */
  combinationId: string;
  combination: Combination;
  tier: BenchTier;
  roles: RoleScore[];
  /** The short end-to-end check, reported beside the role scores, never folded in (MS-N5-7). */
  endToEnd?: { passed: number; total: number };
  score?: Score;
  current: boolean;
  recommended: boolean;
  reason?: string;
  /** Candidates the paired sign test cannot separate from this one (rule 10). */
  indistinguishableFrom: string[];
  /** Overnight only. */
  resolvedAgainst?: { combinationId: string; outcome: "better" | "worse" }[];
  /** Against the recorded frozen baseline; "not established" below what the measurement resolves. */
  versusBaseline?: "better" | "worse" | "not established";
  date: string;
}

/**
 * A benchmark run's state (PM_CONTRACT `BenchmarkRun`): queued for the
 * overnight window or waiting for the runner, running, stopped with its
 * results kept, done or failed. One run holds the runner at a time.
 */
export interface BenchRun {
  runId: string;
  tier: BenchTier;
  /** Combination ids. */
  combinations: string[];
  state: "queued" | "running" | "stopped" | "done" | "failed";
  /** Overnight (MS-N5-9): the window, how many combinations fit tonight, when it starts. */
  schedule?: {
    window: { start: string; end: string };
    fitsTonight: number;
    nextStart?: string;
  };
  progress?: {
    role?: ConfigRole;
    model?: string;
    combinationId?: string;
    done: number;
    total: number;
    elapsedSeconds: number;
    etaSeconds?: number;
  };
  /** Stopped with results kept (MS-N5-6). */
  partial: boolean;
}
