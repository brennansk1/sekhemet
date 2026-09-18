import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BWRAP_CANDIDATES, bubblewrapArgv } from "./bubblewrap.js";
import { generateSeatbeltProfile } from "./seatbelt.js";
import type { ExecutionResult, ExecutionSandbox, SandboxOptions } from "./types.js";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
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
   * Refuse to execute when no OS confinement is available, instead of running
   * the command unconfined. Off by default so the harness still runs on Linux,
   * but the CLI turns it on for untrusted execution.
   */
  requireConfinement?: boolean;
  /** Force confinement off. Intended for trusted internal commands only. */
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
      return { file: this.bwrap, argv: bubblewrapArgv(options, command, args) };
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

    if (this.mode === "none" && this.config.requireConfinement) {
      return {
        exitCode: 126,
        stdout: "",
        stderr:
          "Refusing to execute: OS-level confinement is unavailable on this platform and requireConfinement is set.",
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

      const child = spawn(file, argv, {
        cwd: options.cwd,
        env: buildEnv({ TMPDIR: scratchDir, ...options.env }),
        stdio: ["ignore", "pipe", "pipe"],
      });

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

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString("utf8");
        else stdoutTruncated = true;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString("utf8");
        else stderrTruncated = true;
      });

      const settle = (result: ExecutionResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
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
        if (signal === "SIGKILL" && !timedOut) oomKilled = true;

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
        });
      });
    });
  }
}
