import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv, runWithSecrets } from "../src/injector.js";

/** Run a short Node.js script as the child process. */
const node = process.execPath;

describe("onyx buildChildEnv", () => {
  it("lets secrets override base variables", () => {
    expect(buildChildEnv({ PATH: "/bin", TOKEN: "old" }, { TOKEN: "new", EXTRA: "1" })).toEqual({
      PATH: "/bin",
      TOKEN: "new",
      EXTRA: "1",
    });
  });

  it("drops undefined base values", () => {
    expect(buildChildEnv({ A: "1", B: undefined }, {})).toEqual({ A: "1" });
  });

  it("does not mutate either input", () => {
    const base = { A: "1" };
    const secrets = { B: "2" };
    buildChildEnv(base, secrets);
    expect(base).toEqual({ A: "1" });
    expect(secrets).toEqual({ B: "2" });
  });
});

describe("onyx runWithSecrets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onyx-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("injects secrets into the child environment and captures stdout", async () => {
    const result = await runWithSecrets(
      node,
      ["-e", "process.stdout.write(process.env.ONYX_API_KEY ?? 'missing')"],
      { ONYX_API_KEY: "sk_live_999" },
      { cwd: dir },
    );
    expect(result).toEqual({ code: 0, signal: null, stdout: "sk_live_999", stderr: "" });
  });

  it("leaves the parent process environment untouched", async () => {
    await runWithSecrets(node, ["-e", ""], { ONYX_PARENT_LEAK_CHECK: "x" }, { cwd: dir });
    expect(process.env.ONYX_PARENT_LEAK_CHECK).toBeUndefined();
  });

  it("writes nothing to disk in the working directory", async () => {
    await runWithSecrets(node, ["-e", "process.stdout.write('ok')"], { A: "1" }, { cwd: dir });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("uses baseEnv instead of process.env when given", async () => {
    const result = await runWithSecrets(
      node,
      ["-e", "process.stdout.write(String(process.env.HOME_MARKER) + ':' + process.env.S)"],
      { S: "secret" },
      { cwd: dir, baseEnv: { HOME_MARKER: "base" } },
    );
    expect(result.stdout).toBe("base:secret");
  });

  it("propagates a non-zero exit code and captures stderr", async () => {
    const result = await runWithSecrets(
      node,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      {},
      { cwd: dir },
    );
    expect(result).toEqual({ code: 3, signal: null, stdout: "", stderr: "boom" });
  });

  it("passes arguments without a shell, so metacharacters stay literal", async () => {
    const result = await runWithSecrets(
      node,
      ["-e", "process.stdout.write(process.argv[1])", "$HOME; echo hi"],
      {},
      { cwd: dir },
    );
    expect(result.stdout).toBe("$HOME; echo hi");
  });

  it("kills the child with SIGTERM when the timeout elapses", async () => {
    const result = await runWithSecrets(
      node,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      {
        cwd: dir,
        timeoutMs: 200,
      },
    );
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      runWithSecrets("onyx-command-that-does-not-exist", [], {}, { cwd: dir }),
    ).rejects.toThrow(/ENOENT/);
  });
});
