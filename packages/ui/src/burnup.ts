/**
 * The burn-up and the sprint header's visibility (dashboard §2.4.13, §2.4.17,
 * DB-P3-14): work done and total scope as two lines, so scope growth shows
 * apart from progress, per sprint and per project; the sprint header is shown
 * while a sprint is in force unless the filter points elsewhere (another
 * sprint, or `sprint:none`). A sprint is the internal *cycle* (DEC-31). The
 * work is counted in issues unless Preferences → Estimation is story points
 * (DB-N7-2), when the series is in points. The series is the server's (`GET /api/metrics/burnup`,
 * PM_CONTRACT §3), replayed from the ledger; `web/burnup.js` draws this.
 *
 * The browser loads the compiled module as `/app/lib/burnup.js`.
 */
import {
  type CardFilter,
  type CycleLike,
  type Estimation,
  activeCycle,
  formatShortDate,
  showsPoints,
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
  /** What the series counts (`?unit=`): points (the default) or issues. */
  unit?: "points" | "issues";
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
  /** Status's forecast range, 50% to 85%, as a band (DB-N9-1, DB-N9-3). */
  band?: { x1: number; x2: number; label: string };
  /** Status's target date, as a line. */
  target?: { x: number; label: string };
  caption: string;
  /** The data table: date, done, scope. */
  rows: string[][];
}

export const BURNUP_HEIGHT = 240;
/** The Insights charts' margins (§2.10.2), so the burn-up sits among them. */
export const BURNUP_MARGIN = { l: 44, r: 56, t: 12, b: 28 } as const;

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

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
  return s.scope === "cycle" ? `Burn-up · ${s.name ?? "the sprint"}` : "Burn-up · the project";
}

/** What Status adds to the burn-up: the forecast range and the target date. */
export interface BurnupExtras {
  /** The 50% and 85% forecast dates (`YYYY-MM-DD`). */
  band?: { from: string; to: string };
  target?: string;
}

/**
 * The chart at a width: the scope and done lines over the cycle's whole span
 * (the project's: the days so far), their end labels kept apart, the y axis
 * ticks, and the summary and table a person reads instead of the lines. On
 * Status (§2.8.3) the span reaches the forecast band and the target line too.
 */
export function burnupChart(
  s: BurnupSeries,
  width = 560,
  extras: BurnupExtras = {},
): BurnupChart | { title: string; empty: string } {
  const title = titleOf(s);
  const days = s.days;
  if (days.length === 0) {
    return {
      title,
      empty:
        s.scope === "cycle" && s.startsOn
          ? `${s.name ?? "The sprint"} starts on ${formatShortDate(s.startsOn)}.`
          : "No issues yet.",
    };
  }
  const issues = s.unit === "issues";
  const pts = (n: number) =>
    issues ? `${n} ${n === 1 ? "issue" : "issues"}` : `${n} ${n === 1 ? "pt" : "pts"}`;
  // STA-06: one day of the project's history is a point, not a line; say so
  // rather than draw axes from a day to the same day with nothing on them.
  if (s.scope === "project" && days.length < 2) {
    const only = days[0] as BurnupDay;
    return {
      title,
      empty: `Not enough history yet: ${only.done} of ${pts(only.scope)} done today. The lines start once there are two days.`,
    };
  }
  const M = BURNUP_MARGIN;
  const H = BURNUP_HEIGHT;
  const first = days[0] as BurnupDay;
  const last = days[days.length - 1] as BurnupDay;
  const baseSpan =
    s.scope === "cycle" && s.startsOn && s.endsOn
      ? Math.max(days.length, dayNumber(s.endsOn) - dayNumber(s.startsOn) + 1)
      : days.length;
  const indexOf = (iso: string) => dayNumber(iso) - dayNumber(first.date);
  const reach = [extras.band?.to, extras.target]
    .filter((d): d is string => typeof d === "string" && Number.isFinite(dayNumber(d)))
    .map((d) => indexOf(d) + 1);
  const spanDays = Math.max(baseSpan, ...reach);
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
  const lastShown = [
    s.scope === "cycle" && s.endsOn ? s.endsOn : last.date,
    extras.band?.to,
    extras.target,
  ]
    .filter((d): d is string => typeof d === "string")
    .reduce((a, b) => (dayNumber(b) > dayNumber(a) ? b : a));
  const band = extras.band
    ? {
        x1: x(Math.max(0, indexOf(extras.band.from))),
        x2: x(Math.max(0, indexOf(extras.band.to))),
        label: `50% ${formatShortDate(extras.band.from)} to 85% ${formatShortDate(extras.band.to)}`,
      }
    : undefined;
  const target = extras.target
    ? {
        x: x(Math.max(0, indexOf(extras.target))),
        label: `Target ${formatShortDate(extras.target)}`,
      }
    : undefined;
  const forecastWords =
    (extras.band
      ? ` Forecast: 50% by ${formatShortDate(extras.band.from)}, 85% by ${formatShortDate(extras.band.to)}.`
      : "") + (extras.target ? ` Target ${formatShortDate(extras.target)}.` : "");
  const unest =
    !issues && s.unestimated > 0
      ? ` ${s.unestimated} ${s.unestimated === 1 ? "issue" : "issues"} unestimated, counted as 1 pt each.`
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
    lastDate: formatShortDate(lastShown),
    ...(band ? { band } : {}),
    ...(target ? { target } : {}),
    caption: `${last.done} of ${pts(last.scope)} done by ${formatShortDate(last.date)}. ${grew}${unest}${forecastWords}`,
    rows: days.map((d) => [formatShortDate(d.date), String(d.done), String(d.scope)]),
  };
}

/**
 * The sprint header shows while a sprint is in force (§2.4.13) unless the
 * filter points at another sprint or at `sprint:none` (DB-P3-14).
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
 * The sprint in force while its header shows; otherwise the whole project —
 * the one the board is scoped to (`projectId`), or every project the person
 * can see when it is scoped to none. The series counts issues unless the
 * project's estimation is story points (DB-N7-2).
 */
export function burnupTarget(
  cycles: CycleLike[] | undefined,
  filter: CardFilter,
  now = Date.now(),
  projectId?: string | null,
  estimation?: Estimation,
): BurnupTarget {
  const cycle = cycleHeaderShown(cycles, filter, now) ? activeCycle(cycles, now) : undefined;
  const unit = showsPoints(estimation) ? "" : "&unit=issues";
  return cycle
    ? {
        kind: "cycle",
        id: cycle.id,
        url: `/api/metrics/burnup?cycle=${encodeURIComponent(cycle.id)}${unit}`,
      }
    : {
        kind: "project",
        url: `/api/metrics/burnup?scope=project${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}${unit}`,
      };
}
