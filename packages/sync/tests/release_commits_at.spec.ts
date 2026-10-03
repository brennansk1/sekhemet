import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planRelease, releaseBump, releaseCommitsAt } from "../src/repo_tools.js";

// planner-pm PM-N12-2 (C2b): a maintenance release's version comes from its
// issues' own squashes — read by sha, not every commit since the last tag —
// by review-git §2.6 item 7's rule, so fix-only work is a patch. Real git.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-at-")));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  let n = 0;
  const commit = (msg: string) => {
    writeFileSync(join(root, `f${n++}.txt`), msg);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit };
}

describe("releaseCommitsAt and releaseBump (PM-N12-2)", () => {
  it("parses the squashes at the given shas, in the order given", () => {
    const r = repo();
    r.commit("chore: init");
    const a = r.commit("fix(api): login no longer fails\n\nSource: src/api.ts");
    const b = r.commit("docs: readme");
    const c = r.commit("feat!: drop the v1 export");
    const commits = releaseCommitsAt(r.root, [c, a, b]);
    expect(commits.map((x) => [x.sha, x.type, x.scope, x.subject, x.breaking])).toEqual([
      [c, "feat", undefined, "drop the v1 export", true],
      [a, "fix", "api", "login no longer fails", false],
      [b, "docs", undefined, "readme", false],
    ]);
  });

  it("gives a patch when every squash is a fix, the bump planRelease gives otherwise", () => {
    const r = repo();
    const a = r.commit("fix: one");
    const b = r.commit("fix(ui): two");
    expect(releaseBump(releaseCommitsAt(r.root, [a, b]))).toBe("patch");
    const c = r.commit("feat: three");
    expect(releaseBump(releaseCommitsAt(r.root, [a, c]))).toBe("minor");
    expect(releaseBump(releaseCommitsAt(r.root, [r.commit("refactor!: four")]))).toBe("major");
    expect(releaseBump(releaseCommitsAt(r.root, [r.commit("chore: five")]))).toBe("none");
    // The same rule as the slice's release.
    expect(planRelease(r.root).bump).toBe("major");
  });

  it("refuses a sha the repository does not hold, naming it", () => {
    const r = repo();
    r.commit("fix: one");
    expect(() => releaseCommitsAt(r.root, ["f".repeat(40)])).toThrow(/ffffff/);
  });
});
