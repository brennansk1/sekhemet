import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SuiteTask, TaskOutcome } from "./suite.js";

/**
 * The frozen suite's runner: the one measurement path's suite half
 * (measurement rule 9, MS-M9-1, MS-M9-3).
 *
 * `scripts/run_suite.mjs` used to hold this logic untested and ran each card
 * with `sekhemet run`, the Worker alone. The suite now runs each fixture
 * through the product's queue with its shipped defaults, and the script only
 * prepares the repositories and starts the queue. Every decision that shapes
 * a score — which card is blocked, what a timeout is attributed to, which
 * tokens a card spent, whether a passing card was accepted — is made here,
 * behind tests, with the child processes injected so no model runs in them.
 */

/** What the seeded board says about one card. */
export interface CardInfo {
  scope: string[];
  tests: string[];
  spec: string;
}

/** The ids and board facts a fixture actually seeded, in board order. */
export function seededCards(repo: string, expected: number): { id: string; info: CardInfo }[] {
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    const rows = db
      .prepare("select id, scope_files, acceptance_tests, spec from cards order by order_key, id")
      .all() as Record<string, unknown>[];
    // A guessed id made every task fail in zero seconds with no evidence —
    // a plumbing failure that reads like a catastrophic score — so the count
    // is checked against the manifest rather than trusted.
    if (rows.length !== expected) {
      throw new Error(`frozen suite: seeded ${rows.length} card(s), manifest declares ${expected}`);
    }
    return rows.map((r) => ({
      id: String(r.id),
      info: {
        scope: JSON.parse(String(r.scope_files ?? "[]")) as string[],
        tests: JSON.parse(String(r.acceptance_tests ?? "[]")) as string[],
        spec: String(r.spec ?? ""),
      },
    }));
  } finally {
    db.close();
  }
}

/**
 * The modules a card needs from other cards that are still empty on `main`.
 *
 * A card whose dependency was never built cannot pass, and running it
 * measures only that: it is blocked (rule 3), unmeasured and never paired.
 * Three forms name a dependency: the acceptance test's `../src/...` imports,
 * a `src/...` path in the spec, and a spec's `from "./x.js"` relative to the
 * card's first scoped file.
 */
export function unmetDependencies(repo: string, info: CardInfo): string[] {
  const own = new Set(info.scope.map((f) => f.replace(/\.[cm]?tsx?$/, "")));
  const needed = new Set<string>();
  for (const t of info.tests) {
    const spec = join(repo, "acceptance", t);
    if (!existsSync(spec)) continue;
    for (const m of readFileSync(spec, "utf8").matchAll(
      /from\s+["']\.\.\/(src\/[\w/.-]+?)(?:\.[cm]?js)?["']/g,
    )) {
      if (m[1] && !own.has(m[1])) needed.add(m[1]);
    }
  }
  for (const m of info.spec.matchAll(/\b(src\/[\w/.-]+?)\.[cm]?[jt]sx?\b/g)) {
    if (m[1] && !own.has(m[1])) needed.add(m[1]);
  }
  const home = posix.dirname(info.scope[0] ?? "src/index.ts");
  for (const m of info.spec.matchAll(/from\s+["']\.\/([\w/.-]+?)\.[cm]?js["']/g)) {
    const mod = posix.join(home, m[1] ?? "");
    if (m[1] && !own.has(mod)) needed.add(mod);
  }
  return [...needed].filter((mod) => {
    const file = [".ts", ".tsx", "/index.ts"].map((e) => join(repo, `${mod}${e}`)).find(existsSync);
    return !file || readFileSync(file, "utf8").trim() === "";
  });
}

interface Bundle {
  cardId?: unknown;
  attempt?: unknown;
  passed?: unknown;
  stopReason?: unknown;
  tokens?: { promptTokens?: unknown; completionTokens?: unknown };
}

function readBundle(file: string): Bundle | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Bundle;
  } catch {
    return undefined;
  }
}

const bundleTokens = (b: Bundle): number =>
  Number(b.tokens?.promptTokens ?? 0) + Number(b.tokens?.completionTokens ?? 0);

/**
 * The card's per-attempt bundles (`ev_*.json`), one per attempt number; when
 * two bundles name the same attempt, the later-written one stands.
 */
export function cardAttempts(repo: string, cardId: string): Map<number, Bundle> {
  const dir = join(repo, ".sekhemet", "evidence");
  const out = new Map<number, { b: Bundle; at: number }>();
  if (!existsSync(dir)) return new Map();
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("ev_") || !f.endsWith(".json")) continue;
    const full = join(dir, f);
    const b = readBundle(full);
    if (!b || b.cardId !== cardId) continue;
    const attempt = typeof b.attempt === "number" ? b.attempt : 1;
    const at = statSync(full).mtimeMs;
    const seen = out.get(attempt);
    if (!seen || seen.at <= at) out.set(attempt, { b, at });
  }
  return new Map([...out].map(([k, v]) => [k, v.b]));
}

