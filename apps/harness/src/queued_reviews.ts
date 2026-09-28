import type { UnloadableAdapter } from "@sekhemet/models";
import type { ModelAccess } from "./model_access.js";

/**
 * The queue's reviews of passing cards as queued requests (models rule 20e,
 * C2, C4, C6, C7; review-git's Reviewer): each passing card's review is
 * submitted when the card passes, marked a review, and `decide()` chooses when
 * the Reviewer visits — one tour for every review past half its cap, a
 * review at its cap served at the next boundary, reviews first while a person
 * is present, and never more round trips in an hour than the storm cap
 * allows. The Worker keeps working meanwhile; `drain` waits for the rest.
 */

/** A review's predicted service time (the median) until one is measured: one short request. */
export const REVIEW_SERVICE_MS = 60_000;

export class QueuedReviews<T> {
  private readonly pending: Promise<void>[] = [];

  constructor(
    private readonly opts: {
      access: Pick<ModelAccess, "submit">;
      /** The Reviewer's queue, or Seshat's when no Reviewer is configured. */
      queue: string;
      review: (model: UnloadableAdapter, item: T) => Promise<void>;
      log?: (line: string) => void;
    },
  ) {}

  /**
   * Queue one card's review; it runs when `decide()` has the Reviewer
   * resident. The promise settles when it has run (or failed, logged).
   */
  public add(item: T): Promise<void> {
    const done = this.opts.access
      .submit(this.opts.queue, (model) => this.opts.review(model, item), {
        review: true,
        serviceMs: REVIEW_SERVICE_MS,
      })
      .catch((err: unknown) => {
        this.opts.log?.(`review failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.pending.push(done);
    return done;
  }

  /** Reviews queued and not finished. */
  public get queued(): number {
    return this.pending.length;
  }

  /** Wait until every queued review has run. */
  public async drain(): Promise<void> {
    while (this.pending.length > 0) await Promise.allSettled(this.pending.splice(0));
  }
}
