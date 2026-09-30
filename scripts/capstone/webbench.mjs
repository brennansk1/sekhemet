/**
 * The capstone's second run (W2 G4, run and scored by W2b G3;
 * CAPSTONE_SELECTION "The second run"): one Web-Bench project, reused
 * unchanged. The choice, its reasons and the protocol are in
 * `fixtures/capstone/webbench/choice.md`.
 *
 * Web-Bench's tests are public, so they are kept out of every contestant's
 * reach the same way as the capstone's hidden suite: the checkout lives
 * outside this repository (by default `~/.sekhemet/webbench-src`, or
 * `SEKHEMET_WEBBENCH_SRC`), pinned at one commit. `manifest.json` records that
 * commit, the licence, each task's SHA-256 and every file the run depends on
 * (the project, its two test libraries and the lockfile) by SHA-256 only; no
 * test text enters this repository.
 *
 *   node scripts/capstone/webbench.mjs --check        exit 1 on another commit, or any file changed, added or removed
 *   node scripts/capstone/webbench.mjs --task <n>     task n's description, byte for byte, after the check passes
 *   node scripts/capstone/webbench.mjs --write        re-freeze manifest.json from the checkout
 *   node scripts/capstone/webbench.mjs --deps-package <dir>
 *        write the package.json of the contestant's packages (the project's, from Web-Bench's lockfile)
 *   node scripts/capstone/webbench.mjs prepare --arm <id> --run <n> [--attach <cmd> --detach <cmd>]
 *   node scripts/capstone/webbench.mjs run --arm <id> --run <n> [--base-url <url>] [--url <dashboard>]
 *        [--attach <cmd> --detach <cmd>] [--workers <k>]
 *   node scripts/capstone/webbench.mjs stats
 *
 * `run` runs one grid cell on Web-Bench's protocol: task n given (the one-shot
 * row as Web-Bench's bench-agent gives it, the harness row as a message),
 * scored by Web-Bench's own test command against a copy of the tree in the
 * sealed scratch root, one retry carrying the test output, the run stopped
 * after a task fails twice, and pass@1 and pass@2 written to `score.json` in
 * `<runs root>/webbench-<arm>/<run>/`, beside the capstone's runs. An agentic
 * cell needs `--attach` and `--detach`: the commands that make the sealed
 * volume readable for scoring and unreadable again before the arm works.
 *
 * `--check`, `--task` and `--write` take `--src <dir>` and `--manifest <file>`.
 * Exit 2 is a refusal or a usage error. Installed packages (`node_modules`)
 * are the only files the check ignores.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  arm as armOf,
  isolationProblems,
  logEvent,
  readLog,
  readRecord,
  runPaths,
  runsRoot,
  runsRootRefusal,
  sealedScratchRoot,
  webbenchDir,
  writeRecord,
} from "./grid.mjs";
import { logDecision, questionsIn } from "./person.mjs";
import {
  CHARS_PER_TOKEN,
  ONE_SHOT,
  askerFor,
  claudeCodeArgs,
  claudeCodeSettings,
  claudeTurn,
  commitAll,
} from "./runner.mjs";
import {
  PART_SEPARATOR,
  clearErrorMsg,
  getErrorCounts,
  getMessageParts,
  getPassCounts,
  getSystemMessage,
  parseMarkdownCodeBlocks,
  prettierErrorMessage,
  rate,
} from "./webbench_agent.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MANIFEST = join(REPO_ROOT, "fixtures", "capstone", "webbench", "manifest.json");
export const DEFAULT_SRC =
  process.env.SEKHEMET_WEBBENCH_SRC ?? join(homedir(), ".sekhemet", "webbench-src");

export const REPOSITORY = "https://github.com/bytedance/web-bench";
export const PROJECT = "projects/fastify";
export const LICENCE_FILE = "LICENSE.md";
/** Everything a scored run reads from the checkout. */
export const TRACKED = [
  LICENCE_FILE,
  PROJECT,
  "libraries/test-util",
  "libraries/shop-test-util",
  "common/config/rush/pnpm-lock.yaml",
];
const SKIP = new Set(["node_modules", ".git"]);

class Refusal extends Error {}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Web-Bench's `tasks.yml`, read as its evaluator's YAML parser reads it, for
 * the one shape the file uses: a list of items with plain `id`, `date` and
 * `level` and a literal-block `description` (`|`, indented four spaces; clip
 * chomping keeps exactly one final newline). Anything else is refused rather
 * than guessed at, since every arm must receive the same bytes.
 */
export function parseTasks(text) {
  const lines = text.split("\n");
  const tasks = [];
  let item = null;
  let i = 0;
  const fail = (why) => {
    throw new Error(`tasks.yml line ${i + 1}: ${why}`);
  };
  while (i < lines.length) {
    const line = lines[i];
    const start = /^- id: (\S+)$/.exec(line);
    const plain = /^ {2}(date|level): (\S.*)$/.exec(line);
    if (line.trim() === "") {
      i++;
    } else if (start) {
      item = { id: start[1] };
      tasks.push(item);
      const expected = `task-${tasks.length}`;
      if (item.id !== expected) fail(`expected ${expected}, found ${item.id}`);
      i++;
    } else if (plain && item) {
      item[plain[1]] = plain[2];
      i++;
    } else if (/^ {2}description:/.test(line) && item) {
      if (line !== "  description: |") fail("only a literal block (|) description is read");
      i++;
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") block.push("");
        else if (l.startsWith("    ")) block.push(l.slice(4));
        else if (/^ {3}\S/.test(l)) fail("a description line indented less than its block");
        else break;
        i++;
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      item.description = block.length > 0 ? `${block.join("\n")}\n` : "";
    } else {
      fail(`unexpected line: ${JSON.stringify(line)}`);
    }
  }
  if (tasks.length === 0) throw new Error("tasks.yml: no tasks");
  for (const t of tasks) {
    for (const key of ["date", "level", "description"]) {
      if (t[key] === undefined) throw new Error(`tasks.yml: ${t.id} has no ${key}`);
    }
  }
  return tasks.map((t) => ({ id: t.id, date: t.date, level: t.level, description: t.description }));
}

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.status !== 0)
    throw new Refusal(`git ${args.join(" ")} failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The checkout must exist, be a git checkout, and sit outside this repository. */
function checkout(src) {
  if (!existsSync(src)) throw new Refusal(`no Web-Bench checkout at ${src}`);
  const real = realpathSync(src);
  const roots = [realpathSync(REPO_ROOT)];
  const common = spawnSync(
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (common.status === 0 && existsSync(common.stdout.trim())) {
    roots.push(dirname(realpathSync(common.stdout.trim())));
  }
  for (const root of roots) {
    if (inside(real, root)) {
      throw new Refusal(
        `${src} is inside this repository, where a contestant's harness could read its tests`,
      );
    }
  }
  if (!existsSync(join(real, ".git"))) throw new Refusal(`${src} is not a git checkout`);
  return real;
}

