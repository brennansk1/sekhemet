/**
 * The capstone's frozen input (W2 G1; CAPSTONE_SELECTION "Protocol").
 *
 * Every arm of the grid gets byte-identical text: `prompt.md` first (the
 * stakeholder's brief, her answers as an FAQ and the technical notes), and
 * `change_request.md` at the fixed point (the California change, its answers
 * and the changed notes). Both are rendered here from their sources in
 * `fixtures/capstone/timesheet/`, and `manifest.json` records their SHA-256
 * and the sources' so a runner can refuse to give an arm anything else.
 *
 * An arm that asks a question is answered by `answerFor`: word for word, the
 * script's answers whose keywords match, from the phases already given, or
 * the default answer. It never says more than the FAQ.
 *
 *   node scripts/capstone/render_prompt.mjs --write [dir]   render and re-freeze
 *   node scripts/capstone/render_prompt.mjs --check [dir]   exit 1 on any drift
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIMESHEET_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "capstone",
  "timesheet",
);

/** The files the two prompts are rendered from, each hashed in the manifest. */
export const SOURCES = [
  "brief.md",
  "contract.md",
  "change_letter.md",
  "contract_change.md",
  "stakeholder_script.json",
];

const FAQ_HEADING = "## My answers to the questions you might ask";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function loadScript(dir = TIMESHEET_DIR) {
  return JSON.parse(readFileSync(join(dir, "stakeholder_script.json"), "utf8"));
}

function faq(phase) {
  const lines = [FAQ_HEADING];
  for (const t of phase.topics) lines.push("", `**${t.question}**`, "", t.answer);
  return lines.join("\n");
}

/** One phase's message: its opening, the FAQ of its answers, its technical notes. */
export function renderPhase(dir, script, id) {
  const phase = script.phases.find((p) => p.id === id);
  if (!phase) throw new Error(`the stakeholder script has no phase ${id}`);
  const part = (name) => readFileSync(join(dir, name), "utf8").trimEnd();
  return `${[part(phase.opening), faq(phase), part(phase.notes)].join("\n\n")}\n`;
}

/** Every phase's message, keyed by the file it is frozen in. */
export function render(dir = TIMESHEET_DIR) {
  const script = loadScript(dir);
  return Object.fromEntries(script.phases.map((p) => [p.file, renderPhase(dir, script, p.id)]));
}

export function manifest(dir, files) {
  return {
    about:
      "The capstone's frozen input (W2 G1). Every arm gets prompt.md first and change_request.md at the change request's fixed point (stakeholder_script.json changeRequest), and each is checked against the SHA-256 here when given. Rendered by scripts/capstone/render_prompt.mjs; never edited by hand.",
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        { sha256: sha256(text), bytes: Buffer.byteLength(text) },
      ]),
    ),
    sources: Object.fromEntries(
      SOURCES.map((name) => [name, sha256(readFileSync(join(dir, name), "utf8"))]),
    ),
  };
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Render both prompts and re-freeze the manifest. */
export function write(dir = TIMESHEET_DIR) {
  const files = render(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "manifest.json"), json(manifest(dir, files)));
  return files;
}

/** Every way the frozen files differ from their sources and the manifest; empty when none. */
export function check(dir = TIMESHEET_DIR) {
  const problems = [];
  const readOrNull = (name) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return null;
    }
  };
  let recorded = { files: {}, sources: {} };
  try {
    recorded = JSON.parse(readOrNull("manifest.json") ?? "");
  } catch {
    problems.push("manifest.json: missing or not JSON");
  }
  for (const [name, text] of Object.entries(render(dir))) {
    const onDisk = readOrNull(name);
    if (onDisk !== text) problems.push(`${name}: differs from what its sources render`);
    if (onDisk !== null && recorded.files?.[name]?.sha256 !== sha256(onDisk)) {
      problems.push(`${name}: its SHA-256 is not the one in manifest.json`);
    }
  }
  for (const name of SOURCES) {
    const text = readOrNull(name);
    if (text === null) problems.push(`${name}: missing`);
    else if (recorded.sources?.[name] !== sha256(text)) {
      problems.push(`${name}: its SHA-256 is not the one in manifest.json`);
    }
  }
  return problems;
}

const normal = (text) =>
  ` ${text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()} `;

/**
 * The stakeholder's reply to a question: every answer, word for word, whose
 * topic has a keyword starting a word of the question, from the phases in
 * `given`, in script order and joined by a blank line; or the default answer.
 */
export function answerFor(script, given, question) {
  const q = normal(question);
  const hits = script.phases
    .filter((p) => given.includes(p.id))
    .flatMap((p) => p.topics)
    .filter((t) => t.keywords.some((k) => q.includes(normal(k).trimEnd())));
  return hits.length > 0 ? hits.map((t) => t.answer).join("\n\n") : script.defaultAnswer;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, dirArg] = process.argv.slice(2);
  const dir = dirArg ? resolve(dirArg) : TIMESHEET_DIR;
  if (mode === "--write") {
    const files = write(dir);
    for (const [name, text] of Object.entries(files)) console.log(`${name} ${sha256(text)}`);
  } else if (mode === "--check") {
    const problems = check(dir);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
    console.log("the capstone's frozen prompts are unchanged");
  } else {
    console.error("usage: render_prompt.mjs --write|--check [dir]");
    process.exit(2);
  }
}
