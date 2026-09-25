#!/usr/bin/env node
// Run the frozen suite and record its score against its hash.
//
//   node scripts/run_suite.mjs --worker <model> [--fixtures chronicle,onyx] [--out <file>]
//                              [--settings <file>] [--ab-entry <file>] [--independent]
//
// Each fixture is copied into a fresh git repository and seeded once, and the
// product's own `sekhemet queue` then runs all of its cards with the roles and
// policies the product ships (measurement rule 9, MS-M9-1, MS-M9-4), with
// `--auto-accept` standing in for the person who accepts each card, so later
// cards build on earlier ones. Arms are named only through the RunProfile.
// The model stays resident across cards: a reload costs minutes and would
// dominate the wall-clock the suite reports.
//
// The score is written with the suite's hash. A run whose hash differs from
// another's is not comparable to it, which is the whole point of freezing.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  loadAssetManifest,
  loadFrozenSuite,
  queueInvocation,
  resolveRunProfile,
  runFrozenSuite,
  runProfileHash,
  prepareIndependentCard,
  scoreCardProfiles,
  seededCards,
  suiteQueueRunner,
  summarise,
} = await import(join(ROOT, "packages/eval/dist/index.js"));

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
/**
 * The queue's roster names a harness-managed model (served by its own
 * llama-server, e.g. cyber-tiel with its MTP head) as is and anything else
 * by its Ollama tag, without the `ollama/` prefix `sekhemet run` took.
 */
const workerName = worker.replace(/^ollama\//, "");
/**
 * Refuse the whole run up front when the Worker is not qualified for its
 * combination on this host (models MD-N8-1): every card would be refused,
 * and the run would record only failures that say nothing about the Worker.
 */
function requireQualified(name) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "apps/harness/dist/index.js"), "qualify", "--check", "--json", "--models", name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  let row;
  try {
    row = JSON.parse(r.stdout ?? "")[0];
  } catch {
    row = undefined;
  }
  if (r.status !== 0 || !row?.runnable) {
    console.error(`${row?.reason ?? (r.stdout || r.stderr || "").trim()}\nNo card was run.`);
    process.exit(1);
  }
  // Models rule 27, MD-N4-4: a Worker running under a person's override says
  // so, in the same WorkerOverride shape the evidence and card/repro carry.
  if (row.workerOverride) console.log(`Worker ${name}: ${row.reason} (failed: ${row.failure})`);
  return row.workerOverride;
}
const checkedOverride = requireQualified(worker);

const out = arg("out", join(ROOT, ".sekhemet", "suite-runs", `run-${Date.now()}.json`));
// The run's repositories hold each step's recorded prompt (kernel rule 17),
// which the MTP A/B and the step-replay screen replay: keep them off /tmp,
// which the OS clears.
const workDir = arg("work", join(ROOT, ".sekhemet", "suite-work"));
/** Long enough for the slowest legitimate card seen so far, and no longer. */
const CARD_TIMEOUT_MS = Number(arg("card-timeout-min", "20")) * 60 * 1000;

/**
 * One recorded RunProfile for the whole run (measurement rule 9a): the
 * shipped defaults, a settings file naming an arm, the experiment switches,
 * the Worker, and acceptance in place of the person. The queue receives it
 * as one flag per setting and the switches as environment variables, and
 * records the profile it resolved in every attempt's evidence, which is
 * checked against this one after the run.
 */
const settings = arg("settings");
const runProfile = resolveRunProfile({
  ...(settings ? { settingsFile: { path: settings, text: readFileSync(settings, "utf8") } } : {}),
  env: process.env,
  argv: ["--worker", workerName, "--auto-accept"],
  envRoles: true,
});

/**
 * An A/B's entry (measurement rule 16c): its one cost measure, written
 * before the first card. The run records the entry's hash, so the result
 * itself shows the entry existed before the run started (review M2).
 */
const abEntryPath = arg("ab-entry");
let abEntry;
if (abEntryPath) {
  const text = readFileSync(abEntryPath, "utf8");
  const entry = JSON.parse(text);
  const at = Date.parse(entry.recordedAt ?? "");
  if (entry.costMeasure !== "median tokens per card" || Number.isNaN(at) || at > Date.now()) {
    console.error(
      `--ab-entry ${abEntryPath}: the entry names "median tokens per card" and an ISO recordedAt no later than now (rule 16c). No card was run.`,
    );
    process.exit(2);
  }
  abEntry = {
    sha256: createHash("sha256").update(text).digest("hex"),
    costMeasure: entry.costMeasure,
    recordedAt: entry.recordedAt,
  };
}

const suite = loadFrozenSuite(ROOT);
const tasks = only ? suite.tasks.filter((t) => only.includes(t.suite)) : suite.tasks;
console.log(`Frozen suite ${suite.version} ${suite.hash.slice(0, 12)} — ${tasks.length} task(s)`);

