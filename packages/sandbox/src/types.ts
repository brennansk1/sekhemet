export interface SandboxOptions {
  allowedPaths: string[];
  /**
   * Paths the command may read and never write (L12's run_script: the card's
   * worktree). Every engine already reads the filesystem but what it denies,
   * except under bubblewrap, whose private /tmp hides a worktree made under
   * the host's /tmp: there each is bound back read-only, with any ledger
   * inside it still masked. No engine grants a write here.
   */
  readOnlyPaths?: string[];
  /**
   * Security item 8c (design-stage DS-N9-17): paths whose contents the
   * command may not read — files and directory listings — except the
   * granted roots and read-only grants inside them, which stay as granted.
   * A research packet's probe: the repository hidden, its installed
   * dependencies readable. Metadata stays readable so paths resolve.
   */
  hiddenReadPaths?: string[];
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
  /**
   * Security item 10a (NEW-security-13): paths the command may neither read
   * nor write, whatever else is granted — a card's view of other projects,
   * other cards' worktrees and the workspace's state. A path may end in a
   * `*` glob (macOS engines only). Usually filled in by the card's
   * registered isolation (`registerCardIsolation`).
   */
  denyPaths?: string[];
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
