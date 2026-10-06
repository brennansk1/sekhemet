import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";

/**
 * Skills and their sources through the command line (measurement §2 rule 18,
 * MS-T8-5, MS-T8-6; FINISH_LINE_PLAN C2d): `sekhemet improve` mines the real
 * ledger for skill candidates and `sekhemet skills approve` runs a skill's own
 * checks, both spawned as the built binary. No model is loaded.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

function repo(cwd: string): void {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeFileSync(join(cwd, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
}

/** Done cards of one class, each with one recorded step; `unclosed` lacks a call's result. */
async function doneCards(cwd: string, ids: string[], unclosed: string[] = []): Promise<void> {
  const { db, log } = openLocalLedger(cwd);
  try {
    const store = new CardStore(db, log);
    for (const id of ids) {
      await store.createCard({
        id,
        tier: "task",
        title: `Add ledger migration ${id}`,
        scopeFiles: ["src/db.ts"],
      });
      await store.updateCardStatus(id, "done", "accepted", "harness", { override: true });
      await store.updateCard(id, { stepsUsed: 3 });
      const open = unclosed.includes(id);
      await log.append({
        actor: "executor",
        type: "card/step",
        cardId: id,
        payload: {
          turn: 1,
          calls: [
            { name: "read_file", target: "src/db.ts", summary: "ok" },
            // A call the ledger holds without its result was never closed.
            open
              ? { name: "run_cmd", target: `node scripts/migrate.js ${id}.sql` }
              : { name: "run_cmd", target: `node scripts/migrate.js ${id}.sql`, summary: "ok" },
            { name: "check", target: "test", summary: "pass" },
          ],
        },
      });
    }
  } finally {
    db.close();
  }
}

const candidatePath = (stdout: string) =>
  /skill candidate [^\n]*\((\/[^)]+SKILL\.md)\)/.exec(stdout)?.[1];

describe("sekhemet improve: only complete trajectories are a skill's source", () => {
  it("MS-T8-6: a passing card whose trajectory holds an unclosed tool call is left out of the distilled skill's sources", async () => {
    const where = g2Dirs();
    repo(where.cwd);
    await doneCards(where.cwd, ["c1", "c2", "c3", "c4"], ["c4"]);
    const env = g2Env(where.home);
    const r = await cli(["improve"], { cwd: where.cwd, env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const path = candidatePath(r.stdout);
    if (!path) throw new Error(`no skill candidate:\n${r.stdout}`);
    const skill = readFileSync(path, "utf8");
    expect(skill).toContain("Distilled from 3 passing cards (c1, c2, c3).");
    expect(skill).not.toMatch(/\bc4\b/);
  });

  it("MS-T8-6: with only two complete trajectories left, no skill is distilled at all", async () => {
    const where = g2Dirs();
    repo(where.cwd);
    await doneCards(where.cwd, ["c1", "c2", "c3"], ["c3"]);
    const env = g2Env(where.home);
    const r = await cli(["improve"], { cwd: where.cwd, env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/skill candidate/);
    expect(existsSync(join(where.cwd, ".sekhemet", "skill-candidates"))).toBe(false);
    // Control: the same three, all closed, do make one.
    const ok = g2Dirs();
    repo(ok.cwd);
    await doneCards(ok.cwd, ["c1", "c2", "c3"]);
    const control = await cli(["improve"], { cwd: ok.cwd, env: g2Env(ok.home) });
    expect(control.stdout).toMatch(/skill candidate .*: unchecked — no checks/);
  });
});

describe("sekhemet skills approve: a skill's own checks run confined, first", () => {
  function skill(cwd: string, name: string, check: string): void {
    const dir = join(cwd, ".sekhemet", "skills", name);
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ntriggers: [ledger]\n---\nUse WAL.\n");
    writeFileSync(
      join(dir, "evals", "checks.json"),
      JSON.stringify([{ command: "node", args: ["-e", check] }]),
    );
  }

  it("MS-T8-5: a candidate whose check fails is refused and recorded discarded; one whose check passes is approved", async () => {
    const where = g2Dirs();
    repo(where.cwd);
    skill(where.cwd, "failing", "process.exit(3)");
    skill(where.cwd, "passing", "process.exit(0)");
    const env = g2Env(where.home);
    const bad = await cli(["skills", "approve", "failing"], { cwd: where.cwd, env });
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(
      /failing is not approved: discarded: its check node -e process\.exit\(3\) exited 3/,
    );
    const good = await cli(["skills", "approve", "passing"], { cwd: where.cwd, env });
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toMatch(/passing: its 1 check\(s\) pass, confined\./);
    expect(good.stdout).toMatch(/Approved passing at [0-9a-f]{12}\./);
    const checked = ledgerRows(where.cwd)
      .filter((x) => x.type === "learning/skill_checked")
      .map((x) => [x.payload.name, x.payload.status]);
    expect(checked).toEqual([
      ["failing", "discarded"],
      ["passing", "checked"],
    ]);
    // Only the passing one is in the person's lock.
    const list = await cli(["skills"], { cwd: where.cwd, env });
    expect(list.stdout).toMatch(/passing pinned [0-9a-f]{12}/);
    expect(list.stdout).not.toMatch(/failing pinned/);
  });
});
