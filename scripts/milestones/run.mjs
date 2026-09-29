#!/usr/bin/env node
/**
 * The milestone runners (MODERNIZATION_PLAN "Milestones the owner sees").
 *
 *   pnpm milestone <id> [flags]   one milestone: B1, B2.5, B3, B4.4, B4.10, B4.11
 *   pnpm milestone all            every one, in the plan's order
 *   pnpm milestone report         render docs/reference/MILESTONES.md from the evidence
 *
 * Each run writes `evidence/milestones/<id>_<date>.json` and re-renders
 * MILESTONES.md (unless `--no-report`). Build first (`tsc -b`): the runners
 * drive this checkout's `dist/`. None loads a model; B3 builds an older
 * commit (offline) for the upgrade, and `--old-build <dir>` reuses one.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ORIGINAL_ENV } from "./core.mjs";
import { EVIDENCE_DIR, MILESTONES, ROOT, renderMilestones, writeEvidence } from "./lib.mjs";

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if ((k === "HOME" || k.startsWith("SEKHEMET_")) && !(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k === "HOME" || k.startsWith("SEKHEMET_")) process.env[k] = v;
  }
}

const RUNNERS = Object.fromEntries(MILESTONES.filter((m) => m.runner).map((m) => [m.id, m]));

export function report() {
  let files = [];
  try {
    files = readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    // No evidence yet: every milestone reads NOT RUN.
  }
  const records = files.map((f) => {
    const path = join(EVIDENCE_DIR, f);
    return { ...JSON.parse(readFileSync(path, "utf8")), evidence: relative(ROOT, path) };
  });
  const page = join(ROOT, "docs", "reference", "MILESTONES.md");
  writeFileSync(page, renderMilestones(records));
  return page;
}

async function runOne(id, flags) {
  const m = RUNNERS[id];
  if (!m) throw new Error(`no milestone ${id}; one of ${Object.keys(RUNNERS).join(", ")}`);
  console.log(`\n== ${id}: ${m.title}`);
  const { run } = await import(`./${m.runner}`);
  let record;
  try {
    record = await run(flags);
  } finally {
    // A runner may isolate this process's HOME and Sekhemet directories; the next starts clean.
    restoreEnv();
  }
  const path = writeEvidence({ id, title: m.title, ...record });
  const ev = JSON.parse(readFileSync(path, "utf8"));
  for (const c of ev.checks) {
    console.log(
      `  ${c.ok === true ? "✓" : c.ok === false ? "✗" : "–"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
    );
  }
  console.log(`  ${id}: ${ev.verdict}${ev.reason ? ` (${ev.reason})` : ""}`);
  console.log(`  evidence: ${relative(ROOT, path)}`);
  return ev;
}

const [what, ...flags] = process.argv.slice(2);
if (!what) {
  console.error(`usage: pnpm milestone <${Object.keys(RUNNERS).join("|")}|all|report> [flags]`);
  process.exit(2);
}
const normal = (s) =>
  s.toUpperCase().replace(/^B(\d)_?(\d+)?$/, (_, a, b) => (b ? `B${a}.${b}` : `B${a}`));
if (what === "report") {
  console.log(`Wrote ${relative(ROOT, report())}`);
} else {
  const ids = what === "all" ? Object.keys(RUNNERS) : [normal(what)];
  let failed = false;
  for (const id of ids) {
    const ev = await runOne(id, flags);
    if (ev.verdict === "FAIL") failed = true;
  }
  if (!flags.includes("--no-report")) console.log(`\nWrote ${relative(ROOT, report())}`);
  process.exitCode = failed ? 1 : 0;
}
