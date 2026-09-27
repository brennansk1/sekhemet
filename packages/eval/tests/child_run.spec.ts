import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Live-test F19: stopping `node scripts/run_suite.mjs` (SIGTERM) left the
 * queue's managed llama-server running. The script ran each queue with
 * `execFileSync`, so its own death reached neither the harness child nor the
 * server that child started. `runChild` passes the signal on: the child's
 * `bindToParentLifetime` stops its server, then the script exits.
 *
 * Here a stand-in server (a shell script that records its pid and sleeps)
 * is started by a stand-in harness (a real ManagedLlamaServerAdapter), run by
 * a stand-in suite script through `runChild`; the suite script is SIGTERMed.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-childrun-"));
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

const waitFor = async (ok: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
};

describe("a suite script's stop reaches the managed server its queue started (F19)", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`stops the server when the script receives ${signal}`, async () => {
      const serverPid = join(dir, "server.pid");
      const harnessPid = join(dir, "harness.pid");
      const fakeServer = join(dir, "fake-llama-server.sh");
      writeFileSync(fakeServer, `#!/bin/sh\necho $$ > "${serverPid}"\nexec sleep 300\n`);
      chmodSync(fakeServer, 0o755);
      const model = join(dir, "model.gguf");
      writeFileSync(model, "not a real model");

      const models = join(__dirname, "..", "..", "models", "dist", "llama_server.js");
      const harness = join(dir, "harness.mjs");
      writeFileSync(
        harness,
        `import { writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(harnessPid)}, String(process.pid));
         const { ManagedLlamaServerAdapter } = await import(${JSON.stringify(models)});
         const a = new ManagedLlamaServerAdapter({ modelId: "fake", modelPath: ${JSON.stringify(model)},
           binary: ${JSON.stringify(fakeServer)}, port: 18996, startupTimeoutMs: 120000,
           ollamaBaseUrl: "http://127.0.0.1:1" });
         a.ensureRunning().catch(() => {});`,
      );
      const childRun = join(__dirname, "..", "dist", "child_run.js");
      const suite = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { runChild } = await import(${JSON.stringify(childRun)});
           await runChild(process.execPath, [${JSON.stringify(harness)}], { stdio: "ignore" });
           console.log("the suite went on after its stop");`,
        ],
        { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env } },
      );
      let stdout = "";
      suite.stdout?.on("data", (c) => {
        stdout += String(c);
      });

      await waitFor(() => existsSync(serverPid), 10_000);
      const server = Number.parseInt(readFileSync(serverPid, "utf8"), 10);
      const child = Number.parseInt(readFileSync(harnessPid, "utf8"), 10);
      expect(alive(server)).toBe(true);

      const exited = new Promise<number | null>((r) => suite.once("exit", (code) => r(code)));
      suite.kill(signal);
      const code = await exited;
      await waitFor(() => !alive(server) && !alive(child), 5_000);

      expect(alive(server)).toBe(false);
      expect(alive(child)).toBe(false);
      // The script stops too, with the signal's exit code, and runs nothing after.
      expect(code).toBe(signal === "SIGTERM" ? 143 : 130);
      expect(stdout).not.toMatch(/went on/);
    }, 30_000);
  }
});

describe("the escalation reaches the whole child group (F19 review, major 1)", () => {
  it("a child that cannot answer SIGTERM in time is killed with its own children", async () => {
    const { runChild } = await import("../src/child_run.js");
    const pidFile = join(dir, "grandchild.pid");
    // A stand-in harness busy in a synchronous call: it ignores SIGTERM, and
    // its child (the stand-in llama-server) would otherwise outlive it.
    const script = join(dir, "busy.mjs");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    const run = runChild(process.execPath, [script], {
      stdio: "ignore",
      timeoutMs: 400,
      graceMs: 300,
      exitOnSignal: false,
    });
    const r = await run;
    expect(r.timedOut).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(grandchild)).toBe(false);
  });
});
