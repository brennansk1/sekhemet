import { describe, expect, it } from "vitest";
import { cliIn, g6Repo, write } from "./support/g6_review.js";

/**
 * review-git item 4 (the release version rule, RG-N4-1) at the door (C2d,
 * FINDINGS_C1 TST-01): the built command (`apps/harness/dist/index.js`)
 * spawned in a real repository whose integration branch carries
 * Conventional-Commit squashes after a tag. `sekhemet release` without
 * `--confirm` proposes the next version from those squashes and writes no
 * tag; with it, the proposed version is the tag.
 */

function squash(r: ReturnType<typeof g6Repo>, file: string, message: string) {
  write(r.repo, file, `export const v = "${message.length}";\n`);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", message);
}

describe("RG-N4-1: the release version comes from the squashes since the last tag", () => {
  it("RG-N4-1: a breaking change on 0.y.z bumps minor, not major: `feat!:` on v0.2.0 proposes v0.3.0, a BREAKING CHANGE footer on v0.3.0 proposes v0.4.0", async () => {
    const r = g6Repo();
    r.git("tag", "v0.2.0");
    squash(r, "src/api.ts", "feat!: drop the default export\n\nCard: c1");
    const first = cliIn(r, ["release"]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toMatch(/v0\.2\.0 -> v0\.3\.0 \(major, 1 commits/);
    // Proposed, not tagged.
    expect(r.git("tag", "--list")).toBe("v0.2.0");

    const confirmed = cliIn(r, ["release", "--confirm"]);
    expect(confirmed.status, confirmed.stdout + confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toMatch(/Tagged v0\.3\.0\./);
    expect(r.git("rev-parse", "v0.3.0^{commit}")).toBe(r.git("rev-parse", "HEAD"));

    squash(
      r,
      "src/b.ts",
      "feat: rename the store\n\nBREAKING CHANGE: the store is now called repo\n\nCard: c2",
    );
    const second = cliIn(r, ["release"]);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toMatch(/v0\.3\.0 -> v0\.4\.0 \(major, 1 commits/);
  });

  it("RG-N4-1: only the squashes since the last tag count; at 1.y.z a breaking change is a major release, a feature minor and a fix a patch", async () => {
    const r = g6Repo();
    // Before the tag: a breaking change already released.
    squash(r, "src/old.ts", "feat!: the old break\n\nCard: c0");
    r.git("tag", "v1.2.3");
    squash(r, "src/fix.ts", "fix: keep the trailing newline\n\nCard: c1");
    const patch = cliIn(r, ["release"]);
    expect(patch.stdout, patch.stderr).toMatch(/v1\.2\.3 -> v1\.2\.4 \(patch, 1 commits/);
    squash(r, "src/feat.ts", "feat: export the parser\n\nCard: c2");
    const minor = cliIn(r, ["release"]);
    expect(minor.stdout, minor.stderr).toMatch(/v1\.2\.3 -> v1\.3\.0 \(minor, 2 commits/);
    squash(r, "src/break.ts", "refactor!: one entry point\n\nCard: c3");
    const major = cliIn(r, ["release"]);
    expect(major.stdout, major.stderr).toMatch(/v1\.2\.3 -> v2\.0\.0 \(major, 3 commits/);
    expect(r.git("tag", "--list")).toBe("v1.2.3");
  });
});
