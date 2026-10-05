/**
 * W9's measurement harness (FINISH_LINE_PLAN §A, Responsiveness): the
 * budgets, the PerformanceObserver script a page runs from its first byte,
 * and the arithmetic over several loads. The browser measures; nothing here
 * estimates a figure the browser did not report, except that an interaction
 * Event Timing leaves out (it reports 16 ms and over) is counted at 16 ms,
 * an upper bound, never as zero.
 */

/** §A: LCP-like ≤ 2.5 s, CLS ≤ 0.1, INP-like p75 ≤ 200 ms [S48]. */
export const BUDGETS = { lcpMs: 2500, cls: 0.1, inpP75Ms: 200 } as const;

/** Event Timing's smallest reported duration. */
export const EVENT_TIMING_FLOOR_MS = 16;

/** Loads per page: the median LCP is judged, the worst CLS. */
export const RUNS = 5;

export interface PageMeasure {
  lcpMs: number;
  cls: number;
  /** Interactions made on the page (key presses). */
  interactions: number;
  /** Event Timing entries of 16 ms and over: interaction id and duration. */
  slowEvents: { id: number; d: number }[];
}

/**
 * Installed with `addInitScript({ content })`, so the observers run before
 * the page's own code: the largest contentful paint, the layout shifts
 * without recent input, the main thread's long tasks (over 50 ms), the first input (always reported, whatever its
 * duration: the proof Event Timing runs on the page), and every event entry
 * of 16 ms or more that belongs to an interaction. Plain JavaScript text, not
 * a function: the test transform would add helpers the page does not have.
 */
export const MEASURE_SCRIPT = `
window.__perf = { lcp: 0, cls: 0, firstInput: null, events: [], longTasks: [] };
new PerformanceObserver(function (list) {
  for (const e of list.getEntries()) window.__perf.longTasks.push(e.duration);
}).observe({ type: "longtask", buffered: true });
new PerformanceObserver(function (list) {
  for (const e of list.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime);
}).observe({ type: "largest-contentful-paint", buffered: true });
new PerformanceObserver(function (list) {
  for (const e of list.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value;
}).observe({ type: "layout-shift", buffered: true });
new PerformanceObserver(function (list) {
  for (const e of list.getEntries()) window.__perf.firstInput = e.duration;
}).observe({ type: "first-input", buffered: true });
new PerformanceObserver(function (list) {
  for (const e of list.getEntries())
    if (e.interactionId) window.__perf.events.push({ id: e.interactionId, d: e.duration });
}).observe({ type: "event", buffered: true, durationThreshold: ${EVENT_TIMING_FLOOR_MS} });
`;

const quantile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number);

/**
 * The INP-like p75: each interaction's longest event (keydown and keyup share
 * an id), and the interactions the browser did not report at 16 ms.
 */
export function p75WithUnreported(
  slow: readonly { id: number; d: number }[],
  made: number,
): number {
  const byId = new Map<number, number>();
  for (const e of slow) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.d));
  const durations = [...byId.values()];
  while (durations.length < made) durations.push(EVENT_TIMING_FLOOR_MS);
  return quantile(
    durations.sort((a, b) => a - b),
    0.75,
  );
}

export function summarise(runs: readonly PageMeasure[]): {
  lcpMedianMs: number;
  lcpMaxMs: number;
  clsMax: number;
  interactions: number;
  inpP75Ms: number;
  inpMaxMs: number;
} {
  const lcps = runs.map((r) => r.lcpMs).sort((a, b) => a - b);
  const slow = runs.flatMap((r, i) => r.slowEvents.map((e) => ({ id: i * 1e6 + e.id, d: e.d })));
  const interactions = runs.reduce((n, r) => n + r.interactions, 0);
  return {
    lcpMedianMs: quantile(lcps, 0.5),
    lcpMaxMs: lcps.at(-1) ?? 0,
    clsMax: Math.max(0, ...runs.map((r) => r.cls)),
    interactions,
    inpP75Ms: p75WithUnreported(slow, interactions),
    inpMaxMs: Math.max(EVENT_TIMING_FLOOR_MS, ...slow.map((e) => e.d)),
  };
}

/** `RUNS` loads of one page, one after another (one Chromium at a time). */
export async function perfRuns(one: () => Promise<PageMeasure>): Promise<PageMeasure[]> {
  const out: PageMeasure[] = [];
  for (let i = 0; i < RUNS; i++) out.push(await one());
  return out;
}
