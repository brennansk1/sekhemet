import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leaseProcessStart } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type Place, place, runCli, writeFile } from "./support/cli_spawn.js";

// `doctor`'s reliability rows through their door (C2d, FINDINGS_C1 TST-01;
// surface item 20e, NEW-surface-12): the built `sekhemet doctor` spawned in a
// real repository with an empty home. The machine's own tools are faulted at
// the process boundary — a `caffeinate`/`systemd-inhibit` that refuses, a
// `pmset` that reports the battery, a `du` that reports a worktree too large
// for the disk — by putting a script of that name first on PATH; the model
// lease is a live process's lease file. Before C2d these were proved by
// calling each check in process (doctor_reliability.spec.ts).

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
});

/** A folder of stand-in tools, put first on PATH for the spawned command. */
function bin(p: Place, tools: Record<string, string>): Record<string, string> {
  const dir = join(p.root, "bin");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

function repo(p: Place): string {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
  return p.repo;
}

/** The doctor's line for one row: its mark, its name, and what it says. */
function row(out: string, name: string): string {
  return out.split("\n").find((l) => l.includes(` ${name}: `)) ?? `(no ${name} row)\n${out}`;
}

/** The tool this platform keeps the machine awake with (sleep_assertion.ts). */
const AWAKE = process.platform === "darwin" ? "caffeinate" : "systemd-inhibit";

describe("doctor's reliability rows, spawned (SUR-84, SUR-85, SUR-87)", () => {
  it(
    "SUR-84: names the tool that keeps the machine awake, and warns naming it when it refuses",
    { timeout: 120_000 },
    async () => {
      const p = place("sek-doctor-awake-");
      repo(p);
      const works = await runCli(["doctor"], p, {
        env: bin(p, { [AWAKE]: "exit 0" }),
        timeoutMs: 120_000,
      });
      expect(row(works.out, "Staying awake")).toMatch(
        new RegExp(`✓ Staying awake: \\S*/bin/${AWAKE} keeps the machine awake`),
      );
      const refuses = await runCli(["doctor"], p, {
        env: bin(p, { [AWAKE]: 'echo "denied by policy" >&2\nexit 1' }),
        timeoutMs: 120_000,
      });
      expect(row(refuses.out, "Staying awake")).toMatch(
        new RegExp(
          `! Staying awake: \\S*/bin/${AWAKE} refused to keep the machine awake \\(denied by policy\\)`,
        ),
      );
    },
  );

  // The power source is read from `pmset` on macOS only (Linux reads sysfs,
  // which no test can switch); the warning is the same row either way.
  it.runIf(process.platform === "darwin")(
    "SUR-84: on battery with an overnight window set, warns that a closed lid stops the night",
    { timeout: 120_000 },
    async () => {
      const p = place("sek-doctor-power-");
      repo(p);
      const battery = bin(p, {
        pmset: `echo "Now drawing from 'Battery Power'"\necho " -InternalBattery-0 (id=1)\t87%; discharging; 5:12 remaining present: true"`,
      });
      const noWindow = await runCli(["doctor"], p, { env: battery, timeoutMs: 120_000 });
      expect(row(noWindow.out, "Power")).toMatch(
        /✓ Power: on battery power; no overnight window is set/,
      );
      writeFile(p.repo, ".sekhemet/config.toml", '[machine]\novernight_hours = "22:00-06:00"\n');
      const window = await runCli(["doctor"], p, { env: battery, timeoutMs: 120_000 });
      expect(row(window.out, "Power")).toMatch(
        /! Power: on battery power with an overnight window set: [^\n]*a closed lid or a sleep the battery forces stops the night/,
      );
    },
  );

  it(
    "SUR-85: shows the repository's and the models' free space against the floor, and fails below it",
    { timeout: 120_000 },
    async () => {
      const p = place("sek-doctor-space-");
      repo(p);
      mkdirSync(p.models, { recursive: true });
      const fine = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(row(fine.out, "Free space")).toMatch(
        /✓ Free space: the repository \([^)]+\): [\d.]+ [GMT]B free of a 5\.0 GB floor; the models \([^)]+\): [\d.]+ [GMT]B free of a 5\.0 GB floor/,
      );
      // A worktree that `du` reports at 50 TB raises the floor to twice it:
      // no volume has that free, so no issue could start.
      mkdirSync(join(p.repo, ".sekhemet", "worktrees", "card_big"), { recursive: true });
      const short = await runCli(["doctor"], p, {
        env: bin(p, { du: 'printf "53687091200\\t%s\\n" "$2"' }),
        timeoutMs: 120_000,
      });
      expect(row(short.out, "Free space")).toMatch(
        /✗ Free space: the repository \([^)]+\): [\d.]+ [GMT]B free of a 100(\.0)? TB floor[^\n]*below the floor no issue starts/,
      );
      expect(short.code).not.toBe(0);
    },
  );

  it(
    "SUR-87: warns naming the live holder of the model lease, and passes a stale one naming it",
    { timeout: 120_000 },
    async () => {
      const p = place("sek-doctor-lease-");
      repo(p);
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      kids.push(holder);
      await new Promise((r) => setTimeout(r, 300));
      const pid = holder.pid as number;
      writeFile(
        p.home,
        ".sekhemet/model.lock",
        JSON.stringify({
          pid,
          processStart: leaseProcessStart(pid),
          token: "t",
          since: "2026-10-05T08:00:00.000Z",
          workspace: "ws_alpha",
          project: "/work/alpha",
          models: [{ model: "coder-a", port: 8098, since: "2026-10-05T08:00:00.000Z", hold: "h" }],
        }),
      );
      const held = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(row(held.out, "Model lease")).toMatch(
        new RegExp(
          `! Model lease: another process holds this machine's model lease: project /work/alpha \\(workspace ws_alpha\\) holds coder-a on port 8098 \\(pid ${pid},`,
        ),
      );
      holder.kill("SIGKILL");
      await new Promise((r) => holder.once("exit", r));
      const stale = await runCli(["doctor"], p, { timeoutMs: 120_000 });
      expect(row(stale.out, "Model lease")).toMatch(
        new RegExp(`✓ Model lease: a stale lease from pid ${pid}, whose process is gone`),
      );
    },
  );
});
