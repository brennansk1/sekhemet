import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A background process under bubblewrap gets the seccomp program on fd 3,
 * exactly as `execute` hands it over (S3), and its scratch directory is
 * removed when it exits. Linux is simulated: the argv and spawn options are
 * what is checked, not a real bwrap.
 */
const spawned: { file: string; argv: string[]; options: Record<string, unknown> }[] = [];
/** What the simulated bwrap answers the usability probe (SEC-17c). */
const probe = { status: 0, stderr: "" };

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (file: string, argv: string[], options: Record<string, unknown>) => {
    spawned.push({ file, argv, options });
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 999_999;
    return child;
  },
  spawnSync: (file: string, argv: string[]) => {
    if (file !== "/usr/bin/bwrap")
      throw new Error(`unexpected spawnSync ${file} ${argv.join(" ")}`);
    return { status: probe.status, stderr: probe.stderr, stdout: "" };
  },
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  platform: () => "linux",
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (p: string) => p === "/usr/bin/bwrap" || fs.existsSync(p) };
});

afterEach(() => {
  spawned.length = 0;
  probe.status = 0;
  probe.stderr = "";
});

describe("spawnBackground under bubblewrap", () => {
  it("opens the seccomp fd the argv names, and removes its scratch directory on exit", async () => {
    const { ProcessSandbox } = await import("../src/executor.js");
    const { hostSeccompArch } = await import("../src/seccomp.js");
    const sandbox = new ProcessSandbox({ engine: "native" });
    expect(sandbox.confinement).toBe("bubblewrap");
    const root = mkdtempSync(join(tmpdir(), "bg-root-"));
    try {
      const child = sandbox.spawnBackground("/bin/true", [], {
        allowedPaths: [root],
        allowNetwork: false,
        timeoutMs: 0,
        cwd: root,
      });
      expect(child).not.toBeNull();
      const [call] = spawned;
      expect(call?.file).toBe("/usr/bin/bwrap");
      const stdio = call?.options.stdio as unknown[];
      expect(call?.options.detached).toBe(true);
      if (hostSeccompArch()) {
        const at = call?.argv.indexOf("--seccomp") ?? -1;
        expect(at).toBeGreaterThanOrEqual(0);
        expect(call?.argv[at + 1]).toBe("3");
        expect(stdio).toHaveLength(4);
        expect(typeof stdio[3]).toBe("number");
      } else {
        expect(call?.argv).not.toContain("--seccomp");
        expect(stdio).toHaveLength(3);
      }
      const scratch = (call?.options.env as Record<string, string>).TMPDIR as string;
      expect(existsSync(scratch)).toBe(true);
      (child as unknown as EventEmitter).emit("exit", 0, null);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // R9 review: the executor's use of the probe, where bwrap is installed but
  // cannot start (Ubuntu 24.04's AppArmor restriction). The probe is cached
  // per path, so this simulated bwrap is a different path.
  it("is not in force, and refuses naming bwrap's error, when bwrap cannot start", async () => {
    vi.resetModules();
    probe.status = 1;
    probe.stderr = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n";
    const { ProcessSandbox } = await import("../src/executor.js");
    const sandbox = new ProcessSandbox({ engine: "native" });
    expect(sandbox.confinement).toBe("none");
    expect(sandbox.unavailableReason).toContain("Failed RTM_NEWADDR");
    const root = mkdtempSync(join(tmpdir(), "bg-root-"));
    try {
      const r = await sandbox.execute("/bin/true", [], {
        allowedPaths: [root],
        allowNetwork: false,
        timeoutMs: 5_000,
        cwd: root,
      });
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toContain("Failed RTM_NEWADDR");
      expect(spawned).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
