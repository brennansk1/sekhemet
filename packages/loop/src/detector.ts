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
 * What the detector concluded about this turn.
 *
 * A stall is a failure the Worker must act on, and the design requires such a
 * failure to arrive typed and carrying a suggested action. Ending the card on
 * the first repetition gives it neither: the first frozen-suite run lost most
 * of its cards at step two of a thirty-two step budget, several having read
 * one file twice and written nothing. So the first stall is a warning the
 * model is told about, and only a stall that repeats after being told ends
 * the card.
 */
export type StallVerdict =
  | "none"
  | "warn" // tell the Worker it is repeating; let it act on that
  | "stop"; // it repeated after being told

/**
 * Detects genuine non-progress: identical actions that also left the repo unchanged.
 *
 * Repetition alone is not a stall. The repo hash is what separates "tried the
 * same thing and nothing happened" from "made an edit and re-ran the gate".
 */
export class OscillationDetector {
  private history: StallSignature[] = [];
  private warned = false;

  constructor(private threshold = STALL_THRESHOLD) {}

  /** The last thing the Worker repeated, for the warning's text. */
  public get repeatedTools(): string {
    return this.history.at(-1)?.tools ?? "";
  }

  public recordAndCheck(calls: ToolCall[], repoStateHash = ""): StallVerdict {
    this.history.push(this.computeSignature(calls, repoStateHash));

    const verdict = (): StallVerdict => {
      // Warn once, then stop. A Worker that repeats after being told it is
      // repeating has genuinely run out of ideas; one that has not been told
      // has not yet been given the chance the ladder assumes it had.
      if (this.warned) return "stop";
      this.warned = true;
      return "warn";
    };

    if (this.history.length < this.threshold) return "none";

    const recent = this.history.slice(-this.threshold);
    const first = recent[0] as StallSignature;

    // N consecutive identical signatures with an unchanged repository.
    const identical = recent.every(
      (s) =>
        s.tools === first.tools &&
        s.argHash === first.argHash &&
        s.repoStateHash === first.repoStateHash,
    );
    if (identical) return verdict();

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
        return verdict();
      }
    }

    return "none";
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
