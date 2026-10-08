import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The clean-machine walk (FINDINGS_C1 INS-05; DoD §6.7, §G 8; W10, R9):
 * `node scripts/clean_machine_walk.mjs`, spawned as the person doing the
 * macOS or Ubuntu walk runs it, answering on stdin. It shows each step's
 * commands, records each step's wall time to a JSON log, and never runs a
 * download or anything else that leaves the machine itself.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = join(ROOT, "scripts", "clean_machine_walk.mjs");
const STEPS = ["install", "doctor", "model-download", "verification", "first-issue", "accept"];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A preload that writes every outward connection and spawned program to a file. */
function recorder(dir: string): { file: string; log: string } {
  const log = join(dir, "activity.log");
  const file = join(dir, "record.mjs");
  writeFileSync(
    file,
    `import net from "node:net";
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const note = (s) => appendFileSync(${JSON.stringify(log)}, s + "\\n");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof a === "object" && a !== null ? a : { port: a, host: args[1] };
  note("connect " + (o.path ?? (o.host ?? "localhost") + ":" + o.port));
  return connect.apply(this, args);
};
const real = globalThis.fetch;
globalThis.fetch = (i, init) => { note("fetch " + String(i)); return real(i, init); };
const cp = createRequire(import.meta.url)("node:child_process");
for (const k of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const f = cp[k];
  cp[k] = function (cmd, ...rest) { note("run " + cmd + " " + (Array.isArray(rest[0]) ? rest[0].join(" ") : "")); return f.call(this, cmd, ...rest); };
}
syncBuiltinESMExports();
`,
  );
  return { file, log };
}

function walk(args: string[], input: string) {
  const dir = mkdtempSync(join(tmpdir(), "sek-walk-"));
  dirs.push(dir);
  const rec = recorder(dir);
  const r = spawnSync(process.execPath, ["--import", rec.file, SCRIPT, ...args], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    timeout: 60_000,
  });
  const activity = existsSync(rec.log)
    ? readFileSync(rec.log, "utf8").split("\n").filter(Boolean)
    : [];
  return { dir, status: r.status, out: `${r.stdout}${r.stderr}`, activity };
}

describe("the clean-machine walk, spawned (INS-05, DoD §6.7)", () => {
  it("records each of the six steps with its start, end and wall time, and the answer about hand edits, to the log", () => {
    // Per step: Enter to start it, then Enter when it is done, or `done <note>`, `fail <note>`, `skip <reason>`.
    const answers = [
      ...["", ""],
      ...["", "done Homebrew already had git"],
      ...["", "fail the drive was full"],
      ...["", "skip ran verification inside the download"],
      ...["", ""],
      ...["", ""],
      "n",
      "",
    ].join("\n");
    const w = walk(["--os", "macos", "--log", "walk.json"], answers);
    expect(w.status, w.out).toBe(0);
    const log = JSON.parse(readFileSync(join(w.dir, "walk.json"), "utf8"));
    expect(log.schema).toBe(1);
    expect(log.walk).toBe("clean-machine");
    expect(log.os).toBe("macos");
    expect(log.steps.map((s: { id: string }) => s.id)).toEqual(STEPS);
    expect(log.steps.map((s: { outcome: string }) => s.outcome)).toEqual([
      "done",
      "done",
      "failed",
      "skipped",
      "done",
      "done",
    ]);
    expect(log.steps[1].note).toBe("Homebrew already had git");
    expect(log.steps[2].note).toBe("the drive was full");
    expect(log.steps[3].note).toBe("ran verification inside the download");
    for (const s of log.steps) {
      expect(Date.parse(s.endedAt)).toBeGreaterThanOrEqual(Date.parse(s.startedAt));
      expect(s.wallSeconds).toBe(
        Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 10) / 100,
      );
    }
    expect(log.editedByHand).toBe(false);
    expect(log.totalWallSeconds).toBeGreaterThanOrEqual(0);
    expect(log.host.platform).toBe(process.platform);
    expect(log.host.node).toBe(process.version);
    expect(log.host.memoryGB).toBeGreaterThan(0);
    // Each step showed the person what to run, from the README's quickstart.
    expect(w.out).toContain("sekhemet doctor");
    expect(w.out).toContain("sekhemet models fetch --recommended");
    expect(w.out).toContain("sekhemet accept <issue>");
    expect(w.out).toMatch(/The walk is not a pass: 1 step failed/);
  });

  it("never downloads or reaches the network itself: it runs only git --version", () => {
    const w = walk(["--os", "ubuntu", "--log", "walk.json"], `${"\n\n".repeat(6)}n\n`);
    expect(w.status, w.out).toBe(0);
    expect(w.activity.filter((a) => a.startsWith("connect") || a.startsWith("fetch"))).toEqual([]);
    expect(w.activity.filter((a) => a.startsWith("run"))).toEqual(["run git --version"]);
    // Ubuntu's own steps: bubblewrap, socat and the AppArmor profile.
    expect(w.out).toMatch(/bubblewrap/);
    expect(w.out).toMatch(/socat/);
    expect(w.out).toMatch(/apparmor/i);
    expect(w.out).toMatch(/Every step done in [\d.]+ s; no file edited by hand\./);
  });

  it("refuses an unknown system; a file edited by hand makes the walk no pass", () => {
    expect(walk(["--os", "windows"], "").status).toBe(2);
    const first = walk(["--os", "macos", "--log", "walk.json"], `${"\n\n".repeat(6)}y\n`);
    expect(first.status).toBe(0);
    const log = JSON.parse(readFileSync(join(first.dir, "walk.json"), "utf8"));
    expect(log.editedByHand).toBe(true);
    expect(first.out).toMatch(/not a pass: a file was edited by hand/);
  });
});
