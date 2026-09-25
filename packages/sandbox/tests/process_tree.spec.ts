import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSandbox, processStartTime, reapOrphanedGroups, sameProcess } from "../src/index.js";

/**
 * NEW-runtime-2 (runtime.md item 7): every command runs in its own process
 * group and a kill reaches the whole tree, including a grandchild whose
 * parent has already exited; RUN-12's orphan check reads the registry of
 * live groups a killed runner leaves behind. Real processes throughout.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tree-"));
  dirs.push(dir);
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pidFrom(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() > deadline) throw new Error(`no pid at ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return Number(readFileSync(path, "utf8").trim());
}

describe("NEW-runtime-2: kills reach every descendant", () => {
  it("RUN-6: a timed-out command's orphaned grandchild is gone 1 s after the kill", async () => {
    const dir = scratch();
    const pidFile = join(dir, "grandchild.pid");
    const sandbox = new ProcessSandbox({ disableConfinement: true, requireConfinement: false });
    // The subshell exits at once, so its background sleep is reparented and
    // is no longer in the command's tree when the timeout fires.
    const result = await sandbox.execute(
      "sh",
      ["-c", `(sleep 30 & echo $! > ${pidFile}); sleep 30`],
      {
        cwd: dir,
        timeoutMs: 800,
        allowedPaths: [dir],
        allowNetwork: false,
      },
    );
    expect(result.timedOut).toBe(true);
    const grandchild = await pidFrom(pidFile);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it("RUN-12 (registry): a runner killed with SIGKILL leaves groups the next start reaps", async () => {
    const dir = scratch();
    const registry = join(dir, "processes");
    mkdirSync(registry);
    const pidFile = join(dir, "cmd.pid");
    const dist = join(import.meta.dirname, "../dist/index.js");
    // A runner process that starts a long command, records it, and is then killed.
    const runner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ProcessSandbox } from ${JSON.stringify(dist)};
         const s = new ProcessSandbox({ disableConfinement: true, requireConfinement: false });
         void s.execute("sh", ["-c", "echo $$ > ${pidFile}; sleep 60"], { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000, allowedPaths: [], allowNetwork: false });
         setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore", env: { ...process.env, SEKHEMET_PROCESS_REGISTRY: registry } },
    );
    const cmd = await pidFrom(pidFile);
    const deadline = Date.now() + 5_000;
    while (readdirSync(registry).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(readdirSync(registry).length).toBe(1);
    runner.kill("SIGKILL");
    await new Promise((r) => runner.once("exit", r));
    // The runner is gone; its command is not.
    expect(alive(cmd)).toBe(true);
    const reaped = reapOrphanedGroups(registry);
    expect(reaped.length).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(cmd)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
  }, 20_000);

  it("RUN-12: a dead runner's group whose leader has exited but whose members live is killed, not forgotten", async () => {
    const dir = scratch();
    const registry = join(dir, "processes");
    mkdirSync(registry);
    const pidFile = join(dir, "member.pid");
    // The leader backgrounds a member of its group and exits at once.
    const leader = spawn("sh", ["-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; exit 0`], {
      detached: true,
      stdio: "ignore",
    });
    const leaderPid = leader.pid as number;
    await new Promise((r) => leader.once("exit", r));
    const member = await pidFrom(pidFile);
    expect(alive(member)).toBe(true);
    writeFileSync(
      join(registry, `${leaderPid}.json`),
      JSON.stringify({ pid: leaderPid, processStart: "gone", owner: 2 ** 22 + 12345 }),
    );
    try {
      expect(reapOrphanedGroups(registry)).toEqual([leaderPid]);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(member)).toBe(false);
      expect(readdirSync(registry)).toEqual([]);
    } finally {
      try {
        process.kill(member, "SIGKILL");
      } catch {
        // Reaped.
      }
    }
  }, 20_000);

  it("names a process by pid and start time, so a recycled pid does not match", () => {
    const start = processStartTime(process.pid);
    expect(start).toBeTruthy();
    expect(sameProcess(process.pid, start)).toBe(true);
    expect(sameProcess(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
    expect(processStartTime(2 ** 22 + 12345)).toBeUndefined();
  });
});
