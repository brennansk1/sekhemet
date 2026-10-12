import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { onlyNotRun } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, describe, expect, it } from "vitest";
import {
  TrailerRangeError,
  checkTrailers,
  trailerGate,
  withTrailerGate,
} from "../src/trailer_gate.js";
import { runDevCommand } from "../src/wave2.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sek-trail-"));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

describe("X26: commit-trailer enforcement as a harness gate", () => {
  it("passes harness checkpoints, fails a hand-made commit, in the card runner's gate path", async () => {
    const root = repo();
    const adapter = new NodeGitSyncAdapter(root, "p");
    const wt = await adapter.createWorktree("c1", "main", "Add b");
    writeFileSync(join(wt, "b.ts"), "export const b = 2;\n");
    await adapter.commitCheckpoint({
      cardId: "c1",
      step: 1,
      gateStatus: "pass",
      agentModel: "nail",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    expect(trailerGate(wt)).toEqual([]);
    writeFileSync(join(wt, "c.ts"), "export const c = 3;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-q", "-m", "quick fix\n\nAgent-Model: nail"], { cwd: wt });
    const failures = trailerGate(wt);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorExcerpt).toMatch(
      /"quick fix" lacks Card, Agent-Harness, Agent-Role, Co-authored-by/,
    );
    const inner = { runGates: async () => ({ passed: true, failures: [], durationMs: 1 }) };
    const res = await withTrailerGate(inner).runGates(["test"], wt);
    expect(res.passed).toBe(false);
    expect(res.rungResults?.find((o) => o.gate === "trailers")?.passed).toBe(false);
  });

  it("a rebase checkpoint is attributed too, and `sekhemet trailers` checks a range for CI", async () => {
    const root = repo();
    const adapter = new NodeGitSyncAdapter(root, "p");
    const wt = await adapter.createWorktree("c2", "main", "Rebase me");
    writeFileSync(join(wt, "d.ts"), "export const d = 1;\n");
    await adapter.commitCheckpoint({
      cardId: "c2",
      step: 1,
      gateStatus: "pass",
      agentModel: "nail",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    writeFileSync(join(wt, "e.ts"), "export const e = 1;\n");
    writeFileSync(join(root, "z.ts"), "export const z = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      [
        "commit",
        "-q",
        "-m",
        "main moves\n\nCard: m\nAgent-Model: x\nAgent-Harness: h\nAgent-Role: r\nCo-authored-by: A <a@x>",
      ],
      { cwd: root },
    );
    await adapter.rebaseOntoIntegration("c2", "main");
    expect(checkTrailers(wt, "main..HEAD")).toEqual([]);

    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const lines: string[] = [];
    const k = { repoPath: root, log, cardStore: new CardStore(db, log) };
    // The initial commit has no trailers: the range check names it.
    expect(
      await runDevCommand("trailers", ["HEAD~1..HEAD"], k, { print: (l) => lines.push(l) }),
    ).toBe(0);
    expect(await runDevCommand("trailers", ["HEAD~1"], k, { print: (l) => lines.push(l) })).toBe(1);
    expect(lines.at(-1)).toMatch(/1 commit without the attribution trailers/);
  });
});

/**
 * Wave 9 B10 (sweep 5): a range git cannot read was a pass, in the command
 * and in the gate (gates rule 9: never a pass), and an empty range claimed
 * every commit carried the trailers.
 */
describe("X26: a range git cannot read is never a pass", () => {
  const dev = async (args: string[], root: string) => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const lines: string[] = [];
    const errors: string[] = [];
    const k = { repoPath: root, log, cardStore: new CardStore(db, log) };
    const code = await runDevCommand("trailers", args, k, {
      print: (l) => lines.push(l),
      printError: (l) => errors.push(l),
    });
    return { code, out: lines.join("\n"), err: errors.join("\n") };
  };

  it("checkTrailers throws with git's words for a range git cannot read", () => {
    const root = repo();
    expect(() => checkTrailers(root, "bogus-ref..main")).toThrow(/bogus-ref/);
    expect(() => checkTrailers(root, "main~3..main")).toThrow(TrailerRangeError);
  });

  it("the command exits 1 for an invalid range, naming it, with a next step", async () => {
    const root = repo();
    const { code, out, err } = await dev(["bogus-ref..main"], root);
    expect(code).toBe(1);
    expect(out).not.toMatch(/Every commit carries/);
    expect(err).toMatch(/^sekhemet: git cannot read the range bogus-ref\.\.main/m);
    expect(err).toMatch(/^ {2}Do: /m);
  });

  it("an empty range says no commit was checked, never a pass", async () => {
    const root = repo();
    const { code, out } = await dev(["main..HEAD"], root);
    expect(code).toBe(0);
    expect(out).not.toMatch(/Every commit carries/);
    expect(out).toMatch(/No commits in main\.\.HEAD: nothing to check/);
  });

  it("a pass says how many commits it checked", async () => {
    const root = repo();
    execFileSync(
      "git",
      [
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "two\n\nCard: m\nAgent-Model: x\nAgent-Harness: h\nAgent-Role: r\nCo-authored-by: A <a@x>",
      ],
      { cwd: root },
    );
    const { code, out } = await dev(["HEAD~1..HEAD"], root);
    expect(code).toBe(0);
    expect(out).toMatch(/Every commit carries the attribution trailers \(1 commit checked\)/);
  });

  it("the gate is unavailable, never passed, when its base cannot be read", async () => {
    const root = repo();
    const inner = { runGates: async () => ({ passed: true, failures: [], durationMs: 1 }) };
    const res = await withTrailerGate(inner, "no-such-base").runGates(["test"], root);
    expect(res.passed).toBe(false);
    const outcome = res.rungResults?.find((o) => o.gate === "trailers");
    expect(outcome?.passed).toBe(false);
    expect(outcome?.unavailable).toBe(true);
    expect(outcome?.reason).toMatch(/no-such-base/);
    // Gates rule 9: the failure is "not run", so the card stops for a person
    // (done_pending_gates) and the Worker's repair budget is never spent on it.
    const failure = res.failures.find((f) => f.gate === "trailers");
    expect(failure?.notRun).toBe(true);
    expect(failure?.exitCode).toBe(-1);
    expect(onlyNotRun(res)).toBe(true);
  });
});
