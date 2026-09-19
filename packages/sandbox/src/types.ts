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
  /**
   * Resident-memory cap for the command and its descendants (S7). Exceeding
   * it kills the whole tree and reports `oomKilled` with the peak. Default
   * SEKHEMET_MAX_COMMAND_MEMORY_MB, else 4096 MB.
   */
  maxMemoryBytes?: number;
  /**
   * The egress proxy's loopback port (S5). With `allowNetwork` off, the
   * only network the command gets is this port, and HTTP(S)_PROXY point at it.
   */
  egressProxyPort?: number;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  oomKilled: boolean;
  timedOut: boolean;
  /** Highest resident memory of the command tree that was sampled, in bytes. */
  memoryPeakBytes?: number;
}

export interface ExecutionSandbox {
  execute(command: string, args: string[], options: SandboxOptions): Promise<ExecutionResult>;
}
