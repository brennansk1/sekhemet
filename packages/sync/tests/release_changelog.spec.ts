import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  keepAChangelog,
  nextVersion,
  parseVersion,
  planRelease,
} from "../src/repo_tools.js";

// planner-pm PM-P13-13 (§2.15.8): a slice's release groups its squashes into
// Keep a Changelog's categories — Added, Changed, Deprecated, Removed,
// Fixed, Security — and is computed on the integration branch, whatever is
// checked out. Real git repositories.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-kac-")));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  return { root, git };
}

describe("Keep a Changelog grouping (PM-P13-13)", () => {
  it("files each Conventional Commit under its category and leaves housekeeping out", () => {
    const groups = keepAChangelog([
      { sha: "a1".padEnd(40, "0"), type: "feat", subject: "save a recipe", breaking: false },
      {
        sha: "b2".padEnd(40, "0"),
        type: "fix",
        scope: "list",
        subject: "keep order",
        breaking: false,
      },
      {
        sha: "c3".padEnd(40, "0"),
        type: "fix",
        scope: "security",
        subject: "escape titles",
        breaking: false,
      },
      { sha: "d4".padEnd(40, "0"), type: "refactor", subject: "split the store", breaking: false },
      { sha: "e5".padEnd(40, "0"), type: "feat", subject: "remove the CSV export", breaking: true },
      { sha: "f6".padEnd(40, "0"), type: "deprecate", subject: "the v1 API", breaking: false },
      { sha: "a7".padEnd(40, "0"), type: "revert", subject: "the tag cloud", breaking: false },
      { sha: "b8".padEnd(40, "0"), type: "chore", subject: "bump lockfile", breaking: false },
    ]);
    expect(groups).toEqual({
      Added: ["save a recipe (a100000)"],
      Changed: ["split the store (d400000)", "**Breaking:** remove the CSV export (e500000)"],
      Deprecated: ["the v1 API (f600000)"],
      Removed: ["the tag cloud (a700000)"],
      Fixed: ["**list:** keep order (b200000)"],
      Security: ["escape titles (c300000)"],
    });
  });

  it("plans the release on the integration branch with the changelog in those categories", () => {
    const { root, git } = repo();
    writeFileSync(join(root, "a.txt"), "1");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: save a recipe");
    writeFileSync(join(root, "a.txt"), "2");
    git("commit", "-qam", "fix(list): keep order");
    git("checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(root, "a.txt"), "3");
    git("commit", "-qam", "feat: not on main");
    const plan = planRelease(root, { ref: "main", engine: "builtin" });
    expect(plan.commits.map((c) => c.subject)).toEqual(["keep order", "save a recipe"]);
    expect(plan.categories).toEqual({
      Added: [expect.stringMatching(/^save a recipe \([0-9a-f]{7}\)$/)],
      Fixed: [expect.stringMatching(/^\*\*list:\*\* keep order/)],
    });
    expect(plan.changelog).toMatch(/### Added\n- save a recipe/);
    expect(plan.changelog).toMatch(/### Fixed\n- \*\*list:\*\* keep order/);
  });
});

describe("RG-N4-1: before 1.0 a breaking change bumps minor; 1.0 is a person's decision", () => {
  it("bumps minor, not major, for a breaking change while the version is 0.y.z", () => {
    expect(nextVersion("v0.3.1", "major")).toBe("v0.4.0");
    expect(nextVersion("0.3.1", "major")).toBe("v0.4.0");
    expect(nextVersion(undefined, "major")).toBe("v0.1.0");
    expect(nextVersion("v0.3.1", "minor")).toBe("v0.4.0");
    expect(nextVersion("v0.3.1", "patch")).toBe("v0.3.2");
    // From 1.0 on (a person tagged it), a breaking change is a major.
    expect(nextVersion("v1.2.3", "major")).toBe("v2.0.0");
  });

  it("releases a prerelease rather than skipping past it (SemVer precedence)", () => {
    expect(nextVersion("v1.0.0-rc.1", "patch")).toBe("v1.0.0");
    expect(nextVersion("v2.0.0-beta.2", "major")).toBe("v2.0.0");
    expect(nextVersion("v0.4.0-rc.1", "major")).toBe("v0.4.0");
  });

  it("plans a breaking change on a 0.y.z tag as the next minor, from real commits", () => {
    const { root, git } = repo();
    writeFileSync(join(root, "a.txt"), "1");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: save a recipe");
    git("tag", "-a", "v0.2.0", "-m", "v0.2.0");
    writeFileSync(join(root, "a.txt"), "2");
    git("commit", "-qam", "feat!: drop the old import format");
    let plan = planRelease(root, { engine: "builtin" });
    expect(plan).toMatchObject({ previousTag: "v0.2.0", bump: "major", nextVersion: "v0.3.0" });
    git("tag", "-a", "v0.3.0", "-m", "v0.3.0");
    writeFileSync(join(root, "a.txt"), "3");
    git("commit", "-qam", "refactor: rename the store\n\nBREAKING CHANGE: the store is renamed");
    plan = planRelease(root, { engine: "builtin" });
    expect(plan).toMatchObject({ previousTag: "v0.3.0", bump: "major", nextVersion: "v0.4.0" });
  });

  it("orders versions by SemVer precedence, each prerelease before its release", () => {
    const sorted = ["v1.0.0", "1.0.0-rc.10", "0.9.0", "1.0.0-alpha", "v1.0.0-rc.2", "0.10.0"].sort(
      compareVersions,
    );
    expect(sorted).toEqual([
      "0.9.0",
      "0.10.0",
      "1.0.0-alpha",
      "v1.0.0-rc.2",
      "1.0.0-rc.10",
      "v1.0.0",
    ]);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    // A release's tag name as projects write it.
    expect(compareVersions("release-1.10.0", "release-1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("pkg@2.0.0-beta.1", "pkg@2.0.0")).toBeLessThan(0);
  });
});

describe("C1: only a tag shaped like a version is read as one", () => {
  it("reads v1.2.3, name@1.2.3 and name-1.2.3, and no tag that merely holds a number", () => {
    expect(parseVersion("v1.2.3")?.version).toBe("1.2.3");
    expect(parseVersion("release-1.2.3")?.version).toBe("1.2.3");
    expect(parseVersion("pkg@2.0.0-beta.1")?.version).toBe("2.0.0-beta.1");
    expect(parseVersion("@scope/pkg@3.1.4")?.version).toBe("3.1.4");
    for (const tag of ["deploy-2026", "build42", "prod-7", "2026-09-28", "v12"]) {
      expect(parseVersion(tag), tag).toBeUndefined();
    }
    // A number-holding tag is no version: the next is from 0.0.0, never v2026.1.0.
    expect(nextVersion("deploy-2026", "minor")).toBe("v0.1.0");
  });

  it("plans no bump on a named tag as that tag's version, normalised", () => {
    const { root, git } = repo();
    writeFileSync(join(root, "a.txt"), "1");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: first");
    git("tag", "-a", "release-1.2.3", "-m", "r");
    writeFileSync(join(root, "a.txt"), "2");
    git("commit", "-qam", "chore: tidy");
    const plan = planRelease(root, { engine: "builtin" });
    expect(plan).toMatchObject({
      previousTag: "release-1.2.3",
      bump: "none",
      nextVersion: "v1.2.3",
    });
  });
});
