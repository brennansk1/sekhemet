import type { ToolCall } from "@sekhemet/models";

export class OscillationDetector {
  private history: string[] = [];

  constructor(private threshold = 3) {}

  public recordAndCheck(calls: ToolCall[]): boolean {
    const fingerprint = this.computeFingerprint(calls);
    this.history.push(fingerprint);

    if (this.history.length < this.threshold) {
      return false;
    }

    // 1. Check for N consecutive identical fingerprints
    const recent = this.history.slice(-this.threshold);
    const allIdentical = recent.every((fp) => fp === recent[0]);
    if (allIdentical) {
      return true;
    }

    // 2. Check for alternating cycle (A -> B -> A -> B) across 4 turns
    if (this.history.length >= 4) {
      const last4 = this.history.slice(-4);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        return true;
      }
    }

    return false;
  }

  private computeFingerprint(calls: ToolCall[]): string {
    const simplified = calls.map((c) => ({
      name: c.name,
      args: c.arguments,
    }));
    return JSON.stringify(simplified);
  }

  public reset(): void {
    this.history = [];
  }
}