/** Every tracked file's SHA-256, by path relative to the checkout, sorted. */
function hashTracked(src) {
  const files = {};
  const visit = (rel) => {
    const abs = join(src, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Refusal(`${rel} is a symbolic link`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!SKIP.has(name)) visit(`${rel}/${name}`);
      }
    } else {
      files[rel] = sha256(readFileSync(abs));
    }
  };
  for (const rel of TRACKED) {
    if (existsSync(join(src, rel))) visit(rel);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function treeHash(files) {
  return sha256(
    Object.entries(files)
      .map(([p, h]) => `${h}  ${p}\n`)
      .join(""),
  );
}

function licenceOf(text) {
  if (/Apache License/.test(text) && /Version 2\.0/.test(text)) return "Apache-2.0";
  throw new Refusal(`${LICENCE_FILE} is not the Apache License 2.0; check the licence again`);
}

export function freeze(src) {
  const real = checkout(src);
  const files = hashTracked(real);
  const licenceText = readFileSync(join(real, LICENCE_FILE), "utf8");
  const tasks = parseTasks(readFileSync(join(real, PROJECT, "tasks.yml"), "utf8"));
  const tests = Object.keys(files).filter((p) =>
    new RegExp(`^${PROJECT}/test/task-\\d+\\.spec\\.js$`).test(p),
  );
  return {
    about:
      "The capstone's second run (W2 G4): one Web-Bench project, reused unchanged. The checkout lives outside this repository; this file records it by SHA-256 only. Written by scripts/capstone/webbench.mjs --write; never edited by hand.",
    repository: REPOSITORY,
    commit: git(real, "rev-parse", "HEAD"),
    commitDate: git(real, "log", "-1", "--format=%cI"),
    location: "~/.sekhemet/webbench-src",
    project: PROJECT,
    licence: { file: LICENCE_FILE, spdx: licenceOf(licenceText), sha256: files[LICENCE_FILE] },
    tasks: tasks.map((t) => ({ id: t.id, level: t.level, sha256: sha256(t.description) })),
    tests: {
      dir: `${PROJECT}/test`,
      count: tests.length,
      run: "npm test -- <n> in the project directory: Playwright runs task-1 to task-n (libraries/test-util/test.sh)",
    },
    treeSha256: treeHash(files),
    files,
  };
}

/** Every way the checkout differs from the manifest; empty when it matches. */
export function drift(src, manifest) {
  const real = checkout(src);
  const problems = [];
  const head = git(real, "rev-parse", "HEAD");
  if (head !== manifest.commit) problems.push(`commit is ${head}, pinned ${manifest.commit}`);
  const files = hashTracked(real);
  for (const [p, h] of Object.entries(manifest.files)) {
    if (!(p in files)) problems.push(`missing: ${p}`);
    else if (files[p] !== h) problems.push(`changed: ${p}`);
  }
  for (const p of Object.keys(files)) {
    if (!(p in manifest.files)) problems.push(`added: ${p}`);
  }
  return problems;
}

function readManifest(file) {
  if (!existsSync(file)) throw new Refusal(`no manifest at ${file}; run --write first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// --- the run (W2b G3): the contestant's tree, scoring, the arms -------------------------

/** Web-Bench's attempts per task: the first, and one retry carrying the test output. */
export const RETRY = 2;
/** Web-Bench's limit on one test run (its PlaywrightTester's EXCEED_TIME). */
export const TEST_TIMEOUT_MS = 10 * 60_000;
/** Web-Bench reruns a test run whose web server failed to start, up to three times in all. */
export const TEST_RUNS_ON_SERVER_FAILURE = 3;
/** Playwright's words for a web server that did not start (Web-Bench's PlaywrightTester). */
const SERVER_FAILURE = ["config.webServer", "net::ERR_ABORTED"];
/** Web-Bench's words for a test run that hit the limit. */
export const TIMED_OUT =
  "Test execution timed out. Check for infinite loops or high code complexity.";
/** The two test libraries a scored run reads, beside the project. */
export const LIBRARIES = ["libraries/test-util", "libraries/shop-test-util"];
/** Packages that would put the tests' own code in the contestant's tree. */
const FORBIDDEN_PACKAGES = ["@web-bench", "@playwright", "playwright", "playwright-core"];
/** Where the contestant's tree sits inside the scoring copy of the project. */
const SCORED_TREE = "contestant";

/**
 * Where the port differs from Web-Bench's published conditions (bench-agent
 * and the evaluator at the pinned commit), recorded in every run's `run.json`
 * and in `choice.md`, so pass@1 and pass@2 are read against them.
 */
export const DEPARTURES = {
  contextFit:
    "bench-agent fits a request to the model's context by pruning the chat history and the prompt from the top (compileChatMessages); here a one-shot request over the grid's common window is not sent, and the attempt fails with that reason, so the retry is larger still and the run stops",
  requestRetries:
    "bench-agent retries a failed model request 3 times; here a one-shot request is sent once (retries 0, as the grid's one-shot cells), and a failed request fails the attempt",
  passRule:
    "Web-Bench's tester counts a run as passed when its cleaned error text is empty; here a run passes when test.sh exits 0, and a non-zero exit fails it whatever its output",
  playwright: "@playwright/test 1.61.1 from this repository; Web-Bench pins 1.57.0",
  testCommand: "Web-Bench's test.sh is run directly, not through its evaluator's plugin",
  messageParts:
    "bench-agent's message parts (the files, the task, the last line) are joined into one message",
  fileValidation:
    "Web-Bench's HTML file validation on write is not run; this project's views are EJS",
};

/**
 * The hosts that serve Web-Bench's tests and reference solution: GitHub (the
 * repository, its raw files, archives and release assets), jsDelivr (which
 * mirrors any GitHub repository) and Hugging Face (the dataset). An agentic
 * cell is refused while any of them can be reached from this machine
 * (CAPSTONE_SELECTION: "no network path to GitHub or Hugging Face").
 */
export const WEBBENCH_HOSTS = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "cdn.jsdelivr.net",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
];

/** Whether `host` accepts a TCP connection on `port` from this machine, within `timeoutMs`. */
export function tcpProbe(host, { port = 443, timeoutMs = 5000 } = {}) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    const done = (reachable) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Every Web-Bench host that can be reached, as the isolation check words it. */
export async function networkProblems(probe = tcpProbe, hosts = WEBBENCH_HOSTS) {
  const open = [];
  for (const host of hosts) if (await probe(host)) open.push(host);
  return open.map(
    (host) =>
      `${host} can be reached from this machine, and Web-Bench's tests and reference are public there: block it for the run (a firewall rule, or an /etc/hosts entry to 0.0.0.0)`,
  );
}

/**
 * What every agentic cell on Web-Bench is held to, the same for each and
 * recorded in the run: a wall-clock budget per attempt, and at most
 * `maxReplies` answers per attempt to a question the harness ends on.
 * PROPOSED (W2b G3, 2026-09-29), for the owner to confirm before R11.
 */
export const WEBBENCH_AGENTIC = { attemptMinutes: 30, maxReplies: 3 };

/**
 * The only answer an agentic arm's question gets on Web-Bench: it has no
 * stakeholder, and the one-shot row cannot ask at all.
 */
export const NO_ANSWER =
  "There is no one to ask: the task's text is all there is. Decide for yourself and finish the task.";

/** The harness row's retry sentence, before the test output. */
export const HARNESS_RETRY =
  "Your work on this task did not pass its tests. Fix it. The output of the tests:";

/**
 * The harness row's message for one attempt: task n's text byte for byte;
 * on the retry, the same text, then the fixed sentence and Playwright's
 * cleaned output, as Web-Bench gives it.
 */
export function harnessMessage(task, error) {
  return error ? `${task}\n---\n\n${HARNESS_RETRY}\n\n${error}` : task;
}

/** The installed packages the contestant's tree is given (`SEKHEMET_WEBBENCH_DEPS`, with a `node_modules`). */
export function depsDir(env = process.env) {
  return resolve(env.SEKHEMET_WEBBENCH_DEPS || join(homedir(), ".sekhemet", "webbench-deps"));
}

/** A Web-Bench run's directories: beside the capstone's runs, its arm directory prefixed `webbench-`. */
export function webbenchRunPaths(armId, run, env = process.env) {
  return runPaths(`webbench-${armId}`, run, env);
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Contestant",
  GIT_AUTHOR_EMAIL: "contestant@example.invalid",
  GIT_COMMITTER_NAME: "Contestant",
  GIT_COMMITTER_EMAIL: "contestant@example.invalid",
};

/**
 * The project's package versions from Web-Bench's lockfile: its dependencies
 * and its development dependencies, less the tests' own (`@playwright/test`,
 * the workspace libraries). What the contestant's `node_modules` is
 * installed from (`--deps-package`).
 */
export function lockedPackages(lockText, project = PROJECT) {
  const lines = lockText.split("\n");
  const start = lines.indexOf(`  ../../${project}:`);
  if (start < 0) throw new Refusal(`the lockfile has no entry for ${project}`);
  const out = {};
  let name = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break;
    const n = /^ {6}'?([^':]+)'?:$/.exec(l);
    if (n) name = n[1];
    const v = /^ {8}version: (\S+)$/.exec(l);
    if (v && name) {
      if (!v[1].startsWith("link:") && !FORBIDDEN_PACKAGES.some((f) => name.startsWith(f)))
        out[name] = v[1];
      name = null;
    }
  }
  if (Object.keys(out).length === 0) throw new Refusal(`no packages read for ${project}`);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Every file under `dir`, sorted, `skip` names left out. A symbolic link is
 * refused in the checkout; in a contestant's tree (`links: "skip"`) it is
 * left out, so nothing it points at is ever copied or shown.
 */
