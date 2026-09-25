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
  /**
   * Loopback ports the command may listen on and connect to (L23: a card's
   * background dev server and the commands that talk to it).
   */
  localPorts?: number[];
  /**
   * A headless browser runs here (S3a: the visual gate, `browse`). Chromium
   * cannot start under the native Seatbelt profile without registering its
   * own `org.chromium.*` Mach services and opening the power-management
   * IOKit client, so the profile allows exactly those. Chromium's own sandbox
   * cannot nest inside Seatbelt: the caller passes `--no-sandbox`, and this
   * profile is the confinement.
   */
  browser?: boolean;
  /**
   * Nothing under the harness user's home directory is readable (S3a:
   * `--validate-tools`, browsers), except the toolchains that live there
   * (`homeToolchainPaths`) and the granted roots. Reads are otherwise broad,
   * so a private HOME variable alone would leave `~/.ssh` readable by path.
   */
  denyHomeReads?: boolean;
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
  /**
   * The program never started: the spawn failed, or the confinement wrapper
   * could not exec it. Exit 127 alone cannot say this — a program that ran and
   * printed "No such file or directory" is reported 127 too (gates rule 9).
   */
  notStarted?: true;
}

export interface ExecutionSandbox {
  execute(command: string, args: string[], options: SandboxOptions): Promise<ExecutionResult>;
}
