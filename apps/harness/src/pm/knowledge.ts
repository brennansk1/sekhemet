import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import {
  ASSUMPTION_EVENTS,
  GoalStore,
  type LoggedAssumption,
  SIGNAL_BOUNDS,
  loggedAssumptions,
} from "@sekhemet/planner";
import { latestLedgerEvidence } from "../ledger_evidence.js";

/**
 * What Seshat knows beyond the board (planner-pm §2.8.5, P6): the goals,
 * the assumptions the planner logged and the risk register they make, the
 * brief, the Reviewer's findings and a failed issue's evidence — each read
 * from the ledger with the id Seshat cites it by (PM-P6-1, -2, -6). Scoped
 * by the caller to what the asker can see (PM-N9-8).
 */

/** A goal as Seshat reads it (PM-P6-1). */
export interface SnapshotGoal {
  id: string;
  statement: string;
  state: string;
  met: number;
  total: number;
  /** What the goal was set on the assumption of. */
  assumptions: string[];
}

/** An assumption the planner logged instead of asking (PM-P6-1). */
export interface SnapshotAssumption {
  id: string;
  cardId: string;
  statement: string;
  basis: string;
  /** A person's verdict on it, when one is recorded. */
  outcome?: "kept" | "overridden";
  /** Hours unverified, past the risk register's bound (planner signal 7). */
  riskHours?: number;
}

/** One finding of the latest AI review of an issue (PM-P6-2, review-git RG-P8-9). */
export interface SnapshotFinding {
  cardId: string;
  /** The dossier entry's id: what Seshat cites. */
  entryId: string;
  verdict: string;
  text: string;
  modelId?: string;
}

/** A failed attempt's facts, from its evidence bundle (PM-P6-6). */
export interface FailureFacts {
  cardId: string;
  evidenceId: string;
  attempt?: number;
  stopReason: string;
  /** The step the attempt stopped on. */
  step?: number;
  /** The first failing check, and where its first failure is. */
  gate?: string;
  at?: string;
  excerpt?: string;
}

/** The goals over the projects `canSee` admits, oldest first. */
export async function snapshotGoals(
  ctx: { cardStore: CardStore; log: EventLog },
  canSee: (projectId: string | undefined) => boolean = () => true,
): Promise<SnapshotGoal[]> {
  const goals = await new GoalStore({ store: ctx.cardStore, log: ctx.log }).all().catch(() => []);
  return goals
    .filter((g) => g.state !== "abandoned")
    .filter((g) => g.projectIds.length === 0 || g.projectIds.every((p) => canSee(p)))
    .map((g) => ({
      id: g.id,
      statement: g.statement,
      state: g.state,
      met: g.criteria.filter((c) => c.status === "met").length,
      total: g.criteria.length,
      assumptions: [...g.assumptions],
    }));
}

/**
 * The assumptions logged on the cards `visible` admits, each with its
 * outcome, or the hours it has gone unverified once past the risk register's
 * bound (`SIGNAL_BOUNDS.riskAssumptionHours`), newest first, at most `limit`.
 */
export async function snapshotAssumptions(
  ctx: { cardStore: CardStore; log: EventLog },
  visible: (cardId: string) => boolean = () => true,
  now = Date.now(),
  limit = 12,
): Promise<SnapshotAssumption[]> {
  const logged = await loggedAssumptions({ store: ctx.cardStore, log: ctx.log }).catch(
    () => [] as LoggedAssumption[],
  );
  const outcomes = new Map<string, boolean>();
  for (const e of await ctx.log.getEventsByTypes([ASSUMPTION_EVENTS.outcome])) {
    const p = e.payload as { assumptionId?: string; overridden?: boolean };
    if (p.assumptionId) outcomes.set(p.assumptionId, p.overridden === true);
  }
  return logged
    .filter((a) => visible(a.cardId))
    .slice(-limit)
    .reverse()
    .map((a) => {
      const overridden = outcomes.get(a.id);
      const hours = Math.floor((now - Date.parse(a.createdAt)) / 3_600_000);
      return {
        id: a.id,
        cardId: a.cardId,
        statement: a.statement,
        basis: a.basis,
        ...(overridden === undefined
          ? hours > SIGNAL_BOUNDS.riskAssumptionHours
            ? { riskHours: hours }
            : {}
          : { outcome: overridden ? ("overridden" as const) : ("kept" as const) }),
      };
    });
}

/**
 * The latest AI review of each issue `visible` admits (PM-P6-2): the findings
 * of its last review — every `card/review` entry since the coverage line that
 * closed the one before — without the coverage line itself. At most `limit`
 * issues, the most recently reviewed first.
 */
