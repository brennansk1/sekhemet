import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BWRAP_CANDIDATES, bubblewrapArgv } from "./bubblewrap.js";
import { generateSeatbeltProfile } from "./seatbelt.js";
import { hostSeccompArch, seccompProgram } from "./seccomp.js";
import type { ExecutionResult, ExecutionSandbox, SandboxOptions } from "./types.js";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const MEMORY_POLL_MS = 250;

function defaultMemoryCap(): number {
  const mb = Number(process.env.SEKHEMET_MAX_COMMAND_MEMORY_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 4096) * 1024 * 1024;
}

/** Resident bytes of `pid` and every descendant, from one `ps` snapshot (S7). */
export function sampleTreeMemory(pid: number): Promise<{ bytes: number; pids: number[] }> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({ bytes: 0, pids: [pid] });
      const rows = stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((r) => r.length === 3 && r.every((n) => Number.isFinite(n))) as [
        number,
        number,
        number,
      ][];
      const children = new Map<number, number[]>();
      const rss = new Map<number, number>();
      for (const [p, pp, kb] of rows) {
        rss.set(p, kb * 1024);
        children.set(pp, [...(children.get(pp) ?? []), p]);
      }
      const tree: number[] = [];
      const stack = [pid];
      while (stack.length > 0) {
        const p = stack.pop() as number;
        if (tree.includes(p)) continue;
        tree.push(p);
        stack.push(...(children.get(p) ?? []));
      }
      resolve({ bytes: tree.reduce((n, p) => n + (rss.get(p) ?? 0), 0), pids: tree });
    });
  });
}
const SIGKILL_GRACE_MS = 500;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** How a subprocess is confined. `none` means the OS offers no supported mechanism. */
export type ConfinementMode = "seatbelt" | "bubblewrap" | "none";

/**
 * Environment variables passed through to sandboxed subprocesses.
 *
 * Everything else is dropped. The parent process holds model endpoints and API
 * credentials, and a sandbox that inherits the full parent environment hands
 * those to any command the agent chooses to run.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "LOGSEQ_TEST",
  "NODE_ENV",
  "CI",
];

export interface ProcessSandboxOptions {
  /**
   * Refuse to execute when no OS confinement is available (S4). ON by
   * default: a host without Seatbelt or bubblewrap refuses rather than
   * running agent commands unconfined. `false`, or the environment variable
   * SEKHEMET_ALLOW_UNCONFINED=1, is the explicit opt-out.
   */
  requireConfinement?: boolean;
  /** Force confinement off. Intended for trusted internal commands only (an explicit opt-out). */
  disableConfinement?: boolean;
}

function buildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Runs subprocesses under OS-level confinement with hard timeout enforcement.
 *
 * On macOS the command is wrapped in `sandbox-exec` with a generated Seatbelt
 * profile, so `allowedPaths` and `allowNetwork` are enforced by the kernel
 * rather than merely described.
 */
export class ProcessSandbox implements ExecutionSandbox {
  private readonly mode: ConfinementMode;
  private readonly bwrap: string | undefined;

  constructor(private readonly config: ProcessSandboxOptions = {}) {
    // macOS: Seatbelt. Linux (the Ubuntu AI node): bubblewrap. Anything else,
    // or a host without the tool, runs unconfined and `requireConfinement`
    // refuses to execute there.
    this.bwrap = BWRAP_CANDIDATES.find((p) => existsSync(p));
    this.mode = config.disableConfinement
      ? "none"
      : platform() === "darwin" && existsSync(SANDBOX_EXEC)
        ? "seatbelt"
        : platform() === "linux" && this.bwrap
          ? "bubblewrap"
          : "none";
  }

  /**
   * True when this sandbox refuses to run a command it cannot confine: fail
   * closed by default (S4). `disableConfinement` without `requireConfinement`,
   * `requireConfinement: false` or SEKHEMET_ALLOW_UNCONFINED=1 opt out.
   */
  public get requiresConfinement(): boolean {
    if (this.config.requireConfinement !== undefined) return this.config.requireConfinement;
    if (this.config.disableConfinement) return false;
    return process.env.SEKHEMET_ALLOW_UNCONFINED !== "1";
  }

  /** The confinement mechanism in effect. Surfaced by `sekhemet doctor`. */
  public get confinement(): ConfinementMode {
    return this.mode;
  }

  /** Resolve the real argv, wrapping in `sandbox-exec` when confinement is active. */
  private wrap(
    command: string,
    args: string[],
    options: SandboxOptions,
  ): { file: string; argv: string[] } {
    if (this.mode === "bubblewrap" && this.bwrap) {
      // The seccomp program travels on fd 3 (see `execute`).
      const seccomp = hostSeccompArch() !== undefined ? 3 : undefined;
      return { file: this.bwrap, argv: bubblewrapArgv(options, command, args, seccomp) };
    }
    if (this.mode !== "seatbelt") return { file: command, argv: args };
    const profile = generateSeatbeltProfile(options);
    return { file: SANDBOX_EXEC, argv: ["-p", profile, command, ...args] };
  }

