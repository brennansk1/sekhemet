import type { DatabaseSync } from "node:sqlite";
import type { CardRecord, CardStore } from "@sekhemet/kernel";

/**
 * The shared queue (runtime item 4a, RUN-34; teams §2.7 items 30–31, TEAM-30).
 *
 * Model time is scheduled by fair share per person, costed in tokens as the
 * Virtual Token Counter does (VTC: input tokens weigh 1, output tokens 2, and
 * a person returning from idle is lifted to the lowest active count, so no
 * credit is banked); Seshat's interactive replies go ahead of Worker steps;
 * and any request that has waited longer than `max_wait_s` is promoted ahead
 * of both, oldest first, so nothing starves. Fairness is Sekhemet's, not the
 * engine's.
 */

export type RequestKind = "pm_reply" | "worker_step";

export interface ScheduledRequest {
  id: string;
  person: string;
  kind: RequestKind;
}

interface Queued extends ScheduledRequest {
  enqueuedAt: number;
  order: number;
}

/** VTC's weights: an output token costs twice an input token. */
export const INPUT_WEIGHT = 1;
export const OUTPUT_WEIGHT = 2;

export const tokenCost = (t: { input: number; output: number }): number =>
  INPUT_WEIGHT * t.input + OUTPUT_WEIGHT * t.output;

export interface SchedulerOptions {
  /** The aging bound (`[scheduler] max_wait_s`). */
  maxWaitS: number;
  /** `[scheduler] fair_share`; off, each class is first come, first served. */
  fairShare?: boolean;
  now?: () => number;
}

export class FairScheduler {
  private readonly queue: Queued[] = [];
  private readonly counters = new Map<string, number>();
  private order = 0;
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  public enqueue(request: ScheduledRequest, enqueuedAt = this.now()): void {
    // VTC's lift: a person with nothing queued rejoins at the lowest count
    // among those with work queued, never below it.
    if (!this.queue.some((q) => q.person === request.person)) {
      const active = [...new Set(this.queue.map((q) => q.person))].map(
        (p) => this.counters.get(p) ?? 0,
      );
      if (active.length > 0) {
        const floor = Math.min(...active);
        this.counters.set(request.person, Math.max(this.counters.get(request.person) ?? 0, floor));
      }
    }
    this.queue.push({ ...request, enqueuedAt, order: this.order++ });
  }

  /** Charge a person for model time spent on their behalf. */
  public charge(person: string, tokens: { input: number; output: number }): void {
    this.counters.set(person, (this.counters.get(person) ?? 0) + tokenCost(tokens));
  }

  public counter(person: string): number {
    return this.counters.get(person) ?? 0;
  }

  public pending(): number {
    return this.queue.length;
  }

  /** The request to serve next, removed from the queue. */
  public next(): ScheduledRequest | undefined {
    const pick = this.pick(this.queue);
    if (!pick) return undefined;
    this.queue.splice(this.queue.indexOf(pick), 1);
    const { enqueuedAt: _at, order: _order, ...request } = pick;
    return request;
  }

  private pick(queue: Queued[]): Queued | undefined {
    if (queue.length === 0) return undefined;
    const now = this.now();
    const bound = this.options.maxWaitS * 1000;
    const aged = queue.filter((q) => now - q.enqueuedAt > bound);
    if (aged.length > 0) {
      const oldest = Math.min(...aged.map((q) => q.enqueuedAt));
      return this.fairest(aged.filter((q) => q.enqueuedAt === oldest));
    }
    const interactive = queue.filter((q) => q.kind === "pm_reply");
    return this.fairest(interactive.length > 0 ? interactive : queue);
  }

  /** The least-served person's earliest request; first come when fair share is off. */
  private fairest(candidates: Queued[]): Queued | undefined {
    const byArrival = [...candidates].sort(
      (a, b) => a.enqueuedAt - b.enqueuedAt || a.order - b.order,
    );
    if (this.options.fairShare === false) return byArrival[0];
    let best: Queued | undefined;
    for (const q of byArrival) {
      if (!best || this.counter(q.person) < this.counter(best.person)) best = q;
    }
    return best;
  }
}

// --- The queue runner's cards ---------------------------------------------

export interface FairOrderOptions {
  db: DatabaseSync;
  cardStore: CardStore;
  /** `[queue] agent_issues_per_person`: concurrent Agent issues per person (TEAM-30). */
  cap: number;
  maxWaitS: number;
  fairShare?: boolean;
  /** Tokens are counted from `card/step` events after this seq (the run's start). */
  sinceSeq: number;
  now?: () => number;
}

/**
 * The person an Agent issue runs for: whoever delegated it to the Worker
 * (the Agent acts on their behalf), else its owner, else the install's person.
 */
export function personOf(store: CardStore, card: CardRecord): string {
  return store.delegatorOf(card.id) ?? card.owner ?? store.localPrincipal();
}

/** Tokens each person's cards spent since `sinceSeq`, from the Worker's `card/step` events. */
export function tokensByPerson(
  db: DatabaseSync,
  store: CardStore,
  sinceSeq: number,
  cards: Map<string, string>,
): Map<string, { input: number; output: number }> {
  const rows = db
    .prepare(
      `SELECT card_id AS cardId,
              SUM(COALESCE(json_extract(payload, '$.usage.promptTokens'), 0)) AS input,
              SUM(COALESCE(json_extract(payload, '$.usage.completionTokens'), 0)) AS output
         FROM events WHERE type = 'card/step' AND seq > ? AND card_id IS NOT NULL
        GROUP BY card_id`,
    )
    .all(sinceSeq) as { cardId: string; input: number; output: number }[];
  const out = new Map<string, { input: number; output: number }>();
  for (const r of rows) {
    const person = cards.get(r.cardId) ?? store.delegatorOf(r.cardId);
    if (!person) continue;
    const t = out.get(person) ?? { input: 0, output: 0 };
    out.set(person, { input: t.input + r.input, output: t.output + r.output });
  }
  return out;
}

