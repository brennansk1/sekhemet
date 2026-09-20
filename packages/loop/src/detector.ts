import { createHash } from "node:crypto";
import type { ToolCall } from "@sekhemet/models";

/** Canonical JSON so key ordering cannot change a fingerprint. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export interface StallSignature {
  /** Tool names invoked this turn, in order. */
  tools: string;
  /** Stable hash of the arguments. */
  argHash: string;
  /**
   * Fingerprint of the repository after the turn.
   *
   * Without it, an agent that repeats a command *after* successfully changing
   * the tree is indistinguishable from one stuck in a no-op loop — so a
   * legitimate re-run of the test suite reads as a stall.
   */
  repoStateHash: string;
}

/**
 * Design §740: "Two identical signatures with unchanged repo state is a
 * stall." Not a tunable — `[loop] stall_window` was removed from the config
 * schema for the same reason the repair ladder's shape was: a breaker the
 * user can widen is a breaker that never trips.
 */
export const STALL_THRESHOLD = 2;

/** Design §741: "An A-B-A pattern is an oscillation." Three turns, not four. */
export const OSCILLATION_WINDOW = 3;

/**
 * Detects genuine non-progress: identical actions that also left the repo unchanged.
 *
 * Repetition alone is not a stall. The repo hash is what separates "tried the
 * same thing and nothing happened" from "made an edit and re-ran the gate".
 */
export class OscillationDetector {
  private history: StallSignature[] = [];

  constructor(private threshold = STALL_THRESHOLD) {}

  public recordAndCheck(calls: ToolCall[], repoStateHash = ""): boolean {
    this.history.push(this.computeSignature(calls, repoStateHash));

    if (this.history.length < this.threshold) return false;

    const recent = this.history.slice(-this.threshold);
    const first = recent[0] as StallSignature;

    // N consecutive identical signatures with an unchanged repository.
    const identical = recent.every(
      (s) =>
        s.tools === first.tools &&
        s.argHash === first.argHash &&
        s.repoStateHash === first.repoStateHash,
    );
    if (identical) return true;

    // A -> B -> A: the agent has come back to an action it already took with
    // nothing to show for the detour. Waiting for the fourth turn to confirm
    // a B-A-B-A cycle spends a step the card does not get back.
    if (this.history.length >= OSCILLATION_WINDOW) {
      const window = this.history.slice(-OSCILLATION_WINDOW) as StallSignature[];
      const a = window[0] as StallSignature;
      const b = window[1] as StallSignature;
      const c = window[2] as StallSignature;
      const same = (x: StallSignature, y: StallSignature): boolean =>
        x.tools === y.tools && x.argHash === y.argHash;
      // An empty hash means the tree was never fingerprinted, not that it
      // stood still: returning to an action after an edit is progress, and
      // without the hash there is no way to tell the two apart.
      if (
        same(a, c) &&
        !same(a, b) &&
        a.repoStateHash === c.repoStateHash &&
        a.repoStateHash !== ""
      ) {
        return true;
      }
    }

    return false;
  }

  private computeSignature(calls: ToolCall[], repoStateHash: string): StallSignature {
    return {
      tools: calls.map((c) => c.name).join(","),
      argHash: createHash("sha256")
        .update(canonicalize(calls.map((c) => c.arguments)))
        .digest("hex")
        .slice(0, 32),
      repoStateHash,
    };
  }

  public reset(): void {
    this.history = [];
  }
}
