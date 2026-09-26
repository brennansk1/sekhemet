import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";

/**
 * Sign-in limits (teams item 14a, TEAM-34) and refusal summaries (item 14b,
 * TEAM-35), following NIST SP 800-63B-4:
 * - exponential back-off between failed attempts of one subject and address;
 * - 10 consecutive failures lock that pair for 15 minutes;
 * - 100 consecutive failures lock an account until an Admin unlocks it
 *   (`account/locked`); a setup token or invite is refused likewise;
 * - a success resets the subject's count.
 *
 * Failures are counted in memory and written as at most one
 * `session/refused {reason, count}` per account (per address for an unknown
 * account) per 15-minute window — at the window's end, at a success (which
 * closes the window) or at shutdown. On start the per-account count is
 * rebuilt from those summaries, so a restart does not reset it.
 *
 * These limits and the window are fixed, not configurable (teams §3).
 */
export const PAIR_LOCK_AFTER = 10;
export const PAIR_LOCK_MS = 15 * 60_000;
export const SUBJECT_LOCK_AFTER = 100;
export const SUMMARY_WINDOW_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 60_000;

export type RefusalReason =
  | "bad_credentials"
  | "unknown_account"
  | "bad_setup_token"
  | "bad_invite"
  | "bad_reset_link";

export type LimitRefusal = {
  allowed: false;
  reason: "backoff" | "pair_locked" | "account_locked" | "subject_locked";
  retryAfterMs?: number;
};

interface PairState {
  fails: number;
  lastFail: number;
  lockedUntil: number;
}

interface PendingSummary {
  principal?: string;
  address?: string;
  reason: RefusalReason;
  count: number;
  start: number;
}

/**
 * A subject is `acct:<principal>` for a known account, `addr:<address>` for
 * an unknown one, `setup` for the setup token and `invite:<ref>` for an
 * invite (or `invite:?` for an id that names none).
 */
