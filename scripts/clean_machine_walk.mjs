#!/usr/bin/env node
/**
 * The clean-machine walk (FINDINGS_C1 INS-05; DEFINITION_OF_DONE §6.7;
 * FINISH_LINE_PLAN §G 8, W10, R9).
 *
 *   node scripts/clean_machine_walk.mjs --os macos|ubuntu [--log <file>]
 *
 * A stopwatch and checklist for the person walking a fresh macOS account or a
 * fresh Ubuntu VM from install to a first accepted issue. For each step it
 * shows what to run (the README's quickstart), waits for Enter to start it and
 * for Enter when it is done — or `done <note>`, `fail <note>`, `skip <reason>`
 * — and records each step's start, end and wall time to a JSON log. At the
 * end it asks whether any file was edited by hand.
 *
 * The person runs every command in their own terminal. This script runs
 * nothing that leaves the machine and downloads nothing: the only program it
 * starts is `git --version`, to record the host.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const os = argValue("--os");
if (os !== "macos" && os !== "ubuntu") {
  console.error("usage: node scripts/clean_machine_walk.mjs --os macos|ubuntu [--log <file>]");
  process.exit(2);
}
const logPath = resolve(
  argValue("--log") ??
    `clean_machine_walk_${os}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
);

/** The six steps INS-05 names, each with what the person runs (README Quickstart). */
const STEPS = [
  {
    id: "install",
    title: "Install",
    run:
      os === "macos"
        ? [
            "Node.js 22.13+, pnpm 10, git; llama.cpp's llama-server (brew install llama.cpp)",
            "git clone https://github.com/brennansk1/sekhemet.git && cd sekhemet",
            'pnpm install && pnpm build && alias sekhemet="node $PWD/apps/harness/dist/index.js"',
          ]
        : [
            "Node.js 22.13+, pnpm 10, git; sudo apt install bubblewrap socat; llama.cpp's llama-server",
            "Ubuntu 24.04+: the AppArmor profile for bubblewrap (README, Linux)",
            "git clone https://github.com/brennansk1/sekhemet.git && cd sekhemet",
            'pnpm install && pnpm build && alias sekhemet="node $PWD/apps/harness/dist/index.js"',
          ],
  },
  { id: "doctor", title: "Doctor", run: ["sekhemet doctor"] },
  {
    id: "model-download",
    title: "Model download",
    run: [
      "mkdir -p ~/.sekhemet/models && sekhemet models fetch --recommended --folder ~/.sekhemet/models",
      "(it shows sizes and licences, then asks; answer yes yourself)",
    ],
  },
  {
    id: "verification",
    title: "Verification",
    run: [
      "sekhemet doctor names each model still to verify, with the command; or Configuration › Models › Verify",
    ],
  },
  {
    id: "first-issue",
    title: "First issue",
    run: [
      "cd <your-project> && sekhemet",
      'sekhemet "<one sentence of work>"',
      "sekhemet approve <id>   (when the plan asks for it)",
      "sekhemet run",
    ],
  },
  { id: "accept", title: "Accept", run: ["sekhemet review", "sekhemet accept <issue>"] },
];

function hostFacts() {
  let git = "not found";
  try {
    git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  let sekhemet = "unknown";
  try {
    sekhemet = JSON.parse(
      readFileSync(join(ROOT, "apps", "harness", "package.json"), "utf8"),
    ).version;
  } catch {}
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    git,
    sekhemet,
  };
}

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
/** The next answer, or undefined when input ended. */
async function ask(prompt) {
  process.stdout.write(prompt);
  const next = await lines.next();
  if (next.done) return undefined;
  process.stdout.write("\n");
  return String(next.value).trim();
}

const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 10) / 100;
const log = {
  schema: 1,
  walk: "clean-machine",
  os,
  startedAt: new Date().toISOString(),
  host: hostFacts(),
  steps: [],
};
const save = () => writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

console.log(`Clean-machine walk on ${os}: six steps, each timed. The log is ${logPath}.`);
console.log(
  "Run every command yourself, in your own terminal; this script runs and downloads nothing.\n",
);
for (const [i, step] of STEPS.entries()) {
  console.log(`Step ${i + 1} of ${STEPS.length}: ${step.title}`);
  for (const l of step.run) console.log(`  ${l}`);
  if ((await ask("Press Enter to start it. ")) === undefined) break;
  const startedAt = new Date().toISOString();
  const answer = await ask(
    "Enter when it is done (or: done <note> | fail <note> | skip <reason>). ",
  );
  if (answer === undefined) break;
  const endedAt = new Date().toISOString();
  const [word, ...rest] = answer.split(/\s+/);
  const outcome = word === "fail" ? "failed" : word === "skip" ? "skipped" : "done";
  const note = (
    word === "fail" || word === "skip" || word === "done" ? rest.join(" ") : answer
  ).trim();
  log.steps.push({
    id: step.id,
    title: step.title,
    startedAt,
    endedAt,
    wallSeconds: seconds(startedAt, endedAt),
    outcome,
    ...(note ? { note } : {}),
  });
  save();
  console.log(`  ${step.title}: ${outcome}, ${seconds(startedAt, endedAt)} s.\n`);
}

const complete = log.steps.length === STEPS.length;
if (complete) {
  const edited = await ask("Did you edit any file by hand, in Sekhemet or in your project? [y/N] ");
  log.editedByHand = /^y(es)?$/i.test(edited ?? "");
}
log.finishedAt = new Date().toISOString();
log.totalWallSeconds = Math.round(log.steps.reduce((n, s) => n + s.wallSeconds, 0) * 100) / 100;
save();
rl.close();

const failed = log.steps.filter((s) => s.outcome === "failed").length;
if (!complete) {
  console.log(
    `The walk stopped after ${log.steps.length} of ${STEPS.length} steps; the log keeps them.`,
  );
  process.exit(1);
}
if (failed > 0)
  console.log(`The walk is not a pass: ${failed} step${failed === 1 ? "" : "s"} failed.`);
else if (log.editedByHand)
  console.log("The walk is not a pass: a file was edited by hand (DoD §6.7).");
else if (log.steps.some((s) => s.outcome === "skipped"))
  console.log(`Done in ${log.totalWallSeconds} s, with a step skipped; the log says why.`);
else console.log(`Every step done in ${log.totalWallSeconds} s; no file edited by hand.`);
console.log(`Log: ${logPath}`);
