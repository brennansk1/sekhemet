import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepAChangelog, planRelease } from "../src/repo_tools.js";

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
