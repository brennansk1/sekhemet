import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVE_PORT_TRIES } from "../src/daemon.js";
import { AT_LOGIN_PORT_BASE } from "../src/login_service.js";
import { DEFAULT_DASHBOARD_PORT } from "../src/server.js";
import { type Place, place, runCli } from "./support/cli_spawn.js";

/**
 * Start at login (runtime item 5a, NEW-runtime-15, RUN-74..77; DEC-53 c10;
 * FINDINGS REL-14), through the built command. The home is a temporary
 * folder, so the LaunchAgent (macOS) or `systemd --user` unit (Linux) is
 * written under it; `launchctl` and `systemctl` are stand-ins first on PATH
 * that record their arguments, so the real service manager is never called.
 * The same file runs on Linux (the Lima VM) for the systemd unit.
 */

const MAC = process.platform === "darwin";
const uid = process.getuid?.() ?? 0;

/** Stand-in `launchctl` and `systemctl`: record each call; answer `exit` (0 unless told). */
function standIns(p: Place, exit = 0): { bin: string; calls: () => string[] } {
  const bin = join(p.root, "fake-bin");
  const log = join(p.root, "service-calls.log");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["launchctl", "systemctl"]) {
    const f = join(bin, tool);
    writeFileSync(f, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit ${exit}\n`);
    chmodSync(f, 0o755);
  }
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

function repo(p: Place, name: string): string {
  const dir = join(p.root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  // The command records the folder as the system spells it (/private/var on macOS).
  return realpathSync(dir);
}

const unitDir = (p: Place) =>
  MAC ? join(p.home, "Library", "LaunchAgents") : join(p.home, ".config", "systemd", "user");

describe("RUN-74..77: `daemon start|stop|status --at-login`, the built CLI", () => {
  it("RUN-74, RUN-75: registers each workspace with the service manager on its own port, recorded, and prints the address", async () => {
    const p = place("sek-at-login-");
    const fake = standIns(p);
    const env = { PATH: `${fake.bin}:${process.env.PATH ?? ""}` };
    const a = repo(p, "alpha");
    const b = repo(p, "beta");
    const first = await runCli(["daemon", "start", "--at-login"], p, { cwd: a, env });
    expect(first.code, first.out).toBe(0);
    const portA = Number(/Bookmark http:\/\/127\.0\.0\.1:(\d+)/.exec(first.out)?.[1]);
    expect(portA).toBeGreaterThanOrEqual(AT_LOGIN_PORT_BASE);
    const second = await runCli(["daemon", "start", "--at-login"], p, { cwd: b, env });
    expect(second.code, second.out).toBe(0);
    const portB = Number(/Bookmark http:\/\/127\.0\.0\.1:(\d+)/.exec(second.out)?.[1]);
    // RUN-75: a port no other registered workspace uses.
    expect(portB).not.toBe(portA);
    const units = readdirSync(unitDir(p));
    expect(units).toHaveLength(2);
    const unitA = units
      .map((u) => readFileSync(join(unitDir(p), u), "utf8"))
      .find((t) => t.includes("--port") && t.includes(String(portA))) as string;
    expect(unitA).toBeTruthy();
    if (MAC) {
      expect(unitA).toMatch(/<key>RunAtLoad<\/key><true\/>/);
      expect(unitA).toMatch(
        new RegExp(
          `<string>serve</string>\\s*<string>--repo</string>\\s*<string>${a}</string>\\s*<string>--port</string>\\s*<string>${portA}</string>`,
        ),
      );
      expect(fake.calls().filter((c) => c.includes("bootstrap"))).toHaveLength(2);
      expect(fake.calls()[1]).toMatch(
        new RegExp(
          `^launchctl bootstrap gui/${uid} ${unitDir(p)}/sekhemet\\.serve\\.[0-9a-f]{12}\\.plist$`,
        ),
      );
    } else {
      expect(unitA).toMatch(new RegExp(`ExecStart=.*"serve" "--repo" "${a}" "--port" "${portA}"`));
      expect(unitA).toMatch(/WantedBy=default\.target/);
      expect(fake.calls()).toContain("systemctl --user daemon-reload");
      expect(
        fake
          .calls()
          .filter((c) => /^systemctl --user enable sekhemet-serve-[0-9a-f]{12}\.service$/.test(c)),
      ).toHaveLength(2);
      expect(
        fake
          .calls()
          .filter((c) => /^systemctl --user start sekhemet-serve-[0-9a-f]{12}\.service$/.test(c)),
      ).toHaveLength(2);
    }
    // The port is recorded in the unit and the user directory's record.
    const record = JSON.parse(readFileSync(join(p.home, ".sekhemet", "at-login.json"), "utf8")) as {
      registered: { folder: string; port: number }[];
    };
    expect(record.registered.map((r) => [r.folder, r.port])).toEqual([
      [a, portA],
      [b, portB],
    ]);
    // Again: nothing changes.
    const again = await runCli(["daemon", "start", "--at-login"], p, { cwd: a, env });
    expect(again.out).toMatch(/already starts at login.*nothing was changed/);
    expect(readdirSync(unitDir(p))).toHaveLength(2);

    // RUN-77: status says it; status --all lists each workspace's port and state.
    const status = await runCli(["daemon", "status"], p, { cwd: a, env });
    expect(status.out).toMatch(
      new RegExp(`Starts at login: yes, at http://127\\.0\\.0\\.1:${portA}`),
    );
    const none = await runCli(["daemon", "status"], p, { cwd: repo(p, "gamma"), env });
    expect(none.out).toMatch(/Starts at login: no/);
    const all = await runCli(["daemon", "status", "--all"], p, { cwd: p.home, env });
    expect(all.code).toBe(0);
    expect(all.out).toMatch(
      new RegExp(`${a}\\s+http://127\\.0\\.0\\.1:${portA}\\s+starts at login`),
    );
    expect(all.out).toMatch(
      new RegExp(`${b}\\s+http://127\\.0\\.0\\.1:${portB}\\s+starts at login`),
    );
  }, 120_000);

  it("RUN-74, RUN-77: the unit runs the `node` found on PATH, not the versioned binary behind it, and status says so when that program is gone", async () => {
    const p = place("sek-at-login-node-");
    const fake = standIns(p);
    // A stable link to this Node, as Homebrew's /opt/homebrew/bin/node is to
    // the versioned Cellar binary `process.execPath` names.
    const stable = join(p.root, "stable-bin");
    mkdirSync(stable);
    symlinkSync(process.execPath, join(stable, "node"));
    const env = { PATH: `${fake.bin}:${stable}:${process.env.PATH ?? ""}` };
    const a = repo(p, "alpha");
    const r = await runCli(["daemon", "start", "--at-login"], p, { cwd: a, env });
    expect(r.code, r.out).toBe(0);
    const [unit] = readdirSync(unitDir(p));
    const text = readFileSync(join(unitDir(p), unit as string), "utf8");
    expect(text).toContain(join(stable, "node"));
    expect(text).not.toContain(realpathSync(process.execPath));
    const ok = await runCli(["daemon", "status"], p, { cwd: a, env });
    expect(ok.out).toMatch(/Starts at login: yes/);
    // Node removed or moved (an upgrade under nvm): the unit would not start,
    // and status says so with the fix, rather than "yes".
    rmSync(join(stable, "node"));
    const gone = await runCli(["daemon", "status"], p, { cwd: a, env });
    expect(gone.out).not.toMatch(/Starts at login: yes/);
    expect(gone.out).toMatch(
      /Starts at login: registered, but .*stable-bin\/node no longer exists.*daemon stop --at-login.*daemon start --at-login/,
    );
  }, 120_000);

  it("RUN-76: `daemon stop --at-login` unloads and removes only the unit it wrote", async () => {
    const p = place("sek-at-login-stop-");
    const fake = standIns(p);
    const env = { PATH: `${fake.bin}:${process.env.PATH ?? ""}` };
    const a = repo(p, "alpha");
    const b = repo(p, "beta");
    await runCli(["daemon", "start", "--at-login"], p, { cwd: a, env });
    await runCli(["daemon", "start", "--at-login"], p, { cwd: b, env });
    // Someone else's unit in the same folder, and beta's changed by hand.
    const other = join(unitDir(p), MAC ? "com.example.other.plist" : "other.service");
    writeFileSync(other, "not Sekhemet's\n");
    const record = JSON.parse(readFileSync(join(p.home, ".sekhemet", "at-login.json"), "utf8")) as {
      registered: { folder: string; unit: string }[];
    };
    const unitA = record.registered.find((r) => r.folder === a)?.unit as string;
    const unitB = record.registered.find((r) => r.folder === b)?.unit as string;
    writeFileSync(unitB, `${readFileSync(unitB, "utf8")}\n# changed by hand\n`);

    const stopA = await runCli(["daemon", "stop", "--at-login"], p, { cwd: a, env });
    expect(stopA.code, stopA.out).toBe(0);
    expect(stopA.out).toMatch(/no longer starts at login/);
    expect(existsSync(unitA)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(
      fake
        .calls()
        .some((c) =>
          MAC
            ? c === `launchctl bootout gui/${uid} ${unitA}`
            : /^systemctl --user disable sekhemet-serve-/.test(c),
        ),
    ).toBe(true);
    // Beta's unit changed after Sekhemet wrote it: left in place, and said so.
    const stopB = await runCli(["daemon", "stop", "--at-login"], p, { cwd: b, env });
    expect(stopB.code).toBe(1);
    expect(stopB.out).toMatch(/was changed after Sekhemet wrote it, so it was left in place/);
    expect(existsSync(unitB)).toBe(true);
    const status = await runCli(["daemon", "status"], p, { cwd: a, env });
    expect(status.out).toMatch(/Starts at login: no/);
  }, 120_000);

  it("RUN-74: where the service manager cannot be used, nothing is written and the reason is said", async () => {
    const p = place("sek-at-login-none-");
    const fake = standIns(p, 1);
    const env = { PATH: `${fake.bin}:${process.env.PATH ?? ""}` };
    const a = repo(p, "alpha");
    const r = await runCli(["daemon", "start", "--at-login"], p, { cwd: a, env });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      MAC
        ? /Nothing was changed: launchctl cannot reach/
        : /Nothing was changed: this session has no systemd --user manager/,
    );
    expect(existsSync(unitDir(p))).toBe(false);
    expect(existsSync(join(p.home, ".sekhemet", "at-login.json"))).toBe(false);
    // Only the question was asked: nothing was loaded.
    expect(fake.calls()).toEqual([
      MAC ? `launchctl print gui/${uid}` : "systemctl --user show-environment",
    ]);
  }, 60_000);

  it("RUN-75: a registration's port is past every port `serve` moves to on its own", () => {
    expect(AT_LOGIN_PORT_BASE).toBeGreaterThanOrEqual(DEFAULT_DASHBOARD_PORT + SERVE_PORT_TRIES);
  });
});
