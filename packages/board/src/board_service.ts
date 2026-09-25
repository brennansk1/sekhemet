import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  LEGAL_TRANSITIONS,
  STOP_REASONS,
  StatusTransitionError,
  isCardStatus,
  matchesScope,
} from "@sekhemet/kernel";
import {
  type BoardService,
  type BoardState,
  type CardTransition,
  type EvidenceSummary,
  type ScopeOverlap,
  TransitionRefusedError,
  type WipLimitStatus,
} from "./types.js";

const DEFAULT_WIP_LIMITS: Record<CardStatus, number> = {
  backlog: 500,
  ready: 50,
  planning: 3,
  in_progress: 5,
  verify: 5,
  review: 3,
  done: 10000,
  rejected: 10000,
  parked: 10000,
};

/**
 * The board's view of an evidence bundle (B1, B12), in one place so the
 * dashboard, the CLI and the tests all read a bundle the same way.
 *
 * Typed structurally rather than against `@sekhemet/gates`: the board sits
 * below the gates package in the graph and needs three fields out of the
 * bundle. A skipped gate is not a failing one — it never ran.
 */
export function evidenceSummaryOf(bundle: {
  passed?: boolean;
  rungResults?: { gate?: string; layer?: string; passed?: boolean; skipped?: boolean }[];
}): EvidenceSummary {
  const rungs = bundle.rungResults ?? [];
  const failingSecurityGates = rungs
    .filter((r) => r.layer === "security" && r.passed === false && r.skipped !== true)
    .map((r) => r.gate ?? "security");
  return {
    passed: bundle.passed === true,
    gatesRun: rungs.length,
    ...(failingSecurityGates.length > 0 ? { failingSecurityGates } : {}),
  };
}

/**
 * The Review entry condition's treatment of results from someone else's CI
 * (kernel rule 37, K-N8-4): a result whose `headSha` is not the card branch's
 * head is not counted at all (nor is any when the head is unknown); one for a
 * check the project has not declared blocking is advisory; a declared one
 * counts as a gate that ran, and a failure fails the evidence.
 */
export function withExternalResults(
  summary: EvidenceSummary,
  results: readonly {
    passed: boolean;
    source: "local" | "external";
    externalRef?: { checkName: string; headSha: string };
  }[],
  options: { blockingChecks: readonly string[]; branchHead: string | undefined },
): EvidenceSummary {
  const blocking = new Set(options.blockingChecks);
  const counted = results.filter(
    (r) =>
      r.source === "external" &&
      r.externalRef !== undefined &&
      options.branchHead !== undefined &&
      r.externalRef.headSha === options.branchHead &&
      blocking.has(r.externalRef.checkName),
  );
  if (counted.length === 0) return summary;
  return {
    ...summary,
    passed: summary.passed && counted.every((r) => r.passed),
    gatesRun: summary.gatesRun + counted.length,
  };
}

