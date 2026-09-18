import type { EventLog } from "@sekhemet/kernel";

export interface FlowMetrics {
  throughput: { date: string; done: number }[];
  cycleTime: { cardId: string; hours: number; doneAt?: string }[];
  cfd: {
    date: string;
    backlog: number;
    ready: number;
    working: number;
    checking: number;
    review: number;
    done: number;
  }[];
  wipAge: { cardId: string; hours: number }[];
}

type Bucket = "backlog" | "ready" | "working" | "checking" | "review" | "done";

/** Board columns as flow states. Parked and rejected leave the flow. */
const BUCKET: Record<string, Bucket | undefined> = {
  backlog: "backlog",
  ready: "ready",
  planning: "ready",
  in_progress: "working",
  verify: "checking",
  review: "review",
  done: "done",
};

const day = (iso: string) => iso.slice(0, 10);
const hoursBetween = (a: string, b: string) =>
  Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);

/**
 * Kanban flow metrics from the ledger's status changes.
 *
 * Cycle time runs from a card's first move into Working to its move into
 * Done: the Kanban Method's definition, and the one that makes the number
 * comparable with Jira's and Linear's.
 */
export async function flowMetrics(
  log: EventLog,
  days: number,
  now = new Date(),
): Promise<FlowMetrics> {
  const events = await log.getEventsByTypes(["card/created", "card/status_changed"]);
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const state = new Map<string, Bucket | undefined>();
  const startedAt = new Map<string, string>();
  const enteredAt = new Map<string, string>();
  const throughput = new Map<string, number>();
  const cycleTime: FlowMetrics["cycleTime"] = [];
  const cfdByDay = new Map<string, Record<Bucket, number>>();

  const snapshot = (): Record<Bucket, number> => {
    const counts: Record<Bucket, number> = {
      backlog: 0,
      ready: 0,
      working: 0,
      checking: 0,
      review: 0,
      done: 0,
    };
    for (const b of state.values()) if (b) counts[b]++;
    return counts;
  };

  for (const e of events) {
    const p = e.payload as { id?: string; status?: string; toStatus?: string };
    const id = p.id ?? e.cardId;
    if (!id) continue;
    const status = e.type === "card/created" ? p.status : p.toStatus;
    const bucket = status ? BUCKET[status] : undefined;
    const at = e.createdAt;

    if (bucket === "working" && !startedAt.has(id)) startedAt.set(id, at);
    if (bucket !== state.get(id)) enteredAt.set(id, at);
    if (bucket === "done" && state.get(id) !== "done") {
      if (at >= since) throughput.set(day(at), (throughput.get(day(at)) ?? 0) + 1);
      const start = startedAt.get(id);
      if (start && at >= since) {
        cycleTime.push({ cardId: id, hours: round(hoursBetween(start, at)), doneAt: at });
      }
    }
    state.set(id, bucket);
    cfdByDay.set(day(at), snapshot());
  }

  // One CFD row per day in range, carrying the last known state forward.
  const cfd: FlowMetrics["cfd"] = [];
  let carry = snapshotBefore(cfdByDay, day(since));
  for (let t = Date.parse(day(since)); t <= now.getTime(); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    carry = cfdByDay.get(d) ?? carry;
    cfd.push({ date: d, ...carry });
  }

  const nowIso = now.toISOString();
  const wipAge: FlowMetrics["wipAge"] = [];
  for (const [id, b] of state) {
    if (b === "working" || b === "checking" || b === "review") {
      wipAge.push({ cardId: id, hours: round(hoursBetween(enteredAt.get(id) ?? nowIso, nowIso)) });
    }
  }
  wipAge.sort((a, b) => b.hours - a.hours);

  return {
    throughput: [...throughput].sort().map(([date, done]) => ({ date, done })),
    cycleTime,
    cfd,
    wipAge,
  };
}

function snapshotBefore(
  byDay: Map<string, Record<Bucket, number>>,
  first: string,
): Record<Bucket, number> {
  const empty = { backlog: 0, ready: 0, working: 0, checking: 0, review: 0, done: 0 };
  let last = empty;
  for (const [d, counts] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (d < first) last = counts;
  }
  return last;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