const { reachabilityGate } = await import(join(ROOT, "apps/harness/dist/reachability_gate.js"));
const { regressionFailures } = await import(join(ROOT, "apps/harness/dist/regression_gate.js"));
const { architectureGate } = await import(join(ROOT, "apps/harness/dist/architecture_gate.js"));
const { expectedQueueProfile } = await import(join(ROOT, "apps/harness/dist/rescore.js"));
const { appliedStepBudget } = await import(join(ROOT, "apps/harness/dist/wave2.js"));

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
/** Each prepared repository's expected card profile. */
const expectedByRepo = new Map();
function repoFor(fixture) {
  const existing = repos.get(fixture);
  if (existing) return existing;
  const dir = prepareRepo(fixture, join(workDir, fixture));
  repos.set(fixture, dir);
  return dir;
}

/** A fresh copy of a fixture, committed, seeded, preflighted and marked for measurement. */
function prepareRepo(fixture, dir) {
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
  // The profile this repository's queue should resolve, fixed before any
  // card runs: the run's settings plus the repository's configuration layer
  // (the default step budget), resolved as the queue resolves it. A budget
  // tuned during the run is then a divergence, and named (SUITE_RUNS, ref-r1).
  expectedByRepo.set(dir, expectedQueueProfile(dir, runProfile, appliedStepBudget(dir)));
  // The mark that lets this copy's queue take --auto-accept (review M5): a
  // fixture copy made for measurement, not a person's repository.
  writeFileSync(
    join(dir, ".sekhemet", "measurement.json"),
    `${JSON.stringify({ purpose: "frozen suite", by: "scripts/run_suite.mjs", createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  // Kept out of the fixture's history like the rest of the harness's state.
  appendFileSync(join(dir, ".git", "info", "exclude"), "\n.sekhemet/measurement.json\n");
  return dir;
}

/**
 * Independent mode (MS-T7-3, `--independent`): each card runs alone, in its
 * own copy of its fixture, from a main that holds every earlier card's
 * registered reference solution, so its result depends on no earlier card's
 * outcome. It needs the registered, verified set (MS-T7-2).
 */
const independent = process.argv.includes("--independent");
if (independent && !suite.referenceSolutions) {
  console.error(
    "--independent needs the registered reference solutions (fixtures/eval_assets.json). No card was run.",
  );
  process.exit(2);
}
/** Independent repositories: repo -> the fixture and its board. */
const cardRepos = new Map();
async function prepareCard(task) {
  const dir = prepareRepo(task.suite, join(workDir, `${task.suite}__${task.cardId}`));
  const cards = seededCards(dir, perFixture.get(task.suite));
  const cardId = task.cardId.startsWith(`${task.suite}_`)
    ? (cards[Number(task.cardId.slice(task.suite.length + 1)) - 1]?.id ?? task.cardId)
    : task.cardId;
  await prepareIndependentCard(dir, {
    fixture: task.suite,
    cardId,
    cardOrder: cards.map((c) => c.id),
    // Review M2: earlier cards' acceptance tests are on main, as acceptance leaves them.
    acceptanceTests: Object.fromEntries(cards.map((c) => [c.id, c.info.tests])),
    // The registered asset's own path (review minor 9).
    referencesDir: join(
      ROOT,
      loadAssetManifest(ROOT).assets.find((a) => a.name === "reference-solutions").path,
    ),
  });
  cardRepos.set(dir, cards);
  return { repo: dir, cardId };
}

/**
 * The card ids and board facts each fixture actually seeded, in board order.
 * The count is checked against the manifest inside `seededCards`.
 */
const seeded = new Map();
function cardsFor(fixture, expected) {
  if (!seeded.has(fixture)) seeded.set(fixture, seededCards(repoFor(fixture), expected));
  return seeded.get(fixture);
}

const started = Date.now();
const perFixture = new Map();
for (const t of tasks) perFixture.set(t.suite, (perFixture.get(t.suite) ?? 0) + 1);

/**
 * The processes the runner module needs (MS-M9-3). Every decision that shapes
 * the score — blocking, timeout attribution, token totals, acceptance — is
 * made in packages/eval/src/suite_runner.ts, behind tests; this script only
 * prepares the repositories and starts the product's `sekhemet queue` on each.
 */
const driver = {
  prepare: repoFor,
  // Declared ids are used as given; synthesised ones are resolved from the
  // board the seeder actually wrote.
  resolveCardId: (task) => {
    if (!task.cardId.startsWith(`${task.suite}_`)) return task.cardId;
    const n = Number(task.cardId.slice(task.suite.length + 1)) - 1;
    return cardsFor(task.suite, perFixture.get(task.suite))[n]?.id ?? task.cardId;
  },
  // Read from the board for declared ids too: the old script loaded board
  // facts only for synthesised ids, so a fixture with cards.json never had a
  // card blocked on an unbuilt dependency.
  cardInfo: (repo, cardId) => {
    const own = cardRepos.get(repo);
    if (own) return own.find((c) => c.id === cardId)?.info;
    const fixture = [...repos].find(([, dir]) => dir === repo)?.[0];
    if (!fixture) return undefined;
    return cardsFor(fixture, perFixture.get(fixture)).find((c) => c.id === cardId)?.info;
  },
  runQueue: (repo, timeoutMs) => {
    // Resolve the card ids before the queue moves the board.
    const fixture = [...repos].find(([, dir]) => dir === repo)?.[0];
    if (fixture) cardsFor(fixture, perFixture.get(fixture));
    // The one invocation every measured path uses (MS-M9-1).
    const { args, env } = queueInvocation(runProfile, repo);
    try {
      execFileSync("node", [join(ROOT, "apps/harness/dist/index.js"), ...args], {
        stdio: "inherit",
        timeout: timeoutMs,
        env: { ...process.env, ...env },
      });
    } catch (err) {
      // A non-zero exit is a run with failures, not a failed run: the report decides.
      if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM") return { timedOut: true };
    }
    return { timedOut: false };
  },
  waitingOn: (repo, cardId) => {
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT d.depends_on_card_id AS d FROM card_dependencies d
           JOIN cards c ON c.id = d.depends_on_card_id
           WHERE d.card_id = ? AND c.status != 'done' ORDER BY d.depends_on_card_id`,
        )
        .all(cardId)
        .map((r) => String(r.d));
    } finally {
      db.close();
    }
  },
  log: (line) => console.log(line),
};

