import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A harness killed mid-run must not leave its llama-server behind: on the
 * reference host that orphan holds a 13GB checkpoint nothing will release.
 * A stand-in "server" records its pid and sleeps; the harness side is a child
 * node process we SIGTERM, then we check the stand-in is gone.
 */
describe("@sekhemet/models managed llama-server lifetime", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llama-life-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills the server process when the harness receives SIGTERM", async () => {
    const pidFile = join(dir, "server.pid");
    const fakeServer = join(dir, "fake-llama-server.sh");
    writeFileSync(fakeServer, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
    chmodSync(fakeServer, 0o755);
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");

    const dist = join(__dirname, "..", "dist", "llama_server.js");
    const harness = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { ManagedLlamaServerAdapter } = await import(${JSON.stringify(dist)});
         const a = new ManagedLlamaServerAdapter({ modelId: "fake", modelPath: ${JSON.stringify(model)},
           binary: ${JSON.stringify(fakeServer)}, port: 18997, startupTimeoutMs: 120000,
           ollamaBaseUrl: "http://127.0.0.1:1" });
         a.ensureRunning().catch(() => {});`,
      ],
      { stdio: "ignore" },
    );

    // Wait for the stand-in server to start.
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    const serverPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(alive(serverPid)).toBe(true);

    harness.kill("SIGTERM");
    await new Promise((r) => harness.once("exit", r));
    const gone = Date.now() + 5_000;
    while (alive(serverPid) && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));

    expect(alive(serverPid)).toBe(false);
  }, 30_000);
});
