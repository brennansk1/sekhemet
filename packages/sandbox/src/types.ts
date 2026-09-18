export interface SandboxOptions {
  allowedPaths: string[];
  allowNetwork: boolean;
  timeoutMs: number;
  cwd: string;
  maxBufferBytes?: number;
  env?: Record<string, string>;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  oomKilled: boolean;
  timedOut: boolean;
}

export interface ExecutionSandbox {
  execute(command: string, args: string[], options: SandboxOptions): Promise<ExecutionResult>;
}
