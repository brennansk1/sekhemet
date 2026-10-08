import { readdirSync } from "node:fs";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cardInReview, sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * FINDINGS_C1 CLI-04, CLI-05 and CLI-06, through the built binary: a usage
 * error exits 2 (surface item 18), a missing issue is said one way, and a
 * command that needs a project, run in a folder that is none, says so in one
 * line, exits 2 and writes nothing.
 */

function oneLine(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  expect(lines, stderr).toHaveLength(1);
  return lines[0] as string;
}

describe("CLI-05, CLI-06: a folder that is not a project", () => {
  it("review, status, accept, run and the triage verbs say so in one line, exit 2 and write nothing", () => {
    for (const args of [
      ["review"],
      ["status"],
      ["accept", "c1"],
      ["run", "c1"],
      ["resume", "c1"],
      ["park", "c1"],
      ["card", "pause", "c1"],
    ]) {
      const where = sandboxDirs();
      const r = sekhemet(args, where);
      expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(oneLine(r.stderr)).toMatch(/is not a Sekhemet project yet.*`sekhemet`/);
      expect(r.stdout).toBe("");
      expect(readdirSync(where.cwd), args.join(" ")).toEqual([]);
    }
  });

  it("CLI-05 (C5): every command that reads a project's ledger — replay (also on its own usage error), log, skills, recurring list, models list, depth, dev export (also bare), erase, abort, rewind, fork — says so, exits 2 and writes no ledger; `review` there still refuses after them", () => {
    const where = sandboxDirs();
    for (const args of [
      ["replay", "c1"],
      ["replay"],
      ["log"],
      ["skills"],
      ["recurring", "list"],
      ["models", "list"],
      ["depth"],
      ["dev", "export"],
      ["dev", "export", "--out", "x.json"],
      ["erase", "c1"],
      ["abort", "c1"],
      ["rewind", "c1", "1"],
      ["fork", "c1", "1"],
    ]) {
      const r = sekhemet(args, where);
      expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(oneLine(r.stderr), args.join(" ")).toMatch(
        /is not a Sekhemet project yet.*`sekhemet`/,
      );
      expect(r.stdout, args.join(" ")).toBe("");
      expect(readdirSync(where.cwd), args.join(" ")).toEqual([]);
    }
    // No stray ledger makes the folder look like a project afterwards.
    const review = sekhemet(["review"], where);
    expect(review.status).toBe(2);
    expect(oneLine(review.stderr)).toMatch(/is not a Sekhemet project yet/);
  }, 120_000);

  it("gate outside a project names it, with no package manager's error codes", () => {
    const where = sandboxDirs();
    const r = sekhemet(["gate"], where);
    expect(r.status).toBe(2);
    expect(oneLine(r.stderr)).toMatch(/is not a Sekhemet project yet/);
    expect(r.stdout + r.stderr).not.toMatch(/ERR_PNPM|pnpm typecheck/);
    expect(readdirSync(where.cwd)).toEqual([]);
  });
});

