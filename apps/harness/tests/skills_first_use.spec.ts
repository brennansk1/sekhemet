import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillLock } from "@sekhemet/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSkills } from "../src/doctor.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { loadRepoSkills, skillsLockPath } from "../src/workspace_trust.js";
import { sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * FINDINGS_C1 SEC-02 (extensibility item 15, EXT-4; security item 39): a
 * repository's skills are never trusted on first use. With no person's
 * approval none loads — not on the first load, not after — and nothing is
 * pinned; a person's `sekhemet skills approve <name>` (the built binary) pins
 * that content, and only then does a run's load (`loadRepoSkills`) take it.
 */

afterEach(() => vi.unstubAllEnvs());

function skill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\ndescription: ${name}\ntriggers: [${name}]\n---\nDo ${name} things.\n`,
  );
}

/** A project with a skill, and the same user directory the binary uses. */
function project() {
  const where = sandboxDirs();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
  const { db } = openLocalLedger(where.cwd);
  db.close();
  skill(join(where.cwd, ".sekhemet", "skills"), "deploy");
  vi.stubEnv("HOME", where.home);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(where.home, ".sekhemet"));
  // The binary keeps trust under its user directory; read the same one here.
  vi.stubEnv("SEKHEMET_TRUST_DIR", join(where.home, ".sekhemet", "trust"));
  return where;
}

describe("SEC-02, EXT-4: no trust on first use", () => {
  it("loads none of a repository's skills on the first load, or the next, and pins nothing", () => {
    const where = project();
    for (let i = 0; i < 2; i++) {
      const reg = loadRepoSkills(where.cwd);
      expect(reg.getSkill("deploy")).toBeUndefined();
      expect(reg.rejected().map((r) => [r.skill, r.action])).toEqual([["deploy", "rejected_new"]]);
    }
    const lock = readSkillLock(skillsLockPath(where.cwd));
    expect(lock?.skills.deploy).toBeUndefined();
  });

  it("nor a person's own skills before they approve them", () => {
    const where = project();
    skill(join(where.home, ".sekhemet", "skills"), "commit-style");
    expect(loadRepoSkills(where.cwd).getSkill("commit-style")).toBeUndefined();
  });

  it("loads a skill once a person approves it with `sekhemet skills approve`", () => {
    const where = project();
    expect(loadRepoSkills(where.cwd).getSkill("deploy")).toBeUndefined();
    const r = sekhemet(["skills", "approve", "deploy"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Approved deploy/);
    expect(existsSync(skillsLockPath(where.cwd))).toBe(true);
    const lock = readSkillLock(skillsLockPath(where.cwd));
    expect(lock?.skills.deploy?.approvedBy).not.toBe("trust-on-first-use");
    expect(loadRepoSkills(where.cwd).getSkill("deploy")).toBeDefined();
  });

  it("loads a person's own skill once they approve it with `sekhemet skills approve` (EXT-24, rule 13)", () => {
    const where = project();
    skill(join(where.home, ".sekhemet", "skills"), "commit-style");
    expect(loadRepoSkills(where.cwd).getSkill("commit-style")).toBeUndefined();
    const r = sekhemet(["skills", "approve", "commit-style"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Approved commit-style \(your own skill\)/);
    const loaded = loadRepoSkills(where.cwd).getSkill("commit-style");
    expect(loaded?.scope).toBe("user");
    // Revoked, it does not load again until approved again.
    expect(sekhemet(["skills", "revoke", "commit-style"], where).status).toBe(0);
    expect(loadRepoSkills(where.cwd).getSkill("commit-style")).toBeUndefined();
  });

  it("approves the project's skill by a name both scopes hold, and the person's with --user", () => {
    const where = project();
    skill(join(where.home, ".sekhemet", "skills"), "deploy");
    writeFileSync(
      join(where.home, ".sekhemet", "skills", "deploy", "SKILL.md"),
      "---\ndescription: mine\ntriggers: [deploy]\n---\nMy way.\n",
    );
    const project_ = sekhemet(["skills", "approve", "deploy"], where);
    expect(project_.stdout).not.toMatch(/your own skill/);
    const mine = sekhemet(["skills", "approve", "deploy", "--user"], where);
    expect(mine.status, mine.stderr).toBe(0);
    expect(mine.stdout).toMatch(/Approved deploy \(your own skill\)/);
  });

  it("names both places when no skill by that name exists", () => {
    const where = project();
    const r = sekhemet(["skills", "approve", "nothing-here"], where);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/\.sekhemet\/skills/);
  });
});

describe("EXT-3: the listing shows each skill's current state, not the lock's", () => {
  it("lists a skill changed after approval as waiting for approval, never as pinned", () => {
    const where = project();
    expect(sekhemet(["skills", "approve", "deploy"], where).status).toBe(0);
    appendFileSync(join(where.cwd, ".sekhemet", "skills", "deploy", "SKILL.md"), "And more.\n");
    // The listing alone, before any load has recorded the change.
    const r = sekhemet(["skills"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/deploy pinned/);
    expect(r.stdout).toMatch(
      /deploy changed since it was approved .*it does not load until you approve it again: sekhemet skills approve deploy/,
    );
  });

  it("lists a skill nobody approved as not approved", () => {
    const where = project();
    const r = sekhemet(["skills"], where);
    expect(r.stdout).toMatch(
      /deploy is not approved: it does not load until you approve it: sekhemet skills approve deploy/,
    );
  });

  it("does not keep an old rejection line once the skill is approved", () => {
    const where = project();
    // A load while unapproved records the rejection in the lock's audit.
    expect(loadRepoSkills(where.cwd).rejected().length).toBe(1);
    expect(sekhemet(["skills", "approve", "deploy"], where).status).toBe(0);
    const r = sekhemet(["skills"], where);
    expect(r.stdout).toMatch(/deploy pinned [0-9a-f]{12} by human/);
    expect(r.stdout).not.toMatch(/rejected/);
    expect(r.stdout).not.toMatch(/approve with/);
  });
});

describe("EXT-3: doctor's Skills check names a skill that does not load", () => {
  it("warns of a skill changed since approval, and passes once it is approved again", () => {
    const where = project();
    expect(sekhemet(["skills", "approve", "deploy"], where).status).toBe(0);
    expect(probeSkills(where.cwd).status).toBe("pass");
    appendFileSync(join(where.cwd, ".sekhemet", "skills", "deploy", "SKILL.md"), "And more.\n");
    const changed = probeSkills(where.cwd);
    expect(changed.status).toBe("warn");
    expect(changed.detail).toMatch(/deploy changed since it was approved/);
    expect(changed.do).toMatch(/sekhemet skills approve/);
    expect(sekhemet(["skills", "approve", "deploy"], where).status).toBe(0);
    expect(probeSkills(where.cwd).status).toBe("pass");
  });

  it("warns of a skill nobody approved", () => {
    const where = project();
    const check = probeSkills(where.cwd);
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/deploy is not approved/);
  });
});
