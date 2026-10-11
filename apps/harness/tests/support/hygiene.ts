import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Test hygiene shared by the spawning helpers (F31, C5): the guard that keeps
 * every spawned command off the owner's real model servers, the temporary
 * folder of the run passed on to what is spawned, and the children a test
 * started, killed with their process group when the test ends.
 */

/**
 * Loaded into every spawned command: a connection to the owner's real model
 * servers (Ollama 11434, the Worker 8098 and 8099, Hermes 8080) on loopback
 * is refused at once, so no test ever reaches them, whatever a probe tries.
 */
export const MODEL_PORT_GUARD = `import net from "node:net";
const DENY = new Set([11434, 8098, 8099, 8080]);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect and http pass their options normalized, as an array.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof a === "object" && a !== null ? a : { port: a, host: args[1] };
  const host = String(o.host ?? "localhost");
  if (!o.path && DENY.has(Number(o.port)) && /^(127\\.0\\.0\\.1|localhost|::1|\\[::1\\])$/.test(host)) {
    const err = Object.assign(new Error("connect ECONNREFUSED " + host + ":" + o.port + " (test guard)"), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};
`;

/** The guard's file, written once per worker under the run's temporary folder. */
export function modelPortGuard(): string {
  const dir = join(tmpdir(), `sek-guard-${process.pid}`);
  const file = join(dir, "model_port_guard.mjs");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, MODEL_PORT_GUARD);
  }
  return file;
}

/**
 * Loaded into every spawned command after the guard: the host's memory as the
 * memory watchdog, the run guard and `doctor` read it — the kernel's pressure
 * level (`sysctl kern.memorystatus_vm_pressure_level`, Linux's
 * `/proc/pressure/memory`) and the swap in use (`sysctl vm.swapusage`,
 * `/proc/meminfo`) — held at normal with no swap. The owner's own work on this
 * machine is not part of any behaviour under test: without this, a queue test
 * waited on "the memory watchdog asks to stop new worktrees" until it timed
 * out whenever the host itself was under pressure.
 *
 * A test about memory pressure drives it itself and is left alone: through
 * `support/g5_host.mjs` (`G5_PRESSURE` set), or with its own `sysctl` ahead of
 * the system's on PATH (runtime_watchdog_cli). Nothing else is changed.
 */
export const HOST_MEMORY_NORMAL = String.raw`import { createRequire, syncBuiltinESMExports } from "node:module";
import { delimiter, join } from "node:path";
if (!process.env.G5_PRESSURE) {
  const require = createRequire(import.meta.url);
  const cp = require("node:child_process");
  const fs = require("node:fs");
  const SYSTEM = new Set(["/usr/sbin", "/sbin", "/usr/bin", "/bin"]);
  // The first sysctl on PATH is the test's own stand-in: it drives the host.
  const standIn = () => {
    for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      try {
        fs.accessSync(join(dir, "sysctl"), fs.constants.X_OK);
      } catch {
        continue;
      }
      return !SYSTEM.has(dir);
    }
    return false;
  };
  const as = (opts, t) => {
    const enc = typeof opts === "string" ? opts : opts?.encoding;
    return enc && enc !== "buffer" ? t : Buffer.from(t);
  };
  const realExecFileSync = cp.execFileSync;
  cp.execFileSync = function execFileSync(cmd, args, opts, ...rest) {
    if (cmd === "sysctl" && Array.isArray(args) && !standIn()) {
      if (args.includes("kern.memorystatus_vm_pressure_level")) return as(opts, "1\n");
      if (args.includes("vm.swapusage")) {
        return as(opts, "total = 2048.00M  used = 0.00M  free = 2048.00M  (encrypted)\n");
      }
    }
    return realExecFileSync.call(this, cmd, args, opts, ...rest);
  };
  const realRead = fs.readFileSync;
  fs.readFileSync = function readFileSync(path, ...rest) {
    if (path === "/proc/pressure/memory") {
      return as(rest[0], "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
    }
    if (path === "/proc/meminfo") {
      const real = String(realRead.call(this, path, "utf8"));
      const total = /SwapTotal:\s+(\d+)/.exec(real)?.[1] ?? "0";
      return as(rest[0], real.replace(/SwapFree:\s+\d+/, "SwapFree:       " + total));
    }
    return realRead.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}
`;

/** The host-memory preload's file, written once per worker beside the guard. */
export function hostMemoryNormal(): string {
  const dir = join(tmpdir(), `sek-guard-${process.pid}`);
  const file = join(dir, "host_memory_normal.mjs");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, HOST_MEMORY_NORMAL);
  }
  return file;
}

/** `node` arguments that load the guard and the host's memory first, then `preload` when given. */
export function guardedImports(preload?: string): string[] {
  return [
    "--import",
    modelPortGuard(),
    "--import",
    hostMemoryNormal(),
    ...(preload ? ["--import", preload] : []),
  ];
}

/** The run's temporary folder for a spawned command's environment (`global_tmp.ts`). */
export function runTmpEnv(): Record<string, string> {
  return process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {};
}

const children = new Set<ChildProcess>();

/**
 * Track a child spawned with `detached: true` (its own process group), so the
 * test's end kills it and everything it started (a language server, a sleep
 * assertion) even when the test failed or timed out first.
 */
export function trackChild<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

/** Kill a child's process group (the child alone when it has none). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

afterEach(async () => {
  const live = [...children];
  children.clear();
  await Promise.all(
    live.map(
      (c) =>
        new Promise<void>((done) => {
          if (c.exitCode !== null || c.signalCode !== null) {
            // The child ended; its group may still hold what it started.
            killTree(c);
            done();
            return;
          }
          const t = setTimeout(done, 5_000);
          c.once("close", () => {
            clearTimeout(t);
            done();
          });
          killTree(c);
        }),
    ),
  );
});
