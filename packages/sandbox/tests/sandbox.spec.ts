import { describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/executor.js";
import { generateSeatbeltProfile } from "../src/seatbelt.js";

describe("@sekhemet/sandbox", () => {
  const sandbox = new ProcessSandbox();

  it("executes a safe command and returns exitCode 0 with stdout", async () => {
    const res = await sandbox.execute("node", ["-e", "console.log('sandboxed-output')"], {
      allowedPaths: [process.cwd()],
      allowNetwork: false,
      timeoutMs: 5000,
      cwd: process.cwd(),
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("sandboxed-output");
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThan(0);
  });

  it("captures non-zero exit codes and stderr correctly", async () => {
    const res = await sandbox.execute(
      "node",
      ["-e", "console.error('fatal error'); process.exit(42);"],
      {
        allowedPaths: [process.cwd()],
        allowNetwork: false,
        timeoutMs: 5000,
        cwd: process.cwd(),
      },
    );

    expect(res.exitCode).toBe(42);
    expect(res.stderr).toContain("fatal error");
    expect(res.timedOut).toBe(false);
  });

  it("terminates a long-running process when timeoutMs is exceeded", async () => {
    const start = Date.now();
    const res = await sandbox.execute("node", ["-e", "setTimeout(() => {}, 10000);"], {
      allowedPaths: [process.cwd()],
      allowNetwork: false,
      timeoutMs: 300,
      cwd: process.cwd(),
    });

    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(2500);
  });

  it("generates a valid macOS Seatbelt profile with path and network restrictions", () => {
    const profile = generateSeatbeltProfile({
      allowedPaths: ["/Users/test/workspace", "/tmp"],
      allowNetwork: false,
      cwd: "/Users/test/workspace",
      timeoutMs: 5000,
    });

    expect(profile).toContain("(version 1)");
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/workspace"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).toContain("(deny network*)");
  });

  it("allows network in Seatbelt profile when allowNetwork is true", () => {
    const profile = generateSeatbeltProfile({
      allowedPaths: ["/workspace"],
      allowNetwork: true,
      cwd: "/workspace",
      timeoutMs: 5000,
    });

    expect(profile).toContain("(allow network*)");
  });
});
