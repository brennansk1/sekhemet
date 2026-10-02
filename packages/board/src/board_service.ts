import { createHash } from "node:crypto";
import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  type DepthProfile,
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
  /**
   * A depth profile the caller already read (design-stage P14), which sets
   * the test approvals a card needs before it leaves Planning (planner-pm
   * §2.17, PM-N7-3). Omitted, the board reads the one a person recorded for
   * the card's project (`depthProfileOf`, DS-P14-3).
   */
  depthProfile?: DepthProfile;
  /**
   * Read a staged test file's actual current content, for `planningExitFailure`
   * to re-hash it against what was approved (a file edited directly on disk,
   * without re-staging, must not still read as approved at its old hash).
   */
  readStagedFile?: (path: string) => string | undefined;
}

/** The depth profiles of design-stage §2.8: the kernel's, which records and reads them (DS-P14-3). */
export type { DepthProfile } from "@sekhemet/kernel";
export { DEFAULT_DEPTH_PROFILE } from "@sekhemet/kernel";

/** Where a card leaving for Ready or In Progress has not yet run: its approvals are due. */
const BEFORE_RUNNING = new Set<CardStatus>(["planning", "backlog", "parked", "rejected"]);
/**
 * Ready → In Progress is also re-checked (not only the moves into
 * `BEFORE_RUNNING`): a staged file can be edited on disk, without
 * re-staging, after a card is already Ready and before it starts running.
 */
const RECHECK_BEFORE_RUN = new Set<CardStatus>([...BEFORE_RUNNING, "ready"]);

/**
 * What a card still needs from a person before it leaves Planning
 * (planner-pm §2.17; PM-N7-3, -4, -5), or undefined: its criteria approved
 * as they are now (every profile); for `production`, the staged files of a
 * card that traces to a must-have requirement approved (their example
 * tables); for `regulated`, every staged acceptance-test file. An approval
 * of content that has since changed is void (the kernel binds each to a
 * SHA-256). A card without criterion ids predates the planner's contract.
 *
 * `readStagedFile`, when given, re-hashes each staged file from its actual
 * content on disk rather than trusting the SHA-256 recorded at `stage()`
 * time: a file a person or a process edited directly, without re-staging,
 * would otherwise still read as approved at its old, no-longer-true hash.
 *
 * `given` is a profile the caller already read; omitted, the one a person
 * recorded for the card's project is read from the ledger (DS-P14-3).
 */
/** One row of *Ready to start* (DB-N14-2): an entry condition, met or not, with its reason. */
export interface ReadinessRow {
  id: "dependencies" | "criteria" | "approval" | "suspect" | "scope" | "small";
  met: boolean;
  reason?: string;
}

