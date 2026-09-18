export interface SandboxOptions {
  allowedPaths: string[];
  allowNetwork: boolean;
  timeoutMs: number;
  cwd: string;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  oomKilled: boolean;
}

export interface ExecutionSandbox {
  execute(command: string, args: string[], options: SandboxOptions): Promise<ExecutionResult>;
}
