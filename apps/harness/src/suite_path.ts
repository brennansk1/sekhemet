import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteRunResult } from "@sekhemet/eval";

/**
 * The one measurement path from inside the harness (measurement rule 9,
 * MS-M9-1): the rule gate and the bake-off run their fixtures through the
 * suite runner — `scripts/run_suite.mjs`, whose logic is the tested
 * `packages/eval` module — and so through the product's queue with its
 * shipped defaults. They used `scripts/run_gate.sh`, a second runner with no
 * blocking, no recorded profile and its own scoring.
 */

/** Runs a command to completion and returns its exit code; tests pass a scripted one. */
export type SuiteSpawn = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<number>;

const realSpawn: SuiteSpawn = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawnChild(command, args, { stdio: "inherit", env });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });

export interface SuitePathOptions {
  harnessRoot: string;
  worker: string;
  fixtures: string[];
  out: string;
  /** A settings file naming an arm (measurement rule 9a); recorded with its hash. */
  settingsFile?: string;
  /** Extra environment for the run (the rule gate's candidate rule). */
  env?: Record<string, string>;
  spawn?: SuiteSpawn;
}

/** Run the suite runner on the named fixtures and read its recorded result. */
export async function runSuitePath(o: SuitePathOptions): Promise<SuiteRunResult> {
  const args = [
    join(o.harnessRoot, "scripts", "run_suite.mjs"),
    "--worker",
    o.worker,
    "--fixtures",
    o.fixtures.join(","),
    "--out",
    o.out,
    ...(o.settingsFile ? ["--settings", o.settingsFile] : []),
  ];
  const code = await (o.spawn ?? realSpawn)(process.execPath, args, {
    ...process.env,
    ...o.env,
  });
  if (!existsSync(o.out)) throw new Error(`the suite runner wrote no result (exit ${code})`);
  return JSON.parse(readFileSync(o.out, "utf8")) as SuiteRunResult;
}

export interface BakeOffRow {
  worker: string;
  result?: SuiteRunResult;
  error?: string;
}

/**
 * The bake-off on the suite path: each Worker runs the same fixture from an
 * identical clean repository. A manager is an arm of the run, so it is named
 * in a settings file the run records, not as a flag the runner passes on.
 */
export async function bakeOffOnSuitePath(o: {
  harnessRoot: string;
  workers: string[];
  fixture: string;
  manager?: string | undefined;
  dir: string;
  spawn?: SuiteSpawn;
}): Promise<BakeOffRow[]> {
  mkdirSync(o.dir, { recursive: true });
  let settingsFile: string | undefined;
  if (o.manager) {
    settingsFile = join(o.dir, "bakeoff-settings.json");
    writeFileSync(settingsFile, `${JSON.stringify({ roles: { manager: o.manager } })}\n`);
  }
  const rows: BakeOffRow[] = [];
  for (const worker of o.workers) {
    try {
      const result = await runSuitePath({
        harnessRoot: o.harnessRoot,
        worker,
        fixtures: [o.fixture],
        out: join(o.dir, `${worker.replace(/[^A-Za-z0-9._-]/g, "_")}.json`),
        ...(settingsFile ? { settingsFile } : {}),
        ...(o.spawn ? { spawn: o.spawn } : {}),
      });
      rows.push({ worker, result });
    } catch (err) {
      rows.push({ worker, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return rows;
}