/**
 * One card's outcome, read from its evidence rather than inferred.
 *
 * Tokens are totalled over every attempt's bundle: the `latest-` copy holds
 * only the last attempt, and a card that needed three attempts spent three
 * attempts' tokens. A card the runner's timeout killed is attributed to the
 * timeout — the last bundle belongs to an earlier, finished attempt, and its
 * stop reason is not why this card stopped.
 */
export function cardOutcome(
  repo: string,
  cardId: string,
  seconds: number,
  opts: { timedOutAfterMs?: number } = {},
): Omit<TaskOutcome, "task"> {
  const timeout =
    opts.timedOutAfterMs !== undefined
      ? `timed out after ${Math.round(opts.timedOutAfterMs / 60_000)} min`
      : undefined;
  const latestFile = join(repo, ".sekhemet", "evidence", `latest-${cardId}.json`);
  const latest = existsSync(latestFile) ? readBundle(latestFile) : undefined;
  const attempts = cardAttempts(repo, cardId);
  if (!latest && attempts.size === 0) {
    // "No bundle" covers two failures that must not share a label: a card
    // killed by the timeout was working when it died; one that never started
    // is a plumbing fault.
    return {
      passed: false,
      stopReason: timeout ?? "card did not start (no evidence bundle)",
      wallClockSeconds: seconds,
      tokens: 0,
      rungs: 0,
    };
  }
  const lastAttempt = Math.max(
    typeof latest?.attempt === "number" ? latest.attempt : 1,
    ...attempts.keys(),
  );
  const last = attempts.get(lastAttempt) ?? latest ?? {};
  const tokens =
    attempts.size > 0
      ? [...attempts.values()].reduce((n, b) => n + bundleTokens(b), 0)
      : bundleTokens(latest ?? {});
  // Gates decide completion: a passing bundle stands even if the process was
  // killed afterwards.
  const passed = last.passed === true;
  const recorded = last.stopReason ? String(last.stopReason) : undefined;
  const stopReason =
    timeout && !passed
      ? `${timeout}${recorded ? ` (last recorded attempt ${lastAttempt}: ${recorded})` : ""}`
      : recorded;
  return {
    passed,
    ...(stopReason ? { stopReason } : {}),
    wallClockSeconds: seconds,
    tokens,
    rungs: Math.max(0, lastAttempt - 1),
  };
}

/** One attempt as the queue's report records it (`queue_report.json`). */
export interface QueueEntryRecord {
  cardId: string;
  attempt: number;
  passed: boolean;
  accepted: boolean;
  stopReason: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  held?: string;
  parked?: string;
}

/** The queue report a run wrote, or undefined when it wrote none. */
export function readQueueReport(repo: string): { entries: QueueEntryRecord[] } | undefined {
  const file = join(repo, ".sekhemet", "queue_report.json");
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { entries?: QueueEntryRecord[] };
    return { entries: Array.isArray(r.entries) ? r.entries : [] };
  } catch {
    return undefined;
  }
}

/**
 * The processes a suite run on the queue path needs; the script supplies real
 * ones (`sekhemet queue` on the prepared repository), tests scripted ones.
 */
export interface QueueRunDriver {
  /** The fixture's prepared repository (copied, committed, seeded once). */
  prepare(fixture: string): string;
  /** The board's id for a task (declared ids as given; synthesised ones resolved). */
  resolveCardId(task: SuiteTask, repo: string): string;
  cardInfo(repo: string, cardId: string): CardInfo | undefined;
  /** Runs the product's queue over the repository's Ready cards; true when the timeout killed it. */
  runQueue(repo: string, timeoutMs: number): { timedOut: boolean };
  /** The prerequisites the board says a card is still waiting on. */
  waitingOn(repo: string, cardId: string): string[];
  log?(line: string): void;
}

/**
 * One card's outcome from the queue's report, after the queue ran every card.
 *
 * Tokens and time are totalled over every attempt the queue recorded. A
 * card the queue deferred (its prerequisites did not merge), or ran while a
 * module its contract needs was still empty on `main` at the end of the run,
 * is **blocked** (rule 3): it could not pass, so it is unmeasured. `main`
 * only grows during a run, so a module empty at the end was empty when the
 * card ran.
 */
