import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { killUnder } from "./support/global_tmp.js";
import { guardedImports, killTree, trackChild } from "./support/hygiene.js";

/**
 * F31 (C5): the test run's own hygiene — the model-port guard every spawned
 * command loads, the run's temporary folder, and the process-group teardown
 * — checked with real processes.
 */

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("F31: test hygiene", () => {
  it("a spawned process with the guard is refused the owner's model ports (11434, 8098, 8099, 8080) before any connection, by a socket or by fetch", () => {
    const probe = `import net from "node:net";
      const ports = [11434, 8098, 8099, 8080];
      const out = await Promise.all(ports.map((port) => new Promise((ok) => {
        const s = net.connect({ port, host: "127.0.0.1" });
        s.on("connect", () => { s.destroy(); ok(port + ":connected"); });
        s.on("error", (e) => ok(port + ":" + e.message));
      })));
      const viaFetch = await fetch("http://127.0.0.1:11434/api/tags").then(
        () => "fetch:answered",
        (e) => "fetch:" + (e.cause?.message ?? e.message),
      );
      console.log([...out, viaFetch].join("\\n"));`;
    const r = spawnSync(
      process.execPath,
      [...guardedImports(), "--input-type=module", "-e", probe],
      { encoding: "utf8", timeout: 20_000 },
    );
    const lines = r.stdout.trim().split("\n");
    expect(lines, r.stderr).toHaveLength(5);
    for (const line of lines) expect(line).toMatch(/\(test guard\)$/);
  });

  it("the run's temporary folder is its own, under the system's", () => {
    expect(basename(tmpdir())).toMatch(/^skv-/);
    expect(process.env.SEKHEMET_TEST_RUN_TMP).toBe(tmpdir());
    expect(dirname(tmpdir()).length).toBeGreaterThan(0);
  });

  it("killTree ends a tracked child and the grandchild it started", async () => {
    const child = trackChild(
      spawn(
        process.execPath,
        [
          "-e",
          `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
           console.log(c.pid); setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      ),
    );
    const grandchild = Number(
      await new Promise<string>((ok) => child.stdout?.once("data", (d) => ok(String(d)))),
    );
    expect(alive(grandchild)).toBe(true);
    killTree(child);
    await until(() => !alive(grandchild));
    expect(alive(child.pid as number)).toBe(false);
  });

  it("killUnder ends every process whose command line names the folder, with its children", async () => {
    const marker = `${tmpdir()}/sek-killunder-${process.pid}`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
         console.log(c.pid); setInterval(() => {}, 1000);`,
        marker,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const grandchild = Number(
      await new Promise<string>((ok) => child.stdout?.once("data", (d) => ok(String(d)))),
    );
    const killed = killUnder(marker);
    expect(killed).toEqual(expect.arrayContaining([child.pid, grandchild]));
    await until(() => !alive(grandchild) && !alive(child.pid as number));
  });
});
