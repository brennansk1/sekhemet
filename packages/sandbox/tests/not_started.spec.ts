import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSandbox, type SandboxEngine } from "../src/index.js";
import { srtUnavailableReason } from "../src/srt_engine.js";

// Gates rule 9 (B2.3 confirmation review): a program that never started is
// said explicitly. Exit 127 alone cannot say it — the sandbox also reports 127
// when a program that did run prints "No such file or directory".

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// DEC-39: both engines (srt's wrapper is bash's `exec`, whose message differs).
const ENGINES: SandboxEngine[] =
  platform() === "darwin" || srtUnavailableReason() === undefined ? ["native", "srt"] : ["native"];
const run = (engine: SandboxEngine, command: string, args: string[]) => {
  const cwd = mkdtempSync(join(tmpdir(), "not-started-"));
  dirs.push(cwd);
  return new ProcessSandbox({ engine }).execute(command, args, {
    allowedPaths: [cwd],
    allowNetwork: false,
    timeoutMs: 20_000,
    cwd,
  });
};

describe.each(ENGINES)("a program that never started (%s engine)", (engine) => {
  it("is marked notStarted when the binary does not exist", async () => {
    const r = await run(engine, "definitely-not-a-binary-xyz", []);
    expect(r.notStarted).toBe(true);
  });

  it("is marked notStarted when an absolute path does not exist", async () => {
    const r = await run(engine, "/nonexistent-dir-xyz/tool", []);
    expect(r.notStarted).toBe(true);
  });

  it("is not marked when a program ran and printed No such file or directory", async () => {
    const r = await run(engine, "ls", ["/nonexistent-path-xyz"]);
    expect(r.notStarted).toBeUndefined();
  });

  it("is not marked when a program ran a shell that could not find a command", async () => {
    const r = await run(engine, "/bin/bash", ["-c", "exec definitely-not-a-binary-xyz"]);
    expect(r.exitCode).toBe(127);
    expect(r.notStarted).toBeUndefined();
  });
});
