import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseTags } from "../src/project_done.js";

/**
 * NEW-dashboard-15: a Bug's *Release* lists the repository's tags, newest
 * first, read with the harness's own hardened git (security items 18–22),
 * never a bare `git` in the repository's environment.
 */
describe("the repository's release tags", () => {
  let repo: string;
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("lists tags newest first, and none for a repository without any", () => {
    repo = mkdtempSync(join(tmpdir(), "rel-tags-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "a"],
      { cwd: repo },
    );
    expect(releaseTags(repo)).toEqual([]);
    for (const [tag, date] of [
      ["v1.0.0", "2026-01-01T00:00:00Z"],
      ["v1.1.0", "2026-02-01T00:00:00Z"],
    ] as const) {
      execFileSync(
        "git",
        ["-c", "user.name=T", "-c", "user.email=t@x", "tag", "-a", tag, "-m", tag],
        {
          cwd: repo,
          env: { ...process.env, GIT_COMMITTER_DATE: date },
        },
      );
    }
    expect(releaseTags(repo)).toEqual(["v1.1.0", "v1.0.0"]);
  });

  it("is empty, not an error, outside a repository", () => {
    repo = mkdtempSync(join(tmpdir(), "rel-none-"));
    writeFileSync(join(repo, "x"), "");
    expect(releaseTags(repo)).toEqual([]);
  });
});