  public async execute(
    command: string,
    args: string[],
    options: SandboxOptions,
  ): Promise<ExecutionResult> {
    const startTime = performance.now();

    if (this.mode === "none" && this.requiresConfinement) {
      return {
        exitCode: 126,
        stdout: "",
        stderr:
          "Refusing to execute: no OS-level confinement (Seatbelt or bubblewrap) is available on this host, and the sandbox fails closed. Install bubblewrap, or set SEKHEMET_ALLOW_UNCONFINED=1 to run unconfined deliberately.",
        durationMs: 0,
        oomKilled: false,
        timedOut: false,
      };
    }

    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

    // A private scratch directory per execution: toolchains need a writable
    // TMPDIR, but sharing the system one would let any confined process reach
    // every other sandbox's temporary files.
    const scratchDir = options.scratchDir ?? mkdtempSync(join(tmpdir(), "sekhemet-box-"));
    const ownsScratch = options.scratchDir === undefined;
    const effective: SandboxOptions = { ...options, scratchDir };
    const { file, argv } = this.wrap(command, args, effective);

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let oomKilled = false;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;
      let memoryPeak = 0;
      let memoryKilled = false;
      const memoryCap = options.maxMemoryBytes ?? defaultMemoryCap();

      // S3: under bubblewrap, the seccomp filter is handed over on fd 3.
      const arch = hostSeccompArch();
      let seccompFd: number | undefined;
      if (this.mode === "bubblewrap" && arch) {
        const path = join(scratchDir, ".seccomp.bpf");
        writeFileSync(path, seccompProgram(arch));
        seccompFd = openSync(path, "r");
      }
      const child = spawn(file, argv, {
        cwd: options.cwd,
        env: buildEnv({
          TMPDIR: scratchDir,
          ...(options.egressProxyPort && !options.allowNetwork
            ? {
                HTTP_PROXY: `http://127.0.0.1:${options.egressProxyPort}`,
                HTTPS_PROXY: `http://127.0.0.1:${options.egressProxyPort}`,
                http_proxy: `http://127.0.0.1:${options.egressProxyPort}`,
                https_proxy: `http://127.0.0.1:${options.egressProxyPort}`,
              }
            : {}),
          ...options.env,
        }),
        stdio:
          seccompFd !== undefined
            ? ["ignore", "pipe", "pipe", seccompFd]
            : ["ignore", "pipe", "pipe"],
      });
      if (seccompFd !== undefined) closeSync(seccompFd);

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          // SIGTERM is catchable; a process that ignores it is escalated to an
          // uncatchable SIGKILL so a runaway command cannot outlive its budget.
          killTimer = setTimeout(() => {
            if (!finished) {
              try {
                child.kill("SIGKILL");
              } catch {
                // Already reaped.
              }
            }
          }, SIGKILL_GRACE_MS);
        } catch {
          // Process already exited.
        }
      }, options.timeoutMs);

      // S7: a real memory cap. The tree's resident size is sampled; past the
      // cap every process in it is killed and the result says so, rather
      // than inferring an OOM from an unexplained SIGKILL.
      const memoryTimer = setInterval(() => {
        if (finished || child.pid === undefined) return;
        void sampleTreeMemory(child.pid).then(({ bytes, pids }) => {
          memoryPeak = Math.max(memoryPeak, bytes);
          if (finished || bytes <= memoryCap || memoryKilled) return;
          memoryKilled = true;
          for (const p of pids.reverse()) {
            try {
              process.kill(p, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        });
      }, MEMORY_POLL_MS);
      memoryTimer.unref?.();

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString("utf8");
        else stdoutTruncated = true;
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString("utf8");
        else stderrTruncated = true;
      });

      const settle = (result: ExecutionResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(memoryTimer);
        if (killTimer) clearTimeout(killTimer);
        if (ownsScratch) {
          try {
            rmSync(scratchDir, { recursive: true, force: true });
          } catch {
            // Best effort; a leftover scratch directory is not worth failing on.
          }
        }
        resolve(result);
      };

      child.on("error", (err: Error) => {
        settle({
          exitCode: 127,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs: Math.round(performance.now() - startTime),
          oomKilled: false,
          timedOut,
        });
      });

      child.on("close", (code, signal) => {
        // Our own cap, or an unexplained SIGKILL (the Linux OOM killer).
        if (memoryKilled || (signal === "SIGKILL" && !timedOut)) oomKilled = true;
        if (memoryKilled) {
          stderr += `\n[killed: the command used ${Math.round(memoryPeak / 1048576)} MB, over its ${Math.round(memoryCap / 1048576)} MB memory cap]`;
        }

        // Under sandbox-exec a missing binary surfaces as the wrapper's own
        // status, so callers would see an arbitrary code instead of the
        // conventional "command not found". Normalise it.
        const notFound = /command not found|No such file or directory|execvp\(\) failed/i.test(
          stderr,
        );
        const exitCode = notFound ? 127 : (code ?? (timedOut ? 124 : 1));

        const suffix = (truncated: boolean): string =>
          truncated ? `\n... [output truncated at ${maxBuffer} bytes] ...` : "";

        settle({
          exitCode,
          stdout: stdout + suffix(stdoutTruncated),
          stderr: stderr + suffix(stderrTruncated),
          durationMs: Math.round(performance.now() - startTime),
          oomKilled,
          timedOut,
          ...(memoryPeak > 0 ? { memoryPeakBytes: memoryPeak } : {}),
        });
      });
    });
  }
}
