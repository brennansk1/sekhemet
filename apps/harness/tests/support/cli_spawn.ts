import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach } from "vitest";
import { runTmpEnv } from "./hygiene.js";

/**
 * The built command as a person runs it, for the front door's entry-point
 * tests (C2d, FINDINGS_C1 TST-01): `apps/harness/dist/index.js` spawned in a
 * real repository with an empty home, its user directory and model folder
 * under that home, a `BROWSER` that only records being called, and no model
 * loads (`SEKHEMET_MODEL_LOADS=off`). Unlike `cli_fixture.ts`'s `sekhemet()`
 * it does not wait for the process to end: the bare command serves the
 * dashboard, so a test reads its output until a line appears, then stops it.
 */
export const BIN = resolve(import.meta.dirname, "../../dist/index.js");

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Loaded into every spawned command: a connection to the owner's real model
 * servers (Ollama 11434, the Worker 8098 and 8099, Hermes 8080) on loopback
 * is refused at once, so no test ever reaches them, whatever a probe tries.
 */
const GUARD = `import net from "node:net";
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

export interface Place {
  root: string;
  repo: string;
  home: string;
  models: string;
  /** The file the stand-in browser appends each call to. */
  browserLog: string;
}

/** A fresh root holding an empty repository folder, a home and a models folder. */
export function place(prefix = "sek-front-door-"): Place {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const p = {
    root,
    repo: join(root, "repo"),
    home: join(root, "home"),
    models: join(root, "home", "models"),
    browserLog: join(root, "browser-called"),
  };
  for (const d of [p.repo, p.home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "guard.mjs"), GUARD);
  const browser = join(root, "browser.sh");
  writeFileSync(browser, `#!/bin/sh\necho "$@" >> "${p.browserLog}"\n`);
  chmodSync(browser, 0o755);
  return p;
}

/** A fresh npm repository with TypeScript as a dependency and no lockfile (SUR-1). */
export function npmRepo(p: Place): string {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
  writeFile(
    p.repo,
    "package.json",
    JSON.stringify({
      name: "shop",
      scripts: { test: "vitest run" },
      devDependencies: { typescript: "5.7.3", vitest: "3" },
    }),
  );
  writeFile(p.repo, ".gitignore", "node_modules/\n");
  return p.repo;
}

export function writeFile(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** Every file under `root` but `.git`, sorted: so any file written shows. */
export function tree(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f !== ".git" && !f.startsWith(".git/"))
    .sort();
}

/** The environment the spawned command runs with: nothing of this machine's own. */
export function cliEnv(p: Place, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: p.home,
    SEKHEMET_CONFIG_DIR: join(p.home, ".sekhemet"),
    SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
    SEKHEMET_MODELS_DIR: p.models,
    SEKHEMET_MODEL_LOADS: "off",
    SEKHEMET_KEYCHAIN: "off",
    BROWSER: join(p.root, "browser.sh"),
    ...runTmpEnv(),
    ...extra,
    NODE_OPTIONS: [`--import=${join(p.root, "guard.mjs")}`, extra.NODE_OPTIONS ?? ""]
      .join(" ")
      .trim(),
  };
}

export interface Spawned {
  child: ChildProcess;
  /** stdout and stderr so far. */
  out: () => string;
  /** Resolves with the first match of `pattern`, or rejects when the process ends first. */
  until: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  /** Resolves with the exit code. */
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

/** Spawn the built command; the test stops it (or it is killed after the test). */
export function spawnCli(
  args: string[],
  p: Place,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Spawned {
  // A preload goes through the environment: `NODE_OPTIONS=--import=<file>`.
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? p.repo,
    env: cliEnv(p, opts.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stdin?.end();
  let text = "";
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    text += d.toString("utf8");
    for (const l of listeners) l();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const until = (pattern: RegExp, timeoutMs = 60_000) =>
    new Promise<RegExpMatchArray>((ok, bad) => {
      const check = () => {
        const m = text.match(pattern);
        if (m) {
          listeners.delete(check);
          clearTimeout(timer);
          ok(m);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        bad(new Error(`no ${pattern} in ${timeoutMs} ms; output:\n${text}`));
      }, timeoutMs);
      listeners.add(check);
      check();
      void exited.then((code) => {
        if (!text.match(pattern)) {
          listeners.delete(check);
          clearTimeout(timer);
          bad(new Error(`exited ${code} before ${pattern}; output:\n${text}`));
        }
      });
    });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
  return { child, out: () => text, until, exited, stop };
}

/** Run the built command to its end (for the commands that end). */
export async function runCli(
  args: string[],
  p: Place,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number | null; out: string }> {
  const s = spawnCli(args, p, opts);
  const code = await Promise.race([
    s.exited,
    new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs ?? 60_000)),
  ]);
  await s.stop();
  return { code, out: s.out() };
}

/** A port no one is listening on now. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}
