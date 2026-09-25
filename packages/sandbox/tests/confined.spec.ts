import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dumpDom } from "../src/browser.js";
import { confinedPlacement, runConfined, spawnConfined } from "../src/confined.js";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { srtUnavailableReason } from "../src/srt_engine.js";

/**
 * S3a: runConfined() is the one chokepoint for worktree code (items 4, 6,
 * 8a). Canary markers: a fixture tries to write outside its root, and the
 * test asserts the marker is absent.
 */
const darwin = platform() === "darwin";

describe("runConfined (S3a)", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "confined-root-"));
    outside = mkdtempSync(join(tmpdir(), "confined-out-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  const writeTo = (target: string) =>
    `try { require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); console.log('wrote') } catch (e) { console.log(e.code) }`;

  it.runIf(darwin)("writes inside the root, and a marker outside it stays absent", async () => {
    const marker = join(outside, "marker");
    const r = await runConfined(
      process.execPath,
      ["-e", `${writeTo(join(root, "in.txt"))};${writeTo(marker)}`],
      { root, timeoutMs: 20_000 },
    );
    expect(existsSync(join(root, "in.txt"))).toBe(true);
    expect(r.stdout).toContain("EPERM");
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(darwin)(
    "SEC-6b: a cwd outside the recorded root is clamped to it and never widens the sandbox",
    async () => {
      const marker = join(outside, "marker");
      const r = await runConfined(process.execPath, ["-e", writeTo("marker")], {
        root,
        cwd: outside,
        timeoutMs: 20_000,
      });
      expect(r.cwdClamped).toBe(true);
      expect(r.cwd).toBe(realpathSync(root));
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "marker"))).toBe(true);
      // A relative escape is clamped the same way.
      expect(confinedPlacement(root, "../..").cwdClamped).toBe(true);
      expect(confinedPlacement(root, ".").cwdClamped).toBe(false);
    },
  );

  it("item 8a: the root is canonicalised, symlinks resolved", () => {
    const link = join(outside, "link");
    symlinkSync(root, link);
    expect(confinedPlacement(link).root).toBe(realpathSync(root));
  });

  it("item 6: only the allowlist and the caller's named variables, never a key", async () => {
    vi.stubEnv("SEKHEMET_CANARY_API_KEY", "sk-canary");
    vi.stubEnv("SEKHEMET_CANARY_PLAIN", "plain");
    const r = await runConfined(
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.env))"],
      {
        root,
        env: { PORT: "1234", GITHUB_TOKEN: "ghp-canary", OPENAI_API_KEY: "sk-2" },
        timeoutMs: 20_000,
        sandbox: new ProcessSandbox({ disableConfinement: true }),
      },
    );
    const env = JSON.parse(r.stdout) as Record<string, string>;
    expect(env.PORT).toBe("1234");
    for (const k of [
      "SEKHEMET_CANARY_API_KEY",
      "SEKHEMET_CANARY_PLAIN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
    ]) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it.runIf(darwin)("the network is off unless a port is named", async () => {
    let connections = 0;
    const server: Server = createServer((s) => {
      connections++;
      s.end();
    });
    const port: number = await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
    );
    const probe = `require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('connected'); process.exit(0) }).on('error', (e) => { console.log(e.code); process.exit(3) })`;
    try {
      const off = await runConfined(process.execPath, ["-e", probe], { root, timeoutMs: 20_000 });
      expect(off.exitCode).toBe(3);
      expect(connections).toBe(0);
      const on = await runConfined(process.execPath, ["-e", probe], {
        root,
        localPorts: [port],
        timeoutMs: 20_000,
      });
      expect(on.stdout).toContain("connected");
    } finally {
      server.close();
    }
  });

  it("fails closed: no confinement means no run and no background process", async () => {
    const unconfinable = new ProcessSandbox({ disableConfinement: true, requireConfinement: true });
    const marker = join(outside, "marker");
    const r = await runConfined(process.execPath, ["-e", writeTo(marker)], {
      root,
      timeoutMs: 5_000,
      sandbox: unconfinable,
    });
    expect(r.exitCode).toBe(126);
    expect(
      await spawnConfined(process.execPath, ["-e", writeTo(marker)], {
        root,
        timeoutMs: 0,
        sandbox: unconfinable,
      }),
    ).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(darwin)("a background process is held to its time limit", async () => {
    const child = await spawnConfined(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      root,
      timeoutMs: 300,
    });
    expect(child).not.toBeNull();
    const started = Date.now();
    await new Promise((r) => child?.once("exit", r));
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.runIf(darwin)(
    "SEC-17: the browse tool's browser runs confined (a fake Chrome that writes outside)",
    async () => {
      const marker = join(outside, "marker");
      const fake = join(root, "fake-chrome.sh");
      writeFileSync(
        fake,
        `#!/bin/sh\necho escaped > ${JSON.stringify(marker)} 2>/dev/null\necho '<html><body>fake</body></html>'\n`,
      );
      chmodSync(fake, 0o755);
      vi.stubEnv("SEKHEMET_CHROME", fake);
      const dom = await dumpDom("http://127.0.0.1:9/");
      expect(dom).toContain("fake");
      expect(existsSync(marker)).toBe(false);
    },
  );

  const engines: SandboxEngine[] =
    darwin || srtUnavailableReason() === undefined ? ["native", "srt"] : ["native"];
  for (const engine of engines) {
    it.runIf(darwin)(
      `denyHomeReads (${engine}): a key under HOME is unreadable by absolute path, toolchains still run`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "confined-home-"));
        try {
          const key = join(home, "notes", "canary-key.txt");
          mkdirSync(dirname(key));
          writeFileSync(key, "home-canary-key");
          vi.stubEnv("HOME", home);
          const read = `try { console.log(require('fs').readFileSync(${JSON.stringify(key)}, 'utf8')) } catch (e) { console.log(e.code) }`;
          const sandbox = new ProcessSandbox({ engine });
          // The control: without the deny, reads are broad and the key leaks.
          const open = await runConfined(process.execPath, ["-e", read], {
            root,
            timeoutMs: 20_000,
            sandbox,
          });
          expect(open.stdout).toContain("home-canary-key");
          const denied = await runConfined(process.execPath, ["-e", read], {
            root,
            timeoutMs: 20_000,
            sandbox,
            denyHomeReads: true,
          });
          expect(denied.exitCode).toBe(0);
          expect(denied.stdout).not.toContain("home-canary-key");
          expect(denied.stdout).toMatch(/EPERM|EACCES/);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
      30_000,
    );
  }

  it.runIf(darwin)(
    "stop() ends the whole tree, a descendant in its own process group included",
    async () => {
      const script = `const { spawn } = require("child_process");
const a = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
const b = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
console.log(a.pid + " " + b.pid);
setInterval(() => {}, 1000);`;
      const child = await spawnConfined(process.execPath, ["-e", script], { root, timeoutMs: 0 });
      expect(child).not.toBeNull();
      const pids: number[] = await new Promise((resolve) =>
        child?.stdout.once("data", (d: Buffer) =>
          resolve(d.toString().trim().split(" ").map(Number)),
        ),
      );
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(pids.every(alive)).toBe(true);
      await child?.stop();
      await new Promise((r) => setTimeout(r, 200));
      expect(pids.filter(alive)).toEqual([]);
      expect(child?.pid !== undefined && alive(child.pid)).toBe(false);
    },
    20_000,
  );
});
