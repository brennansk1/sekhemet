/**
 * The capstone's scorer (W2 G5; CAPSTONE_SELECTION "Protocol").
 *
 * It scores one finished run: the hidden suite (from its sealed directory,
 * checked against `hidden.manifest.json` first) on the tree at its
 * `release-1` tag and on its final tree; regressions after the change;
 * wall-clock, the person's hands-on minutes and tokens from the run's log;
 * the mutation score (NOT RUN until Stryker is added); type, lint, security
 * and accessibility findings; the releases tagged. And it makes the blind
 * packet: each run's code under a random name, with every word that names an
 * arm, a harness or a model replaced.
 *
 * **What it writes where.** The hidden suite's own results name its tests, so
 * they stay in the sealed directory (`results/scored/<arm>/<run>/`). The
 * run's `score.json` (in the run's directory, and in the showcase when
 * published) holds counts only: no test name, no expectation. Every scratch
 * copy (the tree at `release-1`, the suite's own install, build and
 * catalogue) is made in the sealed scratch root beside the suite
 * (`<hidden>-scratch`, mode 700), never in the shared temp directory, and the
 * suite is checked against its manifest again after
 * scoring, so a contestant's app that touched it is caught.
 *
 * **What it pools.** Only runs whose log shows the frozen input was given
 * whole and the run finished (`runValidity`) enter the statistics, and two
 * arms are compared over the same number of runs. Nothing is published until
 * the suite is registered in `fixtures/eval_assets.json` with a person's
 * labels (measurement.md rule 29; K2).
 *
 *   node scripts/capstone/score.mjs run --arm <id> --run <n> [--publish]
 *   node scripts/capstone/score.mjs stats [--phase change-request]
 *   node scripts/capstone/score.mjs packet --out <dir> --key <file> [--arm <id> --run <n>]...
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARMS,
  HIDDEN_MANIFEST,
  REPO_ROOT,
  TIMESHEET_DIR,
  arm as armOf,
  frozenManifest,
  hiddenDir,
  identityPattern,
  readLog,
  readRecord,
  runPaths,
  sha256,
} from "./grid.mjs";
import { treeFiles } from "./reply.mjs";
import { withVault } from "./vault.mjs";

export const SHOWCASE = join(REPO_ROOT, "docs", "showcase", "capstone");
const built = (rel) => import(pathToFileURL(join(REPO_ROOT, rel)).href);

// --- the hidden suite -----------------------------------------------------------------

const SUITE_SKIP_DIRS = new Set(["node_modules", "dist", "data", "results", ".git"]);

/** The hidden suite's files and one hash over them, computed the way its manifest records them. */
export function suiteHashes(root) {
  const files = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SUITE_SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile() && e.name !== ".DS_Store") {
        files[relative(root, join(dir, e.name)).split(sep).join("/")] = sha256(
          readFileSync(join(dir, e.name)),
        );
      }
    }
  };
  walk(root);
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const all = sha256(
    Object.entries(sorted)
      .map(([f, h]) => `${h}  ${f}\n`)
      .join(""),
  );
  return { files: sorted, all };
}

/** Every way the sealed suite differs from `hidden.manifest.json`; empty when it is the frozen one. */
export function suiteDrift(hidden, manifestFile = HIDDEN_MANIFEST) {
  if (!existsSync(join(hidden, "run.mjs"))) return [`no hidden suite at ${hidden}`];
  const frozen = JSON.parse(readFileSync(manifestFile, "utf8"));
  const now = suiteHashes(hidden);
  const drift = [];
  if (frozen.suiteSha256 !== now.all)
    drift.push(`the suite's hash is ${now.all}, not the frozen ${frozen.suiteSha256}`);
  for (const f of new Set([...Object.keys(frozen.files), ...Object.keys(now.files)])) {
    if (frozen.files[f] !== now.files[f]) drift.push(`${f} differs from the manifest`);
  }
  return drift;
}

/**
 * A fresh scratch directory in the sealed scratch root (beside the hidden
 * suite's directory, on its volume, mode 700), for anything that copies
 * sealed or scored trees: never the shared temp directory a contestant could
 * read. Not inside the suite's own directory, whose runner refuses a tree
 * there.
 */
export function sealedScratch(hidden, prefix = "scratch-") {
  const root = `${resolve(hidden)}-scratch`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, prefix));
}