describe("CLI-04: one rule for argument errors", () => {
  it("an unknown dev command is named and exits 2", () => {
    const where = sandboxDirs();
    const r = sekhemet(["dev", "frob"], where);
    expect(r.status).toBe(2);
    expect(oneLine(r.stderr)).toMatch(/no command "frob"/);
    expect(r.stdout).toBe("");
  });

  it("a missing issue ID is a usage error, exit 2, naming the usage", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    for (const cmd of ["accept", "resume"]) {
      const r = sekhemet([cmd], where);
      expect(r.status, `${cmd}: ${r.stderr}`).toBe(2);
      expect(oneLine(r.stderr)).toContain(`sekhemet ${cmd} <issue>`);
    }
  });

  it("SUR-95: the commands still in main refuse a bad argument through one helper: one line naming it and the synopsis, exit 2", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const cases: [string[], RegExp][] = [
      // `--attempt abc` was read as the latest attempt (CLI-04).
      [
        ["replay", "c1", "--attempt", "abc"],
        /^sekhemet: "abc" is not an attempt number: sekhemet replay <issue>/,
      ],
      [
        ["replay", "c1", "--attempt", "0"],
        /^sekhemet: "0" is not an attempt number: sekhemet replay <issue>/,
      ],
      [
        ["replay", "c1", "--diff", "1"],
        /^sekhemet: --diff takes two attempt numbers, as 1,2: sekhemet replay/,
      ],
      [["replay"], /^sekhemet: replay needs an issue ID: sekhemet replay <issue>/],
      [["abort"], /^sekhemet: abort needs an issue ID: sekhemet abort <issue>/],
      [
        ["rewind", "c1"],
        /^sekhemet: rewind needs a step number \(0 or more\) after the issue ID: sekhemet rewind <issue> <step>/,
      ],
      [["gates", "frob"], /^sekhemet: no "frob" under sekhemet gates: sekhemet gates init/],
    ];
    for (const [args, said] of cases) {
      const r = sekhemet(args, where);
      expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(oneLine(r.stderr)).toMatch(said);
      expect(r.stdout, args.join(" ")).toBe("");
    }
  });

  it("SUR-95: `replay --attempt` with a number the issue does not have names its attempts, exit 2; one it has is shown", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const all = sekhemet(["replay", "c1"], where);
    expect(all.status, all.stderr).toBe(0);
    const attempts = [...all.stdout.matchAll(/attempt (\d+)/gi)].map((m) => m[1]);
    expect(attempts.length).toBeGreaterThan(0);
    const r = sekhemet(["replay", "c1", "--attempt", "9"], where);
    expect(r.status).toBe(2);
    expect(oneLine(r.stderr)).toMatch(
      /^sekhemet: c1 has no attempt 9 \(its attempts: [\d, ]+\): sekhemet replay/,
    );
    const one = sekhemet(["replay", "c1", "--attempt", String(attempts[0])], where);
    expect(one.status, one.stderr).toBe(0);
  });

  it("SUR-96: an empty `recurring list` says there are none, in one line", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["recurring", "list"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(
      "No recurring issues. Add one with `sekhemet recurring add <issue> --cron '<expr>'`.",
    );
  });

  it("an issue that does not exist is said one way, exit 1, by run, accept and review", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    for (const cmd of ["run", "accept", "review"]) {
      const r = sekhemet([cmd, "nope"], where);
      expect(r.status, `${cmd}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(oneLine(r.stderr)).toBe("sekhemet: no issue nope");
      expect(r.stdout).toBe("");
    }
  });
});

describe("CLI-07: a spec is planned only when its issues can run", () => {
  it("checks the Coding model first: one not verified on this machine is refused before any issue is written, exit 1", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const count = async () => {
      const { db, log } = openLocalLedger(where.cwd);
      try {
        return (await new CardStore(db, log).listCards()).length;
      } finally {
        db.close();
      }
    };
    const before = await count();
    const r = sekhemet(["Add a CSV export of a week", "--planner", "none"], where);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/as the Coding model: not verified on this machine/);
    expect(r.stdout).not.toMatch(/Planning feature/);
    expect(await count()).toBe(before);
  });
});

describe("CLI-07: the plan in the board's words (SUR-97)", () => {
  it("SUR-97: `plan` names each issue by its ID and title, says when two share a title, and keeps cards, Zone 3 tokens, INVEST, criterion ids and lint codes behind --verbose", async () => {
    const spec = "Add a CSV export of a week of hours, with totals per person";
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["plan", spec, "--planner", "none", "--offline"], where);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/^Plan v1: \d+ issues planned/m);
    for (const word of [
      /\bcards?\b/i,
      /Zone 3/,
      /INVEST/,
      /pre-flight/,
      /\.c\d\b/,
      /no_outcome|repeats_title/,
    ])
      expect(out, String(word)).not.toMatch(word);
    // Each new issue: its ID (as the commands take it) and its title.
    const { db, log } = openLocalLedger(where.cwd);
    const issues = (await new CardStore(db, log).listCards()).filter(
      (c) => c.tier !== "epic" && c.id !== "c1",
    );
    db.close();
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues)
      expect(out).toMatch(
        new RegExp(`^  ${issue.id}\\s+${issue.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"),
      );
    // Two issues with one title are said to share it.
    const titles = issues.map((i) => i.title);
    const repeated = titles.find((t, i) => titles.indexOf(t) !== i);
    if (repeated) expect(out).toMatch(/\(the same title as \S+\)/);
    const lines = out.split("\n").filter((l) => /^ {2}\S+ {2}/.test(l));
    expect(new Set(lines).size).toBe(lines.length);
    // The details, when asked.
    const verbose = sekhemet(["plan", spec, "--planner", "none", "--offline", "--verbose"], where);
    expect(verbose.status).toBe(0);
    expect(verbose.stdout).toMatch(/The plan's checks \(INVEST\):/);
    expect(verbose.stdout).toMatch(/\d+ points?, difficulty \d/);
    expect(verbose.stdout).not.toMatch(/pre-flight/);
  });
});
