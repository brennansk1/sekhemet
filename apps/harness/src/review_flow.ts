import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import {
  type LocalInferenceAdapter,
  MANAGED_MODEL_FAMILIES,
  MANAGED_MODEL_NAMES,
  type UnloadableAdapter,
  isManagedModelName,
  resolveWorkerModelId,
} from "@sekhemet/models";
import { REVIEW_DESK_COPY } from "@sekhemet/ui";
import { ledgerBundle } from "./accept.js";
import { type ReviewInput, type ReviewResult, findingText, reviewCard } from "./learning/review.js";
import { reviewCopy } from "./learning/review_copy.js";
import type { ModelAccess } from "./model_access.js";
import { QueuedReviews } from "./queued_reviews.js";

/**
 * When and how the Reviewer runs (review-git §2.3.2, P8): after a card's
 * checks pass and before a person sees it in Review, and before any
 * auto-accept.
 *
 * - A passing card waits in Verify, *Waiting for AI review*, and its review is
 *   queued on the Reviewer's queue, where Smart Swap's tours decide when the
 *   Review model visits (models rule 20e, C2 and C6; RG-P8-3). The review
 *   records the findings, then moves the card to Review (RG-P8-1).
 * - With `--auto-accept` the queue waits for the card's review before it
 *   merges, so the findings are on the card even when it merges (RG-P8-2).
 * - A Review role that is unfilled — no model outside the Coding model's
 *   family — records why on the card, which then goes to Review unreviewed
 *   and says so (RG-P8-10, models rule 23).
 * - A card left waiting by a stopped run is picked up by the next run (`resume`).
 */

/** The `blockedReason` of a card waiting in Verify for its review (DEC-31 words: a person reads it). */
export const REVIEW_WAIT = "Waiting for AI review";

/** The families a model id names, when the registry has none: lower-case stems of well-known families. */
const NAMED_FAMILIES = [
  "qwen",
  "gemma",
  "llama",
  "mistral",
  "phi",
  "deepseek",
  "glm",
  "granite",
  "olmo",
  "nemotron",
];

/**
 * A model's family (RG-P8-10). The registry keys a managed model by the id it
 * runs as (the roster upserts `adapter.modelId`), so a name such as
 * `cyber-tiel` is resolved first (`resolveWorkerModelId`); then the registry's
 * record, the managed defaults' families (`MANAGED_MODEL_FAMILIES`), and a
 * well-known family the id or name names. Undefined when none says, which
 * `resolveReviewerRole` treats as not shown to differ.
 */
