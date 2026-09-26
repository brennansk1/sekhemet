import type { ModelRole } from "./types.js";

/**
 * Declared-hours scheduling (M25, design "Scheduling"): the user declares
 * the hours the machine is theirs; outside them the harness works the
 * backlog. Model swaps are batched by project to preserve caches, and
 * planning runs in scheduled blocks where co-loading is impossible.
 * Everything here is pure and deterministic; the queue executes the plan.
 */
export interface HoursBlock {
  /** 0 = Sunday .. 6 = Saturday. */
  days: number[];
  /** Local time "HH:MM". `end` before `start` wraps past midnight. */
  start: string;
  end: string;
}

export interface DeclaredHours {
  /** Blocks when the machine belongs to the user (the harness stays idle). */
  userBlocks: HoursBlock[];
}

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Invalid time "${hhmm}"`);
  return h * 60 + min;
}

/** True when `at` (local time) falls inside a declared user block. */
export function isUserTime(at: Date, hours: DeclaredHours): boolean {
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();
  for (const b of hours.userBlocks) {
    const start = minutesOf(b.start);
    const end = minutesOf(b.end);
    if (start <= end) {
      if (b.days.includes(day) && minute >= start && minute < end) return true;
    } else {
      // Wraps midnight: [start, 24:00) on the day, [0, end) on the next day.
      if (b.days.includes(day) && minute >= start) return true;
      if (b.days.includes((day + 6) % 7) && minute < end) return true;
    }
  }
  return false;
}

/**
 * The next window the harness may work, starting at or after `from`: the
 * first minute outside user time, until the next user block begins (capped
 * at `horizonMinutes`). Scans by minute: exact, and a week is only 10,080.
 */
export function nextWorkWindow(
  from: Date,
  hours: DeclaredHours,
  horizonMinutes = 7 * 24 * 60,
): { start: Date; end: Date } | undefined {
  const t = new Date(from);
  t.setSeconds(0, 0);
  let i = 0;
  while (i < horizonMinutes && isUserTime(t, hours)) {
    t.setMinutes(t.getMinutes() + 1);
    i++;
  }
  if (i >= horizonMinutes) return undefined;
  const start = new Date(t);
  while (i < horizonMinutes && !isUserTime(t, hours)) {
    t.setMinutes(t.getMinutes() + 1);
    i++;
  }
  return { start, end: new Date(t) };
}

export interface BacklogItem {
  cardId: string;
  project: string;
  role: ModelRole;
  /** Planning work (plans, decomposition) runs first in the window; execution after. */
  planning?: boolean;
  modelId: string;
  /** Estimated minutes (from the planner's estimate or measured actuals). */
  minutes: number;
  /** Higher runs earlier among equals (WSJF score or priority). */
  priority?: number;
}

export interface ScheduledBatch {
  modelId: string;
  role: ModelRole;
  project: string;
  items: BacklogItem[];
  start: Date;
  end: Date;
  /** True when this batch needed a model load (a swap). */
  swap: boolean;
}

export interface BacklogSchedule {
  batches: ScheduledBatch[];
  swaps: number;
  /** Items that did not fit in the window. */
  deferred: BacklogItem[];
}

/**
 * Plan a work window (M25). Items are grouped by model, then project, so
 * each model loads once per window and a project's cards run back to back
 * on a warm prefix cache. Planning (planner) batches go first in the
 * window, so the planning block's output feeds the execution batches. The
 * model already resident, when given, goes first among execution batches
 * (no swap). Inside a batch, higher priority first, then card id.
 */
export function planWorkWindow(
  items: readonly BacklogItem[],
  window: { start: Date; end: Date },
  options: { swapMinutes?: number; residentModelId?: string } = {},
): BacklogSchedule {
  const swapMinutes = options.swapMinutes ?? 4;
  const byModel = new Map<string, BacklogItem[]>();
  for (const it of items) {
    const list = byModel.get(it.modelId) ?? [];
    list.push(it);
    byModel.set(it.modelId, list);
  }
  const modelOrder = [...byModel.keys()].sort((a, b) => {
    const planA = byModel.get(a)?.some((i) => i.planning === true) ? 0 : 1;
    const planB = byModel.get(b)?.some((i) => i.planning === true) ? 0 : 1;
    if (planA !== planB) return planA - planB;
    const resA = a === options.residentModelId ? 0 : 1;
    const resB = b === options.residentModelId ? 0 : 1;
    if (resA !== resB) return resA - resB;
    const pri = (m: string) => Math.max(...(byModel.get(m) ?? []).map((i) => i.priority ?? 0));
    return pri(b) - pri(a) || a.localeCompare(b);
  });

  const batches: ScheduledBatch[] = [];
  const deferred: BacklogItem[] = [];
  let cursor = window.start.getTime();
  const end = window.end.getTime();
  let loaded = options.residentModelId;
  let swaps = 0;
  for (const modelId of modelOrder) {
    const list = byModel.get(modelId) ?? [];
    const projects = [...new Set(list.map((i) => i.project))].sort();
    for (const project of projects) {
      const group = list
        .filter((i) => i.project === project)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.cardId.localeCompare(b.cardId));
      const needsSwap = loaded !== modelId;
      let t = cursor + (needsSwap ? swapMinutes * 60_000 : 0);
      const fitted: BacklogItem[] = [];
      for (const it of group) {
        if (t + it.minutes * 60_000 <= end) {
          fitted.push(it);
          t += it.minutes * 60_000;
        } else deferred.push(it);
      }
      if (fitted.length === 0) continue;
      if (needsSwap) {
        swaps++;
        loaded = modelId;
      }
      batches.push({
        modelId,
        role: fitted[0]?.role ?? "worker",
        project,
        items: fitted,
        start: new Date(cursor),
        end: new Date(t),
        swap: needsSwap,
      });
      cursor = t;
    }
  }
  return { batches, swaps, deferred };
}

/**
 * The next batch to run now, or why not (`user_time`): the queue calls this
 * before each card so it yields the machine inside declared hours.
 */
export function scheduleNow(
  now: Date,
  hours: DeclaredHours,
  items: readonly BacklogItem[],
  options: { swapMinutes?: number; residentModelId?: string } = {},
):
  | { state: "user_time"; resumesAt: Date | undefined }
  | { state: "work"; schedule: BacklogSchedule } {
  if (isUserTime(now, hours)) {
    return { state: "user_time", resumesAt: nextWorkWindow(now, hours)?.start };
  }
  const window = nextWorkWindow(now, hours);
  if (!window) return { state: "user_time", resumesAt: undefined };
  return { state: "work", schedule: planWorkWindow(items, window, options) };
}
