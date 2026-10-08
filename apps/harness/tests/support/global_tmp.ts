import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test hygiene for a whole `vitest run` (F31; C5): every temporary folder a
 * test or the command it spawns makes goes under one folder of this run,
 * removed when the run ends, and any process still running from that folder
 * (a `sekhemet queue` a timed-out test left, its language server) is killed
 * with its children. Before this, the C4 gate filled the disk with folders
 * tests left behind, and a spawned queue outlived vitest holding a sleep
 * assertion.
 *
 * The run's folder is `TMPDIR` for the workers (forked after this runs) and,
 * through the support helpers' environments, for the commands they spawn.
 * Its name is short: macOS caps a socket path at 104 bytes.
 */
export default function setup(): () => void {
  // Each project of the config runs this too: the first one owns the folder.
  if (process.env.SEKHEMET_TEST_RUN_TMP) return () => undefined;
  const before = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), "skv-"));
  process.env.TMPDIR = dir;
  process.env.SEKHEMET_TEST_RUN_TMP = dir;
  return () => {
    killUnder(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    // `process.env.X = undefined` would set the string "undefined".
    Reflect.deleteProperty(process.env, "SEKHEMET_TEST_RUN_TMP");
    if (before === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = before;
  };
}

/** Kill every process whose command line names `dir`, children first. */
export function killUnder(dir: string): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const rows = table
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" }));
  const roots = rows.filter((r) => r.command.includes(dir) && r.pid !== process.pid);
  const doomed = new Set<number>();
  const add = (pid: number) => {
    if (doomed.has(pid)) return;
    doomed.add(pid);
    for (const child of rows) if (child.ppid === pid) add(child.pid);
  };
  for (const r of roots) add(r.pid);
  for (const pid of [...doomed].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return [...doomed];
}
