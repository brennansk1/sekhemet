import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/index.js";

// Gates rule 9 (B2.3 confirmation review): a program that never started is
// said explicitly. Exit 127 alone cannot say it — the sandbox also reports 127
// when a program that did run prints "No such file or directory".

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const run = (command: string, args: string[]) => {
  const cwd = mkdtempSync(join(tmpdir(), "not-started-"));
  dirs.push(cwd);
  return new ProcessSandbox().execute(command, args, {
    allowedPaths: [cwd],
    allowNetwork: false,
    timeoutMs: 20_000,
    cwd,
  });
};

describe("a program that never started", () => {
  it("is marked notStarted when the binary does not exist", async () => {
    const r = await run("definitely-not-a-binary-xyz", []);
    expect(r.notStarted).toBe(true);
  });

  it("is not marked when a program ran and printed No such file or directory", async () => {
    const r = await run("ls", ["/nonexistent-path-xyz"]);
    expect(r.notStarted).toBeUndefined();
  });
});