function listFiles(dir, skip = new Set(), { links = "refuse" } = {}) {
  const out = [];
  const visit = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        if (links === "skip") continue;
        throw new Refusal(`${join(dir, r)} is a symbolic link`);
      }
      if (e.isDirectory()) visit(r);
      else out.push(r);
    }
  };
  visit("");
  return out;
}

function copyFiles(from, to, skip, options) {
  for (const rel of listFiles(from, skip, options)) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(join(from, rel), join(to, rel));
  }
}

/** The installed packages, refused if any would carry the tests' own code; `name@version`, sorted. */
function checkDeps(deps) {
  const nm = join(deps, "node_modules");
  if (!existsSync(nm))
    throw new Refusal(
      `no installed packages at ${nm}: write the package list with \`webbench.mjs --deps-package ${deps}\`, then install it there once (npm install)`,
    );
  const names = readdirSync(nm).filter((n) => !n.startsWith("."));
  const bad = names.filter((n) => FORBIDDEN_PACKAGES.includes(n));
  if (bad.length)
    throw new Refusal(
      `${nm} holds ${bad.join(", ")}: the tests' own libraries never go into the contestant's tree`,
    );
  const packages = [];
  for (const n of names) {
    const dirs = n.startsWith("@") ? readdirSync(join(nm, n)).map((m) => `${n}/${m}`) : [n];
    for (const d of dirs) {
      const pj = join(nm, d, "package.json");
      if (existsSync(pj)) packages.push(`${d}@${JSON.parse(readFileSync(pj, "utf8")).version}`);
    }
  }
  return packages.sort();
}

/** The ignore patterns Web-Bench's evaluator applies to a tree before showing it: the project's and the repository's. */
function ignorePatterns(src, project) {
  const out = [];
  for (const f of [
    join(project, ".gitignore"),
    join(project, ".npmignore"),
    ".gitignore",
    join(project, ".evalignore"),
  ]) {
    const file = join(src, f);
    if (existsSync(file)) out.push(...readFileSync(file, "utf8").split("\n"));
  }
  return out.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += glob.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return re;
}

/**
 * Whether a path relative to the tree is ignored, as the `ignore` package
 * Web-Bench uses reads these patterns: the last matching pattern wins, `!`
 * re-includes, a trailing `/` matches directories only, a pattern with a `/`
 * is anchored at the tree, and an ignored directory ignores all it holds.
 */
export function ignored(path, patterns) {
  const parts = path.split("/");
  let out = false;
  for (const raw of patterns) {
    const negate = raw.startsWith("!");
    let p = negate ? raw.slice(1) : raw;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.includes("/");
    if (anchored && p.startsWith("/")) p = p.slice(1);
    const re = new RegExp(`^${globToRegex(p)}$`);
    let hit = false;
    for (let k = 1; k <= parts.length && !hit; k++) {
      const isDir = k < parts.length;
      if (dirOnly && !isDir) continue;
      const candidate = anchored ? parts.slice(0, k).join("/") : parts[k - 1];
      hit = re.test(candidate);
    }
    if (hit) out = !negate;
  }
  return out;
}

/** The tree's files as Web-Bench's evaluator shows them to an agent: text, by path, ignored ones left out. */
export function contextFiles(tree, patterns = ["node_modules/"]) {
  const files = {};
  for (const rel of listFiles(tree, new Set([".git", "node_modules"]), { links: "skip" })) {
    if (ignored(rel, patterns)) continue;
    files[rel] = readFileSync(join(tree, rel), "utf8");
  }
  return files;
}