export class SignInLimits {
  private readonly pairs = new Map<string, PairState>();
  private readonly subjects = new Map<string, number>();
  private readonly pending = new Map<string, PendingSummary>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    private readonly now: () => number,
  ) {}

  /** Whether an attempt by `subject` from `address` may be checked now. */
  public check(subject: string, address: string): { allowed: true } | LimitRefusal {
    const t = this.now();
    const principal = subject.startsWith("acct:") ? subject.slice(5) : undefined;
    if (principal && this.accountLocked(principal)) {
      return { allowed: false, reason: "account_locked" };
    }
    if (!principal && !subject.startsWith("addr:") && this.count(subject) >= SUBJECT_LOCK_AFTER) {
      return { allowed: false, reason: "subject_locked" };
    }
    const pair = this.pairs.get(`${subject}|${address}`);
    if (pair) {
      if (pair.lockedUntil > t) {
        return { allowed: false, reason: "pair_locked", retryAfterMs: pair.lockedUntil - t };
      }
      if (pair.lockedUntil !== 0 && pair.lockedUntil <= t) {
        // The 15 minutes are over: the pair starts again; the account count does not.
        pair.fails = 0;
        pair.lockedUntil = 0;
      } else if (pair.fails > 0) {
        const wait = Math.min(BACKOFF_BASE_MS * 2 ** (pair.fails - 1), BACKOFF_MAX_MS);
        if (t - pair.lastFail < wait) {
          return { allowed: false, reason: "backoff", retryAfterMs: wait - (t - pair.lastFail) };
        }
      }
    }
    return { allowed: true };
  }

  /** Record a failed attempt; returns true when it locked the account. */
  public fail(subject: string, address: string, reason: RefusalReason): boolean {
    const t = this.now();
    const key = `${subject}|${address}`;
    const pair = this.pairs.get(key) ?? { fails: 0, lastFail: 0, lockedUntil: 0 };
    pair.fails += 1;
    pair.lastFail = t;
    if (pair.fails >= PAIR_LOCK_AFTER) pair.lockedUntil = t + PAIR_LOCK_MS;
    this.pairs.set(key, pair);

    const principal = subject.startsWith("acct:") ? subject.slice(5) : undefined;
    const count = this.count(subject) + 1;
    this.subjects.set(subject, count);
    this.summarise(principal, principal ? undefined : address, reason, t);
    if (principal && count >= SUBJECT_LOCK_AFTER && !this.accountLocked(principal)) {
      this.flushOne(principal);
      this.log.appendNow({
        actor: "harness",
        type: "account/locked",
        payload: { principal },
      });
      return true;
    }
    return false;
  }

  /** A success: the subject's count and the pair reset, and the window closes. */
  public succeed(subject: string, address: string): void {
    this.pairs.delete(`${subject}|${address}`);
    this.subjects.set(subject, 0);
    if (subject.startsWith("acct:")) this.flushOne(subject.slice(5));
  }

  /** An Admin's unlock: the account's count restarts. */
  public unlocked(principal: string): void {
    this.flushOne(principal);
    this.subjects.set(`acct:${principal}`, 0);
    for (const key of [...this.pairs.keys()]) {
      if (key.startsWith(`acct:${principal}|`)) this.pairs.delete(key);
    }
  }

  public accountLocked(principal: string): boolean {
    const row = this.db
      .prepare(
        `SELECT type FROM events
          WHERE type IN ('account/locked', 'account/unlocked')
            AND json_extract(payload, '$.principal') = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(principal) as { type: string } | undefined;
    return row?.type === "account/locked";
  }

  /** Consecutive failures of `subject`, rebuilt from the summaries for an account. */
  private count(subject: string): number {
    const known = this.subjects.get(subject);
    if (known !== undefined) return known;
    let rebuilt = 0;
    if (subject.startsWith("acct:")) rebuilt = this.fromLedger(subject.slice(5));
    this.subjects.set(subject, rebuilt);
    return rebuilt;
  }

  /** The failures recorded since the account's last sign-in or unlock (TEAM-35). */
  private fromLedger(principal: string): number {
    const reset = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM events
          WHERE (type = 'session/started' AND principal = ?)
             OR (type = 'account/unlocked' AND json_extract(payload, '$.principal') = ?)`,
      )
      .get(principal, principal) as { seq: number };
    const sum = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.count')), 0) AS n FROM events
          WHERE type = 'session/refused' AND principal = ? AND seq > ?`,
      )
      .get(principal, reset.seq) as { n: number };
    return Number(sum.n) || 0;
  }

  private summarise(
    principal: string | undefined,
    address: string | undefined,
    reason: RefusalReason,
    t: number,
  ): void {
    const key = principal ? `p:${principal}` : `a:${address}`;
    const open = this.pending.get(key);
    if (open && t - open.start >= SUMMARY_WINDOW_MS) {
      this.write(open);
      this.pending.delete(key);
    }
    const current = this.pending.get(key);
    if (current) {
      current.count += 1;
      current.reason = reason;
    } else {
      this.pending.set(key, {
        ...(principal ? { principal } : {}),
        ...(address ? { address } : {}),
        reason,
        count: 1,
        start: t,
      });
    }
  }

  private write(summary: PendingSummary): void {
    this.log.appendNow({
      actor: "harness",
      type: "session/refused",
      payload: {
        reason: summary.reason,
        count: summary.count,
        window: new Date(summary.start).toISOString(),
      },
      ...(summary.principal ? { principal: summary.principal } : {}),
      // The address is personal data: erasable, off the chain.
      ...(summary.address ? { private: { address: summary.address } } : {}),
    });
  }

  private flushOne(principal: string): void {
    const key = `p:${principal}`;
    const open = this.pending.get(key);
    if (!open) return;
    this.pending.delete(key);
    this.write(open);
  }

  /** Write every summary whose window has ended; with `all`, every open one (shutdown). */
  public flush(all = false): void {
    const t = this.now();
    for (const [key, summary] of [...this.pending]) {
      if (all || t - summary.start >= SUMMARY_WINDOW_MS) {
        this.pending.delete(key);
        this.write(summary);
      }
    }
  }
}
