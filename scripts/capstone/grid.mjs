/**
 * The capstone's grid (W2 G5; CAPSTONE_SELECTION "Protocol"): the arms, where
 * a run lives, the frozen texts every arm is given, and the run's log.
 *
 * Rows are one shot (the prompt, one reply, no tools, no retries) and with its
 * harness (the prompt, then free to work); columns are the models. Every arm
 * is given `prompt.md` first and `change_request.md` at the fixed point, and
 * each is checked against its SHA-256 in `manifest.json` immediately before it
 * is given: a changed file is refused, never sent.
 *
 * A run lives under the runs root (`SEKHEMET_CAPSTONE_RUNS`, by default
 * `~/capstone-runs`), outside this repository, outside `~/.sekhemet` (where
 * the sealed suite and Web-Bench's checkout sit, and which the product's
 * sandbox denies) and outside the hidden suite's directory, which this module
 * never reads. `isolationProblems` is the check an agentic run must pass
 * first: nothing sealed, and no other run, readable by the contestant.
 */
import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TIMESHEET_DIR = join(REPO_ROOT, "fixtures", "capstone", "timesheet");
/**
 * The hidden suite's record (hashes and counts, no content). It sits beside
 * the contestant-visible `timesheet/` directory, never inside it.
 */
export const HIDDEN_MANIFEST = join(REPO_ROOT, "fixtures", "capstone", "hidden.manifest.json");

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The cells of the grid. `model` is what the cell's harness is given: a
 * registry id for a local model, a Claude model id for a Claude one.
 */
export const ARMS = [
  {
    id: "one-shot-nail-mtp",
    row: "one-shot",
    column: "nail-mtp",
    kind: "local",
    model: "nail-mtp",
  },
  {
    id: "one-shot-qwen3.8-27b",
    row: "one-shot",
    column: "Qwen3.8-27B",
    kind: "local",
    model: "qwen3.8-27b-ud-q3-k-xl",
  },
  {
    id: "one-shot-opus",
    row: "one-shot",
    column: "Opus 5.5",
    kind: "claude",
    model: "claude-opus-5-5",
  },
  {
    id: "one-shot-sonnet",
    row: "one-shot",
    column: "Sonnet 5",
    kind: "claude",
    model: "claude-sonnet-5",
  },
  {
    id: "one-shot-haiku",
    row: "one-shot",
    column: "Haiku 4.5",
    kind: "claude",
    model: "claude-haiku-4-5",
  },
  { id: "sekhemet-local", row: "harness", column: "nail-mtp", kind: "sekhemet", model: "nail-mtp" },
  {
    id: "claude-code-opus",
    row: "harness",
    column: "Opus 5.5",
    kind: "claude-code",
    model: "claude-opus-5-5",
  },
  {
    id: "claude-code-sonnet",
    row: "harness",
    column: "Sonnet 5",
    kind: "claude-code",
    model: "claude-sonnet-5",
  },
  {
    id: "claude-code-haiku",
    row: "harness",
    column: "Haiku 4.5",
    kind: "claude-code",
    model: "claude-haiku-4-5",
  },
];

export function arm(id) {
  const a = ARMS.find((x) => x.id === id);
  if (!a) throw new Error(`no arm ${id}; the arms are ${ARMS.map((x) => x.id).join(", ")}`);
  return a;
}

/**
 * Every word that names an arm, a harness, a model or its maker: what a blind
 * packet may not contain. Matched whole-word and case-insensitively.
 */
export const IDENTITY_WORDS = [
  "claude",
  "anthropic",
  "opus",
  "sonnet",
  "haiku",
  "sekhemet",
  "seshat",
  "nail",
  "qwen",
  "qwen3",
  "tiel",
  "cyber-tiel",
  "llama",
  "ollama",
  "one-shot",
  "one shot",
  "oneshot",
  "codex",
  "gpt",
  ...ARMS.map((a) => a.id),
];

