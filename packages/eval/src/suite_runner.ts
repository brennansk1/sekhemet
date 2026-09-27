import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog } from "@sekhemet/kernel";
import { readMeasurementMarker } from "./measurement_marker.js";
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
  // Live-test F20: built means `main` holds it. Safe Accept moves `main` by
  // plumbing and leaves the checkout as seeded, so the working tree is read
  // only where the repository is not a git repository.
  return [...needed].filter((mod) => {
    for (const e of [".ts", ".tsx", "/index.ts"]) {
      const committed = committedText(repo, `${mod}${e}`);
      if (committed !== undefined) return committed.trim() === "";
    }
    const file = [".ts", ".tsx", "/index.ts"].map((e) => join(repo, `${mod}${e}`)).find(existsSync);
    return !file || readFileSync(file, "utf8").trim() === "";
  });
}

/** A file's text at the repository's HEAD commit, or undefined when git has none (not a repo, no such file). */
function committedText(repo: string, path: string): string | undefined {
  try {
    // A blob's raw bytes: `show` runs no filter, and textconv is refused.
    return execFileSync("git", ["show", "--no-textconv", `HEAD:${path}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
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

/**
 * Prepare a repository for one card in independent mode (MS-T7-3): every
 * earlier card's reference solution (`<referencesDir>/<fixture>/<card>/`,
 * repository-relative files) is committed to `main`, the earlier cards are
 * done and the later ones wait in the backlog, so the queue runs this card
 * alone and its result depends on no earlier card's outcome.
 */
export async function prepareIndependentCard(
  repo: string,
  o: {
    fixture: string;
    cardId: string;
    cardOrder: readonly string[];
    referencesDir: string;
    /**
     * Each card's staged acceptance tests (`acceptance/<t>`): an accepted
     * card's tests are on `main` as `tests/<t>`, as sequential acceptance
     * leaves them (review M2).
     */
    acceptanceTests?: Readonly<Record<string, readonly string[]>>;
  },
): Promise<{ predecessors: string[] }> {
  const at = o.cardOrder.indexOf(o.cardId);
  if (at === -1) throw new Error(`${o.fixture}/${o.cardId} is not on the board`);
  // Independent mode is measurement setup: only in a repository a measured
  // run prepared, which carries the marker — refused before anything changes.
  const marker = readMeasurementMarker(repo);
  if (!marker) {
    throw new Error(
      `${repo} carries no .sekhemet/measurement.json: independent mode marks cards done without running them, so it runs only in a repository a measured run prepared`,
    );
  }
  const predecessors = o.cardOrder.slice(0, at);
  for (const p of predecessors) {
    const dir = join(o.referencesDir, o.fixture, p);
    if (!existsSync(dir)) throw new Error(`no reference solution for ${o.fixture}/${p}`);
  }
  for (const p of predecessors) {
    cpSync(join(o.referencesDir, o.fixture, p), repo, { recursive: true });
    for (const t of o.acceptanceTests?.[p] ?? []) {
      const from = join(repo, "acceptance", t);
      if (!existsSync(from))
        throw new Error(`${o.fixture}/${p}: its acceptance test ${t} is missing`);
      mkdirSync(dirname(join(repo, "tests", t)), { recursive: true });
      copyFileSync(from, join(repo, "tests", t));
    }
  }
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.email=suite@sekhemet.local",
        "-c",
        "user.name=Frozen Suite",
        ...a,
      ],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  if (predecessors.length) {
    git("add", "-A");
    if (git("diff", "--cached", "--name-only"))
      git(
        "commit",
        "-q",
        "-m",
        `independent mode: the reference solutions of ${predecessors.join(", ")}`,
      );
  }
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  try {
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    // Every move goes through the board (kernel rule 26, K-S4-3). Marking a
    // predecessor done without running it is measurement setup, recorded as
    // the harness's, never as a person's override (rule 28): no person
    // decided it. The marker was checked above.
    // No entryConditions: measurement only, bounded by the marker checked above (.sekhemet/measurement.json).
    const board = new BoardServiceImpl(store);
    for (const [i, id] of o.cardOrder.entries()) {
      if (i === at) continue;
      const card = await store.getCard(id);
      if (!card) continue;
      if (i < at) {
        await board.setUpForMeasurement(
          {
            cardId: id,
            toStatus: "done",
            reason: "independent mode: its reference solution is on main",
          },
          marker,
        );
      } else {
        await board.transitionCard({
          cardId: id,
          fromStatus: card.status,
          toStatus: "backlog",
          actor: "harness",
          reason: "independent mode: a later card",
        });
      }
    }
  } finally {
    db.close();
  }
  return { predecessors };
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
/** A model's load time as the queue recorded it, apart from the cards (MS-T7-1). */
export interface ModelLoad {
  modelId: string;
  /** What the server said its loads cost (Ollama): how many, the total, the first. */
  loadMs?: LoadStat;
  /**
   * For a server the harness started: from spawn to its first healthy
   * /health, every start. It falls inside the first card's wall clock too.
   */
  spawnToHealthyMs?: LoadStat;
}

export interface LoadStat {
  count: number;
  totalMs: number;
  firstMs: number;
}

export function readQueueReport(
  repo: string,
): { entries: QueueEntryRecord[]; modelLoads?: ModelLoad[] } | undefined {
  const file = join(repo, ".sekhemet", "queue_report.json");
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as {
      entries?: QueueEntryRecord[];
      modelLoads?: ModelLoad[];
    };
    return {
      entries: Array.isArray(r.entries) ? r.entries : [],
      ...(Array.isArray(r.modelLoads) ? { modelLoads: r.modelLoads } : {}),
    };
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
  runQueue(repo: string, timeoutMs: number): { timedOut: boolean } | Promise<{ timedOut: boolean }>;
  /** The prerequisites the board says a card is still waiting on. */
  waitingOn(repo: string, cardId: string): string[];
  /**
   * Independent mode (MS-T7-3): a fresh repository for one card, its main
   * holding every earlier card's reference solution and only it Ready.
   */
  prepareCard?(
    task: SuiteTask,
  ): { repo: string; cardId: string } | Promise<{ repo: string; cardId: string }>;
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
  opts: { tasks: readonly SuiteTask[]; cardTimeoutMs: number; independent?: boolean },
): ((task: SuiteTask) => Promise<Omit<TaskOutcome, "task">>) & {
  /** Each fixture's model loads, reported apart from the cards' time (MS-T7-1). */
  modelLoads: () => (ModelLoad & { fixture: string })[];
} {
  const log = driver.log ?? (() => {});
  const runs = new Map<
    string,
    { repo: string; timedOut: boolean; timeoutMs: number; report?: { entries: QueueEntryRecord[] } }
  >();
  const loads: (ModelLoad & { fixture: string })[] = [];
  const runTask = async (task: SuiteTask): Promise<Omit<TaskOutcome, "task">> => {
    // Independent mode runs each card alone, in its own repository (MS-T7-3).
    const key = opts.independent ? `${task.suite}/${task.cardId}` : task.suite;
    let run = runs.get(key);
    let independentId: string | undefined;
    if (!run) {
      let repo: string;
      if (opts.independent) {
        if (!driver.prepareCard) throw new Error("independent mode needs the driver's prepareCard");
        const prepared = await driver.prepareCard(task);
        repo = prepared.repo;
        independentId = prepared.cardId;
      } else {
        repo = driver.prepare(task.suite);
      }
      const cards = opts.independent ? 1 : opts.tasks.filter((t) => t.suite === task.suite).length;
      const timeoutMs = cards * opts.cardTimeoutMs;
      log(`  ${task.suite}: sekhemet queue over ${cards} card(s) ...`);
      const { timedOut } = await driver.runQueue(repo, timeoutMs);
      // A timed-out queue leaves the partial report it wrote after its last entry.
      const report = readQueueReport(repo);
      for (const l of report?.modelLoads ?? []) loads.push({ fixture: task.suite, ...l });
      run = { repo, timedOut, timeoutMs, ...(report ? { report } : {}) };
      runs.set(key, run);
    }
    const cardId = independentId ?? driver.resolveCardId(task, run.repo);
    const o = queueCardOutcome(driver, run.repo, cardId, run);
    log(
      `  ${task.suite}/${cardId} ... ${o.blocked ? "BLOCKED" : o.notRun ? "NOT RUN" : o.passed ? "PASS" : "FAIL"} ${o.wallClockSeconds}s${o.stopReason ? ` (${o.stopReason})` : ""}`,
    );
    return o;
  };
  return Object.assign(runTask, { modelLoads: () => [...loads] });
}