/** When each card last entered Ready, in ms (the aging clock's start). */
function readySince(db: DatabaseSync, cardId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT created_at AS at FROM events
        WHERE card_id = ? AND type IN ('card/status_changed', 'card/created')
          AND COALESCE(json_extract(payload, '$.to'), json_extract(payload, '$.toStatus'), json_extract(payload, '$.status')) = 'ready'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(cardId) as { at: string } | undefined;
  return row ? Date.parse(row.at) : undefined;
}

/** Running Agent issues per person: cards in progress, by whom they run for. */
async function runningByPerson(
  store: CardStore,
  exclude: Set<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const c of await store.listCards({ status: "in_progress" })) {
    if (exclude.has(c.id)) continue;
    const p = personOf(store, c);
    out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

/** One fair pick among `remaining`, persons at the cap last (TEAM-30). */
async function pickNext(
  remaining: CardRecord[],
  options: FairOrderOptions,
  started: number,
): Promise<CardRecord | undefined> {
  const store = options.cardStore;
  const persons = new Map(remaining.map((c) => [c.id, personOf(store, c)]));
  const running = await runningByPerson(store, new Set(remaining.map((c) => c.id)));
  const atCap = (p: string) => (running.get(p) ?? 0) >= options.cap;
  const free = remaining.filter((c) => !atCap(persons.get(c.id) as string));
  const pool = free.length > 0 ? free : remaining;
  const scheduler = new FairScheduler({
    maxWaitS: options.maxWaitS,
    ...(options.fairShare !== undefined ? { fairShare: options.fairShare } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  // Everyone's cards are queued together, then charged what they spent: no
  // one here is returning from idle, so VTC's lift does not apply.
  for (const c of pool) {
    // Waiting counts from the later of entering Ready and the run's start.
    const since = Math.max(readySince(options.db, c.id) ?? started, started);
    scheduler.enqueue(
      { id: c.id, person: persons.get(c.id) as string, kind: "worker_step" },
      since,
    );
  }
  for (const [person, t] of tokensByPerson(options.db, store, options.sinceSeq, persons)) {
    scheduler.charge(person, t);
  }
  const id = scheduler.next()?.id;
  return pool.find((c) => c.id === id);
}

/**
 * The queue runner's order (RUN-34, TEAM-30): one card at a time, each
 * picked when the previous one is done, so the tokens it spent count before
 * the next pick. The input order (the planner's WSJF order) breaks ties.
 */
export async function* fairOrder(
  cards: readonly CardRecord[],
  options: FairOrderOptions,
): AsyncGenerator<CardRecord> {
  const remaining = [...cards];
  const started = (options.now ?? Date.now)();
  while (remaining.length > 0) {
    const next = (await pickNext(remaining, options, started)) ?? remaining[0];
    if (!next) return;
    remaining.splice(remaining.indexOf(next), 1);
    yield next;
  }
}

/** Seconds a card takes: the median of finished attempts, else ten minutes. */
export function typicalCardSeconds(db: DatabaseSync): number {
  const rows = db
    .prepare(
      "SELECT seconds_used AS s FROM attempts WHERE status != 'running' AND seconds_used > 0 ORDER BY started_at DESC LIMIT 50",
    )
    .all() as { s: number }[];
  if (rows.length === 0) return 600;
  const sorted = rows.map((r) => r.s).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** "2nd in queue, about 6 minutes" (teams item 31). */
export function standingMessage(place: number, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const where = place === 1 ? "Next in queue" : `${ordinal(place)} in queue`;
  return `${where}, about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export interface Standing {
  cardId: string;
  person: string;
  place: number;
  estimateSeconds: number;
  message: string;
  /** Its person is at the per-person cap (TEAM-30): the cap and their running Agent issues. */
  capped?: { cap: number; running: number };
}

/** Running Agent issues per person, now (TEAM-30): what the per-person cap counts. */
export function runningAgentIssues(store: CardStore): Promise<Map<string, number>> {
  return runningByPerson(store, new Set());
}

/**
 * Why an issue waits at the per-person cap (TEAM-30, item 31), in plain
 * words: whose issues run, how many, the limit, and that others go first.
 * `who` is a name, or "you" for the reader; `opening` false continues a sentence.
 */
export function capNote(who: string, running: number, cap: number, opening = true): string {
  const has = who === "you" ? (opening ? "You have" : "you have") : `${who} has`;
  return `${has} ${running} Agent issue${running === 1 ? "" : "s"} running and the limit is ${cap} per person, so other people's issues go first`;
}

/**
 * Where each queued card stands (TEAM-30, item 31): its place in the fair
 * order and an estimate — the cards ahead of it, and one for each running
 * card, at the typical card's time.
 */
export async function queueStanding(
  cards: readonly CardRecord[],
  options: FairOrderOptions,
): Promise<Standing[]> {
  const typical = typicalCardSeconds(options.db);
  const running = (await options.cardStore.listCards({ status: "in_progress" })).length;
  const out: Standing[] = [];
  let place = 0;
  for await (const card of fairOrder(cards, options)) {
    place++;
    const estimateSeconds = (place - 1 + Math.min(running, 1)) * typical;
    out.push({
      cardId: card.id,
      person: personOf(options.cardStore, card),
      place,
      estimateSeconds,
      message: standingMessage(place, estimateSeconds),
    });
  }
  return out;
}