/**
 * The contestant's starting tree, alone at `dest`: `src-init/` from the
 * pinned checkout (checked first), the installed packages in its
 * `node_modules` (a copy, never a link into anything sealed), and nothing
 * else of the checkout: no tests, no reference solution, no scripts. A git
 * repository with one commit, `node_modules/` and `test.sqlite` excluded.
 */
export function materialise({ src = DEFAULT_SRC, manifestFile = MANIFEST, manifest, deps, dest }) {
  const m = manifest ?? readManifest(manifestFile);
  const problems = drift(src, m);
  if (problems.length)
    throw new Refusal(`the Web-Bench checkout differs from the pinned one: ${problems.join("; ")}`);
  const real = realpathSync(src);
  const packages = checkDeps(deps);
  if (existsSync(dest) && readdirSync(dest).length)
    throw new Refusal(`${dest} is not empty: a run is never repeated in place`);
  mkdirSync(dest, { recursive: true });
  copyFiles(join(real, m.project, "src-init"), dest, new Set());
  cpSync(join(deps, "node_modules"), join(dest, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const g = (...args) => {
    const r = spawnSync("git", args, {
      cwd: dest,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dest, ".git", "info", "exclude"), "node_modules/\ntest.sqlite\n");
  g("add", "-A");
  g(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "The starting tree (Web-Bench src-init)",
  );
  return {
    commit: g("rev-parse", "HEAD"),
    files: listFiles(dest, new Set([".git", "node_modules"])),
    packages,
    ignore: ignorePatterns(real, m.project),
  };
}

/** Task n's text, read from the checkout as Web-Bench's evaluator reads it, refused unless its SHA-256 is the manifest's. */
export function readTasks(src, manifest) {
  const tasks = parseTasks(readFileSync(join(src, manifest.project, "tasks.yml"), "utf8"));
  if (tasks.length !== manifest.tasks.length)
    throw new Refusal(
      `tasks.yml has ${tasks.length} tasks; the manifest records ${manifest.tasks.length}`,
    );
  tasks.forEach((t, i) => {
    if (sha256(t.description) !== manifest.tasks[i].sha256)
      throw new Refusal(`${t.id}'s text does not match its recorded SHA-256`);
  });
  return tasks;
}

/** A free local port for one test run's web server. */
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** One run of Web-Bench's test command, its process group killed at the limit. */
function runTests({ cwd, script, n, env, timeoutMs }) {
  return new Promise((ok) => {
    const child = spawn("bash", [script, String(n)], { cwd, env, detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group has already gone.
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Playwright stopped its web server itself.
      }
      ok({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Score task n on a tree, as Web-Bench's evaluator does, outside the
 * contestant's reach: a fresh copy of the project (without its reference
 * solution) and its two test libraries in the sealed scratch root, the tree
 * copied in beside them (without its `node_modules` or git), the pristine
 * packages, and `@playwright/test` from this repository (1.61.1; Web-Bench
 * pins 1.57.0). Web-Bench's `test.sh` runs the specs of tasks 1 to n with its
 * settings (`EVAL_PROJECT_ROOT`, a free `EVAL_PROJECT_PORT`,
 * `IS_EVAL_PRODUCTION`, `MAX_TEST_WORKERS`). Exit 0 passes. Otherwise the
 * error is Playwright's output cleaned as Web-Bench cleans it, every scratch
 * path replaced by `.`. The scratch copy is removed either way.
 */
export async function scoreTask({
  tree,
  n,
  env = process.env,
  src = webbenchDir(env),
  manifestFile = MANIFEST,
  manifest,
  deps = depsDir(env),
  workers = 1,
  timeoutMs = TEST_TIMEOUT_MS,
}) {
  const m = manifest ?? readManifest(manifestFile);
  const problems = drift(src, m);
  if (problems.length)
    throw new Refusal(`the Web-Bench checkout differs from the pinned one: ${problems.join("; ")}`);
  checkDeps(deps);
  const real = realpathSync(src);
  const root = sealedScratchRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(mkdtempSync(join(root, "webbench-")));
  const began = Date.now();
  try {
    const bench = join(scratch, "web-bench");
    const project = join(bench, m.project);
    copyFiles(
      join(real, m.project),
      project,
      new Set(["node_modules", "src", "test-results", "playwright-report", "eval"]),
    );
    for (const lib of LIBRARIES) {
      if (existsSync(join(real, lib)))
        copyFiles(join(real, lib), join(bench, lib), new Set(["node_modules"]));
    }
    const scored = join(project, SCORED_TREE);
    copyFiles(tree, scored, new Set([".git", "node_modules", "test.sqlite"]), { links: "skip" });
    // The packages: the pristine install, linked; the tests' own libraries and Playwright beside them.
    const depsNm = join(deps, "node_modules");
    const nm = join(project, "node_modules");
    mkdirSync(join(nm, ".bin"), { recursive: true });
    for (const name of readdirSync(depsNm)) {
      if (name !== ".bin") symlinkSync(join(depsNm, name), join(nm, name));
    }
    if (existsSync(join(depsNm, ".bin"))) {
      for (const b of readdirSync(join(depsNm, ".bin")))
        symlinkSync(join(depsNm, ".bin", b), join(nm, ".bin", b));
    }
    const playwright = realpathSync(join(REPO_ROOT, "node_modules", "@playwright", "test"));
    const rootNm = join(bench, "node_modules");
    for (const dir of [nm, rootNm]) {
      mkdirSync(join(dir, "@playwright"), { recursive: true });
      symlinkSync(playwright, join(dir, "@playwright", "test"));
    }
    symlinkSync(join(playwright, "cli.js"), join(nm, ".bin", "playwright"));
    mkdirSync(join(rootNm, "@web-bench"), { recursive: true });
    for (const lib of LIBRARIES) {
      if (existsSync(join(bench, lib)))
        symlinkSync(join(bench, lib), join(rootNm, "@web-bench", basename(lib)));
    }
    const base = { ...env };
    for (const k of ["CI", "EVAL_PROJECT_ROOT", "EVAL_PROJECT_PORT", "NODE_OPTIONS"])
      delete base[k];
    const dirs = [
      join(project, "test"),
      project,
      join(bench, LIBRARIES[0]),
      bench,
      "src/",
      scratch,
    ];
    let result;
    let runs = 0;
    let output = "";
    for (let i = 0; i < TEST_RUNS_ON_SERVER_FAILURE; i++) {
      runs += 1;
      const port = await freePort();
      const r = await runTests({
        cwd: project,
        script: join(bench, LIBRARIES[0], "test.sh"),
        n,
        timeoutMs,
        env: {
          ...base,
          PATH: `${dirname(process.execPath)}${delimiter}${base.PATH ?? "/usr/bin:/bin"}`,
          EVAL_PROJECT_ROOT: scored,
          EVAL_TASK: `task-${n}`,
          EVAL_PROJECT_PORT: String(port),
          IS_EVAL_PRODUCTION: "true",
          EVAL: "true",
          MAX_TEST_WORKERS: String(workers),
          FORCE_COLOR: "0",
          npm_config_offline: "true",
          npm_config_update_notifier: "false",
        },
      });
      output = `${r.stdout}${r.stderr}`;
      if (r.timedOut) {
        result = { passed: false, error: TIMED_OUT, exit: null };
        break;
      }
      if (r.code === 0) {
        result = { passed: true, error: "", exit: 0 };
        break;
      }
      const error = clearErrorMsg(prettierErrorMessage(r.stdout || r.stderr), dirs);
      result = { passed: false, error, exit: r.code };
      if (!SERVER_FAILURE.some((s) => output.includes(s))) break;
    }
    return {
      ...result,
      runs,
      outputSha256: sha256(output),
      minutes: Math.round(((Date.now() - began) / 60_000) * 100) / 100,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One one-shot request, as bench-agent makes it: its system message, then one message of the files, the task and the last line. */
export function oneShotRequest({ task, files = {}, error }) {
  const system = getSystemMessage();
  const parts = getMessageParts({ files, task, error });
  const message = parts.join(PART_SEPARATOR);
  return {
    system,
    message,
    parts: parts.length,
    messageSha256: sha256(message),
    estimatedPromptTokens: Math.ceil((system.length + message.length) / CHARS_PER_TOKEN),
  };
}

/**
 * A one-shot reply's files written into the tree, as bench-agent reads them
 * (each named code block, the last of a name winning); a block with no name
 * is skipped, and a name that leaves the tree is refused.
 */
export function applyReply(tree, text) {
  const files = {};
  const refused = [];
  let unnamed = 0;
  for (const b of parseMarkdownCodeBlocks(text ?? "")) {
    if (!b.filename) {
      unnamed += 1;
      continue;
    }
    const target = resolve(tree, b.filename);
    if (!target.startsWith(`${resolve(tree)}${sep}`) || b.filename.split("/").includes(".git")) {
      if (!refused.includes(b.filename)) refused.push(b.filename);
      continue;
    }
    files[b.filename] = b.code;
  }
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, name)), { recursive: true });
    writeFileSync(join(tree, name), code);
  }
  return { written: Object.keys(files), refused, unnamed };
}

const attemptId = (n, attempt) => `task-${n}-attempt-${attempt}`;

/**
 * The one-shot row's attempt: one request through `ask` (the grid's asker:
 * the product's adapter or `claude -p` with no tools), its reply's files
 * written into the tree and committed. A request that does not fit the grid's
 * common window is not sent, and the attempt fails with that reason.
 */
export function oneShotAttempt(ask) {
  return async ({ paths, n, attempt, task, error, record }) => {
    const id = attemptId(n, attempt);
    const files = contextFiles(paths.repo, record.context.ignore);
    const request = oneShotRequest({ task: task.description, files, error });
    writeFileSync(join(paths.input, `${id}-request.txt`), request.message);
    logEvent(paths, {
      kind: "request",
      task: task.id,
      attempt,
      files: Object.keys(files).length,
      messageSha256: request.messageSha256,
      systemSha256: sha256(request.system),
      estimatedPromptTokens: request.estimatedPromptTokens,
    });
    if (request.estimatedPromptTokens + ONE_SHOT.maxOutputTokens > ONE_SHOT.contextTokens)
      throw new Error(
        `the request does not fit the common window: about ${request.estimatedPromptTokens} prompt tokens plus the ${ONE_SHOT.maxOutputTokens}-token output allowance exceed ${ONE_SHOT.contextTokens}; not sent`,
      );
    const reply = await ask(request, paths);
    writeFileSync(join(paths.input, `${id}-reply.md`), reply.text ?? "");
    const applied = applyReply(paths.repo, reply.text ?? "");
    const commit = commitAll(paths.repo, `The one-shot reply to task-${n}, attempt ${attempt}`);
    logEvent(paths, {
      kind: "reply",
      task: task.id,
      attempt,
      replySha256: sha256(reply.text ?? ""),
      finishReason: reply.finishReason ?? null,
      ...applied,
      commit,
    });
    if (reply.usage)
      logEvent(paths, {
        kind: "usage",
        phase: id,
        ...reply.usage,
        costUsd: reply.costUsd ?? null,
        models: reply.models ?? null,
      });
  };
}

/** The questions a harness ends on, answered only with `NO_ANSWER`. */
function noAnswer(text) {
  const questions = questionsIn(text ?? "");
  if (questions.length === 0) return null;
  return {
    questions,
    text: NO_ANSWER,
    usedDefault: true,
    why: "Web-Bench has no stakeholder: the fixed answer",
  };
}

/**
 * The Claude Code row's attempt: one session for the whole run (the grid's
 * pinned `claude -p` configuration), task n's message, then `NO_ANSWER` to a
 * question it ends on, at most `maxReplies` times, within the attempt's
 * budget. Work left uncommitted is committed by the runner.
 */
export function claudeCodeAttempt({ env = process.env, budget = WEBBENCH_AGENTIC } = {}) {
  let state = null;
  return async ({ a, paths, n, attempt, task, error }) => {
    if (a.kind !== "claude-code") throw new Error(`${a.id} is not a Claude Code arm`);
    if (!state) {
      const settings = join(paths.input, "claude-settings.json");
      const text = `${JSON.stringify(claudeCodeSettings(env), null, 2)}\n`;
      writeFileSync(settings, text);
      state = { settings, sessionId: randomUUID(), turns: 0 };
      logEvent(paths, {
        kind: "claude_code",
        sessionId: state.sessionId,
        args: claudeCodeArgs(a.model, { settings, sessionId: state.sessionId, resume: false }),
        settingsSha256: sha256(text),
        budget,
      });
    }
    const id = attemptId(n, attempt);
    const deadline = Date.now() + budget.attemptMinutes * 60_000;
    let next = harnessMessage(task.description, error);
    let replies = 0;
    let why = "the session ended without a question";
    for (let k = 1; ; k += 1) {
      const left = deadline - Date.now();
      if (left <= 0) {
        why = "the attempt's time budget was spent";
        break;
      }
      const t = claudeTurn(a, paths, {
        message: next,
        phase: id,
        n: k,
        sessionId: state.sessionId,
        resume: state.turns > 0,
        settings: state.settings,
        timeoutMs: left,
        env,
      });
      state.turns += 1;
      if (t.timedOut) {
        why = "the attempt's time budget was spent";
        break;
      }
      if (t.exit !== 0 && !t.text) {
        why = `the session failed (exit ${t.exit})`;
        break;
      }
      const answer = noAnswer(t.text);
      if (!answer) break;
      if (replies >= budget.maxReplies) {
        why = "the reply cap was reached";
        break;
      }
      replies += 1;
      logDecision(
        paths,
        "answer Claude Code",
        { decision: "answer", why: answer.why },
        { phase: id, questions: answer.questions },
      );
      next = answer.text;
    }
    const leftover = commitAll(
      paths.repo,
      `Work left uncommitted after task-${n}, attempt ${attempt} (committed by the runner)`,
    );
    logEvent(paths, {
      kind: "attempt_ended",
      task: task.id,
      attempt,
      why,
      leftoverCommit: leftover,
    });
  };
}

/**
 * The Sekhemet row's attempt, against a running `sekhemet serve` (Solo) on
 * the run's repository: task n's message to Seshat (refused unless the
 * thread holds it whole), the conversation (proposals applied, a question
 * answered with `NO_ANSWER`), then the board worked as the capstone's
 * person works it (`sekhemet_arm.mjs`: criteria approved, the queue run,
 * Review decided, the next Backlog issue moved with the product's `/ready`)
 * until every issue is done or nothing can move. The tree scored is her checkout,
 * brought up to the integration branch.
 */
export function sekhemetAttempt({
  url,
  csrf,
  runQueue,
  pollMs,
  cli,
  cliEnv,
  budget = WEBBENCH_AGENTIC,
} = {}) {
  let ctx = null;
  let arm = null;
  return async ({ paths, n, attempt, task, error }) => {
    if (!arm) arm = await import("./sekhemet_arm.mjs");
    if (!ctx) {
      if (!url)
        throw new Error(
          "the Sekhemet arm needs --url, the dashboard of the run's `sekhemet serve`",
        );
      ctx = await arm.armContext({
        paths,
        url,
        csrf,
        budget: { maxReplies: budget.maxReplies },
        ...(pollMs ? { pollMs } : {}),
        ...(cli ? { cli } : {}),
        ...(cliEnv ? { cliEnv } : {}),
        ...(runQueue ? { runQueue } : {}),
        releaseTag: () => () => ({ ok: false, why: "no release on Web-Bench" }),
        answer: noAnswer,
        // No fixed point to protect: an attempt nothing can move ends there.
        waitOnStall: false,
      });
      logEvent(paths, { kind: "sekhemet", dashboard: ctx.d.origin, budget });
    }
    const id = attemptId(n, attempt);
    const deadline = Date.now() + budget.attemptMinutes * 60_000;
    const message = harnessMessage(task.description, error);
    const since = arm.ledgerSeq(ctx.repo);
    const sent = await ctx.d.post("/api/pm/messages", { text: message });
    if (sent.status !== 200)
      throw new Error(`Seshat refused task-${n}'s message: HTTP ${sent.status}`);
    const thread = await ctx.d.get("/api/pm/thread");
    const mine = (thread.json?.messages ?? []).filter((m) => m.role === "user");
    const held = mine.find((m) => m.id === sent.json?.message?.id) ?? mine.at(-1);
    if (!held || (held.text !== message && held.text !== message.trim()))
      throw new Error(`Seshat does not hold task-${n}'s message whole`);
    logEvent(paths, { kind: "received", task: task.id, attempt, messageSha256: sha256(message) });
    arm.catchUp(ctx, `the message's notice (${id})`, sent.json?.notice);
    const talk = await arm.converse(ctx, id, held.seq ?? 0, [], deadline);
    const worked = await arm.work(ctx, id, deadline);
    arm.logUsage(ctx, id, since);
    arm.catchUp(ctx, `the end of ${id}`);
    // No agentic run may be in progress while scoring (the sealed material is
    // attached then): Seshat must be idle before the attempt ends.
    const idle = await arm.awaitIdle(ctx, Date.now() + SESHAT_IDLE_GRACE_MS);
    logEvent(paths, {
      kind: "attempt_ended",
      task: task.id,
      attempt,
      conversation: talk,
      work: worked,
      seshatIdle: idle,
    });
    if (!idle)
      throw new Error(
        `Seshat was still answering ${SESHAT_IDLE_GRACE_MS / 60_000} minutes after task-${n}'s attempt ended; it is not scored while an agentic run is in progress`,
      );
  };
}

/** How long after an attempt's work ends Seshat may take to finish answering before it is not scored. */
export const SESHAT_IDLE_GRACE_MS = 10 * 60_000;

function noSealing() {
  return { attach: () => {}, detach: () => {} };
}

/** `fn` with the sealed material attached (the checkout readable), detached again afterwards. */
async function whileAttached(sealing, fn) {
  await sealing.attach();
  try {
    return await fn();
  } finally {
    await sealing.detach();
  }
}

async function refuseUnlessIsolated(a, paths, env, networkProbe) {
  if (a.row !== "harness") return;
  const problems = [...isolationProblems(paths, env), ...(await networkProblems(networkProbe))];
  if (problems.length) {
    logEvent(paths, { kind: "stopped", why: "not isolated", problems });
    throw new Error(
      `an agentic run is not isolated (CAPSTONE_SELECTION, Protocol: isolation):\n- ${problems.join("\n- ")}`,
    );
  }
}

/**
 * A Web-Bench run's directory and starting tree, refused when the run
 * exists or the runs root is not allowed. Reads the checkout, so it runs
 * with the sealed material attached; an agentic run's isolation is checked
 * later, with it detached, before every attempt.
 */
export function prepareWebBench({
  armId,
  run,
  env = process.env,
  manifestFile = MANIFEST,
  sealing = noSealing(),
}) {
  const a = armOf(armId);
  const paths = webbenchRunPaths(a.id, run, env);
  if (existsSync(paths.dir))
    throw new Error(
      `${paths.dir} already exists: a run is never repeated in place; use the next run number`,
    );
  const refusal = runsRootRefusal(env);
  if (refusal) throw new Error(refusal);
  const manifest = readManifest(manifestFile);
  sealing.attach();
  let made;
  try {
    mkdirSync(paths.input, { recursive: true });
    made = materialise({ src: webbenchDir(env), manifest, deps: depsDir(env), dest: paths.repo });
  } catch (err) {
    rmSync(paths.dir, { recursive: true, force: true });
    throw err;
  } finally {
    sealing.detach();
  }
  const record = writeRecord(paths, {
    about:
      "One Web-Bench run of the capstone's grid (W2b G3). Written by scripts/capstone/webbench.mjs.",
    benchmark: "web-bench",
    arm: a.id,
    row: a.row,
    column: a.column,
    model: a.model,
    run: Number(run),
    checkout: {
      repository: manifest.repository,
      commit: manifest.commit,
      project: manifest.project,
      treeSha256: manifest.treeSha256,
    },
    start: { commit: made.commit, files: made.files },
    packages: made.packages,
    context: { ignore: made.ignore },
    protocol: {
      retry: RETRY,
      mode: "sequential: the run stops after a task fails both attempts",
      testTimeoutMs: TEST_TIMEOUT_MS,
      maxTestWorkers: 1,
      playwright: "@playwright/test from this repository (Web-Bench pins 1.57.0)",
      departures: DEPARTURES,
    },
    oneShot:
      a.row === "one-shot"
        ? {
            ...ONE_SHOT,
            system: "Web-Bench's bench-agent system message",
            systemSha256: sha256(getSystemMessage()),
          }
        : null,
    agentic:
      a.row === "harness"
        ? { ...WEBBENCH_AGENTIC, noAnswer: NO_ANSWER, retrySentence: HARNESS_RETRY }
        : null,
  });
  logEvent(paths, { kind: "prepared", arm: a.id, run: Number(run), startCommit: made.commit });
  return { paths, record };
}

/**
 * Web-Bench's pass@1, pass@2 and error@1 for one run, as its report counts
 * them, over all the project's tasks (a task never given counts as not passed).
 */
export function scoreOf(perTask, total) {
  const outcomes = perTask.map((t) => t.attempts);
  const passTasks = getPassCounts(outcomes, total, RETRY);
  const errors = getErrorCounts(outcomes, RETRY);
  return {
    tasks: total,
    given: perTask.length,
    passTasks,
    pass: Object.fromEntries(passTasks.map((c, i) => [`pass@${i + 1}`, rate(c, total)])),
    errorTasks: errors,
    error: Object.fromEntries(errors.map((c, i) => [`error@${i + 1}`, rate(c, total)])),
  };
}

/**
 * A whole Web-Bench cell: task 1 to task 20 in order, each given by
 * `attempt` (the row's: `oneShotAttempt`, `claudeCodeAttempt`,
 * `sekhemetAttempt`) and scored by `scoreTask` with the sealed material
 * attached; a failed task gets one retry carrying the cleaned test output; the
 * run stops after a task fails both. An agentic cell is refused unless the OS
 * isolation check passes, and no host serving Web-Bench's tests can be
 * reached (`networkProbe`, a TCP connect by default), before every attempt.
 * Writes `score.json` beside `run.json` and `log.jsonl`.
 */
export async function runWebBench({
  armId,
  run,
  attempt,
  env = process.env,
  manifestFile = MANIFEST,
  sealing = noSealing(),
  workers = 1,
  networkProbe = tcpProbe,
}) {
  const a = armOf(armId);
  const paths = webbenchRunPaths(a.id, run, env);
  let record = readRecord(paths);
  if (!record) record = prepareWebBench({ armId, run, env, manifestFile, sealing }).record;
  if (readLog(paths).some((e) => e.kind === "start"))
    throw new Error(`${paths.dir} has already run: a run is never repeated in place`);
  const manifest = readManifest(manifestFile);
  const tasks = await whileAttached(sealing, () => {
    const problems = drift(webbenchDir(env), manifest);
    if (problems.length)
      throw new Refusal(
        `the Web-Bench checkout differs from the pinned one: ${problems.join("; ")}`,
      );
    return readTasks(webbenchDir(env), manifest);
  });
  mkdirSync(paths.input, { recursive: true });
  logEvent(paths, { kind: "start", benchmark: "web-bench", tasks: tasks.length });
  const perTask = [];
  let stoppedAt = null;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const n = i + 1;
    const attempts = [];
    let error;
    for (let times = 1; times <= RETRY; times++) {
      await refuseUnlessIsolated(a, paths, env, networkProbe);
      logEvent(paths, {
        kind: "given",
        task: task.id,
        attempt: times,
        taskSha256: sha256(task.description),
        retryWith: error
          ? { errorSha256: sha256(error), errorBytes: Buffer.byteLength(error) }
          : null,
      });
      let failure = null;
      try {
        await attempt({ a, paths, n, attempt: times, task, error, record, env });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        logEvent(paths, { kind: "attempt_failed", task: task.id, attempt: times, why: failure });
      }
      const result = failure
        ? { passed: false, error: failure, exit: null, runs: 0 }
        : await whileAttached(sealing, () =>
            scoreTask({ tree: paths.repo, n, env, manifest, workers }),
          );
      if (!result.passed)
        writeFileSync(join(paths.input, `${attemptId(n, times)}-error.txt`), result.error);
      logEvent(paths, {
        kind: "tested",
        task: task.id,
        attempt: times,
        passed: result.passed,
        exit: result.exit,
        runs: result.runs,
        minutes: result.minutes ?? null,
        errorSha256: result.passed ? null : sha256(result.error),
        outputSha256: result.outputSha256 ?? null,
      });
      attempts.push(result.passed);
      if (result.passed) break;
      error = result.error || undefined;
    }
    perTask.push({ id: task.id, attempts });
    if (!attempts.some(Boolean)) {
      stoppedAt = task.id;
      break;
    }
  }
  logEvent(paths, { kind: "end", stoppedAt });
  const score = {
    about:
      "One Web-Bench run's score (W2b G3): Web-Bench's pass@1, pass@2 and error@1 (projects/readme.md), as percentages of all the project's tasks.",
    benchmark: "web-bench",
    project: manifest.project,
    commit: manifest.commit,
    arm: a.id,
    row: a.row,
    column: a.column,
    model: a.model,
    run: Number(run),
    scoredAt: new Date().toISOString(),
    ...scoreOf(perTask, tasks.length),
    perTask,
    stoppedAt,
    effort: effort(readLog(paths)),
  };
  writeFileSync(join(paths.dir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
  return { paths, score };
}

/** Tokens and minutes from a run's log, as every cell records them. */
function effort(log) {
  const sum = { inputTokens: 0, outputTokens: 0, costUsd: 0, testMinutes: 0 };
  const notCounted = new Set();
  for (const e of log) {
    if (e.kind === "usage" && e.notCounted) notCounted.add(e.notCounted);
    if (e.kind === "usage") {
      sum.inputTokens += e.inputTokens ?? 0;
      sum.outputTokens += e.outputTokens ?? 0;
      sum.costUsd += e.costUsd ?? 0;
    }
    if (e.kind === "tested") sum.testMinutes += e.minutes ?? 0;
  }
  const start = log.find((e) => e.kind === "start");
  const end = log.find((e) => e.kind === "end");
  return {
    ...sum,
    costUsd: Math.round(sum.costUsd * 10000) / 10000,
    testMinutes: Math.round(sum.testMinutes * 100) / 100,
    wallMinutes:
      start && end
        ? Math.round(((Date.parse(end.at) - Date.parse(start.at)) / 60_000) * 10) / 10
        : null,
    // Some of the arm's models left out (the Sekhemet row: the Coding model's only): not comparable.
    tokensNotCounted: notCounted.size ? [...notCounted].join("; ") : null,
  };
}

/**
 * Every scored Web-Bench run under the runs root, by arm: each run's pass@1
 * and pass@2 as they fall, and their mean. Reported as runs, not best of
 * five (the paper's per-project figure).
 */
export function webbenchStats(env = process.env) {
  const root = runsRoot(env);
  const arms = {};
  if (!existsSync(root)) return { arms };
  for (const dir of readdirSync(root)
    .filter((d) => d.startsWith("webbench-"))
    .sort()) {
    for (const r of readdirSync(join(root, dir)).sort((x, y) => Number(x) - Number(y))) {
      const file = join(root, dir, r, "score.json");
      if (!existsSync(file)) continue;
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (!arms[s.arm]) arms[s.arm] = { row: s.row, column: s.column, runs: [] };
      arms[s.arm].runs.push({ run: s.run, ...s.pass, ...s.error, stoppedAt: s.stoppedAt });
    }
  }
  const mean = (xs) => Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 100) / 100;
  for (const a of Object.values(arms)) {
    a.mean = {
      "pass@1": mean(a.runs.map((r) => r["pass@1"])),
      "pass@2": mean(a.runs.map((r) => r["pass@2"])),
    };
  }
  return { arms };
}

/** A shell command a person gives for attaching or detaching the sealed volume; it must exit 0. */
function shellSealing(attachCmd, detachCmd) {
  if (!attachCmd && !detachCmd) return noSealing();
  if (!attachCmd || !detachCmd) throw new Refusal("--attach and --detach go together");
  const sh = (cmd) => {
    const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`\`${cmd}\` exited ${r.status}`);
  };
  return { attach: () => sh(attachCmd), detach: () => sh(detachCmd) };
}

function flagsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

/** The row's attempt for a grid cell, as the command line builds it. */
async function attemptFor(a, f) {
  if (a.row === "one-shot") {
    const asker = await askerFor(a, {
      baseUrl: f["base-url"],
      registryPath:
        f.registry ??
        process.env.SEKHEMET_MODEL_REGISTRY ??
        join(process.env.HOME ?? "", ".sekhemet", "models.json"),
      reasoning: ONE_SHOT.reasoning,
    });
    return oneShotAttempt(asker.ask);
  }
  if (a.kind === "claude-code") return claudeCodeAttempt();
  if (a.kind === "sekhemet")
    return sekhemetAttempt({
      url: f.url,
      ...(typeof f.csrf === "string" ? { csrf: f.csrf } : {}),
      ...(typeof f.cli === "string" ? { cli: resolve(f.cli) } : {}),
    });
  throw new Refusal(`${a.id} has no Web-Bench attempt`);
}

async function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const src = resolve(opt("--src", DEFAULT_SRC));
  const manifestFile = resolve(opt("--manifest", MANIFEST));
  try {
    const f = flagsOf(argv);
    const [command] = f._;
    if (command === "prepare" || command === "run") {
      const a = armOf(f.arm);
      const sealing = shellSealing(f.attach, f.detach);
      if (command === "prepare") {
        const { paths } = prepareWebBench({ armId: a.id, run: f.run, manifestFile, sealing });
        console.log(
          a.kind === "sekhemet"
            ? `The run's repository: ${paths.repo}\nStart the dashboard on it in another terminal (Solo), its models assigned beforehand:\n  node apps/harness/dist/index.js serve --repo ${paths.repo} --port 7700\nthen run the cell:\n  node scripts/capstone/webbench.mjs run --arm ${a.id} --run ${f.run} --url http://127.0.0.1:7700 --attach <cmd> --detach <cmd>`
            : `The run's repository: ${paths.repo}`,
        );
        return 0;
      }
      const { paths, score } = await runWebBench({
        armId: a.id,
        run: f.run,
        manifestFile,
        sealing,
        attempt: await attemptFor(a, f),
        workers: f.workers ? Number(f.workers) : 1,
      });
      console.log(
        `${a.id} run ${f.run}: pass@1 ${score.pass["pass@1"]}%, pass@2 ${score.pass["pass@2"]}% of ${score.tasks} tasks${score.stoppedAt ? `; stopped at ${score.stoppedAt}` : ""}. The run: ${paths.dir}`,
      );
      return 0;
    }
    if (command === "stats") {
      process.stdout.write(`${JSON.stringify(webbenchStats(), null, 2)}\n`);
      return 0;
    }
    if (argv.includes("--deps-package")) {
      const dir = resolve(opt("--deps-package", ""));
      const manifest = readManifest(manifestFile);
      const problems = drift(src, manifest);
      if (problems.length) throw new Refusal(`the checkout differs: ${problems.join("; ")}`);
      const lock = readFileSync(join(src, "common", "config", "rush", "pnpm-lock.yaml"), "utf8");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "webbench-contestant-packages", private: true, description: `The packages of Web-Bench ${manifest.project} at ${manifest.commit}, from its lockfile, less the tests' own.`, dependencies: lockedPackages(lock, manifest.project) }, null, 2)}\n`,
      );
      return 0;
    }
    if (argv.includes("--write")) {
      writeFileSync(manifestFile, `${JSON.stringify(freeze(src), null, 2)}\n`);
      return 0;
    }
    if (argv.includes("--check") || argv.includes("--task")) {
      const manifest = readManifest(manifestFile);
      let n = 0;
      if (argv.includes("--task")) {
        n = Number(opt("--task", ""));
        if (!Number.isInteger(n) || n < 1 || n > manifest.tasks.length) {
          throw new Refusal(`--task takes 1 to ${manifest.tasks.length}`);
        }
      }
      const problems = drift(src, manifest);
      if (problems.length > 0) {
        process.stderr.write(
          `The Web-Bench checkout differs from the pinned one:\n${problems.map((p) => `  ${p}\n`).join("")}`,
        );
        return 1;
      }
      if (n === 0) return 0;
      const task = parseTasks(readFileSync(join(src, manifest.project, "tasks.yml"), "utf8"))[
        n - 1
      ];
      if (sha256(task.description) !== manifest.tasks[n - 1].sha256) {
        process.stderr.write(`task-${n}'s text does not match its recorded SHA-256\n`);
        return 1;
      }
      process.stdout.write(task.description);
      return 0;
    }
    throw new Refusal(
      "usage: webbench.mjs --check | --task <n> | --write | --deps-package <dir> [--src <dir>] [--manifest <file>] | prepare --arm <id> --run <n> | run --arm <id> --run <n> [--base-url <url>] [--url <dashboard>] [--attach <cmd> --detach <cmd>] | stats",
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof Refusal ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
