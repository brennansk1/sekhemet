import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** The run's `sysctl` stand-in: normal memory pressure and no swap; anything else is the system's. */
export const HOST_SYSCTL = `#!/bin/sh
value() { case " $* " in *" -n "*) echo "$2";; *) echo "$1: $2";; esac; }
for a in "$@"; do
  case "$a" in
    kern.memorystatus_vm_pressure_level) value "$a" 1 "$@"; exit 0;;
    vm.swapusage) value "$a" "total = 2048.00M  used = 0.00M  free = 2048.00M  (encrypted)" "$@"; exit 0;;
  esac
done
exec /usr/sbin/sysctl "$@"
`;

export default function setup(): () => void {
  // Each project of the config runs this too: the first one owns the folder.
  if (process.env.SEKHEMET_TEST_RUN_TMP) return () => undefined;
  const before = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), "skv-"));
  process.env.TMPDIR = dir;
  process.env.SEKHEMET_TEST_RUN_TMP = dir;
  // The host's memory is not under test (N1a): the owner's own work on this
  // machine put the kernel at a pressure warning, the memory watchdog of every
  // spawned `queue` held its worktrees, and 146 waits timed tests out. A
  // `sysctl` first on PATH, for the workers and every command they spawn,
  // answers the two memory readings as normal and passes every other query
  // to the system's. A test about pressure puts its own `sysctl` ahead of this
  // one, or drives it in-process (`g5_host.mjs`), as before.
  const before_path = process.env.PATH;
  const bin = join(dir, "host-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sysctl"), HOST_SYSCTL);
  chmodSync(join(bin, "sysctl"), 0o755);
  process.env.PATH = `${bin}:${before_path ?? "/usr/bin:/bin"}`;
  return () => {
    if (before_path === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = before_path;
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
