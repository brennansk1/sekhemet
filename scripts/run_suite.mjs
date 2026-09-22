#!/usr/bin/env node
// Run the frozen suite and record its score against its hash.
//
//   node scripts/run_suite.mjs --worker <model> [--fixtures chronicle,onyx] [--out <file>]
//
// Each fixture is copied into a fresh git repository and seeded once; every
// card in it is then run through the real `sekhemet run`, which is the same
// path a user takes. The model stays resident across cards on purpose: a
// reload costs minutes and would dominate the wall-clock the suite reports.
//
// The score is written with the suite's hash. A run whose hash differs from
// another's is not comparable to it, which is the whole point of freezing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadFrozenSuite, runFrozenSuite, summarise } = await import(
  join(ROOT, "packages/eval/dist/index.js")
);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const worker = arg("worker");
if (!worker) {
  console.error("usage: run_suite.mjs --worker <model> [--fixtures a,b] [--out file]");
  process.exit(2);
}
const only = arg("fixtures")?.split(",");
const out = arg("out", join(ROOT, ".sekhemet", "suite-runs", `run-${Date.now()}.json`));
const workDir = arg("work", "/tmp/claude-501/suite");
/** Long enough for the slowest legitimate card seen so far, and no longer. */
const CARD_TIMEOUT_MS = Number(arg("card-timeout-min", "20")) * 60 * 1000;

const suite = loadFrozenSuite(ROOT);
const tasks = only ? suite.tasks.filter((t) => only.includes(t.suite)) : suite.tasks;
console.log(`Frozen suite ${suite.version} ${suite.hash.slice(0, 12)} — ${tasks.length} task(s)`);

const { reachabilityGate } = await import(join(ROOT, "apps/harness/dist/reachability_gate.js"));
const { regressionFailures } = await import(join(ROOT, "apps/harness/dist/regression_gate.js"));
const { architectureGate } = await import(join(ROOT, "apps/harness/dist/architecture_gate.js"));

/**
 * Every project gate must pass an untouched repository. Run 3 was stopped
 * after two cards because a new gate failed every fixture on its empty
 * tests/.gitkeep — a defect this check finds in seconds instead of an hour.
 */
function preflight(fixture, dir) {
  const failures = [
    ...reachabilityGate(dir),
    ...regressionFailures(dir, []),
    ...architectureGate(dir),
  ];
  if (failures.length) {
    console.error(`preflight: a project gate fails untouched ${fixture}; not running the suite.`);
    for (const f of failures) console.error(`  ${f.gate}: ${f.errorExcerpt}`);
    process.exit(3);
  }
}

/** One prepared repository per fixture, seeded once and reused by its cards. */
const repos = new Map();
function repoFor(fixture) {
  const existing = repos.get(fixture);
  if (existing) return existing;
  const dir = join(workDir, fixture);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("cp", ["-R", `${join(ROOT, "fixtures", fixture)}/.`, dir]);
  execFileSync("ln", ["-s", join(ROOT, "node_modules"), join(dir, "node_modules")]);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "suite@sekhemet.local");
  git("config", "user.name", "Frozen Suite");
  git("add", "-A");
  git("commit", "-q", "-m", `seed: ${fixture}`);
  const seeder = existsSync(join(ROOT, "fixtures", fixture, "cards.json"))
    ? ["scripts/seed_project.mjs", join(ROOT, "fixtures", fixture), dir]
    : ["scripts/seed_chronicle.mjs", dir];
  execFileSync("node", [join(ROOT, seeder[0]), ...seeder.slice(1)], { stdio: "ignore" });
  preflight(fixture, dir);
  repos.set(fixture, dir);
  return dir;
}

/**
 * The card ids a fixture actually seeded, in board order.
 *
 * A fixture with `cards.json` declares its ids; one seeded by a script does
 * not, and the manifest can only declare how many. Guessing the ids made
 * every task fail in zero seconds with no evidence bundle — a plumbing
 * failure that reads exactly like a catastrophic score, so the count is
 * checked against the manifest rather than trusted.
 */
const idsByFixture = new Map();
const cardInfo = new Map();
function cardIdsFor(fixture, expected) {
  const cached = idsByFixture.get(fixture);
  if (cached) return cached;
  const db = new DatabaseSync(join(repoFor(fixture), ".sekhemet", "events.db"), { readOnly: true });
  const rows = db
    .prepare("select id, scope_files, acceptance_tests from cards order by order_key, id")
    .all();
  db.close();
  const ids = rows.map((r) => String(r.id));
  for (const r of rows) {
    cardInfo.set(String(r.id), {
      scope: JSON.parse(String(r.scope_files ?? "[]")),
      tests: JSON.parse(String(r.acceptance_tests ?? "[]")),
    });
  }
  if (ids.length !== expected) {
    throw new Error(
      `frozen suite: ${fixture} seeded ${ids.length} card(s), manifest declares ${expected}`,
    );
  }
  idsByFixture.set(fixture, ids);
  return ids;
}

/**
 * The modules a card's acceptance test needs from *other* cards that are
 * still empty on main — its unmet dependencies.
 *
 * The first two runs of this suite never accepted a passing card, so every
 * card that builds on another's work ran against the empty seed file: the
 * model read types.ts for a type that could not be there, read it again, and
 * was stopped for repeating itself. A card whose dependency was never built
 * cannot pass, and running it measures nothing but that.
 */
