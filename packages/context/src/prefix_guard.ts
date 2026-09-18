/**
 * Zone-2 prefix stability for a whole card (C4, design "Prompt layout").
 *
 * The system prompt is the cached prefix. Anything in it that changes
 * mid-card (a rule re-ranked after a gate failure, skills collapsing to
 * manifests under pressure, the allocator cutting a rule) re-prefills the
 * whole prompt on this hardware. The guard pins the system prompt the first
 * time a card's prompt is built; `buildWorkerPrompt` then reuses the pinned
 * text verbatim and moves anything new (a rule that entered later) to the
 * volatile tail. Every later build's `prefixHash` is checked against the
 * pin, so drift is an observable event rather than a silent cache miss.
 */
export interface PinnedPrefix {
  cardId: string;
  systemPrompt: string;
  prefixHash: string;
  /** Rule ids in the pinned system prompt. */
  ruleIds: string[];
  /** Skill disclosure in force when pinned. */
  disclosure: "full" | "manifest";
  /** Joint prompt/playbook/tool version at pin time (C21). */
  versionHash: string;
}

export interface PrefixDrift {
  cardId: string;
  expected: string;
  actual: string;
  build: number;
}

export class PrefixStabilityGuard {
  private pins = new Map<string, PinnedPrefix>();
  private builds = new Map<string, number>();
  public readonly drifts: PrefixDrift[] = [];

  public pinned(cardId: string): PinnedPrefix | undefined {
    return this.pins.get(cardId);
  }

  public pin(prefix: PinnedPrefix): void {
    if (!this.pins.has(prefix.cardId)) this.pins.set(prefix.cardId, prefix);
  }

  /**
   * Record one build's prefix hash. Returns false (and records a drift)
   * when it differs from the card's pin.
   */
  public observe(cardId: string, prefixHash: string): boolean {
    const n = (this.builds.get(cardId) ?? 0) + 1;
    this.builds.set(cardId, n);
    const pin = this.pins.get(cardId);
    if (!pin || pin.prefixHash === prefixHash) return true;
    this.drifts.push({ cardId, expected: pin.prefixHash, actual: prefixHash, build: n });
    return false;
  }

  /** Throws when any build drifted: the runtime assertion (C4, C15). */
  public assertStable(cardId?: string): void {
    const d = this.drifts.find((x) => cardId === undefined || x.cardId === cardId);
    if (d) {
      throw new Error(
        `Prompt prefix drifted mid-card for ${d.cardId} at build ${d.build}: ${d.expected.slice(0, 12)} -> ${d.actual.slice(0, 12)}`,
      );
    }
  }

  /** Forget a card (a new attempt with a deliberately fresh prompt). */
  public reset(cardId: string): void {
    this.pins.delete(cardId);
    this.builds.delete(cardId);
  }
}