/**
 * One phase of the hidden suite on one tree, through the suite's own runner.
 * Its full result (with test names) is written only to `out`, in the sealed
 * directory; this returns it for the caller to count. The suite and the app it
 * starts get a scratch HOME and TMPDIR inside the sealed directory.
 */
export function hiddenPhase({ hidden, app, phase, out, release1Version, scratch }) {
  mkdirSync(dirname(out), { recursive: true });
  const own = scratch ?? sealedScratch(hidden, "phase-");
  const home = join(own, `home-${phase}`);
  const tmp = join(own, `tmp-${phase}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const args = [join(hidden, "run.mjs"), "--app", app, "--phase", phase, "--out", out];
  if (release1Version !== undefined) args.push("--release1-version", release1Version);
  const r = spawnSync(process.execPath, args, {
    cwd: hidden,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmp,
      npm_config_cache: join(process.env.HOME ?? "", ".npm"),
    },
  });
  if (!scratch) rmSync(own, { recursive: true, force: true });
  if (r.status !== 0 || !existsSync(out)) {
    writeFileSync(`${out}.error.txt`, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    throw new Error(
      `the hidden suite's runner failed on the ${phase} phase (exit ${r.status}); its output is in the sealed results`,
    );
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/** A result's counts, with nothing that names a test. */
export function counts(result) {
  return {
    phase: result.phase,
    passed: result.passed,
    total: result.total,
    passRate: result.passRate,
    byPriority: result.byPriority,
    byRelease: result.byRelease,
    notScored: result.notScored.length,
    install: result.install.ok,
    build: result.build.ok,
    suiteSha256: result.suite.sha256,
  };
}

/** Release-1 tests that passed on the release-1 tree and fail after the change. */
export function regressions(releaseOne, afterChange) {
  const after = new Map(afterChange.tests.map((t) => [t.name, t]));
  let count = 0;
  const byPriority = {};
  let comparable = 0;
  for (const t of releaseOne.tests) {
    const a = after.get(t.name);
    if (!a || t.release !== "release 1") continue;
    comparable += 1;
    if (t.status === "pass" && a.status !== "pass") {
      count += 1;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
  }
  return { count, byPriority, comparable };
}

// --- git and the tree -------------------------------------------------------------------

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
  });
}

/** The tree at a tag, exported (no `.git`) into a fresh directory; null when the tag does not exist. */
export function exportTag(repo, tag, dest) {
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]).status !== 0) return null;
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", tag], {
    maxBuffer: 512 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (archive.status !== 0) throw new Error(`git archive ${tag} failed`);
  const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`could not unpack ${tag}`);
  return dest;
}

/** The releases the contestant tagged (the protocol's own `seed` and `release-1` tags are not theirs). */
export function releasesTagged(repo) {
  const r = git(repo, ["tag", "--list"]);
  const tags = r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  const theirs = tags.filter((t) => t !== "seed" && t !== "release-1").sort();
  const version = (ref) => {
    const s = git(repo, ["show", `${ref}:package.json`]);
    if (s.status !== 0) return null;
    try {
      return JSON.parse(s.stdout).version ?? null;
    } catch {
      return null;
    }
  };
  return {
    count: theirs.length,
    tags: theirs,
    versionAtReleaseOne: version("release-1"),
    versionAtEnd: version("HEAD"),
  };
}

/** Copy a tree without `.git`, installed packages, build output or data. */
function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (rel === "") return true;
      const parts = rel.split(sep);
      if (parts.includes(".git") || parts.includes("node_modules")) return false;
      return !(parts.length === 1 && (parts[0] === "dist" || parts[0] === "data"));
    },
  });
}

