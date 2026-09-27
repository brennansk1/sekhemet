/**
 * The burn-up and the cycle header's visibility (dashboard §2.4.13, §2.4.17,
 * DB-P3-14): done points and total scope as two lines, so scope growth shows
 * apart from progress, per cycle and per project; the cycle header is shown
 * while a cycle is in force unless the filter points elsewhere (another cycle,
 * or `cycle:none`). The series is the server's (`GET /api/metrics/burnup`,
 * PM_CONTRACT §3), replayed from the ledger; `web/burnup.js` draws this.
 *
 * The browser loads the compiled module as `/app/lib/burnup.js`.
 */
import {
  type CardFilter,
  type CycleLike,
  activeCycle,
  formatShortDate,
  slug,
  termValues,
} from "./pm.js";

export interface BurnupDay {
  date: string;
  done: number;
  scope: number;
}

export interface BurnupSeries {
  scope: "cycle" | "project";
  cycleId?: string;
  name?: string;
  startsOn?: string;
  endsOn?: string;
  /** One row per day so far, the last known state carried forward. */
  days: BurnupDay[];
  /** Cards without an estimate, each counted as 1 point. */
  unestimated: number;
}

export interface BurnupChart {
  title: string;
  width: number;
  height: number;
  yMax: number;
  ticks: { value: number; y: number }[];
  scopePath: string;
  donePath: string;
  labels: {
    scope: { text: string; x: number; y: number };
    done: { text: string; x: number; y: number };
  };
  firstDate: string;
  lastDate: string;
  caption: string;
  /** The data table: date, done, scope. */
  rows: string[][];
}

export const BURNUP_HEIGHT = 240;
/** The Insights charts' margins (§2.10.2), so the burn-up sits among them. */
export const BURNUP_MARGIN = { l: 44, r: 56, t: 12, b: 28 } as const;

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (n: number) => `${n} ${n === 1 ? "pt" : "pts"}`;

function dayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY : Number.NaN;
}

/** A 1-2-2.5-5 step, whole numbers only, and the axis top at or above `v`. */
function niceMax(v: number, ticks = 4): { max: number; step: number } {
  const raw = Math.max(1, v) / ticks;
  const p = 10 ** Math.floor(Math.log10(raw));
  let step = 10 * p;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * p >= raw) {
      step = m * p;
      break;
    }
  }
  step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(Math.max(1, v) / step) * step, step };
}

function titleOf(s: BurnupSeries): string {
  return s.scope === "cycle" ? `Burn-up · ${s.name ?? "the cycle"}` : "Burn-up · the project";
}

/**
 * The chart at a width: the scope and done lines over the cycle's whole span
 * (the project's: the days so far), their end labels kept apart, the y axis
 * ticks, and the summary and table a person reads instead of the lines.
 */
export function burnupChart(
  s: BurnupSeries,
  width = 560,
): BurnupChart | { title: string; empty: string } {
  const title = titleOf(s);
  const days = s.days;
  if (days.length === 0) {
    return {
      title,
      empty:
        s.scope === "cycle" && s.startsOn
          ? `${s.name ?? "The cycle"} starts on ${formatShortDate(s.startsOn)}.`
          : "No cards yet.",
    };
  }
  const M = BURNUP_MARGIN;
  const H = BURNUP_HEIGHT;
  const first = days[0] as BurnupDay;
  const last = days[days.length - 1] as BurnupDay;
  const spanDays =
    s.scope === "cycle" && s.startsOn && s.endsOn
      ? Math.max(days.length, dayNumber(s.endsOn) - dayNumber(s.startsOn) + 1)
      : days.length;
  const { max, step } = niceMax(Math.max(...days.map((d) => Math.max(d.scope, d.done))));
  const x = (i: number) =>
    r1(M.l + (spanDays <= 1 ? 0 : (i * (width - M.l - M.r)) / (spanDays - 1)));
  const y = (v: number) => r1(M.t + (H - M.t - M.b) * (1 - v / max));
  const path = (key: "done" | "scope") =>
    days.map((d, i) => `${i ? "L" : "M"}${x(i)} ${y(d[key])}`).join("");
  const ticks: { value: number; y: number }[] = [];
  for (let v = 0; v <= max; v += step) ticks.push({ value: v, y: y(v) });
  const endX = r1(x(days.length - 1) + 6);
  const scopeY = r1(y(last.scope) + 3.5);
  let doneY = r1(y(last.done) + 3.5);
  if (Math.abs(doneY - scopeY) < 12) doneY = r1(scopeY + 12);
  const growth = last.scope - first.scope;
  const since = formatShortDate(first.date);
  const grew =
    growth > 0
      ? `Scope grew by ${pts(growth)} since ${since}.`
      : growth < 0
        ? `Scope shrank by ${pts(-growth)} since ${since}.`
        : `Scope has not changed since ${since}.`;
  const unest =
    s.unestimated > 0
      ? ` ${s.unestimated} ${s.unestimated === 1 ? "card" : "cards"} unestimated, counted as 1 pt each.`
      : "";
  return {
    title,
    width,
    height: H,
    yMax: max,
    ticks,
    scopePath: path("scope"),
    donePath: path("done"),
    labels: {
      scope: { text: `Scope ${pts(last.scope)}`, x: endX, y: scopeY },
      done: { text: `Done ${pts(last.done)}`, x: endX, y: doneY },
    },
    firstDate: since,
    lastDate: formatShortDate(s.scope === "cycle" && s.endsOn ? s.endsOn : last.date),
    caption: `${last.done} of ${pts(last.scope)} done by ${formatShortDate(last.date)}. ${grew}${unest}`,
    rows: days.map((d) => [formatShortDate(d.date), String(d.done), String(d.scope)]),
  };
}

/**
 * The cycle header shows while a cycle is in force (§2.4.13) unless the filter
 * points at another cycle or at `cycle:none` (DB-P3-14).
 */
export function cycleHeaderShown(
  cycles: CycleLike[] | undefined,
  filter: CardFilter,
  now = Date.now(),
): boolean {
  const cycle = activeCycle(cycles, now);
  if (!cycle) return false;
  const vals = termValues(filter, "cycle");
  return (
    vals.length === 0 ||
    vals.includes("current") ||
    vals.includes(slug(cycle.name)) ||
    vals.includes(cycle.id.toLowerCase())
  );
}

export type BurnupTarget =
  | { kind: "cycle"; id: string; url: string }
  | { kind: "project"; url: string };

/**
 * The cycle in force while its header shows; otherwise the whole project —
 * the one the board is scoped to (`projectId`), or every project the person
 * can see when it is scoped to none.
 */
export function burnupTarget(
  cycles: CycleLike[] | undefined,
  filter: CardFilter,
  now = Date.now(),
  projectId?: string | null,
): BurnupTarget {
  const cycle = cycleHeaderShown(cycles, filter, now) ? activeCycle(cycles, now) : undefined;
  return cycle
    ? {
        kind: "cycle",
        id: cycle.id,
        url: `/api/metrics/burnup?cycle=${encodeURIComponent(cycle.id)}`,
      }
    : {
        kind: "project",
        url: `/api/metrics/burnup?scope=project${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`,
      };
}
