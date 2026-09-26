import { acquireSlotLease } from "./slot_lease.js";

/**
 * The queue runner's slots (RUN-35): at most N cards run at once, each under
 * its own slot lease (`slot_lease.ts`) and in its own worktree and sandbox
 * (the card runner's, one per card). A card whose declared files a running
 * card is editing is not started; the caller defers it with the reason.
 *
 *     const claim = await pool.claim(card);
 *     if ("waiting" in claim) defer(card, claim.waiting);
 *     else pool.start(card.id, claim, () => runTheCard());
 *     await pool.whileFull();   // the next pick waits for a free slot
 *     ...
 *     await pool.drain();       // every card this pool started has ended
 */
export class SlotPool {
  private readonly inflight = new Map<string, Promise<void>>();
  private failure: { error: unknown } | undefined;

  constructor(
    private readonly repoPath: string,
    public readonly capacity: number,
    private readonly heartbeatMs?: number,
  ) {}

  /** Cards this pool is running now. */
  public get running(): number {
    return this.inflight.size;
  }

  /**
   * A slot for the card, or why it waits. When every slot is full with this
   * pool's own cards it waits for one to end; a card whose files a running
   * card is editing, or slots held by another process, answer at once.
   */
  public async claim(card: {
    id: string;
    scopeFiles: readonly string[];
  }): Promise<{ slot: number; release: () => void } | { waiting: string }> {
    for (;;) {
      const got = acquireSlotLease(this.repoPath, {
        capacity: this.capacity,
        cardId: card.id,
        scopeFiles: card.scopeFiles,
        ...(this.heartbeatMs !== undefined ? { heartbeatMs: this.heartbeatMs } : {}),
      });
      if (got.granted) return { slot: got.slot, release: got.release };
      const ours = got.holders.some((h) => this.inflight.has(h.cardId));
      if (got.reason === "full" && ours) {
        await this.oneEnds();
        continue;
      }
      return { waiting: got.message };
    }
  }

  /** Run `work` in the claimed slot; the slot is released when it ends, however it ends. */
  public start(cardId: string, claim: { release: () => void }, work: () => Promise<void>): void {
    const run = (async () => {
      try {
        await work();
      } catch (error) {
        this.failure ??= { error };
      } finally {
        claim.release();
        this.inflight.delete(cardId);
      }
    })();
    this.inflight.set(cardId, run);
  }

  /** Wait until a slot is free for the next pick (rethrows a card's error). */
  public async whileFull(): Promise<void> {
    while (this.inflight.size >= this.capacity) await this.oneEnds();
    this.rethrow();
  }

  /** Wait for every card this pool started (rethrows the first card's error). */
  public async drain(): Promise<void> {
    while (this.inflight.size > 0) await this.oneEnds();
    this.rethrow();
  }

  private async oneEnds(): Promise<void> {
    if (this.inflight.size > 0) await Promise.race(this.inflight.values());
  }

  private rethrow(): void {
    const failure = this.failure;
    if (failure) {
      this.failure = undefined;
      throw failure.error;
    }
  }
}
