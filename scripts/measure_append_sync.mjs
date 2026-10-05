#!/usr/bin/env node
// K-N11-1 (kernel rule 38, NEW-kernel-11; FINDINGS_C1 REL-16): the cost of
// one ledger append under `synchronous = NORMAL` against `synchronous = FULL`
// with `fullfsync` and `checkpoint_fullfsync` on, measured on this machine.
//
//   node scripts/measure_append_sync.mjs [--dir <folder on the volume to measure>]
//        [--appends 600] [--rounds 3] [--appends-per-step 10]
//        [--steps-from evidence/injection_2026-10-04.json] [--out <file.json>]
//
// Each round opens a fresh WAL ledger through the kernel's own `initSchema`
// and `EventLog` (built `packages/kernel/dist`), sets the mode under test,
// and times single appends (`EventLog.append`, one transaction each, with a
// private part like a real step's), one after another, as the Worker's loop
// writes them. The modes alternate round by round so drift on the machine
// hits both. The median Worker step comes from a live run's evidence (each
// card's seconds over its steps), and the added cost per step is
// appends-per-step x (p95 FULL - p95 NORMAL).
//
// Policy bound (set by the lead with this measurement, kernel rule 38): FULL
// is adopted when its p95 single append is at most 25 ms AND the added cost
// per median step is under 1 %. Run with `tsc -b` done; nothing is loaded.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const kernel = await import(pathToFileURL(join(ROOT, "packages/kernel/dist/index.js")).href);

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = resolve(flag("dir", tmpdir()));
const appends = Number(flag("appends", "600"));
const rounds = Number(flag("rounds", "3"));
const appendsPerStep = Number(flag("appends-per-step", "10"));
const stepsFrom = resolve(ROOT, flag("steps-from", "evidence/injection_2026-10-04.json"));
const out = flag("out", undefined);

const MODES = {
  NORMAL: ["PRAGMA synchronous = NORMAL"],
  FULL: ["PRAGMA synchronous = FULL", "PRAGMA fullfsync = ON", "PRAGMA checkpoint_fullfsync = ON"],
};

function quantile(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

async function round(mode) {
  const folder = mkdtempSync(join(dir, "sekhemet-append-sync-"));
  const db = new DatabaseSync(join(folder, "events.db"));
  try {
    kernel.initSchema(db);
    for (const sql of MODES[mode]) db.exec(sql);
    const reported = db.prepare("PRAGMA synchronous").get().synchronous;
    const log = new kernel.EventLog(db);
    const body = { text: "x".repeat(400) };
    for (let i = 0; i < 50; i++) {
      await log.append({ actor: "executor", type: "measure/warmup", payload: { i } });
    }
    const times = [];
    for (let i = 0; i < appends; i++) {
      const t0 = performance.now();
      await log.append({
        actor: "executor",
        type: "measure/append",
        cardId: "card_measure",
        payload: { i, tool: "read_file", ok: true },
        private: body,
      });
      times.push(performance.now() - t0);
    }
    return { reported, times };
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

const samples = { NORMAL: [], FULL: [] };
const reported = {};
for (let r = 0; r < rounds; r++) {
  for (const mode of r % 2 === 0 ? ["NORMAL", "FULL"] : ["FULL", "NORMAL"]) {
    const res = await round(mode);
    samples[mode].push(...res.times);
    reported[mode] = res.reported;
  }
}

const summary = {};
for (const mode of Object.keys(samples)) {
  const sorted = [...samples[mode]].sort((a, b) => a - b);
  summary[mode] = {
    synchronousPragma: reported[mode],
    n: sorted.length,
    p50Ms: +quantile(sorted, 0.5).toFixed(3),
    p95Ms: +quantile(sorted, 0.95).toFixed(3),
    p99Ms: +quantile(sorted, 0.99).toFixed(3),
    maxMs: +sorted[sorted.length - 1].toFixed(3),
  };
}

const evidence = JSON.parse(readFileSync(stepsFrom, "utf8"));
const perStep = evidence.results
  .filter((r) => r.turns > 0 && r.seconds > 0)
  .map((r) => r.seconds / r.turns)
  .sort((a, b) => a - b);
const medianStepS = perStep.length ? quantile(perStep, 0.5) : Number.NaN;
const addedPerStepMs = appendsPerStep * (summary.FULL.p95Ms - summary.NORMAL.p95Ms);
const addedShare = addedPerStepMs / (medianStepS * 1000);
const result = {
  measuredAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.versions.node,
  dir,
  appendsPerRound: appends,
  rounds,
  modes: summary,
  medianWorkerStep: {
    seconds: +medianStepS.toFixed(2),
    from: stepsFrom.replace(`${ROOT}/`, ""),
    cards: perStep.length,
  },
  appendsPerStep,
  addedPerMedianStepMs: +addedPerStepMs.toFixed(2),
  addedShareOfMedianStep: +(addedShare * 100).toFixed(3),
  bound: { p95MsAtMost: 25, addedShareBelowPercent: 1 },
  adoptFull: summary.FULL.p95Ms <= 25 && addedShare < 0.01,
};
const text = `${JSON.stringify(result, null, 2)}\n`;
if (out) writeFileSync(out, text);
process.stdout.write(text);
