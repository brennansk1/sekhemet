/**
 * The capstone's seed repository (W2 G2; CAPSTONE_SELECTION "Protocol").
 *
 * Every arm of the grid starts from the same empty repository with a pinned
 * toolchain: `fixtures/capstone/timesheet/seed/`. This script materialises it
 * as a fresh git repository for one run. The commit is built with a fixed
 * author, date and message and with no global or system git configuration, so
 * it is the same commit, byte for byte, on every run and every machine; its
 * hash, its tree and every file's SHA-256 are frozen in `seed.json`, and a
 * repository that does not come out at that commit is refused and removed.
 *
 * It also refuses to run on a Node.js other than the seed's pinned one, and
 * to materialise inside this repository, inside the hidden suite's directory
 * (`SEKHEMET_CAPSTONE_HIDDEN`, by default under `~/.sekhemet`), inside any
 * other git repository (a contestant could read its parent's files), or into a
 * directory that is not empty.
 *
 *   node scripts/capstone/seed.mjs <dest> [--record <file>]   one run's repository; prints its record
 *   node scripts/capstone/seed.mjs --check                    exit 1 on any drift from seed.json
 *   node scripts/capstone/seed.mjs --write                    re-freeze seed.json
 *   node scripts/capstone/seed.mjs --render                   the seed as text, for a one-shot arm
 *
 * Each takes `--fixture <dir>` (the directory holding `seed/` and `seed.json`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TIMESHEET_DIR = join(REPO_ROOT, "fixtures", "capstone", "timesheet");

/** The seed commit's fixed identity: the same bytes on every run. */
export const IDENTITY = {
  name: "Seed",
  email: "seed@example.invalid",
  date: "2026-09-29T00:00:00+00:00",
};
export const MESSAGE = "An empty repository with a pinned toolchain";
export const TAG = "seed";
export const BRANCH = "main";

/** Directories an install, a build or a run may leave in the seed; never copied. */
const SKIP = new Set([".git", "node_modules", "dist", "data"]);

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const seedDir = (fixture) => join(fixture, "seed");
const recordPath = (fixture) => join(fixture, "seed.json");

/** The seed's files, as sorted POSIX paths relative to it; a link is refused. */
export function seedFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (SKIP.has(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) throw new Error(`the seed may not hold a link: ${path}`);
      if (stat.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
}

/** The Node.js version the seed pins (its `.nvmrc`). */
export function pinnedNode(fixture = TIMESHEET_DIR) {
  return readFileSync(join(seedDir(fixture), ".nvmrc"), "utf8").trim();
}

export function hiddenDir(env = process.env) {
  return resolve(env.SEKHEMET_CAPSTONE_HIDDEN || join(homedir(), ".sekhemet", "capstone-hidden"));
}

/** A path with its existing part resolved through links (on macOS /tmp is /private/tmp). */
function real(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...tail);
}

