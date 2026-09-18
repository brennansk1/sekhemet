export interface SandboxOptions {
  allowedPaths: string[];
  /**
   * Private scratch directory granted for temporary files.
   *
   * Supplied per execution so toolchains have a TMPDIR without every sandbox
   * sharing one writable directory.
   */
  scratchDir?: string;
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
