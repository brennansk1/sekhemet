import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** A new environment: the defined base entries, then the secrets over them. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...secrets };
}

/** Run a command with the secrets in its environment only; no shell, nothing on disk. */
export function runWithSecrets(
  command: string,
  args: string[],
  secrets: Record<string, string>,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: buildChildEnv(options.baseEnv ?? process.env, secrets),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
        : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