function unmetDependencies(repo, cardId) {
  const info = cardInfo.get(cardId);
  if (!info) return [];
  const own = new Set(info.scope.map((f) => f.replace(/\.[cm]?tsx?$/, "")));
  const needed = new Set();
  for (const t of info.tests) {
    const spec = join(repo, "acceptance", t);
    if (!existsSync(spec)) continue;
    for (const m of readFileSync(spec, "utf8").matchAll(
      /from\s+["']\.\.\/(src\/[\w/.-]+?)(?:\.[cm]?js)?["']/g,
    )) {
      if (m[1] && !own.has(m[1])) needed.add(m[1]);
    }
  }
  return [...needed].filter((mod) => {
    const file = [".ts", ".tsx", "/index.ts"].map((e) => join(repo, `${mod}${e}`)).find(existsSync);
    return !file || readFileSync(file, "utf8").trim() === "";
  });
}

/** The evidence bundle is the record of what happened; read it, do not infer. */
function outcomeFrom(repo, cardId, seconds, why) {
  const file = join(repo, ".sekhemet", "evidence", `latest-${cardId}.json`);
  if (!existsSync(file)) {
    // "No bundle" covers two different failures and they must not share a
    // label: a card killed by this runner's timeout was working when it died,
    // while a card that never started is a plumbing fault — which is how the
    // first attempt at this suite scored 0/6 in zero seconds.
    return {
      passed: false,
      stopReason: why ?? "card did not start (no evidence bundle)",
      wallClockSeconds: seconds,
      tokens: 0,
      rungs: 0,
    };
  }
  const e = JSON.parse(readFileSync(file, "utf8"));
  return {
    passed: e.passed === true,
    ...(e.stopReason ? { stopReason: String(e.stopReason) } : {}),
    wallClockSeconds: seconds,
    tokens: Number(e.tokens?.promptTokens ?? 0) + Number(e.tokens?.completionTokens ?? 0),
    // Attempts beyond the first are repair rungs spent.
    rungs: Math.max(0, Number(e.attempt ?? 1) - 1),
  };
}

const started = Date.now();
const perFixture = new Map();
for (const t of tasks) perFixture.set(t.suite, (perFixture.get(t.suite) ?? 0) + 1);

const result = await runFrozenSuite({ ...suite, tasks }, async (task) => {
  const repo = repoFor(task.suite);
  // Declared ids are used as given; synthesised ones are resolved from the
  // board the seeder actually wrote.
  const cardId = task.cardId.startsWith(`${task.suite}_`)
    ? (cardIdsFor(task.suite, perFixture.get(task.suite))[
        Number(task.cardId.slice(task.suite.length + 1)) - 1
      ] ?? task.cardId)
    : task.cardId;
  const blocked = unmetDependencies(repo, cardId);
  if (blocked.length) {
    const why = `blocked: ${blocked.join(", ")} never built (an earlier card failed)`;
    console.log(`  ${task.suite}/${cardId} ... FAIL 0s (${why})`);
    return { passed: false, stopReason: why, wallClockSeconds: 0, tokens: 0, rungs: 0 };
  }
  const t0 = Date.now();
  let timedOut;
  process.stdout.write(`  ${task.suite}/${cardId} ... `);
  try {
    execFileSync(
      "node",
      [
        join(ROOT, "apps/harness/dist/index.js"),
        "run",
        cardId,
        "--repo",
        repo,
        "--worker",
        `ollama/${worker}`,
      ],
      { stdio: "ignore", timeout: CARD_TIMEOUT_MS },
    );
  } catch (err) {
    // A non-zero exit is a failed card, not a failed run: the evidence
    // bundle below is what decides, and stopping here would lose the rest.
    if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") {
      timedOut = `timed out after ${Math.round(CARD_TIMEOUT_MS / 60000)} min`;
    }
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const o = outcomeFrom(repo, cardId, seconds, timedOut);
  // A passing card is accepted — squash-merged to main — so the cards after
  // it build on its work, as they would in a real project. Measuring each
  // card against the empty seed measured nothing about building projects.
  if (o.passed) {
    try {
      execFileSync(
        "node",
        [join(ROOT, "apps/harness/dist/index.js"), "accept", cardId, "--repo", repo],
        { stdio: "ignore", timeout: 5 * 60 * 1000 },
      );
    } catch {
      o.stopReason = "passed, but accept failed: later cards cannot build on it";
    }
  }
  console.log(
    `${o.passed ? "PASS" : "FAIL"} ${seconds}s${o.stopReason ? ` (${o.stopReason})` : ""}`,
  );
  return o;
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ ...result, worker, tasksRun: tasks.length }, null, 2)}\n`);
console.log(`\n${summarise(result)}`);
console.log(`wall clock ${Math.round((Date.now() - started) / 60000)} min · recorded in ${out}`);
for (const o of result.outcomes.filter((x) => !x.passed)) {
  console.log(`  FAIL ${o.task.suite}/${o.task.cardId}: ${o.stopReason ?? "gates did not pass"}`);
}
