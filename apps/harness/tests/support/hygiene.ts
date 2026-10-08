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

/** `node` arguments that load the guard first, then `preload` when given. */
export function guardedImports(preload?: string): string[] {
  return ["--import", modelPortGuard(), ...(preload ? ["--import", preload] : [])];
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