const runner = suiteQueueRunner(
  { ...driver, prepareCard },
  { tasks, cardTimeoutMs: CARD_TIMEOUT_MS, independent },
);
const result = await runFrozenSuite({ ...suite, tasks }, runner);
// MS-T7-1: the model's load time, reported apart from the cards' wall clock.
result.modelLoads = runner.modelLoads();

/**
 * The profile each card actually ran with, from its evidence, against the one
 * its repository's queue was expected to resolve: the run's settings plus that
 * repository's configuration layer. Comparing against the run's profile alone
 * named every card (ref-r1: the config's step budget of 40 against the run's
 * null), so admission refused every run. A card that differs (a tuned budget,
 * a different switch) is still named, never silently pooled; each card's
 * profile is kept for admission to compare across arms.
 */
const scoredCards = [];
/** The person's override each card's Worker ran under, from its card/repro (MD-N4-4). */
const overrides = new Map();
for (const [fixture, repo] of repos) {
  for (const { id } of cardsFor(fixture, perFixture.get(fixture))) {
    const file = join(repo, ".sekhemet", "evidence", `latest-${id}.json`);
    if (!existsSync(file)) continue;
    const repro = JSON.parse(readFileSync(file, "utf8")).reproducibility;
    if (repro?.workerOverride)
      overrides.set(JSON.stringify(repro.workerOverride), repro.workerOverride);
    scoredCards.push({
      card: `${fixture}/${id}`,
      expected: expectedByRepo.get(repo),
      recorded: repro?.runProfile,
    });
  }
}
const { profileMismatch: mismatched, differences, cardProfiles } = scoreCardProfiles(scoredCards);
if (mismatched.length) {
  console.log(
    `WARNING: ${mismatched.length} card(s) ran with a different profile: ${mismatched.map((c) => `${c} (${differences[c].join(", ")})`).join(", ")}`,
  );
}

/**
 * Every measurement made under a person's override says so (models rule 27,
 * MD-N4-4): the override the cards' evidence recorded, else the one the
 * qualification check reported, in the same shape.
 */
function workerOverrideField() {
  const recorded = [...overrides.values()];
  if (recorded.length === 1) return { workerOverride: recorded[0] };
  if (recorded.length > 1) return { workerOverride: recorded[0], workerOverrides: recorded };
  return checkedOverride ? { workerOverride: checkedOverride } : {};
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ ...result, worker, tasksRun: tasks.length, runProfile: { ...runProfile, hash: runProfileHash(runProfile) }, mode: independent ? "independent" : "sequential", ...(abEntry ? { abEntry } : {}), ...(mismatched.length ? { profileMismatch: mismatched } : {}), cardProfiles, ...workerOverrideField() }, null, 2)}\n`,
);
console.log(`\n${summarise(result)}`);
/**
 * Every adopted harness change is watched after every run (measurement rule
 * 18, MS-T8-3): paired against the runs it was admitted over, and rolled
 * back, flagged, when this run resolves a loss. The harness's own ledger
 * holds the admissions.
 */
try {
  execFileSync(
    "node",
    [
      join(ROOT, "apps/harness/dist/index.js"),
      "measure",
      "watch-adopted",
      "--repo",
      ROOT,
      "--with",
      out,
    ],
    { stdio: "inherit" },
  );
} catch {
  console.log(
    "watch-adopted did not run; run it with: sekhemet measure watch-adopted --with <run>",
  );
}
console.log(`wall clock ${Math.round((Date.now() - started) / 60000)} min · recorded in ${out}`);
for (const o of result.outcomes.filter((x) => !x.passed)) {
  console.log(`  FAIL ${o.task.suite}/${o.task.cardId}: ${o.stopReason ?? "gates did not pass"}`);
}
