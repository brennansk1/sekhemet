import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { COMMANDS, PRIMARY_COMMANDS, routeFrontDoor } from "../src/cli_commands.js";
import { devHelpRows, helpFor } from "../src/commands/help_table.js";
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
    "issue",
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

// S1B-B20, S1B-B22 (wave 1): the help's words are NAMING's. The review
// verdict is *Request changes*; the thing is an *issue* (a *card* only as
// its tile on a board); an old command name is an alias, said beside its
// command, never its own line in `sekhemet dev --help`.
describe("the help table speaks NAMING's words (S1B-B20, S1B-B22)", () => {
  const FRONT = new Set(["run", "review", "accept", "ask", "doctor"]);
  const listed = () => devHelpRows(FRONT);

  it("S1B-B20: request-changes is described as Request changes, not as sending an issue back", () => {
    const row = helpFor("request-changes");
    expect(row?.what).toMatch(/^Request changes\b/);
    // The alias note, "(alias: send-back)", is the command's old name, not its description.
    expect(row?.what.replace(/ \(alias: [^)]+\)$/, "")).not.toMatch(/\bsend\b[^.]*\bback\b/i);
  });

  it("K-N5-6 (loop wave 10 A3): unpark's help says where the issue goes, as review-git §2.4 does — Ready, or Backlog or Planning — never 'back where it was'", () => {
    const row = helpFor("unpark");
    expect(row?.what).not.toMatch(/where it was/);
    expect(row?.what).toMatch(/Ready/);
    expect(row?.what).toMatch(/Backlog or Planning/);
  });

  it("loop wave 10 A2: reopen's help does not promise to reopen a Done issue, which only revert undoes", () => {
    const row = helpFor("reopen");
    expect(row?.what).not.toMatch(/finished/);
    expect(row?.what).toMatch(/Won't do/);
    expect(row?.what).toMatch(/sekhemet revert/);
  });

  it("S1B-B22: `sekhemet dev --help` lists no alias on its own line; request-changes names send-back as its alias", () => {
    const names = listed().map(([n]) => n);
    expect(names).not.toContain("send-back");
    expect(names).not.toContain("card");
    expect(names).toContain("request-changes");
    expect(names).toContain("issue");
    expect(helpFor("request-changes")?.what).toMatch(/\(alias: send-back\)$/);
    expect(helpFor("issue")?.what).toMatch(/\(alias: card\)$/);
    // The alias keeps its own help for whoever types it.
    expect(helpFor("send-back")?.what).toMatch(/alias of request-changes/i);
  });

  it("S1B-B22: no listed help line, nor the front door, names the running-issue verbs as `card`", () => {
    for (const [name, row] of listed()) {
      expect(`${row.usage} ${row.what}`, name).not.toMatch(
        /\bcard (message|pause|hand-back|take-over)\b/,
      );
    }
    for (const c of PRIMARY_COMMANDS) expect(c.what).not.toMatch(/\bsekhemet card\b/);
    expect(helpFor("issue")?.synopsis).toContain("sekhemet issue message <issue>");
    expect(helpFor("card")?.what).toMatch(/alias of issue/i);
  });

  it("S1B-B22: `sekhemet issue <verb>` routes as `card <verb>` did, and `card` still works", () => {
    for (const word of ["issue", "card"]) {
      expect(routeFrontDoor([word, "message", "TS-101", "Use", "the", "helper"])).toEqual({
        kind: "card",
        verb: "message",
        cardId: "TS-101",
        text: "Use the helper",
        flags: [],
      });
      expect(routeFrontDoor(["dev", word, "pause", "TS-101"])).toMatchObject({
        kind: "card",
        verb: "pause",
      });
    }
    expect(routeFrontDoor(["issue", "frob"])).toMatchObject({
      kind: "unknown",
      word: expect.stringContaining("sekhemet issue message|pause|hand-back|take-over <issue>"),
    });
  });
});