function queueCardOutcome(
  driver: QueueRunDriver,
  repo: string,
  cardId: string,
  run: { timedOut: boolean; timeoutMs: number; report?: { entries: QueueEntryRecord[] } },
): Omit<TaskOutcome, "task"> {
  const minutes = Math.round(run.timeoutMs / 60_000);
  const mine = (run.report?.entries ?? [])
    .filter((e) => e.cardId === cardId)
    .sort((a, b) => a.attempt - b.attempt);
  const last = mine.at(-1);
  const unmet = (() => {
    const info = driver.cardInfo(repo, cardId);
    return info ? unmetDependencies(repo, info) : [];
  })();
  if (last) {
    const tokens = mine.reduce((n, e) => n + e.promptTokens + e.completionTokens, 0);
    const seconds = Math.round(mine.reduce((n, e) => n + e.durationMs, 0) / 1000);
    const rungs = Math.max(0, last.attempt - 1);
    if (!last.passed && unmet.length) {
      return {
        passed: false,
        blocked: true,
        stopReason: `blocked: ${unmet.join(", ")} never built (an earlier card failed); the queue ran it: ${last.stopReason}`,
        wallClockSeconds: seconds,
        tokens,
        rungs,
      };
    }
    const notAccepted =
      last.passed && !last.accepted
        ? `passed, but not accepted${last.held ? ` (held: ${last.held})` : ""}: later cards cannot build on it`
        : undefined;
    const stopReason = notAccepted ?? (last.passed ? undefined : last.stopReason);
    return {
      passed: last.passed,
      ...(stopReason ? { stopReason } : {}),
      wallClockSeconds: seconds,
      tokens,
      rungs,
    };
  }
  if (run.timedOut) {
    // The queue writes its report after every entry, so the cards it
    // finished were read above; the card it was running when it was killed
    // has bundles and no entry, and is the runner's timeout; the cards after
    // it have neither and were never run (review M4).
    const o = cardOutcome(repo, cardId, 0, { timedOutAfterMs: run.timeoutMs });
    if (o.stopReason === `timed out after ${minutes} min` && o.tokens === 0) {
      return {
        ...o,
        notRun: true,
        stopReason: `no attempt recorded: the runner stopped the queue after ${minutes} min`,
      };
    }
    return o;
  }
  if (!run.report) {
    return {
      passed: false,
      notRun: true,
      stopReason: "not run: the queue wrote no report (it refused to run or crashed)",
      wallClockSeconds: 0,
      tokens: 0,
      rungs: 0,
    };
  }
  const waiting = driver.waitingOn(repo, cardId);
  if (waiting.length || unmet.length) {
    return {
      passed: false,
      blocked: true,
      stopReason: waiting.length
        ? `blocked: the queue deferred it; prerequisites ${waiting.join(", ")} did not merge`
        : `blocked: ${unmet.join(", ")} never built (an earlier card failed); the queue did not run it`,
      wallClockSeconds: 0,
      tokens: 0,
      rungs: 0,
    };
  }
  return {
    passed: false,
    notRun: true,
    stopReason: "not run: the queue finished without running it",
    wallClockSeconds: 0,
    tokens: 0,
    rungs: 0,
  };
}

/**
 * The task runner `runFrozenSuite` takes, on the product's queue path
 * (measurement rule 9, MS-M9-1, MS-M9-3): the first task of a fixture runs
 * `sekhemet queue` once over all of that fixture's cards — the same card
 * execution, roles and policies a person's run gets, with acceptance
 * standing in for the person — and every task of the fixture is then read
 * from the queue's report and evidence. The queue cannot be stopped per
 * card, so its timeout is the per-card timeout times the fixture's cards.
 */
export function suiteQueueRunner(
  driver: QueueRunDriver,
  opts: { tasks: readonly SuiteTask[]; cardTimeoutMs: number },
): (task: SuiteTask) => Promise<Omit<TaskOutcome, "task">> {
  const log = driver.log ?? (() => {});
  const runs = new Map<
    string,
    { repo: string; timedOut: boolean; timeoutMs: number; report?: { entries: QueueEntryRecord[] } }
  >();
  return async (task) => {
    let run = runs.get(task.suite);
    if (!run) {
      const repo = driver.prepare(task.suite);
      const cards = opts.tasks.filter((t) => t.suite === task.suite).length;
      const timeoutMs = cards * opts.cardTimeoutMs;
      log(`  ${task.suite}: sekhemet queue over ${cards} card(s) ...`);
      const { timedOut } = driver.runQueue(repo, timeoutMs);
      // A timed-out queue leaves the partial report it wrote after its last entry.
      const report = readQueueReport(repo);
      run = { repo, timedOut, timeoutMs, ...(report ? { report } : {}) };
      runs.set(task.suite, run);
    }
    const cardId = driver.resolveCardId(task, run.repo);
    const o = queueCardOutcome(driver, run.repo, cardId, run);
    log(
      `  ${task.suite}/${cardId} ... ${o.blocked ? "BLOCKED" : o.notRun ? "NOT RUN" : o.passed ? "PASS" : "FAIL"} ${o.wallClockSeconds}s${o.stopReason ? ` (${o.stopReason})` : ""}`,
    );
    return o;
  };
}