function run(cmd, args, cwd, timeout = 10 * 60_000, home = cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: join(home, ".tmp"),
      npm_config_cache: join(process.env.HOME ?? "", ".npm"),
    },
  });
  return { ok: r.status === 0, exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// --- findings ---------------------------------------------------------------------------

const NEUTRAL_BIOME = {
  formatter: { enabled: false },
  organizeImports: { enabled: false },
  linter: { enabled: true, rules: { recommended: true } },
};

/** Hygiene findings that hold every arm to the same rule: debug output left in the code. */
export function neutralHygiene(failures) {
  return failures.filter(
    (f) => f.gate === "hygiene" && !f.notRun && /leaves debug output/.test(f.errorExcerpt ?? ""),
  );
}

/**
 * Type, lint and security findings on a run's final tree, the same way for
 * every arm, plus Sekhemet's own gates for the project: always its npm
 * template, never a `gates.toml` the contestant wrote, so every arm is
 * checked by the same set. Each is a count, or NOT RUN with the reason. The
 * copy and every command's HOME sit under `scratchRoot`.
 */
export async function findings(repo, { scratchRoot = tmpdir() } = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "findings-"));
  const copy = join(scratch, "copy");
  const home = join(scratch, "home");
  mkdirSync(join(home, ".tmp"), { recursive: true });
  const out = {};
  try {
    copyTree(repo, copy);
    const install = existsSync(join(copy, "package.json"))
      ? run(
          "npm",
          [
            existsSync(join(copy, "package-lock.json")) ? "ci" : "install",
            "--no-audit",
            "--no-fund",
            "--prefer-offline",
            "--ignore-scripts",
          ],
          copy,
          15 * 60_000,
          home,
        )
      : { ok: false, out: "no package.json" };
    const tsc = join(copy, "node_modules", ".bin", "tsc");
    if (install.ok && existsSync(tsc) && existsSync(join(copy, "tsconfig.json"))) {
      const t = run(tsc, ["--noEmit", "-p", "tsconfig.json"], copy, 10 * 60_000, home);
      out.type = {
        errors: (t.out.match(/error TS\d+/g) ?? []).length,
        tool: "tsc --noEmit, the tree's own TypeScript",
      };
    } else
      out.type = {
        notRun: install.ok ? "no TypeScript or tsconfig.json in the tree" : "the install failed",
      };

    const biome = join(REPO_ROOT, "node_modules", ".bin", "biome");
    const cfgDir = join(scratch, "biome");
    mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, "biome.json"), JSON.stringify(NEUTRAL_BIOME));
    if (existsSync(biome)) {
      const target = existsSync(join(copy, "src")) ? join(copy, "src") : copy;
      const l = spawnSync(
        biome,
        ["lint", `--config-path=${cfgDir}`, "--reporter=json", "--max-diagnostics=none", target],
        { cwd: scratch, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
      let report = null;
      try {
        report = JSON.parse(l.stdout.slice(l.stdout.indexOf("{")));
      } catch {
        report = null;
      }
      if (report?.summary) {
        const byRule = {};
        for (const d of report.diagnostics ?? [])
          byRule[d.category] = (byRule[d.category] ?? 0) + 1;
        out.lint = {
          errors: report.summary.errors,
          warnings: report.summary.warnings,
          filesChecked: (report.summary.changed ?? 0) + (report.summary.unchanged ?? 0),
          byRule,
          tool: "Biome 1.9 lint, recommended rules, the same configuration for every arm",
        };
      } else out.lint = { notRun: `Biome gave no report: ${(l.stderr ?? "").slice(0, 200)}` };
    } else out.lint = { notRun: "Biome is not installed in this checkout" };

    const gates = await built("packages/gates/dist/index.js");
    const clone = join(scratch, "clone");
    const cl = git(scratch, ["clone", "--quiet", "--no-hardlinks", repo, clone]);
    if (cl.status === 0) {
      const diff = git(clone, ["diff", "seed", "HEAD"]);
      const project = { ...gates.DEFAULT_PROJECT_CONFIG, changelog: false };
      const template = gates.gateTemplate(copy, "npm") ?? [];
      const b = await gates.runBuiltinGates({
        root: clone,
        base: "seed",
        diff: diff.status === 0 ? diff.stdout : undefined,
        project,
        gates: ["secrets", "dependencies", "osv", "semgrep", "hygiene"],
      });
      const byGate = {};
      for (const f of b.failures)
        if (!f.notRun && f.gate !== "hygiene") byGate[f.gate] = (byGate[f.gate] ?? 0) + 1;
      out.hygiene = {
        findings: neutralHygiene(b.failures).length,
        tool: "Sekhemet's hygiene check, debug output only (at most 5), on the diff from the seed; its changelog and commit-trailer rules are Sekhemet's own process and are not counted",
      };
      const notRun = [
        ...b.failures.filter((f) => f.notRun).map((f) => f.gate),
        ...b.outcomes.filter((o) => o.skipped).map((o) => o.gate),
      ];
      const security = ["secrets", "dependencies", "osv", "semgrep"].reduce(
        (n, g) => n + (byGate[g] ?? 0),
        0,
      );
      out.security = {
        findings: security,
        byGate,
        notRun,
        tool: "Sekhemet's built-in checks on the diff from the seed (secrets, dependencies, osv-scanner and semgrep when installed)",
      };
      out.sekhemetGates = [];
      if (install.ok) {
        for (const g of template) {
          const r = run(g.command, g.args, copy, g.timeoutMs ?? 300_000, home);
          out.sekhemetGates.push({ id: g.id, passed: r.ok });
        }
      }
    } else out.security = { notRun: "the run's repository could not be cloned" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

/** Accessibility findings from the screenshots run, or NOT RUN. */
export function accessibility(armId, runNo, showcase = SHOWCASE) {
  const file = join(showcase, armId, String(runNo), "views.json");
  if (!existsSync(file))
    return { notRun: "no screenshots run for this run (scripts/capstone/screenshots.mjs)" };
  const views = JSON.parse(readFileSync(file, "utf8"));
  if (!views.started) return { notRun: "the app did not start" };
  const all = views.views.flatMap((v) => v.a11y ?? []);
  const byRule = {};
  for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    findings: all.length,
    byRule,
    tool: "the visual gate's WCAG subset (A11Y_SCRIPT), on the fixed views",
  };
}

// --- time and tokens --------------------------------------------------------------------

/**
 * Wall-clock, hands-on minutes and tokens, from the run's log. When a
 * `usage` event says some of the arm's models are not counted (`notCounted`:
 * the Sekhemet arm's ledger holds the Coding model's tokens only), the count
 * is kept but marked with that reason, and no page compares it across arms.
 */
export function effort(log) {
  const start = log.find((e) => e.kind === "start");
  const end = [...log].reverse().find((e) => e.kind === "end");
  const person = log.filter((e) => e.kind === "person");
  const usage = log.filter((e) => e.kind === "usage");
  const sum = (k) => usage.reduce((n, u) => n + (typeof u[k] === "number" ? u[k] : 0), 0);
  const costs = usage.filter((u) => typeof u.costUsd === "number");
  return {
    wallClockMinutes:
      start && end
        ? Math.round(((Date.parse(end.at) - Date.parse(start.at)) / 60_000) * 10) / 10
        : null,
    handsOnMinutes: person.filter((p) => !p.simulated).reduce((n, p) => n + (p.minutes ?? 0), 0),
    simulatedDecisions: person.filter((p) => p.simulated).length,
    inputTokens: usage.length ? sum("inputTokens") : null,
    outputTokens: usage.length ? sum("outputTokens") : null,
    costUsd: costs.length ? Math.round(costs.reduce((n, u) => n + u.costUsd, 0) * 100) / 100 : null,
    unparsedFiles: log
      .filter((e) => e.kind === "reply")
      .reduce((n, e) => n + (e.unparsedCount ?? 0), 0),
    tokensNotCounted: tokensNotCounted(usage),
  };
}

/** Why a run's token count leaves some of its models out, or null when it counts them all. */
export function tokensNotCounted(usage) {
  const why = [...new Set(usage.map((u) => u.notCounted).filter(Boolean))];
  return why.length ? why.join("; ") : null;
}

// --- one run ----------------------------------------------------------------------------

/**
 * Why a run may not enter the statistics, from its log: empty when the
 * frozen input was given whole and the run finished. Checked: a start and an
 * end; `prompt.md` given at its frozen hash; `change_request.md` given at
 * its; release 1 finished before it (an agentic arm) or both replies landed
 * (one shot); and no `stopped` event.
 */
export function runValidity(log, armId, fixture = TIMESHEET_DIR) {
  const a = armOf(armId);
  const frozen = frozenManifest(fixture).files;
  const problems = [];
  const has = (kind) => log.some((e) => e.kind === kind);
  if (!has("start")) problems.push("the log has no start");
  if (!has("end")) problems.push("the run did not end");
  const prompt = log.find((e) => e.kind === "given" && e.phase === "release-1");
  if (!prompt) problems.push("prompt.md was never given");
  else if (prompt.frozenSha256 !== frozen["prompt.md"].sha256)
    problems.push("what was given first is not the frozen prompt.md");
  const change = log.find((e) => e.kind === "change_given");
  if (!change) problems.push("change_request.md was never given");
  else if (change.frozenSha256 !== frozen["change_request.md"].sha256)
    problems.push("the change request given is not the frozen change_request.md");
  if (a.row === "harness" && !has("release_1_finished"))
    problems.push("release 1 was never recorded as finished");
  if (a.row === "one-shot") {
    const replied = new Set(log.filter((e) => e.kind === "reply").map((e) => e.phase));
    for (const p of ["release-1", "change-request"])
      if (!replied.has(p)) problems.push(`no reply landed for ${p}`);
  }
  for (const e of log.filter((x) => x.kind === "stopped"))
    problems.push(`the run was stopped: ${e.why ?? "no reason recorded"}`);
  return problems;
}

/**
 * Whether the sealed suite is registered as an evaluation asset at its
 * frozen hash, labelled by a person (measurement.md rule 29; FINISH_LINE_PLAN
 * K2): nothing is published until it is.
 */
export async function suiteRegistration(
  manifestFile = HIDDEN_MANIFEST,
  assetsFile = join(REPO_ROOT, "fixtures", "eval_assets.json"),
) {
  const { namesAModel } = await built("packages/eval/dist/index.js");
  const suite = JSON.parse(readFileSync(manifestFile, "utf8")).suiteSha256;
  const assets = existsSync(assetsFile)
    ? (JSON.parse(readFileSync(assetsFile, "utf8")).assets ?? [])
    : [];
  const entry = assets.find((x) => x.name === "capstone-hidden-suite" && x.hash === suite);
  if (!entry)
    return {
      registered: false,
      why: "the hidden suite is not registered in fixtures/eval_assets.json at its frozen hash: it waits for a person's check (K2)",
    };
  // Execution alone is circular here: the reference solution that "executes" the
  // labels was written by the same agent as the suite, so a person must check them.
  if (!/^person:/i.test(entry.labelledBy ?? "") || namesAModel(entry.labelledBy))
    return {
      registered: false,
      why: "the hidden suite's labels are not a person's (labelledBy must be person: <name>)",
    };
  return { registered: true, labelledBy: entry.labelledBy };
}

export const MUTATION_NOT_RUN = {
  notRun:
    "Stryker is not added to this repository yet (DEC-47 O-4 allows it when its workflow arrives); the mutation score of the contestants' own tests is NOT RUN",
};

/**
 * Score one finished run. `tree` defaults to the run's repository; `hidden`
 * to the sealed directory. With `publish`, `score.json` is also written to
 * the showcase. `findingsToo: false` skips the findings (tests).
 *
 * When the sealed material is in the vault (`vault.mjs`), the vault is
 * mounted first (the keychain asks the person for its passphrase) and
 * unmounted in a `finally` block, whether scoring succeeded or not.
 */
export function scoreRun(options) {
  return withVault(() => scoreMounted(options), { env: options.env ?? process.env });
}

async function scoreMounted({
  armId,
  run: runNo,
  env = process.env,
  tree,
  hidden = hiddenDir(env),
  fixture = TIMESHEET_DIR,
  manifestFile = HIDDEN_MANIFEST,
  publish = false,
  findingsToo = true,
  showcase = SHOWCASE,
  sealedDir,
}) {
  const a = armOf(armId);
  const paths = runPaths(a.id, runNo, env);
  const repo = tree ?? paths.repo;
  const drift = suiteDrift(hidden, manifestFile);
  if (drift.length) throw new Error(`the hidden suite is not the frozen one: ${drift.join("; ")}`);
  const sealed = sealedDir ?? join(hidden, "results", "scored", a.id, String(runNo));
  if (!resolve(sealed).startsWith(`${resolve(hidden)}${sep}`))
    throw new Error("the hidden suite's results stay inside its sealed directory");
  const scratch = sealedScratch(hidden, "score-");
  try {
    const releaseOneTree = exportTag(repo, "release-1", join(scratch, "release-1"));
    const r1 = releaseOneTree
      ? hiddenPhase({
          hidden,
          app: releaseOneTree,
          phase: "release-1",
          out: join(sealed, "release-1.json"),
          scratch,
        })
      : null;
    const r2 = hiddenPhase({
      hidden,
      app: repo,
      phase: "change-request",
      out: join(sealed, "change-request.json"),
      scratch,
    });
    const log = existsSync(paths.log) ? readLog(paths) : [];
    const invalid = runValidity(log, a.id, fixture);
    writeFileSync(
      join(sealed, "validity.json"),
      `${JSON.stringify({ valid: invalid.length === 0, problems: invalid }, null, 2)}\n`,
    );
    const found = findingsToo
      ? await findings(repo, { scratchRoot: scratch })
      : { notRun: "not asked for" };
    const after = suiteDrift(hidden, manifestFile);
    if (after.length)
      throw new Error(
        `the hidden suite changed while this run was scored (${after.join("; ")}): the score is void`,
      );
    const registration = await suiteRegistration(manifestFile);
    const score = {
      about:
        "One capstone run's score (W2 G5): counts only. The hidden suite's per-test results stay sealed until every run is scored.",
      arm: a.id,
      row: a.row,
      column: a.column,
      run: Number(runNo),
      scoredAt: new Date().toISOString(),
      hiddenSuite: {
        sha256: r2.suite.sha256,
        files: r2.suite.files,
        registered: registration.registered,
        ...(registration.why ? { notRegistered: registration.why } : {}),
      },
      valid: invalid.length === 0,
      invalidBecause: invalid,
      releaseOne: r1 ? counts(r1) : { notRun: "the tree has no release-1 tag" },
      afterChange: counts(r2),
      regressions: r1 ? regressions(r1, r2) : { notRun: "no release-1 tag to compare with" },
      effort: effort(log),
      mutation: MUTATION_NOT_RUN,
      findings: found,
      accessibility: accessibility(a.id, runNo, showcase),
      releases: releasesTagged(repo),
      sealedResults: {
        "release-1": r1 ? sha256(readFileSync(join(sealed, "release-1.json"))) : null,
        "change-request": sha256(readFileSync(join(sealed, "change-request.json"))),
      },
    };
    if (existsSync(paths.dir))
      writeFileSync(join(paths.dir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
    if (publish) {
      if (!registration.registered) throw new Error(`not published: ${registration.why}`);
      if (invalid.length) throw new Error(`not published: ${invalid.join("; ")}`);
      const dest = join(showcase, a.id, String(runNo));
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
    }
    return score;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- statistics (measurement.md rules 4, 10–12) ---------------------------------------

/**
 * One arm's runs in one phase: each run's pass rate with its exact 95%
 * interval, and over the k runs pass^k (the share of tests that passed in
 * every run) and pass@k (in at least one), each with its exact interval.
 */
export async function armStats(results) {
  const { clopperPearson } = await built("packages/eval/dist/stats.js");
  const k = results.length;
  if (k === 0) return null;
  const names = new Map();
  for (const r of results) {
    for (const t of r.tests)
      names.set(t.name, (names.get(t.name) ?? 0) + (t.status === "pass" ? 1 : 0));
  }
  const n = names.size;
  const all = [...names.values()].filter((c) => c === k).length;
  const any = [...names.values()].filter((c) => c >= 1).length;
  const round = (x) => Math.round(x * 1000) / 1000;
  const ci = (x, m) => {
    const c = clopperPearson(x, m);
    return { low: round(c.low), high: round(c.high) };
  };
  return {
    runs: k,
    tests: n,
    perRun: results.map((r) => ({
      passed: r.passed,
      total: r.total,
      passRate: r.passRate,
      interval: ci(r.passed, r.total),
    })),
    passHatK: { k, passed: all, rate: n ? round(all / n) : 0, interval: ci(all, n) },
    passAtK: { k, passed: any, rate: n ? round(any / n) : 0, interval: ci(any, n) },
  };
}

/**
 * Two arms compared on the same tests, each test counted as passed when it
 * passed in every one of the first k runs of that arm (pass^k), with the same
 * k for both: the smaller arm's run count, so an arm with more runs does not
 * face a stricter all-runs criterion. The exact McNemar test on the tests
 * where they disagree. Unresolved (p ≥ 0.05) reads "no clear difference",
 * and the smallest difference the comparison could detect is stated (rule 11).
 */
export async function compareArms(aAll, bAll) {
  const { exactMcNemar, minDetectableDifference } = await built("packages/eval/dist/stats.js");
  const k = Math.min(aAll.length, bAll.length);
  const aResults = aAll.slice(0, k);
  const bResults = bAll.slice(0, k);
  const passedAll = (results) => {
    const m = new Map();
    for (const r of results)
      for (const t of r.tests) m.set(t.name, (m.get(t.name) ?? true) && t.status === "pass");
    return m;
  };
  const a = passedAll(aResults);
  const b = passedAll(bResults);
  let onlyA = 0;
  let onlyB = 0;
  let paired = 0;
  for (const [name, pa] of a) {
    if (!b.has(name)) continue;
    paired += 1;
    const pb = b.get(name);
    if (pa && !pb) onlyA += 1;
    if (pb && !pa) onlyB += 1;
  }
  const p = exactMcNemar(onlyA, onlyB);
  const d = minDetectableDifference(paired);
  const verdict =
    p >= 0.05
      ? "no clear difference"
      : onlyA > onlyB
        ? "the first arm ahead"
        : "the second arm ahead";
  return {
    k,
    runsLeftOut: { first: aAll.length - k, second: bAll.length - k },
    pairedTests: paired,
    onlyFirstPassed: onlyA,
    onlySecondPassed: onlyB,
    pValue: Math.round(p * 10000) / 10000,
    verdict,
    smallestDetectablePoints: d === null ? null : Math.round(d * 100),
  };
}

/**
 * The sealed results of every valid scored run in one phase, by arm, in run
 * order. A run whose `validity.json` is missing or says it is not valid is
 * left out, and listed in `excluded` with why.
 */
export function sealedResults(hidden, phase) {
  const root = join(hidden, "results", "scored");
  const out = {};
  const excluded = [];
  Object.defineProperty(out, "excluded", { value: excluded, enumerable: false });
  if (!existsSync(root)) return out;
  for (const armId of readdirSync(root)) {
    if (!ARMS.some((a) => a.id === armId)) continue;
    const runs = readdirSync(join(root, armId))
      .filter((r) => /^[1-9][0-9]?$/.test(r))
      .sort((x, y) => Number(x) - Number(y));
    for (const runNo of runs) {
      const f = join(root, armId, runNo, `${phase}.json`);
      if (!existsSync(f)) continue;
      const vf = join(root, armId, runNo, "validity.json");
      const validity = existsSync(vf) ? JSON.parse(readFileSync(vf, "utf8")) : null;
      if (!validity?.valid) {
        excluded.push({
          arm: armId,
          run: Number(runNo),
          why: validity ? validity.problems : ["no validity record"],
        });
        continue;
      }
      out[armId] = [...(out[armId] ?? []), JSON.parse(readFileSync(f, "utf8"))];
    }
  }
  return out;
}

/**
 * The grid's statistics: each arm's summary; rows (the harness's effect on
 * one model: one shot against with its harness) and columns (the models'
 * effect within one row), every comparison paired on the same tests.
 */
export async function gridStats(byArm) {
  const arms = {};
  for (const [id, results] of Object.entries(byArm)) arms[id] = await armStats(results);
  const comparisons = [];
  const has = (id) => (byArm[id]?.length ?? 0) > 0;
  const byColumn = new Map();
  for (const a of ARMS) byColumn.set(a.column, [...(byColumn.get(a.column) ?? []), a]);
  for (const [column, cells] of byColumn) {
    const one = cells.find((c) => c.row === "one-shot");
    const harness = cells.find((c) => c.row === "harness");
    if (one && harness && has(one.id) && has(harness.id)) {
      comparisons.push({
        kind: "harness effect",
        column,
        first: one.id,
        second: harness.id,
        ...(await compareArms(byArm[one.id], byArm[harness.id])),
      });
    }
  }
  for (const row of ["one-shot", "harness"]) {
    const cells = ARMS.filter((a) => a.row === row && has(a.id));
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        comparisons.push({
          kind: "model effect",
          row,
          first: cells[i].id,
          second: cells[j].id,
          ...(await compareArms(byArm[cells[i].id], byArm[cells[j].id])),
        });
      }
    }
  }
  return { arms, comparisons };
}

// --- the blind packet -------------------------------------------------------------------

/** Files a harness leaves that name it; never copied into a packet. */
const HARNESS_FILES = [
  /^\.claude(\/|$)/,
  /^\.sekhemet(\/|$)/,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)\.cursor(\/|$)/,
  /(^|\/)\.aider/,
  // A long message to Seshat is committed as a project document (PM-N10-2):
  // the Sekhemet arm's tree holds the frozen prompt itself, which no other arm's does.
  /^docs\/product\/inputs(\/|$)/,
];

/** A path or a text with every identity word replaced. */
export function redact(text) {
  let n = 0;
  const out = text.replace(identityPattern(), () => {
    n += 1;
    return "[redacted]";
  });
  return { text: out, replaced: n };
}

/**
 * The blind packet: each run's final tree under a random name (`entry-<hex>`),
 * without `.git` (its authors and messages), installed packages, build
 * output, data, or the files a harness leaves; every identity word in a path
 * or a text file replaced by `[redacted]`. The key from names to arms is
 * written to `keyFile`, which must be outside the packet.
 */
export function blindPacket({ runs, out, keyFile }) {
  const outAbs = resolve(out);
  const keyAbs = resolve(keyFile);
  if (keyAbs === outAbs || keyAbs.startsWith(`${outAbs}${sep}`))
    throw new Error("the key may not be inside the packet");
  if (existsSync(outAbs) && readdirSync(outAbs).length) throw new Error(`${outAbs} is not empty`);
  mkdirSync(outAbs, { recursive: true });
  const shuffled = runs
    .map((r) => ({ r, order: randomBytes(4).readUInt32BE(0) }))
    .sort((x, y) => x.order - y.order)
    .map((x) => x.r);
  const key = [];
  for (const r of shuffled) {
    const name = `entry-${randomBytes(4).toString("hex")}`;
    const dest = join(outAbs, name);
    let redactions = 0;
    let dropped = 0;
    for (const path of treeFiles(r.repo)) {
      if (HARNESS_FILES.some((re) => re.test(path))) {
        dropped += 1;
        continue;
      }
      const p = redact(path);
      redactions += p.replaced;
      const buf = readFileSync(join(r.repo, path));
      const text = buf.toString("utf8");
      const target = join(dest, p.text);
      mkdirSync(dirname(target), { recursive: true });
      if (Buffer.compare(Buffer.from(text, "utf8"), buf) === 0) {
        const t = redact(text);
        redactions += t.replaced;
        writeFileSync(target, t.text);
      } else {
        writeFileSync(target, buf);
      }
    }
    key.push({ entry: name, arm: r.arm, run: r.run, redactions, harnessFilesDropped: dropped });
  }
  mkdirSync(dirname(keyAbs), { recursive: true });
  writeFileSync(
    keyAbs,
    `${JSON.stringify({ about: "The blind packet's key: keep it away from the reviewers until their review is recorded.", key }, null, 2)}\n`,
  );
  return { out: outAbs, entries: key.map((k) => k.entry), keyFile: keyAbs };
}

/** Every file of a packet that still names an arm, a harness or a model. */
export function identityLeaks(dir) {
  const leaks = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (identityPattern().test(name)) leaks.push(`${path} (name)`);
      const st = statSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (identityPattern().test(readFileSync(join(dir, path), "utf8"))) leaks.push(path);
    }
  };
  walk("");
  return leaks;
}

// --- the command line ---------------------------------------------------------------------

function flagsOf(argv) {
  const out = { _: [], arm: [], run: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[a.slice(2)] = true;
    else {
      const k = a.slice(2);
      if (Array.isArray(out[k])) out[k].push(argv[i + 1]);
      else out[k] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main(argv) {
  const f = flagsOf(argv);
  const [command] = f._;
  if (command === "run") {
    const s = await scoreRun({ armId: f.arm[0], run: f.run[0], publish: Boolean(f.publish) });
    const pct = (c) =>
      c.passRate !== undefined
        ? `${c.passed}/${c.total} (${(c.passRate * 100).toFixed(1)}%)`
        : c.notRun;
    console.log(
      `${s.arm} run ${s.run}: release 1 ${pct(s.releaseOne)}; after the change ${pct(s.afterChange)}; regressions ${s.regressions.count ?? s.regressions.notRun}`,
    );
    return 0;
  }
  if (command === "stats") {
    const phase = f.phase ?? "change-request";
    const pooled = await withVault(async () => sealedResults(hiddenDir(), phase));
    const stats = await gridStats(pooled);
    const text = `${JSON.stringify({ about: "The capstone grid's statistics (measurement.md rules 4, 10–12): counts and intervals only.", phase, ...stats, excludedRuns: pooled.excluded }, null, 2)}\n`;
    if (f.publish) {
      const registration = await suiteRegistration();
      if (!registration.registered) throw new Error(`not published: ${registration.why}`);
      mkdirSync(SHOWCASE, { recursive: true });
      writeFileSync(join(SHOWCASE, `stats-${phase}.json`), text);
    }
    process.stdout.write(text);
    return 0;
  }
  if (command === "packet") {
    const runs = f.arm.map((armId, i) => ({
      arm: armId,
      run: Number(f.run[i]),
      repo: runPaths(armId, f.run[i]).repo,
    }));
    const r = blindPacket({ runs, out: f.out, keyFile: f.key });
    const leaks = identityLeaks(r.out);
    console.log(
      `${r.entries.length} entries in ${r.out}; key in ${r.keyFile}; ${leaks.length} files still naming an arm`,
    );
    return leaks.length ? 1 : 0;
  }
  console.error(
    "usage: score.mjs run --arm <id> --run <n> [--publish] | stats [--phase <p>] [--publish] | packet --out <dir> --key <file> (--arm <id> --run <n>)...",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}

export { readRecord };