function within(child, parent) {
  const r = relative(real(parent), real(child));
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

/** The git work tree that already holds `dest`'s nearest existing directory, or null. */
function enclosingRepository(dest) {
  let head = resolve(dest);
  while (!existsSync(head) && dirname(head) !== head) head = dirname(head);
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: head,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
    },
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Why `dest` may not receive a seed repository, or null when it may. */
export function refusal(dest, env = process.env) {
  if (within(dest, REPO_ROOT)) return `${dest} is inside the Sekhemet repository`;
  if (within(dest, hiddenDir(env))) return `${dest} is inside the hidden suite's directory`;
  const outer = enclosingRepository(dest);
  if (outer) return `${dest} is inside the git repository ${outer}`;
  if (existsSync(dest) && readdirSync(dest).length > 0) return `${dest} is not empty`;
  return null;
}

/** git with no global or system configuration and nothing else inherited. */
function git(cwd, args) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: cwd,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: IDENTITY.date,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: IDENTITY.date,
    LC_ALL: "C",
    TZ: "UTC",
  };
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Copy the seed into `dest` and commit it; returns the commit and tree. No checks. */
function build(fixture, dest) {
  const src = seedDir(fixture);
  mkdirSync(dest, { recursive: true });
  for (const path of seedFiles(src)) {
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    cpSync(join(src, path), join(dest, path));
  }
  git(dest, [
    "init",
    "--quiet",
    "--template=",
    `--initial-branch=${BRANCH}`,
    "--object-format=sha1",
  ]);
  git(dest, ["add", "--all"]);
  git(dest, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", MESSAGE]);
  git(dest, ["tag", TAG]);
  return {
    commit: git(dest, ["rev-parse", "HEAD"]),
    tree: git(dest, ["rev-parse", "HEAD^{tree}"]),
  };
}

export function loadRecord(fixture = TIMESHEET_DIR) {
  return JSON.parse(readFileSync(recordPath(fixture), "utf8"));
}

function wrongNode(fixture) {
  const pinned = pinnedNode(fixture);
  return process.versions.node === pinned
    ? null
    : `the seed pins Node.js ${pinned}, and this is Node.js ${process.versions.node}`;
}

/**
 * One run's repository at `dest`: refused before anything is written when
 * Node is not the pinned one or `dest` is not allowed, and removed again when
 * it does not come out at the recorded commit. Returns the run's record.
 */
export function materialise(dest, { fixture = TIMESHEET_DIR, env = process.env } = {}) {
  const why = wrongNode(fixture) ?? refusal(dest, env);
  if (why) throw new Error(why);
  const existed = existsSync(dest);
  const recorded = loadRecord(fixture);
  let made;
  try {
    made = build(fixture, dest);
    if (made.commit !== recorded.commit) {
      throw new Error(
        `the seed gave commit ${made.commit}, not the recorded seed commit ${recorded.commit}: run --check`,
      );
    }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    if (existed) mkdirSync(dest);
    throw err;
  }
  return {
    seedCommit: made.commit,
    seedTree: made.tree,
    tag: TAG,
    branch: BRANCH,
    dest: real(dest),
    node: process.version,
    npm: npmVersion(),
    listingSha256: recorded.listingSha256,
    createdAt: new Date().toISOString(),
  };
}

function npmVersion() {
  const r = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The seed as one text in the format the prompt asks a text-only reply to use
 * (`### path`, then one fenced block holding the whole file), sorted by path.
 */
export function renderListing(fixture = TIMESHEET_DIR) {
  const src = seedDir(fixture);
  return seedFiles(src)
    .map((path) => {
      const body = readFileSync(join(src, path), "utf8");
      const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longest + 1);
      return `### ${path}\n\n${fence}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}\n`;
    })
    .join("\n");
}

function freshRecord(fixture) {
  const scratch = mkdtempSync(join(tmpdir(), "capstone-seed-"));
  try {
    const { commit, tree } = build(fixture, join(scratch, "repo"));
    const src = seedDir(fixture);
    return {
      about:
        "The capstone's seed repository (W2 G2): the commit scripts/capstone/seed.mjs gives every arm, its tree and every file's SHA-256, and the SHA-256 of its text rendering for an arm that cannot open a repository. Written by seed.mjs --write; never edited by hand.",
      node: pinnedNode(fixture),
      commit,
      tree,
      files: Object.fromEntries(
        seedFiles(src).map((path) => [path, sha256(readFileSync(join(src, path), "utf8"))]),
      ),
      listingSha256: sha256(renderListing(fixture)),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Re-freeze `seed.json` from the seed as it is now. */
export function write(fixture = TIMESHEET_DIR) {
  const record = freshRecord(fixture);
  writeFileSync(recordPath(fixture), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Every way the seed differs from `seed.json`; empty when none. */
export function check(fixture = TIMESHEET_DIR) {
  let recorded;
  try {
    recorded = loadRecord(fixture);
  } catch {
    return ["seed.json: missing or not JSON"];
  }
  const now = freshRecord(fixture);
  const problems = [];
  const names = new Set([...Object.keys(recorded.files ?? {}), ...Object.keys(now.files)]);
  for (const name of [...names].sort()) {
    const was = recorded.files?.[name];
    const is = now.files[name];
    if (was === undefined) problems.push(`${name}: in the seed but not in seed.json`);
    else if (is === undefined) problems.push(`${name}: in seed.json but missing from the seed`);
    else if (was !== is) problems.push(`${name}: its SHA-256 is not the one in seed.json`);
  }
  for (const key of ["node", "commit", "tree", "listingSha256"]) {
    if (recorded[key] !== now[key]) {
      problems.push(`${key}: seed.json has ${recorded[key]}, the seed gives ${now[key]}`);
    }
  }
  return problems;
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const [, value] = args.splice(i, 2);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  const fixtureArg = take("--fixture");
  const fixture = fixtureArg ? resolve(fixtureArg) : TIMESHEET_DIR;
  const recordFile = take("--record");
  const [first, ...rest] = args;
  if (first === "--check" && rest.length === 0) {
    const problems = check(fixture);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      return 1;
    }
    console.log(`the seed is unchanged: commit ${loadRecord(fixture).commit}`);
    return 0;
  }
  if (first === "--write" && rest.length === 0) {
    console.log(`seed commit ${write(fixture).commit}`);
    return 0;
  }
  if (first === "--render" && rest.length === 0) {
    process.stdout.write(renderListing(fixture));
    return 0;
  }
  if (first && !first.startsWith("--") && rest.length === 0) {
    const record = materialise(resolve(first), { fixture });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (recordFile) writeFileSync(resolve(recordFile), text);
    process.stdout.write(text);
    return 0;
  }
  console.error(
    "usage: seed.mjs <dest> [--record <file>] | --check | --write | --render   [--fixture <dir>]",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
