#!/usr/bin/env node
// W9 (FINISH_LINE_PLAN §A, "CLI start": measured and recorded, then held to
// +20% of that figure). The time from spawning the built CLI to its exit for
// `sekhemet --help`, warm: one run first to fill the file cache, then
// `--runs` timed runs one after another, and the median is the figure.
//
//   node scripts/measure_cli_start.mjs [--runs 9] [--record] [--check]
//
// --record writes the figure, with the machine it was taken on, to
// evidence/cli_start_baseline.json. --check compares a fresh figure with
// that file and exits 1 when it is more than 20% slower (the release gate's
// `apps/harness/tests/perf/cli_start.spec.ts` runs it). Nothing is estimated:
// each run is a real `node apps/harness/dist/index.js --help`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "apps/harness/dist/index.js");
const BASELINE = join(ROOT, "evidence", "cli_start_baseline.json");
/** §A policy: held to +20% of the recorded figure. */
export const CLI_START_ALLOWANCE = 1.2;

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

function once() {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, "--help"], {
    encoding: "utf8",
    env: { ...process.env, SEKHEMET_MODEL_LOADS: "off", NO_COLOR: "1" },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`sekhemet --help exited ${r.status}: ${r.stderr}`);
  return ms;
}

const runs = Number(flag("--runs", "9")) || 9;
once();
const times = Array.from({ length: runs }, once).sort((a, b) => a - b);
const medianMs = Math.round(times[Math.floor(times.length / 2)]);
const figure = {
  medianMs,
  runsMs: times.map((t) => Math.round(t)),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  memoryGb: Math.round(totalmem() / 1024 ** 3),
  date: new Date().toISOString(),
};

if (process.argv.includes("--record")) {
  // The runs on one line, as the repository's formatter keeps a short array.
  const text = JSON.stringify(figure, null, 2).replace(
    /\[\n\s+([\d,\s]+?)\n\s+\]/,
    (_m, inner) => `[${inner.trim().split(/,\s*/).join(", ")}]`,
  );
  writeFileSync(BASELINE, `${text}\n`);
  console.log(`Recorded the CLI start: median ${medianMs} ms over ${runs} runs, in ${BASELINE}.`);
} else if (process.argv.includes("--check")) {
  if (!existsSync(BASELINE)) {
    console.error(`No recorded CLI start at ${BASELINE}: run with --record first.`);
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const limit = Math.round(base.medianMs * CLI_START_ALLOWANCE);
  const ok = medianMs <= limit;
  console.log(
    JSON.stringify({
      ok,
      medianMs,
      limitMs: limit,
      baselineMs: base.medianMs,
      baselineOn: base.cpu,
    }),
  );
  process.exitCode = ok ? 0 : 1;
} else {
  console.log(JSON.stringify(figure));
}