export async function snapshotFindings(
  log: EventLog,
  visible: (cardId: string) => boolean = () => true,
  limit = 6,
): Promise<SnapshotFinding[]> {
  const byCard = new Map<string, SnapshotFinding[]>();
  const order: string[] = [];
  for (const e of await log.getEventsByTypes(["card/review"])) {
    const cardId = e.cardId;
    if (!cardId || !visible(cardId)) continue;
    const p = e.payload as { text?: string; verdict?: string; modelId?: string };
    if (typeof p.text !== "string") continue;
    let list = byCard.get(cardId) ?? [];
    // A coverage line closes a review; the next finding starts the next one.
    const closed = list.at(-1)?.verdict === "coverage";
    if (closed && p.verdict !== "coverage") list = [];
    list.push({
      cardId,
      entryId: e.id,
      verdict: p.verdict ?? "note",
      text: p.text,
      ...(p.modelId ? { modelId: p.modelId } : {}),
    });
    byCard.set(cardId, list);
    const at = order.indexOf(cardId);
    if (at !== -1) order.splice(at, 1);
    order.push(cardId);
  }
  return order
    .slice(-limit)
    .reverse()
    .flatMap((id) => (byCard.get(id) ?? []).filter((f) => f.verdict !== "coverage"));
}

/**
 * The facts of an issue's latest failed attempt from its evidence bundle
 * (PM-P6-6): the stop reason, the step, the first failing check and its
 * first failure's `file:line`, with the bundle's id. Undefined when the
 * latest attempt passed or no sound bundle is recorded — a bundle whose file
 * is missing or whose hash differs from the ledger's is no evidence.
 */
export async function failureFacts(
  cardStore: CardStore,
  repoPath: string,
  cardId: string,
): Promise<FailureFacts | undefined> {
  const record = await latestLedgerEvidence(cardStore, cardId).catch(() => undefined);
  if (!record || record.passed) return undefined;
  const path = isAbsolute(record.path) ? record.path : join(repoPath, record.path);
  let bundle: {
    attempt?: number;
    turnsUsed?: number;
    stopReason?: string;
    failures?: {
      gate?: string;
      location?: { file?: string; line?: number };
      errorExcerpt?: string;
    }[];
    rungResults?: { gate?: string; passed?: boolean; skipped?: boolean }[];
  };
  try {
    const body = readFileSync(path, "utf8");
    if (createHash("sha256").update(body).digest("hex") !== record.sha256) return undefined;
    bundle = JSON.parse(body);
  } catch {
    return undefined;
  }
  const first = bundle.failures?.[0];
  const gate =
    first?.gate ?? bundle.rungResults?.find((r) => r.passed === false && !r.skipped)?.gate;
  const file = first?.location?.file;
  const excerpt = first?.errorExcerpt
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  return {
    cardId,
    evidenceId: record.id,
    stopReason: bundle.stopReason ?? record.stopReason,
    ...(bundle.attempt !== undefined ? { attempt: bundle.attempt } : {}),
    ...(bundle.turnsUsed !== undefined ? { step: bundle.turnsUsed } : {}),
    ...(gate ? { gate } : {}),
    ...(file ? { at: first?.location?.line ? `${file}:${first.location.line}` : file } : {}),
    ...(excerpt ? { excerpt: excerpt.slice(0, 200) } : {}),
  };
}

/** The project's brief (`.sekhemet/brief.md`), cut to `maxChars`, or undefined. */
export function briefText(repoPath: string, maxChars = 2400): string | undefined {
  const path = join(repoPath, ".sekhemet", "brief.md");
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) return undefined;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
  } catch {
    return undefined;
  }
}

/**
 * The issues a message names: by key in or out of backticks, or by a title
 * of more than three characters, in the order of `cards`.
 */
export function cardsNamed(text: string, cards: readonly CardRecord[]): CardRecord[] {
  const lower = text.toLowerCase();
  return cards.filter(
    (c) =>
      new RegExp(
        `(^|[^A-Za-z0-9_-])${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
      ).test(text) ||
      (c.title.length > 3 &&
        lower.includes(c.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "").toLowerCase())),
  );
}

/** A question asking why an issue failed, stopped or is stuck (PM-P6-6). */
export function isWhyFailedQuestion(text: string): boolean {
  return /\bwhy\b[^?]*\b(fail(ed|s|ing)?|stop(ped|s)?|stuck|park(ed)?|broke|red)\b/i.test(text);
}
