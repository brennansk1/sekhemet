import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli_commands.js";
import { helpFor } from "../src/commands/help_table.js";
import { BIN, cliEnv, place } from "./support/cli_spawn.js";

// Every command's own help, through the built binary (surface item 19a,
// NEW-surface-13; FINDINGS_C1 CLI-03, W3 G2–G3): `apps/harness/dist/index.js
// <command> --help` for every name `main` dispatches — the list is
// generated from `COMMANDS` and the board's verbs, so a command added
// without a help row fails here.

/** Every name `main` dispatches: `COMMANDS`, the board's decisions and `card`. */
const NAMES = [
  ...new Set<string>([
    ...COMMANDS,
    "request-changes",
    "send-back",
    "park",
    "unpark",
    "reopen",
    "reject",
    "revert",
    "card",
  ]),
].sort();

/** A spec, finding or decision id: never in help (R-12). An issue key (TS-101) is not one. */
const SPEC_ID =
  /\b(?:SUR|MD|PM|DS|RG|SEC|RUN|TEAM|EXT|GT|WL|DB|INT|CX|MS|DEC|CLI|INS|REL|IX|TST|NAM|K|R)-[A-Z]?\d|\bNEW-[a-z-]+-\d/;

/** The built command in a fresh folder and home (each removed after its test). */
const run = (args: string[]) => {
  const p = place("sek-help-");
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.repo,
    env: cliEnv(p),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

describe("every command has its own help, from one table (SUR-94, CLI-03)", () => {
  it("SUR-94: the help table has a row, a synopsis naming the command and an example running it, for every name main dispatches", () => {
    const missing = NAMES.filter((n) => {
      const row = helpFor(n);
      return (
        !row ||
        !row.what.trim() ||
        !row.synopsis.includes(`sekhemet ${n}`) ||
        !row.example.startsWith(`sekhemet ${n}`)
      );
    });
    expect(missing).toEqual([]);
  });

  it.each(NAMES)(
    "SUR-94: `sekhemet %s --help` prints what it does, its synopsis and an example, with no spec id, and exits 0",
    (name) => {
      const r = run([name, "--help"]);
      expect(r.code, r.out).toBe(0);
      const row = helpFor(name);
      expect(r.stdout).toContain(`Usage: ${row?.synopsis}`);
      expect(r.stdout).toMatch(new RegExp(`^Example: sekhemet ${name}\\b`, "m"));
      expect(r.stdout.split("\n")[0]).toBe(row?.what);
      expect(r.stdout).not.toMatch(SPEC_ID);
      // Not the front door's help instead.
      expect(r.stdout).not.toMatch(/Everything else: sekhemet dev --help/);
    },
  );

  it("SUR-94: `sekhemet dev <command> --help` is the same help", () => {
    for (const name of ["gate-host", "queue", "park"]) {
      const viaDev = run(["dev", name, "--help"]);
      expect(viaDev.code).toBe(0);
      expect(viaDev.stdout).toBe(run([name, "--help"]).stdout);
    }
  });

  it("SUR-94: `sekhemet dev --help` lists each command on its own line, gate-host, prompt-screen, reserve and benchmark included, and no help screen shows a spec id", () => {
    const dev = run(["dev", "--help"]);
    expect(dev.code).toBe(0);
    for (const name of ["gate-host", "prompt-screen", "reserve", "benchmark", "queue", "board"]) {
      const lines = dev.stdout
        .split("\n")
        .filter((l) => l.trimStart().startsWith(`${name} `) || l.trim() === name);
      expect(lines, name).toHaveLength(1);
    }
    // No line lumps several commands under one description.
    expect(dev.stdout).not.toMatch(/ \/ [a-z-]+ \/ /);
    expect(dev.stdout).not.toMatch(SPEC_ID);
    const front = run(["--help"]);
    expect(front.code).toBe(0);
    expect(front.stdout).not.toMatch(SPEC_ID);
  });
});