/** The identity words as one whole-word, case-insensitive pattern (global). */
export function identityPattern() {
  const escaped = [...new Set(IDENTITY_WORDS)]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[-_ ]?"));
  return new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join("|")})(?![A-Za-z0-9])`, "gi");
}

export function runsRoot(env = process.env) {
  return resolve(env.SEKHEMET_CAPSTONE_RUNS || join(homedir(), "capstone-runs"));
}

export function hiddenDir(env = process.env) {
  return resolve(env.SEKHEMET_CAPSTONE_HIDDEN || join(homedir(), ".sekhemet", "capstone-hidden"));
}

/**
 * Where scoring copies anything sealed (the tree at `release-1` of the
 * reference, the suite's catalogue and its own install): beside the hidden
 * suite's directory and on its volume, mode 700, never the shared temp
 * directory. Not inside it, because the suite refuses to score a tree there.
 */
export function sealedScratchRoot(env = process.env) {
  return `${hiddenDir(env)}-scratch`;
}

/** Web-Bench's checkout (public tests and reference solution): sealed like the hidden suite. */
export function webbenchDir(env = process.env) {
  return resolve(env.SEKHEMET_WEBBENCH_SRC || join(homedir(), ".sekhemet", "webbench-src"));
}

const within = (child, parent) => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(`${p}${sep}`);
};

/**
 * Why the runs root may not hold a run: inside this repository, inside the
 * hidden suite's directory, or inside `~/.sekhemet` (a sibling of the sealed
 * suite and of Web-Bench's checkout, and denied to sandboxed commands by the
 * product's Seatbelt profile, so a Sekhemet run there could not read its own
 * sources). Null when it may.
 */
export function runsRootRefusal(env = process.env) {
  const root = runsRoot(env);
  if (within(root, hiddenDir(env))) return "the runs root is inside the hidden suite's directory";
  if (within(root, REPO_ROOT)) return "the runs root is inside this repository";
  const dotSekhemet = resolve(env.HOME || homedir(), ".sekhemet");
  if (within(root, dotSekhemet))
    return `the runs root ${root} is inside ${dotSekhemet}, beside the sealed suite; set SEKHEMET_CAPSTONE_RUNS elsewhere`;
  return null;
}

const readable = (path) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** Scratch copies the scorer or the suite's own tools once left in the shared temp directory. */
const SEALED_SCRATCH = /^(capstone-score-|capstone-findings-|ts-hidden-)/;

/**
 * Everything that keeps an agentic run (Claude Code, Sekhemet) from being
 * sealed off, as the OS sees it from this user, the one the run's harness
 * runs as. Permission rules inside a harness are not a boundary, so this is
 * what is checked:
 * - the hidden suite's directory, its scratch directory and Web-Bench's
 *   checkout are not readable (their volume is detached, or they belong to
 *   another user with mode 700);
 * - no other run's directory under the runs root is readable (a finished run
 *   is moved to the sealed volume before the next agentic run starts);
 * - no scorer scratch copy is left in the shared temp directory.
 * Empty when the run may start.
 */
export function isolationProblems(paths, env = process.env) {
  const problems = [];
  for (const [what, dir] of [
    ["the hidden suite", hiddenDir(env)],
    ["Web-Bench's checkout", webbenchDir(env)],
    ["the sealed scratch directory", sealedScratchRoot(env)],
  ]) {
    if (readable(dir))
      problems.push(
        `${what} at ${dir} is readable by this user: detach its volume, or make it another user's with mode 700, before an agentic run`,
      );
  }
  const root = runsRoot(env);
  if (existsSync(root)) {
    for (const a of readdirSync(root, { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      const armDir = join(root, a.name);
      if (!readable(armDir)) continue;
      for (const r of readdirSync(armDir, { withFileTypes: true })) {
        const dir = join(armDir, r.name);
        if (!r.isDirectory() || resolve(dir) === resolve(paths.dir)) continue;
        if (readable(dir))
          problems.push(
            `another run, ${a.name}/${r.name}, is readable under the runs root: move finished runs to the sealed volume first`,
          );
      }
    }
  }
  const tmp = env.TMPDIR || tmpdir();
  if (existsSync(tmp)) {
    for (const name of readdirSync(tmp)) {
      if (SEALED_SCRATCH.test(name) && readable(join(tmp, name)))
        problems.push(`${join(tmp, name)} is a scorer scratch copy in the shared temp directory`);
    }
  }
  return problems;
}

/** A run's directories: `repo` is the contestant's working directory, the rest sit beside it. */
export function runPaths(armId, run, env = process.env) {
  if (!/^[1-9][0-9]?$/.test(String(run))) throw new Error(`a run is numbered 1 to 99, not ${run}`);
  const dir = join(runsRoot(env), armId, String(run));
  return {
    dir,
    repo: join(dir, "repo"),
    input: join(dir, "input"),
    log: join(dir, "log.jsonl"),
    record: join(dir, "run.json"),
  };
}

/** The frozen manifest (`manifest.json`) of the capstone's input. */
export function frozenManifest(fixture = TIMESHEET_DIR) {
  return JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf8"));
}

/**
 * One frozen text (`prompt.md` or `change_request.md`), read now and refused
 * unless its SHA-256 is the manifest's. Returns the text and its hash.
 */
export function frozenText(name, fixture = TIMESHEET_DIR) {
  const recorded = frozenManifest(fixture).files?.[name]?.sha256;
  if (!recorded) throw new Error(`${name} is not in the frozen manifest`);
  const bytes = readFileSync(join(fixture, name));
  const got = sha256(bytes);
  if (got !== recorded) {
    throw new Error(
      `${name} has SHA-256 ${got}, not the frozen ${recorded}: refused (render_prompt.mjs --check)`,
    );
  }
  return { name, text: bytes.toString("utf8"), sha256: got, bytes: bytes.length };
}

/** A copy of a frozen text for a person to give an arm, written where the arm cannot reach it. */
export function writeInput(paths, frozen) {
  mkdirSync(paths.input, { recursive: true });
  const file = join(paths.input, frozen.name);
  writeFileSync(file, frozen.text);
  if (sha256(readFileSync(file)) !== frozen.sha256)
    throw new Error(`${file} did not write back identical`);
  return file;
}

/** Append one event to the run's log; every simulated decision and every step goes here. */
export function logEvent(paths, event, now = () => new Date()) {
  mkdirSync(dirname(paths.log), { recursive: true });
  const line = { at: now().toISOString(), ...event };
  appendFileSync(paths.log, `${JSON.stringify(line)}\n`);
  return line;
}

export function readLog(paths) {
  if (!existsSync(paths.log)) return [];
  return readFileSync(paths.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function readRecord(paths) {
  return existsSync(paths.record) ? JSON.parse(readFileSync(paths.record, "utf8")) : null;
}

export function writeRecord(paths, record) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
