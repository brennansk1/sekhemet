import { OVERRIDE_RATE_SHIFT_THRESHOLD } from "./constants.js";
import type {
  AmbiguityCategory,
  AssumptionOverrideRecord,
  CategoryCalibration,
  TrustCalibrationSnapshot,
} from "./types.js";

export interface CalibrationOptions {
  /** Visible and adjustable; defaults to 15%. */
  threshold?: number;
  /**
   * Observations required before a rate is acted on.
   *
   * Defaults to 1, which is the design rule applied literally: the first
   * override in a category flips it to `ask`. Raise it for a project that
   * would rather absorb a few overrides than lose autonomy early.
   */
  minimumSamples?: number;
  /** Prior observations, e.g. rehydrated from the kernel event log. */
  history?: AssumptionOverrideRecord[];
}

/**
 * Tracks whether humans keep or replace the planner's assumptions.
 *
 * Autonomy that is never measured drifts: the planner keeps assuming in a
 * category it is consistently wrong about, and the human keeps correcting it.
 * Crossing the override threshold converts that silent tax into an explicit
 * question.
 */
export class AssumptionCalibrationLog {
  private readonly records: AssumptionOverrideRecord[] = [];
  private readonly threshold: number;
  private readonly minimumSamples: number;

  public constructor(options: CalibrationOptions = {}) {
    this.threshold = options.threshold ?? OVERRIDE_RATE_SHIFT_THRESHOLD;
    this.minimumSamples = Math.max(1, options.minimumSamples ?? 1);
    for (const record of options.history ?? []) {
      this.records.push(record);
    }
  }

  public record(entry: AssumptionOverrideRecord): void {
    this.records.push(entry);
  }

  public history(): readonly AssumptionOverrideRecord[] {
    return this.records;
  }

  /** Per-category rates, including categories observed zero times. */
  public snapshot(categories?: readonly AmbiguityCategory[]): TrustCalibrationSnapshot {
    const seen = new Set<AmbiguityCategory>(categories ?? []);
    for (const record of this.records) {
      seen.add(record.category);
    }

    const result: CategoryCalibration[] = [];
    for (const category of seen) {
      result.push(this.calibrationFor(category));
    }
    result.sort((a, b) => b.overrideRate - a.overrideRate);

    return {
      threshold: this.threshold,
      minimumSamples: this.minimumSamples,
      categories: result,
    };
  }

  public calibrationFor(category: AmbiguityCategory): CategoryCalibration {
    let observed = 0;
    let overridden = 0;
    for (const record of this.records) {
      if (record.category !== category) {
        continue;
      }
      observed += 1;
      if (record.overridden) {
        overridden += 1;
      }
    }

    const overrideRate = observed === 0 ? 0 : overridden / observed;
    const shifted = observed >= this.minimumSamples && overrideRate > this.threshold;

    return {
      category,
      observed,
      overridden,
      overrideRate,
      disposition: shifted ? "ask" : "assume",
      shifted,
    };
  }

  /**
   * Whether a category that would otherwise be assumed must now be asked.
   *
   * Only ever tightens: calibration can turn an assume into an ask, never an
   * ask into an assume, because the categories that are asked by default are
   * asked for reasons calibration does not measure (public API, security).
   */
  public shouldAskInsteadOfAssume(category: AmbiguityCategory): boolean {
    return this.calibrationFor(category).shifted;
  }
}