export async function planningExitFailure(
  store: CardStore,
  card: CardRecord,
  given?: DepthProfile,
  readStagedFile?: (path: string) => string | undefined,
): Promise<string | undefined> {
  const profile = given ?? store.depthProfiles.of(card.projectId).profile;
  if ((card.criterionIds?.length ?? 0) === 0) return undefined;
  const criteria = store.stagedTests.criteriaApproval(card.id);
  if (!criteria.approved) {
    const why = criteria.approvedSha256
      ? "its criteria changed since they were approved"
      : "no one has approved them yet";
    return `${card.id} needs a person's approval of its criteria before it leaves Planning (${why}): sekhemet approve ${card.id}`;
  }
  if (profile !== "production" && profile !== "regulated") return undefined;
  if (profile === "production") {
    const links = store.requirements.linksFrom("card", card.id);
    let mustHave = false;
    for (const l of links) {
      if ((await store.requirements.get(l.requirementId))?.mustHave) mustHave = true;
    }
    if (!mustHave) return undefined;
  }
  const currentSha256 = (a: { path: string; stagedSha256: string }): string => {
    if (!readStagedFile) return a.stagedSha256;
    // A file the board can read the disk for but cannot find has changed: never the recorded hash.
    const disk = readStagedFile(a.path);
    return disk === undefined ? "missing" : createHash("sha256").update(disk).digest("hex");
  };
  const approvals = store.stagedTests.testApprovals(card.id).map((a) => ({
    ...a,
    approved: a.approved && currentSha256(a) === a.approvedSha256,
  }));
  // Regulated approves the whole file; an approval of its examples alone is not that.
  const missing = approvals.filter(
    (a) => !a.approved || (profile === "regulated" && a.what !== "file"),
  );
  if (missing.length === 0) return undefined;
  const voided = missing.filter((a) => a.approvedSha256 !== undefined && !a.approved);
  const never = missing.filter((a) => !voided.includes(a));
  const what =
    profile === "production"
      ? "the example tables of a must-have requirement (production profile)"
      : "every staged acceptance-test file (regulated profile)";
  const parts = [
    ...(never.length > 0 ? [`not yet approved: ${never.map((a) => a.path).join(", ")}`] : []),
    ...(voided.length > 0
      ? [
          `approval void, the content changed since it was approved: ${voided.map((a) => a.path).join(", ")}`,
        ]
      : []),
  ];
  return `${card.id} needs a person's approval of ${what} before it leaves Planning — ${parts.join("; ")}: sekhemet approve ${card.id}`;
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
const MEASUREMENT_PURPOSES = new Set(["frozen suite", "m0", "benchmark"]);

/**
 * Columns a card only reaches by having passed its gates (B12).
 *
 * Moving into either is the act an override exists to force, so these are the
 * two doors the security refusal below has to stand at.
 */
const GATED_COLUMNS = new Set<CardStatus>(["review", "done"]);

/** Minutes a human review is assumed to take before any is recorded (S6, RG-S6-1). */
export const REVIEW_MINUTES_PRIOR = 15;
/** The prior holds until this many human reviews exist (review-git §2.2 item 3). */
export const REVIEW_PRIOR_UNTIL = 5;
/**
 * The least a measured median counts as (FINDINGS BRD-04): a review faster than
 * this says nothing of a person's reading time, and 60 minutes a day over one
 * second a review is a limit of 3,600 that nobody can hold.
 */
export const REVIEW_MINUTES_FLOOR = 2;
/** Above this, a decision is reported as fast (RG-S6-7; SmartBear's ceiling). */
export const FAST_REVIEW_LINES_PER_HOUR = 500;

export class BoardServiceImpl implements BoardService {
  private wipLimits: Record<CardStatus, number>;
  private options: BoardServiceOptions;
  /** A person fixed Review's limit (`[review] wip`); otherwise it is derived (S6). */
  private reviewWipFixed: boolean;

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
      "measurementMarker" in optionsOrLimits ||
      "depthProfile" in optionsOrLimits ||
      "readStagedFile" in optionsOrLimits
        ? (optionsOrLimits as BoardServiceOptions)
        : { customLimits: optionsOrLimits as Partial<Record<CardStatus, number>> };

    this.options = options;
    this.wipLimits = { ...DEFAULT_WIP_LIMITS, ...(options.customLimits ?? {}) };
    this.reviewWipFixed = options.customLimits?.review !== undefined;
  }

  /**
   * *Ready to start* (dashboard NEW-dashboard-14, DB-N14-2): each entry
   * condition an issue must meet to go from Backlog to Ready and on to In
   * progress, met or not with its reason in words, read from the same
   * checks `entryConditionFailure` makes (dependencies, criteria, their
   * approval by the depth profile, a revised requirement, scope, Small). It
   * enforces nothing and appends nothing (DB-N14-3); a parent, which never
   * runs itself, has no approval, scope or size rows.
   */
  public async readiness(card: CardRecord): Promise<ReadinessRow[]> {
    const rows: ReadinessRow[] = [];
    const isParent = (await this.cardStore.listCards({ parentId: card.id })).length > 0;
    const waiting = this.cardStore.waitingOn(card.id);
    const names = await Promise.all(
      waiting.map(async (id) => (await this.cardStore.getCard(id))?.title ?? "another issue"),
    );
    rows.push(
      waiting.length
        ? {
            id: "dependencies",
            met: false,
            reason: `It waits on ${names.join(", ")}, which ${names.length === 1 ? "is" : "are"} not done.`,
          }
        : { id: "dependencies", met: true },
    );
    const criteria =
      (card.acceptanceCriteria?.length ?? 0) > 0 || (card.acceptanceTests?.length ?? 0) > 0;
    rows.push(
      criteria
        ? { id: "criteria", met: true }
        : {
            id: "criteria",
            met: false,
            reason: "No acceptance criteria or tests are written yet.",
          },
    );
    if (!isParent && (card.criterionIds?.length ?? 0) > 0) {
      const failure = await planningExitFailure(
        this.cardStore,
        card,
        this.options.depthProfile,
        this.options.readStagedFile,
      );
      const approval = this.cardStore.stagedTests.criteriaApproval(card.id);
      rows.push(
        !failure
          ? { id: "approval", met: true }
          : {
              id: "approval",
              met: false,
              reason: !approval.approved
                ? approval.approvedSha256
                  ? "Its acceptance criteria changed since a person approved them."
                  : "No one has approved its acceptance criteria yet."
                : "Its tests' examples need a person's approval, as the project's Type asks.",
            },
      );
    }
    const suspect = this.cardStore.requirements.linksFrom("card", card.id).filter((l) => l.suspect);
    rows.push(
      suspect.length
        ? {
            id: "suspect",
            met: false,
            reason:
              "A requirement it traces to was revised since it was planned; re-plan or re-confirm it.",
          }
        : { id: "suspect", met: true },
    );
    if (!isParent) {
      rows.push(
        card.scopeFiles.length
          ? { id: "scope", met: true }
          : { id: "scope", met: false, reason: "It declares no files it may change." },
      );
      if (this.options.zone3Fit) {
        const fit = await this.options.zone3Fit(card);
        rows.push(
          fit.tokens <= fit.cap
            ? { id: "small", met: true }
            : {
                id: "small",
                met: false,
                reason: `It is too big for the Coding model to build in one pass (${fit.tokens.toLocaleString("en-US")} of ${fit.cap.toLocaleString("en-US")} tokens); split it.`,
              },
        );
      }
    }
    return rows;
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
    // PM-P13-11: `holdSuspectCards` only pulls a ready, verifying or
    // in-review card back to Planning when a requirement it traces to is
    // revised — a Backlog or Parked card never ran, so it is never held.
    // Without this check such a card reaches Ready with a suspect link
    // untouched. A person re-plans or re-confirms it (clearing the link)
    // before it may run again.
    if (to === "ready") {
      const suspect = this.cardStore.requirements
        .linksFrom("card", card.id)
        .filter((l) => l.suspect);
      if (suspect.length > 0) {
        return `${card.id} traces to ${suspect.map((l) => `${l.requirementId} (v${l.version})`).join(", ")}, revised since; it waits for a re-plan or a re-confirmation before it is Ready`;
      }
    }
    // A parent's scope is its children's; it never runs itself (B7 rollup).
    const isParent = (await this.cardStore.listCards({ parentId: card.id })).length > 0;
    // PM-N7-3/4/5: a card leaves Planning (or starts from where it waited)
    // only with a person's approvals, by the depth profile.
    if (
      (to === "ready" || to === "in_progress") &&
      RECHECK_BEFORE_RUN.has(t.fromStatus) &&
      !isParent
    ) {
      const approval = await planningExitFailure(
        this.cardStore,
        card,
        this.options.depthProfile,
        this.options.readStagedFile,
      );
      if (approval) return approval;
    }
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
   * ReviewWIP = floor(review minutes per day / median minutes per human
   * review), at least 1 (review-git §2.2, S6). Only a person's recorded
   * decision (`review/decided`) is a review: an automated exit from Review
   * says nothing about a person's reading time (the 7,708 probe). With no
   * human review yet, the 15-minute prior (60 minutes a day → 4). Per
   * project: its own review minutes, its own reviews. Computed at each use,
   * so a decision counts before the next card leaves Verify (RG-S6-4). A
   * limit a person fixed (`[review] wip`) is kept.
   */
  public async computeReviewWip(reviewMinutesPerDay?: number, projectId?: string): Promise<number> {
    if (this.reviewWipFixed) return this.wipLimits.review;
    const budget = reviewMinutesPerDay ?? this.reviewMinutesFor(projectId);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `review_minutes_per_day must be greater than 0 (got ${budget}); ReviewWIP is derived from it, never from a static limit`,
      );
    }
    const { median } = await this.medianReviewMinutes(projectId);
    return Math.max(1, Math.floor(budget / median));
  }

  /**
   * The median minutes of a person's reviews, at least REVIEW_MINUTES_FLOOR;
   * the prior until five reviews exist (S6, review-git §2.2 item 3; BRD-04).
   */
  private async medianReviewMinutes(
    projectId?: string,
  ): Promise<{ median: number; reviews: number }> {
    const durations = (await this.measuredReviewMinutes(projectId)).sort((a, b) => a - b);
    if (durations.length < REVIEW_PRIOR_UNTIL)
      return { median: REVIEW_MINUTES_PRIOR, reviews: durations.length };
    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
        : (durations[mid] as number);
    return { median: Math.max(REVIEW_MINUTES_FLOOR, median), reviews: durations.length };
  }

  /**
   * How the Review limit was reached, for the board's header (dashboard
   * DB-P3-9): the review minutes a day, the median minutes per review and over
   * how many reviews — or that a person fixed it with `[review] wip`.
   */
  public async reviewLimitFacts(projectId?: string): Promise<
    | { limit: number; fixed: true }
    | {
        limit: number;
        fixed: false;
        minutesPerDay: number;
        minutesPerCard: number;
        reviews: number;
      }
  > {
    if (this.reviewWipFixed) return { limit: this.wipLimits.review, fixed: true };
    const minutesPerDay = this.reviewMinutesFor(projectId);
    const { median, reviews } = await this.medianReviewMinutes(projectId);
    return {
      limit: await this.computeReviewWip(minutesPerDay, projectId),
      fixed: false,
      minutesPerDay,
      minutesPerCard: median,
      reviews,
    };
  }

  /** The review minutes a day for a project: its own setting, else the board's, else 60. */
  private reviewMinutesFor(projectId?: string): number {
    const project = projectId ? this.cardStore.getProject(projectId) : undefined;
    return project?.reviewMinutesPerDay ?? this.options.reviewMinutesPerDay ?? 60;
  }

  /** A person's recorded review decisions, with the card's project (S6). */
  private async humanDecisions(
    projectId?: string,
  ): Promise<{ cardId: string; minutes: number; lines: number }[]> {
    const out: { cardId: string; minutes: number; lines: number }[] = [];
    const cards = new Map((await this.cardStore.listCards()).map((c) => [c.id, c]));
    for (const e of await this.cardStore.eventsOfType(["review/decided"])) {
      if (e.actor !== "human" || !e.cardId) continue;
      const p = e.payload as { minutes?: number; linesReviewed?: number };
      if (typeof p.minutes !== "number" || !(p.minutes > 0)) continue;
      if (projectId !== undefined && cards.get(e.cardId)?.projectId !== projectId) continue;
      out.push({ cardId: e.cardId, minutes: p.minutes, lines: p.linesReviewed ?? 0 });
    }
    return out;
  }

  /**
   * Minutes each human review took (S6, RG-S6-6): the `minutes` a person's
   * `review/decided` records — accept, send back, park or reject alike, and
   * for Worker- and person-built cards alike (RG-S6-7).
   */
  public async measuredReviewMinutes(projectId?: string): Promise<number[]> {
    return (await this.humanDecisions(projectId)).map((d) => d.minutes);
  }

  /**
   * The review rate (RG-S6-7): decisions faster than 500 changed lines an
   * hour are reported beside the rest, never refused (research RG-T5).
   */
  public async reviewRate(
    projectId?: string,
  ): Promise<{ decisions: number; fast: { cardId: string; linesPerHour: number }[] }> {
    const decisions = await this.humanDecisions(projectId);
    const fast = decisions
      .map((d) => ({ cardId: d.cardId, linesPerHour: Math.round(d.lines / (d.minutes / 60)) }))
      .filter((d) => d.linesPerHour > FAST_REVIEW_LINES_PER_HOUR);
    return { decisions: decisions.length, fast };
  }

  /** Set the board's review minutes a day; returns the ReviewWIP it now gives. */
  public async calibrateReviewWip(reviewMinutesPerDay: number): Promise<number> {
    const limit = await this.computeReviewWip(reviewMinutesPerDay);
    this.options = { ...this.options, reviewMinutesPerDay };
    return limit;
  }

  /** Review's limit for a project now (S6): fixed by a person, or derived. */
  private async reviewLimit(projectId?: string): Promise<number> {
    return this.computeReviewWip(undefined, projectId);
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
    // S6: the card's own project's Review count against its own ReviewWIP.
    const reviewLimit =
      t.toStatus === "verify" || t.toStatus === "review"
        ? await this.reviewLimit(card.projectId)
        : undefined;
    if (t.toStatus === "verify") {
      const reviewCards = await this.reviewCount(card.projectId);
      if (reviewCards.length >= (reviewLimit as number)) {
        throw new TransitionRefusedError(
          "back_pressure",
          t.cardId,
          t.toStatus,
          `Back-pressure: Review is at capacity (${reviewCards.length}/${reviewLimit}). No card may enter Verify until a review is accepted or returned.`,
        );
      }
    }

    const inTarget =
      t.toStatus === "review"
        ? (await this.reviewCount(card.projectId)).length
        : (await this.cardStore.listCards({ status: t.toStatus })).length;
    const limit = t.toStatus === "review" ? (reviewLimit as number) : this.wipLimits[t.toStatus];
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
        ...(t.with?.length ? { with: t.with } : {}),
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
    if (!marker || !MEASUREMENT_PURPOSES.has(marker.purpose)) {
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
    /** Committed with `card/pr_opened` in one transaction: Accept's `card/accepted`. */
    withEvents: NonNullable<CardTransition["with"]> = [],
  ): Promise<void> {
    await this.cardStore.recordPullRequestOpened(cardId, { ...pr, accepter }, actor, withEvents);
  }

  /**
   * The pull request closed (rule 24, K-N3-4): merged, the card moves to Done
   * — the accepting decision is already on the ledger, and the merge was its
   * last condition; closed unmerged, the hold and the accepter clear and the
   * card waits in Review, counted toward the WIP limit again. Merged after
   * its accept was dismissed (teams TEAM-24), the merge is recorded and the
   * card stays in Review for a person's decision.
   */
  public async closePullRequest(
    cardId: string,
    pr: {
      pr: number;
      merged: boolean;
      /** The merge commit and who closed it (integrations INT-13, INT-14). */
      mergeCommit?: string;
      closedBy?: string;
      closedByHandle?: string;
    },
    actor = "harness",
  ): Promise<void> {
    const accepted = (await this.cardStore.getCard(cardId))?.accepter !== undefined;
    await this.cardStore.recordPullRequestClosed(cardId, pr, actor);
    // A merge after the accept was dismissed (teams TEAM-24) is recorded, and
    // no accept covers the commits that dismissed it: the card stays in Review.
    if (!pr.merged || !accepted) return;
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
    const limits = { ...this.wipLimits, review: await this.reviewLimit() };
    const counts = {} as Record<CardStatus, number>;
    for (const column of Object.keys(limits) as CardStatus[]) counts[column] = 0;
    for (const c of cards) {
      // An accepted card awaiting its merge is not counted (rule 24); one
      // whose accept was dismissed waits for a decision again (TEAM-24).
      if (c.hold?.kind === "awaitingMerge" && !c.hold.dismissed) continue;
      counts[c.status] = (counts[c.status] ?? 0) + 1;
    }

    return (Object.entries(limits) as [CardStatus, number][]).map(([col, limit]) => ({
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
  private async reviewCount(projectId?: string): Promise<CardRecord[]> {
    return (await this.cardStore.listCards({ status: "review" })).filter(
      (c) => c.hold?.kind !== "awaitingMerge" && c.projectId === projectId,
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
      (c) =>
        c.status === "review" &&
        c.hold?.kind !== "awaitingMerge" &&
        (!filter.projectId || c.projectId === filter.projectId),
    ).length;
    const review = await this.reviewLimit(filter.projectId);

    return {
      cards,
      wipLimits: { ...this.wipLimits, review },
      backpressureActive: reviewCount >= review,
    };
  }
}
