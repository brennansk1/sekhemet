import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ExecutionResult, ExecutionSandbox, SandboxOptions } from "./types.js";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export class ProcessSandbox implements ExecutionSandbox {
  public async execute(
    command: string,
    args: string[],
    options: SandboxOptions,
  ): Promise<ExecutionResult> {
    const startTime = performance.now();
    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let oomKilled = false;
      let finished = false;

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!finished) {
              child.kill("SIGKILL");
            }
          }, 500);
        } catch {
          // Process already dead
        }
      }, options.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (err: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const durationMs = Math.round(performance.now() - startTime);
        resolve({
          exitCode: 1,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          durationMs,
          oomKilled: false,
          timedOut,
        });
      });

      child.on("close", (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        const durationMs = Math.round(performance.now() - startTime);
        if (signal === "SIGKILL" && !timedOut) {
          oomKilled = true;
        }

        resolve({
          exitCode: code ?? (timedOut ? 124 : 1),
          stdout,
          stderr,
          durationMs,
          oomKilled,
          timedOut,
        });
      });
    });
  }
}
