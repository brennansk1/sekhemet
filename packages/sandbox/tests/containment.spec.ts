import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/executor.js";

/**
 * Containment is asserted by attempting to escape, not by inspecting a profile.
 *
 * The suite this replaced checked that the Seatbelt profile *string* was
 * well-formed while the executor never applied it — so every assertion passed
 * against a sandbox that confined nothing.
 */
describe("@sekhemet/sandbox containment", () => {
  let work: string;
  let outside: string;
  const sandbox = new ProcessSandbox();
  const darwin = platform() === "darwin";

  const opts = (): Parameters<ProcessSandbox["execute"]>[2] => ({
    allowedPaths: [work],
    allowNetwork: false,
    timeoutMs: 20_000,
    cwd: work,
  });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "contain-work-"));
    outside = mkdtempSync(join(tmpdir(), "contain-out-"));
  });

  afterEach(() => {
    for (const dir of [work, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it("reports which confinement mechanism is actually in force", () => {
    expect(["seatbelt", "none"]).toContain(sandbox.confinement);
    if (darwin) expect(sandbox.confinement).toBe("seatbelt");
  });

  it("permits writes inside the allowed path", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(process.argv[1] + '/ok.txt', 'x')`, work],
      opts(),
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(work, "ok.txt"))).toBe(true);
  });

  it.runIf(darwin)("refuses a write outside the allowed path", async () => {
    const target = join(outside, "escaped.txt");
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'pwned')`],
      opts(),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("EPERM");
    // The decisive assertion: nothing was written.
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(darwin)("refuses a write to the user's home directory", async () => {
    const target = join(homedir(), ".sekhemet_containment_probe");
    const result = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`],
      opts(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(darwin)("blocks network egress when allowNetwork is false", async () => {
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        "fetch('https://example.com').then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})",
      ],
      opts(),
    );
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("does not leak parent environment variables to the child", async () => {
    // The parent holds model endpoints and credentials; a sandbox that inherits
    // the full environment hands them to any command the agent chooses to run.
    process.env.SEKHEMET_FAKE_SECRET = "super-secret-value";
    try {
      const result = await sandbox.execute(
        process.execPath,
        ["-e", "console.log(process.env.SEKHEMET_FAKE_SECRET ?? 'ABSENT')"],
        opts(),
      );
      expect(result.stdout.trim()).toBe("ABSENT");
    } finally {
      process.env.SEKHEMET_FAKE_SECRET = undefined;
    }
  });

  it("passes explicitly provided environment variables through", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.log(process.env.EXPLICIT ?? 'ABSENT')"],
      { ...opts(), env: { EXPLICIT: "yes" } },
    );
    expect(result.stdout.trim()).toBe("yes");
  });

  it("kills a process that ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        // Trap SIGTERM and refuse to exit: only an uncatchable SIGKILL ends this.
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 50);",
      ],
      { ...opts(), timeoutMs: 800 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // SIGTERM plus the 500ms grace, with headroom for process teardown.
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("reports a non-zero exit code and captures stderr", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.error('boom'); process.exit(3)"],
      opts(),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  it("returns 127 for a command that does not exist", async () => {
    const result = await sandbox.execute("definitely-not-a-real-binary-xyz", [], opts());
    expect(result.exitCode).toBe(127);
  });

  it("refuses to run unconfined when requireConfinement is set and none is available", async () => {
    const strict = new ProcessSandbox({ requireConfinement: true, disableConfinement: true });
    const result = await strict.execute(process.execPath, ["-e", "console.log('ran')"], opts());

    // Failing closed matters: degrading silently to an unconfined run is how a
    // sandbox stops being one.
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("Refusing to execute");
    expect(result.stdout).not.toContain("ran");
    expect(strict.requiresConfinement).toBe(true);
    expect(strict.confinement).toBe("none");
    // S4 (wave 2): a default sandbox fails closed; opting out is explicit.
    expect(new ProcessSandbox().requiresConfinement).toBe(true);
    expect(new ProcessSandbox({ disableConfinement: true }).requiresConfinement).toBe(false);
  });

  it("truncates output beyond the buffer cap rather than growing without bound", async () => {
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(200000))"],
      { ...opts(), maxBufferBytes: 4096 },
    );
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout.length).toBeLessThan(200_000);
  });

  it.runIf(darwin)("allows reads of system files the toolchain needs", async () => {
    // Confinement restricts writes and egress; a profile that also blocked
    // reads would break every compiler rather than improve safety.
    const result = await sandbox.execute(
      process.execPath,
      ["-e", "console.log(require('fs').existsSync('/usr/bin/env'))"],
      opts(),
    );
    expect(result.stdout.trim()).toBe("true");
  });
});
