/**
 * The capstone's second run (W2 G4; CAPSTONE_SELECTION "The second run"): one
 * Web-Bench project, reused unchanged. The choice and its reasons are in
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
 *
 * Each takes `--src <dir>` and `--manifest <file>`. Exit 2 is a refusal or a
 * usage error. Installed packages (`node_modules`) are the only files ignored.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const src = resolve(opt("--src", DEFAULT_SRC));
  const manifestFile = resolve(opt("--manifest", MANIFEST));
  try {
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
      "usage: webbench.mjs --check | --task <n> | --write [--src <dir>] [--manifest <file>]",
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof Refusal ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
