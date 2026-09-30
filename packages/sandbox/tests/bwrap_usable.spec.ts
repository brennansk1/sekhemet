import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bubblewrapUnavailableReason } from "../src/bubblewrap.js";
import { srtExecFailed } from "../src/executor.js";

/**
 * R9 (the Lima VM, Ubuntu 24.04): bubblewrap was installed but could not
 * create its namespaces — AppArmor's `apparmor_restrict_unprivileged_userns`
 * — so every command failed with bwrap's own error, and the sandbox still
 * reported `bubblewrap` in force. Installed is not usable: the check runs it.
 */
describe("bubblewrap is in force only when it can start a namespace (SEC-17c)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bwrap-usable-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fake = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it("names bwrap's own error and the AppArmor fix when it cannot start", () => {
    const bwrap = fake(
      "denied",
      "echo 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2; exit 1",
    );
    const reason = bubblewrapUnavailableReason(bwrap);
    expect(reason).toContain("Failed RTM_NEWADDR: Operation not permitted");
    expect(reason).toContain("apparmor_restrict_unprivileged_userns");
  });

  it("is usable when a trivial command runs inside it", () => {
    expect(bubblewrapUnavailableReason(fake("ok", "exit 0"))).toBeUndefined();
  });

  it("asks for the namespaces a card's commands get, the network one included", () => {
    const log = join(dir, "argv.log");
    const bwrap = fake("logger", `echo "$@" > '${log}'; exit 0`);
    bubblewrapUnavailableReason(bwrap);
    const argv = readFileSync(log, "utf8");
    for (const flag of ["--unshare-pid", "--unshare-ipc", "--unshare-net"]) {
      expect(argv).toContain(flag);
    }
  });

  it("names a missing or unrunnable program rather than passing it", () => {
    expect(bubblewrapUnavailableReason(join(dir, "absent"))).toMatch(/cannot run/);
  });
});

/**
 * R9: Ubuntu 24.04's bash 5.2 words an absolute path that does not exist
 * without the `exec: ` prefix macOS's bash gives, so srt on Linux never
 * marked a missing program notStarted.
 */
describe("srt's missing-program message on Linux's bash", () => {
  it("matches bash 5.2's wording for an absolute path", () => {
    expect(
      srtExecFailed(
        "/bin/bash: line 1: /nonexistent/prog: No such file or directory\n",
        "/nonexistent/prog",
      ),
    ).toBe(true);
  });

  it("still ignores a shell the program ran that could not find another command", () => {
    expect(
      srtExecFailed(
        "/bin/bash: line 1: exec: definitely-not-a-binary-xyz: not found\n",
        "/bin/bash",
      ),
    ).toBe(false);
  });
});
