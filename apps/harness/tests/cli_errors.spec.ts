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
