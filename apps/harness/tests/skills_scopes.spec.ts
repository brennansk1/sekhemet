import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveSkill } from "@sekhemet/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRepoSkills, skillsLockPath } from "../src/workspace_trust.js";

/**
 * extensibility EXT-24 in the product: the card's skills come from the
 * person's user directory and the project, the project's winning by name.
 */
let root: string;
let repo: string;
let user: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-skill-scopes-"));
  repo = join(root, "repo");
  user = join(root, "user");
  mkdirSync(repo);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", user);
  vi.stubEnv("SEKHEMET_TRUST_DIR", join(user, "trust"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\ndescription: ${name}\ntriggers: [${name}]\n---\n${body}\n`,
  );
}

describe("EXT-24: a user-level skill is offered on a project that has none by its name", () => {
  it("offers the person's skill, and the project's in place of one with the same name", () => {
    const userSkills = join(user, "skills");
    const projectSkills = join(repo, ".sekhemet", "skills");
    skill(userSkills, "commit-style", "User body");
    skill(projectSkills, "api-style", "Project body");
    const lock = skillsLockPath(repo);
    approveSkill(userSkills, "commit-style", "human", lock);
    approveSkill(projectSkills, "api-style", "human", lock);
    const reg = loadRepoSkills(repo);
    expect(reg.getAllSkills().map((s) => [s.name, s.scope])).toEqual([
      ["api-style", "project"],
      ["commit-style", "user"],
    ]);
  });
});