/** The shortest legal route between two columns (for rollup), or undefined. */
export function legalPath(from: CardStatus, to: CardStatus): CardStatus[] | undefined {
  if (from === to) return [];
  const queue: CardStatus[][] = [[from]];
  const seen = new Set<CardStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as CardStatus[];
    for (const next of LEGAL_TRANSITIONS[path[path.length - 1] as CardStatus] ?? []) {
      if (seen.has(next)) continue;
      if (next === to) return [...path.slice(1), next];
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

export interface BoardServiceOptions {
  customLimits?: Partial<Record<CardStatus, number>>;
  /** Minutes a human can spend reviewing per day, used to derive ReviewWIP. */
  reviewMinutesPerDay?: number;
  /**
   * Called for every override (an `override:` reason past an illegal edge or
   * an entry condition). The board also records a `card/override` event.
   */
  onOverride?: (t: CardTransition, reason: string) => void;
  /**
   * Check each column's entry condition (B1, design "Entry conditions").
   * The harness turns this on; a bare board (and its unit tests) checks
   * only the edge table and the WIP limits.
   */
  entryConditions?: boolean;
  /** The card's latest evidence, for the Review entry condition. */
  evidenceFor?: (
    cardId: string,
  ) => Promise<EvidenceSummary | undefined> | EvidenceSummary | undefined;
  /**
   * The project's Planner, when one is resolvable (rule 27, K-N5-1): it
   * scores a card without a difficulty (1–10) as part of its move into
   * Planning. Without one, such a move is refused.
   */
  planner?: { scoreDifficulty(card: CardRecord): Promise<number> | number };
  /**
   * The context allocator's measure of the card's Zone 3 content at the
   * resolved Worker's prompt budget, and Zone 3's cap (rule 27, K-N5-7) —
   * INVEST's *Small*, the only token-count limit on a card.
   */
  zone3Fit?: (
    card: CardRecord,
  ) => Promise<{ tokens: number; cap: number }> | { tokens: number; cap: number };
  /**
   * The repository's measurement marker (`.sekhemet/measurement.json`), read
   * by the caller: the board sits below `@sekhemet/eval`. Only where a measured
   * run prepared the repository may the harness accept a card (`--auto-accept`).
   */
  measurementMarker?: { purpose: string };
}

/**
 * A decision request's policy (planner-pm §2.10.3): the planner's request
 * travels in the record's `context` as JSON (`{planner: {policy}}`); a
 * record without one (the ask tier's) has no policy.
 */
function decisionPolicy(context: string): string | undefined {
  try {
    const parsed = JSON.parse(context) as { planner?: { policy?: unknown } } | null;
    const policy = parsed?.planner?.policy;
    return typeof policy === "string" ? policy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who may record acceptance (the Done entry condition, rule 24): a person.
 * The harness moves a card to Done only as a parent's rollup (rule 30) or in
 * a repository a measured run prepared (`--auto-accept`) — `harnessMayAccept`.
 */
const ACCEPTING_ACTORS = new Set(["human"]);

/** The measurement marker's purposes (`@sekhemet/eval`'s `MeasurementMarker`). */
const MEASUREMENT_PURPOSES = new Set(["frozen suite", "m0"]);

/**
 * Columns a card only reaches by having passed its gates (B12).
 *
 * Moving into either is the act an override exists to force, so these are the
 * two doors the security refusal below has to stand at.
 */
const GATED_COLUMNS = new Set<CardStatus>(["review", "done"]);

export class BoardServiceImpl implements BoardService {
  private wipLimits: Record<CardStatus, number>;
  private options: BoardServiceOptions;

  constructor(
    private cardStore: CardStore,
    optionsOrLimits: BoardServiceOptions | Partial<Record<CardStatus, number>> = {},
  ) {
    // Accept the legacy positional limits object as well as the options form.
    const options: BoardServiceOptions =
      "customLimits" in optionsOrLimits ||
      "reviewMinutesPerDay" in optionsOrLimits ||
      "onOverride" in optionsOrLimits ||
      "entryConditions" in optionsOrLimits ||
      "evidenceFor" in optionsOrLimits ||
      "planner" in optionsOrLimits ||
      "zone3Fit" in optionsOrLimits ||
      "measurementMarker" in optionsOrLimits
        ? (optionsOrLimits as BoardServiceOptions)
        : { customLimits: optionsOrLimits as Partial<Record<CardStatus, number>> };

    this.options = options;
    this.wipLimits = { ...DEFAULT_WIP_LIMITS, ...(options.customLimits ?? {}) };
  }

  /**
   * The entry condition a move into `to` fails, or undefined (B1). Checked
   * after the edge table, before back-pressure and WIP.
   */
  public async entryConditionFailure(
    card: CardRecord,
    t: CardTransition,
    /** The move is `closePullRequest`'s, for a merged pull request (rule 24). */
    via: { merged?: boolean } = {},
  ): Promise<string | undefined> {
    const to = t.toStatus;
    if (to === "ready" || to === "in_progress" || to === "planning") {
      const waiting = this.cardStore.waitingOn(card.id);
      if (waiting.length > 0) {
        return `${card.id} waits on ${waiting.join(", ")}, which ${waiting.length === 1 ? "is" : "are"} not done`;
      }
    }
    if (to === "ready" && t.fromStatus === "backlog") {
      const criteria =
        (card.acceptanceCriteria?.length ?? 0) > 0 || (card.acceptanceTests?.length ?? 0) > 0;
      if (!criteria)
        return `${card.id} has no acceptance criteria or tests; write them before it is Ready`;
    }
    // A parent's scope is its children's; it never runs itself (B7 rollup).
    const isParent = (await this.cardStore.listCards({ parentId: card.id })).length > 0;
    // K-N5-7: INVEST's Small — the card's Zone 3 content fits Zone 3's cap.
    if (
      to === "ready" &&
      (t.fromStatus === "backlog" || t.fromStatus === "planning") &&
      !isParent &&
      this.options.zone3Fit
    ) {
      const fit = await this.options.zone3Fit(card);
      if (fit.tokens > fit.cap) {
        return `${card.id}'s Zone 3 content is ${fit.tokens.toLocaleString("en-US")} tokens, over Zone 3's cap of ${fit.cap.toLocaleString("en-US")}; split it before it is Ready`;
      }
    }
    // K-N5-1: Planning needs a difficulty score, or a Planner to score it on entry.
    if (to === "planning" && card.difficulty === undefined && !this.options.planner) {
      return `${card.id} has no difficulty score and no Planner is resolvable for the project to score it`;
    }
    // K-N5-2: Parked needs a recorded reason.
    if (to === "parked" && !(await this.parkReason(card, t))) {
      return `${card.id} has no reason to park: a stop reason that parks, a person's reason, or an open decision request on the card`;
    }
    if (to === "in_progress" && card.scopeFiles.length === 0 && !isParent) {
      return `${card.id} declares no scope files; declare what it may change before it starts`;
    }
    if (to === "review") {
      const evidence = await this.options.evidenceFor?.(card.id);
      if (!evidence) return `${card.id} has no evidence bundle; Review needs one`;
      if (!evidence.passed || evidence.gatesRun === 0) {
        return `${card.id}'s latest evidence ${evidence.gatesRun === 0 ? "ran no gates" : "did not pass every gate"}`;
      }
    }
    // Rule 27, K-S4-6: Verify takes a finished attempt, with its stop reason
    // on the ledger — never a card whose attempt is still running, or none.
    if (to === "verify") {
      const current = this.cardStore.runs.listAttempts(card.id).at(-1);
      if (!current?.stopReason) {
        return current
          ? `${card.id}'s attempt ${current.attemptNumber} has no recorded stop reason; Verify takes a finished attempt`
          : `${card.id} has no attempt with a recorded stop reason; Verify takes a finished attempt`;
      }
    }
    // An accepting decision: a person's move, or — only for the merge of an
    // accepted card's pull request — the acceptance already recorded (rule
    // 24). A stored accepter alone never accepts: a card that left Done needs
    // a new decision (spine: the human is the rate limiter).
    const mergeOfAccepted = via.merged === true && card.accepter !== undefined;
    if (
      to === "done" &&
      !ACCEPTING_ACTORS.has(t.actor) &&
      !mergeOfAccepted &&
      !(t.actor === "harness" && (await this.harnessMayAccept(card)))
    ) {
      return t.actor === "harness"
        ? `Only a person accepts a card: the harness moves ${card.id} to Done only as a parent's passing rollup (rule 30) or in a repository a measured run prepared (.sekhemet/measurement.json)`
        : `Only a person accepts a card (actor was ${t.actor})`;
    }
    return undefined;
  }

  /**
   * The harness's two moves to Done: a measured repository's `--auto-accept`
   * (the marker bounds it), or a parent's rollup (rule 30) — every child
   * `done` and a passing `card/rollup` from the gate recorded after the last
   * child's last move, naming every child. Success is never inferred from
   * the children alone.
   */
  private async harnessMayAccept(card: CardRecord): Promise<boolean> {
    const marker = this.options.measurementMarker;
    if (marker && MEASUREMENT_PURPOSES.has(marker.purpose)) return true;
    const children = await this.cardStore.listCards({ parentId: card.id });
    if (children.length === 0 || children.some((c) => c.status !== "done")) return false;
    const rollup = (await this.cardStore.cardEvents(card.id, ["card/rollup"])).at(-1);
    const verdict = rollup?.payload as { passed?: unknown; children?: unknown } | undefined;
    if (!rollup || rollup.actor !== "gate" || verdict?.passed !== true) return false;
    const named = new Set(Array.isArray(verdict.children) ? verdict.children : []);
    if (children.some((c) => !named.has(c.id))) return false;
    for (const child of children) {
      const last = (await this.cardStore.cardEvents(child.id, ["card/status_changed"])).at(-1);
      if (last && last.seq > rollup.seq) return false;
    }
    return true;
  }

  /**
   * The recorded reason a card may park for (rule 27, K-N5-2): its latest
   * attempt's stop reason when the table parks it, a person's reason, or an
   * open decision request on the card — which parks it from the request.
   */
  private async parkReason(card: CardRecord, t: CardTransition): Promise<string | undefined> {
    if ((t.actor === "human" || t.actor === "mcp") && t.reason?.trim()) return "person";
    const latest = this.cardStore.runs.listAttempts(card.id).at(-1);
    if (latest?.stopReason && STOP_REASONS[latest.stopReason]?.parks !== "no") return "stop";
    // Only a `default_deny` request parks its card from the request; under
    // `safe_default` work proceeds on the default (planner-pm §2.10.3).
    const open = this.cardStore.runs
      .listDecisions("pending")
      .some((d) => d.cardId === card.id && decisionPolicy(d.context) === "default_deny");
    return open ? "decision" : undefined;
  }

  /** Record an override on the ledger as the human decision it is (B1). */
  private async recordOverride(t: CardTransition, what: string): Promise<void> {
    this.options.onOverride?.(t, t.reason ?? "unspecified");
    await this.cardStore.recordEvent({
      type: "card/override",
      cardId: t.cardId,
      actor: "human",
      ...(t.principal ? { principal: t.principal } : {}),
      payload: {
        id: t.cardId,
        from: t.fromStatus,
        to: t.toStatus,
        overrode: what,
        ...(t.principal ? { principal: t.principal } : {}),
      },
      // The reason is a person's free text: the private part (rule 33, K-S7-9).
      private: { reason: t.reason ?? "" },
    });
  }

  /**
   * ReviewWIP = floor(reviewMinutesPerDay / medianReviewMinutesPerCard), min 1.
   *
   * Derived from the project's own accepted-card history rather than fixed at a
   * constant, because the bottleneck being modelled is a specific human's
   * available review time.
   */
  public async computeReviewWip(reviewMinutesPerDay?: number): Promise<number> {
    const budget = reviewMinutesPerDay ?? this.options.reviewMinutesPerDay;
    if (!budget || budget <= 0) return this.wipLimits.review;

    const durations = (await this.measuredReviewMinutes()).sort((a, b) => a - b);

    if (durations.length === 0) return this.wipLimits.review;

    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
        : (durations[mid] as number);

    return Math.max(1, Math.floor(budget / median));
  }

  /**
   * Minutes each review took (B3): from a card entering Review to the
   * person's verdict (accept, return, park), read from the ledger's status
   * changes. Every review counts, not only accepted ones: a return costs the
   * reviewer the same reading time.
   */
  public async measuredReviewMinutes(): Promise<number[]> {
    const out: number[] = [];
    for (const card of await this.cardStore.listCards()) {
      const changes = await this.cardStore.cardEvents(card.id, ["card/status_changed"]);
      let enteredAt: number | undefined;
      for (const e of changes) {
        const p = e.payload as { toStatus?: string; fromStatus?: string; updatedAt?: string };
        const at = Date.parse(p.updatedAt ?? e.createdAt);
        if (p.toStatus === "review") enteredAt = at;
        else if (p.fromStatus === "review" && enteredAt !== undefined) {
          const minutes = (at - enteredAt) / 60_000;
          if (minutes > 0) out.push(minutes);
          enteredAt = undefined;
        }
      }
    }
    return out;
  }

  /** Apply a history-derived ReviewWIP, replacing the static default. */
  public async calibrateReviewWip(reviewMinutesPerDay: number): Promise<number> {
    const limit = await this.computeReviewWip(reviewMinutesPerDay);
    this.wipLimits = { ...this.wipLimits, review: limit };
    return limit;
  }

  public async transitionCard(t: CardTransition): Promise<void> {
    await this.move(t, {});
  }

  /** `transitionCard`, and the merge's move to Done (`closePullRequest`). */
  private async move(t: CardTransition, via: { merged?: boolean }): Promise<void> {
    const card = await this.cardStore.getCard(t.cardId);
    if (!card) {
      throw new TransitionRefusedError(
        "card_not_found",
        t.cardId,
        t.toStatus,
        `Card not found: ${t.cardId}`,
      );
    }

    // Rule 26, K-S4-1: a compare-and-set against the stored status.
    if (t.fromStatus !== card.status) {
      throw new TransitionRefusedError(
        "stale_from",
        t.cardId,
        t.toStatus,
        `${t.cardId} is in '${card.status}', not '${t.fromStatus}'; nothing was changed`,
      );
    }
    // K-S4-2: a move to the state the card is in appends nothing.
    if (t.toStatus === card.status) return;
    // K-N3-5: an accepted card awaiting its pull request reaches Done only by
    // the merge (`closePullRequest`), never by a move, not even an override.
    if (card.hold?.kind === "awaitingMerge" && t.toStatus === "done") {
      throw new TransitionRefusedError(
        "entry_condition",
        t.cardId,
        t.toStatus,
        `${t.cardId} was accepted and awaits pull request #${card.hold.pr}; it reaches Done when that merges`,
      );
    }

    const legal = LEGAL_TRANSITIONS[card.status] ?? [];
    const override = t.reason?.startsWith("override:") === true;
    // Rule 28, K-S4-5: only a person, named, takes responsibility for an override.
    if (override && (t.actor !== "human" || !t.principal?.trim())) {
      throw new TransitionRefusedError(
        "override_forbidden",
        t.cardId,
        t.toStatus,
        t.actor !== "human"
          ? `Only a person may override (the actor was ${t.actor}); nothing was changed`
          : "An override names the person who takes responsibility for it; none was given",
      );
    }
    let edgeOverridden = false;
    // What the override passed, recorded only once every non-overridable
    // check (back-pressure, WIP) has passed too: a refused move records no
    // override (rule 28).
    const overridden: string[] = [];

    // B12: an override is a person taking responsibility for a judgement the
    // board would otherwise refuse — but never for a secret in the diff or a
    // vulnerable dependency. Those are not judgement calls, and a harness that
    // lets one through on a typed reason has no security layer at all. Checked
    // before the override branches below, so nothing can swallow it.
    if (GATED_COLUMNS.has(t.toStatus)) {
      const failing = (await this.options.evidenceFor?.(card.id))?.failingSecurityGates ?? [];
      if (failing.length > 0) {
        throw new TransitionRefusedError(
          "security_gate",
          t.cardId,
          t.toStatus,
          `${t.cardId} cannot move to '${t.toStatus}': its latest evidence fails the security gate(s) ${failing.join(", ")}. A security-layer failure is never overridden; fix it, or reject the card.`,
        );
      }
    }
    if (!legal.includes(t.toStatus)) {
      if (!override) {
        throw new TransitionRefusedError(
          "illegal_transition",
          t.cardId,
          t.toStatus,
          `Illegal transition '${t.fromStatus}' -> '${t.toStatus}' for card ${t.cardId}. Legal destinations: ${legal.join(", ")}`,
        );
      }
      overridden.push("edge");
      edgeOverridden = true;
    }

    if (this.options.entryConditions) {
      const failure = await this.entryConditionFailure(card, t, via);
      if (failure && !override) {
        throw new TransitionRefusedError("entry_condition", t.cardId, t.toStatus, failure);
      }
      if (failure) overridden.push(`entry condition: ${failure}`);
    }

    // Back-pressure blocks entry to VERIFY, not Review (design §392). Holding
    // cards one column upstream is what stops work piling into a queue the
    // human cannot drain; blocking at Review would let Verify fill instead.
    if (t.toStatus === "verify") {
      const reviewCards = await this.reviewCount();
      if (reviewCards.length >= this.wipLimits.review) {
        throw new TransitionRefusedError(
          "back_pressure",
          t.cardId,
          t.toStatus,
          `Back-pressure: Review is at capacity (${reviewCards.length}/${this.wipLimits.review}). No card may enter Verify until a review is accepted or returned.`,
        );
      }
    }

    const inTarget =
      t.toStatus === "review"
        ? (await this.reviewCount()).length
        : (await this.cardStore.listCards({ status: t.toStatus })).length;
    const limit = this.wipLimits[t.toStatus];
    if (inTarget >= limit) {
      throw new TransitionRefusedError(
        "wip_limit",
        t.cardId,
        t.toStatus,
        `WIP limit exceeded for column '${t.toStatus}': ${inTarget}/${limit} cards active`,
      );
    }

    // K-N5-1: the Planner scores an unscored card as part of its move into Planning.
    if (
      this.options.entryConditions &&
      t.toStatus === "planning" &&
      card.difficulty === undefined &&
      this.options.planner
    ) {
      const score = await this.options.planner.scoreDifficulty(card);
      if (!Number.isInteger(score) || score < 1 || score > 10) {
        throw new TransitionRefusedError(
          "entry_condition",
          t.cardId,
          t.toStatus,
          `The Planner scored ${t.cardId} ${score}; a difficulty is an integer 1–10`,
        );
      }
      await this.cardStore.updateCard(t.cardId, { difficulty: score }, "planner");
    }

    for (const what of overridden) await this.recordOverride(t, what);
    try {
      await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, t.actor, {
        expectedFrom: card.status,
        override: edgeOverridden,
        // Rule 19, K-N2-2: the person who moved the card, as named.
        ...(t.principal ? { principal: t.principal } : {}),
      });
    } catch (err) {
      // Another writer moved the card between the read and the write.
      if (err instanceof StatusTransitionError && err.code === "stale_from") {
        throw new TransitionRefusedError("stale_from", t.cardId, t.toStatus, err.message);
      }
      throw err;
    }
  }

  /**
   * Measurement setup (independent mode, MS-T7-3): put a card where a
   * measured run needs it — an earlier card `done` because its reference
   * solution is on main — without running it. Recorded as the harness's
   * `card/measurement_setup`, never as a person's override (rule 28): no
   * person decided it. Only in a repository a measured run prepared, which
   * the caller shows by its measurement marker (as `--auto-accept` is bounded).
   */
  public async setUpForMeasurement(
    t: { cardId: string; toStatus: CardStatus; reason: string },
    marker: { purpose: string } | undefined,
  ): Promise<void> {
    if (!marker || (marker.purpose !== "frozen suite" && marker.purpose !== "m0")) {
      throw new TransitionRefusedError(
        "override_forbidden",
        t.cardId,
        t.toStatus,
        "Measurement setup runs only in a repository a measured run prepared, which carries .sekhemet/measurement.json; here a card moves only by the board's rules",
      );
    }
    const card = await this.cardStore.getCard(t.cardId);
    if (!card) {
      throw new TransitionRefusedError(
        "card_not_found",
        t.cardId,
        t.toStatus,
        `Card not found: ${t.cardId}`,
      );
    }
    if (card.status === t.toStatus) return;
    await this.cardStore.recordEvent({
      type: "card/measurement_setup",
      cardId: t.cardId,
      actor: "harness",
      payload: { id: t.cardId, from: card.status, to: t.toStatus, purpose: marker.purpose },
    });
    await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, "harness", {
      expectedFrom: card.status,
      override: true,
    });
  }

  /**
   * Hold a card where it stands with a recorded reason (defect 1; rule 24).
   *
   * Used when a move the runner wanted was refused by back-pressure: the card
   * keeps its state and its work, and the ledger records a typed hold —
   * `card/held {awaiting, reason}` — that the board lists without reading any
   * free text (K-N3-1). `releaseHeld` resumes it later. `awaiting` defaults to
   * the state a `"<state> refused (...)"` reason names, else Verify, the one
   * move back-pressure refuses.
   */
  public async holdCard(
    cardId: string,
    reason: string,
    actor = "executor",
    awaiting?: CardStatus,
  ): Promise<void> {
    const text = reason.trim();
    if (!text) throw new Error("A held card needs a reason");
    const card = await this.cardStore.getCard(cardId);
    if (!card) {
      throw new TransitionRefusedError(
        "card_not_found",
        cardId,
        awaiting ?? "verify",
        `Card not found: ${cardId}`,
      );
    }
    const named = /^(?:held:\s*)?(\w+) refused\b/.exec(text)?.[1];
    const target = awaiting ?? (isCardStatus(named) ? named : "verify");
    await this.cardStore.holdCard(cardId, { awaiting: target, reason: text }, actor);
  }

  /** Cards held by back-pressure, oldest hold first (rule 24). */
  public async listHeld(): Promise<CardRecord[]> {
    const cards = await this.cardStore.listCards();
    return cards
      .filter((c) => c.hold?.kind === "backpressure")
      .sort((a, b) => (a.hold?.since ?? "").localeCompare(b.hold?.since ?? ""));
  }

  /**
   * Retry the move a held card was waiting for — its recorded `awaiting`
   * state unless another is named — and on success append `card/released`
   * (K-N3-2). While the move is still refused the hold stays and nothing is
   * appended; returns false.
   */
  public async releaseHeld(
    cardId: string,
    toStatus?: CardStatus,
    actor = "executor",
  ): Promise<boolean> {
    const card = await this.cardStore.getCard(cardId);
    if (card?.hold?.kind !== "backpressure") return false;
    try {
      await this.transitionCard({
        cardId,
        fromStatus: card.status,
        toStatus: toStatus ?? card.hold.awaiting,
        actor,
        reason: "released from hold",
      });
    } catch (err) {
      if (
        err instanceof TransitionRefusedError &&
        (err.code === "back_pressure" || err.code === "wip_limit")
      ) {
        return false;
      }
      throw err;
    }
    await this.cardStore.releaseHold(cardId, actor);
    return true;
  }

  /**
   * A person accepted a card with pull-request-on-accept on, and its pull
   * request opened (rule 24, K-N3-3): the card stays in Review with an
   * `awaitingMerge` hold, the person recorded as its accepter, and it no
   * longer counts toward Review's WIP limit.
   */
  public async acceptWithPullRequest(
    cardId: string,
    pr: { pr: number; url: string; headSha: string },
    accepter: string,
    actor = "harness",
  ): Promise<void> {
    await this.cardStore.recordPullRequestOpened(cardId, { ...pr, accepter }, actor);
  }

  /**
   * The pull request closed (rule 24, K-N3-4): merged, the card moves to Done
   * — the accepting decision is already on the ledger, and the merge was its
   * last condition; closed unmerged, the hold and the accepter clear and the
   * card waits in Review, counted toward the WIP limit again.
   */
  public async closePullRequest(
    cardId: string,
    pr: { pr: number; merged: boolean },
    actor = "harness",
  ): Promise<void> {
    await this.cardStore.recordPullRequestClosed(cardId, pr, actor);
    if (!pr.merged) return;
    await this.move(
      {
        cardId,
        fromStatus: "review",
        toStatus: "done",
        actor,
        reason: `pull request #${pr.pr} merged`,
      },
      { merged: true },
    );
  }

  public async checkWipLimits(): Promise<WipLimitStatus[]> {
    const cards = await this.cardStore.listCards();
    const counts = {} as Record<CardStatus, number>;
    for (const column of Object.keys(this.wipLimits) as CardStatus[]) counts[column] = 0;
    for (const c of cards) {
      // An accepted card awaiting its merge is not counted (rule 24).
      if (c.hold?.kind === "awaitingMerge") continue;
      counts[c.status] = (counts[c.status] ?? 0) + 1;
    }

    return (Object.entries(this.wipLimits) as [CardStatus, number][]).map(([col, limit]) => ({
      column: col,
      currentCount: counts[col] ?? 0,
      maxLimit: limit,
      isExceeded: (counts[col] ?? 0) > limit,
      // Enforcement blocks at >= limit, so this is the flag the UI reads.
      isAtCapacity: (counts[col] ?? 0) >= limit,
    }));
  }

  /**
   * Running cards that would edit a file `card` declares (B6). Two cards
   * that touch the same file must be serialised: their worktrees would
   * merge into a conflict, and each gate run would measure the other's
   * half-done change.
   */
  public async overlappingRunning(card: CardRecord): Promise<ScopeOverlap[]> {
    // A held card is waiting for a column, not editing: it does not block.
    const running = (await this.cardStore.listCards({ status: "in_progress" })).filter(
      (c) => c.id !== card.id && c.hold?.kind !== "backpressure",
    );
    const out: ScopeOverlap[] = [];
    for (const other of running) {
      const files = card.scopeFiles.filter((f) =>
        other.scopeFiles.some((g) => matchesScope(f, g) || matchesScope(g, f)),
      );
      if (files.length > 0) out.push({ cardId: other.id, files });
    }
    return out;
  }

  /**
   * The cards Review's WIP limit counts (rules 24, 29): an accepted card
   * awaiting its pull request's merge is a person's decided work, not a
   * review waiting for one.
   */
  private async reviewCount(): Promise<CardRecord[]> {
    return (await this.cardStore.listCards({ status: "review" })).filter(
      (c) => c.hold?.kind !== "awaitingMerge",
    );
  }

  public async getBoardState(filter: { projectId?: string } = {}): Promise<BoardState> {
    const all = await this.cardStore.listCards();
    // B8: a project's board shows its own cards (cards from before projects
    // existed have none and belong to every board).
    const cards = filter.projectId
      ? all.filter((c) => !c.projectId || c.projectId === filter.projectId)
      : all;
    const reviewCount = cards.filter(
      (c) => c.status === "review" && c.hold?.kind !== "awaitingMerge",
    ).length;

    return {
      cards,
      wipLimits: this.wipLimits,
      backpressureActive: reviewCount >= this.wipLimits.review,
    };
  }
}