export function familyOf(
  model: string,
  registry?: { get(id: string): { family?: string | undefined } | undefined },
): string | undefined {
  const name = model.replace(/^ollama\//, "");
  const id = resolveWorkerModelId(name);
  const recorded = registry?.get(model)?.family ?? registry?.get(id)?.family;
  if (recorded) return recorded.toLowerCase();
  const managed = isManagedModelName(name)
    ? name
    : MANAGED_MODEL_NAMES.find((n) => resolveWorkerModelId(n) === id);
  const known = managed ? MANAGED_MODEL_FAMILIES[managed] : undefined;
  if (known) return known.toLowerCase();
  const text = `${name} ${id}`.toLowerCase();
  return NAMED_FAMILIES.find((f) => text.includes(f));
}

export type ReviewerRole =
  | {
      state: "filled";
      model: string;
      /** The queue it runs on: its own, or the Planner's weights when they are of another family. */
      queue: "reviewer" | "manager";
    }
  | { state: "unfilled"; reason: string };

/**
 * The Review role for this run (review-git §2.3.7, RG-P8-10): the assigned or
 * named Review model when its family is known and differs from the Coding
 * model's; else the Planning model on the same terms. Otherwise — a shared
 * family, or a family not known for either — the role is unfilled, with the
 * reason Review shows.
 */
export function resolveReviewerRole(input: {
  reviewer?: string | undefined;
  planner?: string | undefined;
  worker: string;
  familyOf: (model: string) => string | undefined;
}): ReviewerRole {
  // Fail closed: a model whose family, or the Coding model's, is unknown is
  // not shown to be of another family, so it does not fill the role.
  const worker = input.familyOf(input.worker);
  const other = (m: string | undefined): m is string => {
    if (!m || worker === undefined) return false;
    const f = input.familyOf(m);
    return f !== undefined && f !== worker;
  };
  if (other(input.reviewer)) return { state: "filled", model: input.reviewer, queue: "reviewer" };
  if (other(input.planner)) return { state: "filled", model: input.planner, queue: "manager" };
  return { state: "unfilled", reason: REVIEW_DESK_COPY.noReviewer };
}

export interface ReviewContext {
  repoPath: string;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
}

/** What the project has learned that the Reviewer checks against. */
export interface Learned {
  preferences: string[];
  rules: string[];
}

/** The active code-style statements and the Worker's approved rules, from the learning store. */
export async function learnedFrom(learning: {
  profile(): Promise<{ status: string; category: string; statement: string }[]>;
  rules(): Promise<{ status: string; role?: string | undefined; text: string }[]>;
}): Promise<Learned> {
  return {
    preferences: (await learning.profile())
      .filter((p) => p.status === "active" && p.category === "code_style")
      .map((p) => p.statement),
    rules: (await learning.rules())
      .filter((r) => r.status === "active" && r.role === "worker")
      .map((r) => r.text),
  };
}

/**
 * The Reviewer's input for a card, from the ledger (RG-P8-11): the issue, its
 * criteria, the staged cases with the criterion each names, the checks, the
 * Worker's `Assumed: …` notes and the diff from the recorded evidence. The
 * Worker's transcript, steps, lessons and questions are not read.
 */
export async function reviewerInput(
  ctx: ReviewContext,
  card: CardRecord,
  learned: Learned,
): Promise<{ input: ReviewInput; evidenceId?: string } | undefined> {
  const ev = await ledgerBundle(ctx, card.id);
  if (!ev) return undefined;
  const dossier = await ctx.cardStore.getDossier(card.id);
  const assumptions = dossier.notes
    .filter((e) => /^\s*assumed\s*:/i.test(e.text))
    .map((e) => e.text.trim());
  const input: ReviewInput = {
    card: {
      id: card.id,
      title: card.title,
      ...(card.spec ? { spec: card.spec } : {}),
      acceptanceCriteria: card.acceptanceCriteria ?? [],
      criterionIds: card.criterionIds ?? [],
    },
    diff: ev.diff ?? "",
    stagedTests: ctx.cardStore.stagedTests
      .staged(card.id)
      .map((t) => ({ path: t.path, ...(t.cases ? { cases: t.cases } : {}) })),
    checks: (ev.rungResults ?? []).map((r) => ({
      gate: r.gate,
      passed: r.passed,
      ...(r.skipped ? { skipped: true } : {}),
    })),
    assumptions,
    preferences: learned.preferences,
    rules: learned.rules,
  };
  return { input, ...(ev.id ? { evidenceId: ev.id } : {}) };
}

/**
 * Record a review (RG-P8-9): one `card/review` dossier entry per finding —
 * verdict, text with its `file:line`, the files read as `sources`, the model
 * — then its coverage line, and the review beside the evidence bundle as
 * `review-<evidence id>.json` (the bundle itself is sealed by its hash on
 * the ledger, so it is written beside it, never into it).
 */
export async function recordReview(
  ctx: Pick<ReviewContext, "repoPath" | "cardStore">,
  cardId: string,
  review: ReviewResult,
  opts: { evidenceId?: string | undefined; attempt?: number | undefined } = {},
): Promise<string[]> {
  const ids: string[] = [];
  const common = {
    cardId,
    kind: "review" as const,
    actor: "reviewer",
    modelId: review.modelId,
    ...(review.filesRead.length ? { sources: review.filesRead } : {}),
    ...(opts.attempt ? { attempt: opts.attempt } : {}),
  };
  for (const [i, f] of review.findings.entries()) {
    const e = await ctx.cardStore.recordDossierEntry({
      ...common,
      verdict: f.verdict,
      text: findingText(f, review.cited[i] === true),
    });
    ids.push(e.entryId);
  }
  // RG-P8-6: the coverage line, with every file not read named (RG-P8-5).
  await ctx.cardStore.recordDossierEntry({
    ...common,
    verdict: "coverage",
    text: [review.coverage, review.notRead.length ? reviewCopy.notRead(review.notRead) : ""]
      .filter(Boolean)
      .join(" "),
  });
  if (opts.evidenceId) {
    const dir = join(ctx.repoPath, ".sekhemet", "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `review-${opts.evidenceId}.json`),
      `${JSON.stringify(
        {
          evidenceId: opts.evidenceId,
          cardId,
          modelId: review.modelId,
          findings: review.findings,
          // Which findings cite a line the harness checked; a skipped
          // criterion's fallback location cites nothing (RG-P8-1).
          cited: review.cited,
          entryIds: ids,
          filesChanged: review.filesChanged,
          filesRead: review.filesRead,
          notRead: review.notRead,
          coverage: review.coverage,
          uncited: review.uncited,
        },
        null,
        2,
      )}\n`,
    );
  }
  return ids;
}

/** Why no AI review ran on this change, on the card (RG-P8-10, models rule 23). */
export async function recordNotReviewed(
  ctx: Pick<ReviewContext, "cardStore">,
  cardId: string,
  text: string,
): Promise<void> {
  await ctx.cardStore.recordDossierEntry({
    cardId,
    kind: "review",
    actor: "reviewer",
    verdict: "not_reviewed",
    text,
  });
}

/**
 * Move a reviewed card from Verify to Review. The board may refuse
 * (back-pressure): the card is then held awaiting Review, which
 * `releaseHeldCards` retries when Review drains.
 */
export async function releaseToReview(ctx: ReviewContext, cardId: string): Promise<boolean> {
  const card = await ctx.cardStore.getCard(cardId);
  if (!card || card.status !== "verify") return false;
  if (card.blockedReason === REVIEW_WAIT)
    await ctx.cardStore.updateCard(cardId, { blockedReason: null }, "executor");
  try {
    await ctx.boardService.transitionCard({
      cardId,
      fromStatus: "verify",
      toStatus: "review",
      actor: "executor",
      reason: "checks passed; AI review recorded",
    });
    return true;
  } catch (err) {
    await ctx.boardService
      .holdCard(
        cardId,
        `review refused (${err instanceof Error ? err.message : String(err)})`,
        "executor",
        "review",
      )
      .catch(() => undefined);
    return false;
  }
}

/** A review that could not run: the reason on the card, which goes on to Review (models rule 23). */
export async function releaseUnreviewed(
  ctx: ReviewContext,
  cardId: string,
  err: unknown,
): Promise<void> {
  await recordNotReviewed(
    ctx,
    cardId,
    REVIEW_DESK_COPY.reviewFailed(err instanceof Error ? err.message : String(err)),
  ).catch(() => undefined);
  await releaseToReview(ctx, cardId);
}

/**
 * Review one waiting card on the model given and move it to Review. A
 * review that cannot run leaves the reason on the card, which goes on to
 * Review unreviewed (models rule 23), never stuck in Verify.
 */
export async function reviewAndRelease(
  ctx: ReviewContext,
  cardId: string,
  model: LocalInferenceAdapter,
  learned: Learned,
): Promise<ReviewResult | undefined> {
  const card = await ctx.cardStore.getCard(cardId);
  if (!card || card.status !== "verify") return undefined;
  let review: ReviewResult;
  try {
    const got = await reviewerInput(ctx, card, learned);
    if (!got) throw new Error("no recorded evidence to review");
    review = await reviewCard(model, got.input);
    const attempt = ctx.cardStore.runs.listAttempts(cardId).at(-1)?.attemptNumber;
    await recordReview(ctx, cardId, review, { evidenceId: got.evidenceId, attempt });
  } catch (err) {
    await releaseUnreviewed(ctx, cardId, err);
    return undefined;
  }
  await releaseToReview(ctx, cardId);
  return review;
}

/**
 * The queue's reviews (RG-P8-1..3): `decide` is the runner's `awaitReview`,
 * `afterRun` queues the review once the card's run has finished, and
 * `whenReviewed` is what auto-accept waits on.
 */
export class ReviewFlow {
  private readonly reviews: QueuedReviews<string> | undefined;
  private readonly waiting = new Map<string, Promise<void>>();
  /** Cards whose queued review could not run: they reach Review unreviewed, never merged. */
  private readonly unreviewed = new Set<string>();

  constructor(
    private readonly o: {
      ctx: ReviewContext;
      role: ReviewerRole;
      access: Pick<ModelAccess, "submit">;
      learned: () => Promise<Learned>;
      log?: (line: string) => void;
    },
  ) {
    const role = o.role;
    this.reviews =
      role.state === "filled"
        ? new QueuedReviews<string>({
            access: o.access,
            queue: role.queue,
            review: async (model: UnloadableAdapter, cardId: string) => {
              const r = await reviewAndRelease(o.ctx, cardId, model, await o.learned());
              if (!r) this.unreviewed.add(cardId);
              else {
                this.unreviewed.delete(cardId);
                const open = r.findings.filter((f) => f.verdict !== "met").length;
                o.log?.(`AI review of ${cardId} (${r.modelId}): ${open} to look at. ${r.coverage}`);
              }
            },
            ...(o.log ? { log: o.log } : {}),
          })
        : undefined;
  }

  public get role(): ReviewerRole {
    return this.o.role;
  }

  /** The runner's `awaitReview`: wait in Verify when a Review model is filled; else say why not. */
  public async decide(cardId: string): Promise<string | undefined> {
    // §2.3.2: a change with no diff has nothing to review.
    if (!(await ledgerBundle(this.o.ctx, cardId))?.diff?.trim()) return undefined;
    if (this.o.role.state === "unfilled") {
      await recordNotReviewed(this.o.ctx, cardId, this.o.role.reason).catch(() => undefined);
      return undefined;
    }
    return REVIEW_WAIT;
  }

  /** Queue the review of a card waiting in Verify (after its run's last write). */
  public async afterRun(cardId: string): Promise<void> {
    const card = await this.o.ctx.cardStore.getCard(cardId);
    if (card?.status !== "verify" || card.blockedReason !== REVIEW_WAIT) return;
    this.enqueue(cardId);
  }

  private enqueue(cardId: string): void {
    if (!this.reviews || this.waiting.has(cardId)) return;
    const done = this.reviews.add(cardId).finally(() => this.waiting.delete(cardId));
    this.waiting.set(cardId, done);
  }

  /** Resolves once the card's queued review has recorded its findings and moved it on (RG-P8-2). */
  public whenReviewed(cardId: string): Promise<void> {
    return this.waiting.get(cardId) ?? Promise.resolve();
  }

  /** Whether the card's queued review could not run, so nothing reviewed its change. */
  public reviewFailed(cardId: string): boolean {
    return this.unreviewed.has(cardId);
  }

  /**
   * Cards a stopped run left waiting in Verify: queued again, or — with the
   * role unfilled now — sent on to Review with the reason.
   */
  public async resume(): Promise<string[]> {
    const waiting = (await this.o.ctx.cardStore.listCards({ status: "verify" })).filter(
      (c) => c.blockedReason === REVIEW_WAIT,
    );
    for (const c of waiting) {
      if (this.o.role.state === "unfilled") {
        await recordNotReviewed(this.o.ctx, c.id, this.o.role.reason).catch(() => undefined);
        await releaseToReview(this.o.ctx, c.id);
      } else this.enqueue(c.id);
    }
    return waiting.map((c) => c.id);
  }

  public get queued(): number {
    return this.waiting.size;
  }

  public drain(): Promise<void> {
    return this.reviews?.drain() ?? Promise.resolve();
  }
}

/**
 * RG-P8-2: `--auto-accept` merges only after the card's AI review has
 * recorded its findings, and only a card that reached Review; a card whose
 * review could not run is left in Review for a person.
 */
export async function acceptAfterReview(
  flow: ReviewFlow,
  ctx: Pick<ReviewContext, "cardStore">,
  cardId: string,
  accept: (card: CardRecord) => Promise<string>,
): Promise<string | undefined> {
  await flow.whenReviewed(cardId);
  // A filled role whose review could not run leaves the change unreviewed: it
  // waits in Review for a person, saying so, and is never merged unread.
  if (flow.reviewFailed(cardId)) return undefined;
  const card = await ctx.cardStore.getCard(cardId);
  if (card?.status !== "review") return undefined;
  return accept(card);
}
