import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitFilesOnBranch,
  keepAChangelogSection,
  lastCommitTouching,
  listBranchFiles,
  prependChangelogSection,
  readBranchFile,
} from "../src/repo_tools.js";

// design-stage NEW-design-stage-3 (DS-N3-1, -7, -8): project documents are
// committed onto the integration branch by plumbing — the person's checkout
// is never touched, the ref moves by compare-and-set, the commit carries the
// attribution trailers, README.md and CONTRIBUTING.md are never written —
// and a release's section goes on top of CHANGELOG.md with every earlier
// section byte-identical. Real git repositories.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "docs-commit-")));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(root, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: seed");
  return { root, git };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

const TRAILERS = {
  Card: "docs",
  "Agent-Model": "none",
  "Agent-Harness": "sekhemet",
  "Agent-Role": "documenter",
  "Co-authored-by": "sekhemet <harness@sekhemet.local>",
};

describe("committing project documents onto the integration branch (DS-N3-1)", () => {
  it("writes a commit by plumbing, moves the branch by compare-and-set and leaves the checkout alone", () => {
    const { root, git } = repo();
    const before = snapshot(root);
    const old = git("rev-parse", "main");
    const sha = commitFilesOnBranch(root, {
      branch: "main",
      expectedOld: old,
      files: [
        { path: "docs/product/brief.md", text: "# Brief\n" },
        { path: "docs/decisions/0001-use-sqlite.md", text: "# Use SQLite\n" },
      ],
      subject: "docs(product): regenerate from ledger seq 7",
      trailers: TRAILERS,
    });
    expect(git("rev-parse", "main")).toBe(sha);
    expect(git("rev-parse", `${sha}^`)).toBe(old);
    expect(snapshot(root)).toEqual(before);
    expect(readBranchFile(root, "main", "docs/product/brief.md")).toBe("# Brief\n");
    expect(readBranchFile(root, "main", "a.txt")).toBe("1\n");
    expect(readBranchFile(root, "main", "docs/product/missing.md")).toBeUndefined();
    expect(listBranchFiles(root, "main")).toEqual([
      "a.txt",
      "docs/decisions/0001-use-sqlite.md",
      "docs/product/brief.md",
    ]);
    expect(lastCommitTouching(root, "main", "docs/product/brief.md")).toBe(sha);
    expect(lastCommitTouching(root, "main", "nothing.md")).toBeUndefined();
    const message = git("log", "-1", "--format=%B", "main");
    expect(message).toMatch(/^docs\(product\): regenerate from ledger seq 7/);
    expect(message).toContain("Agent-Harness: sekhemet");
  });

  it("refuses a moved branch, a missing trailer, and README.md or CONTRIBUTING.md, writing nothing", () => {
    const { root, git } = repo();
    const old = git("rev-parse", "main");
    writeFileSync(join(root, "a.txt"), "2\n");
    git("commit", "-qam", "fix: moved");
    const moved = git("rev-parse", "main");
    const files = [{ path: "docs/product/brief.md", text: "# Brief\n" }];
    const input = { branch: "main", files, subject: "docs: x", trailers: TRAILERS };
    expect(() => commitFilesOnBranch(root, { ...input, expectedOld: old })).toThrow(/moved/);
    expect(() =>
      commitFilesOnBranch(root, { ...input, trailers: { Card: "docs" }, expectedOld: moved }),
    ).toThrow(/trailer/);
    for (const path of ["README.md", "CONTRIBUTING.md", "readme.md"]) {
      expect(() =>
        commitFilesOnBranch(root, {
          ...input,
          files: [{ path, text: "mine" }],
          expectedOld: moved,
        }),
      ).toThrow(/person's/);
    }
    expect(() =>
      commitFilesOnBranch(root, {
        ...input,
        files: [{ path: "../out.md", text: "x" }],
        expectedOld: moved,
      }),
    ).toThrow(/inside the repository/);
    expect(git("rev-parse", "main")).toBe(moved);
  });
});

describe("a release's section in CHANGELOG.md (DS-N3-8, Keep a Changelog)", () => {
  const section = keepAChangelogSection("0.2.0", "2026-09-26", {
    Added: ["Save a recipe (a100000)"],
    Fixed: ["**list:** keep order (b200000)"],
  });

  it("writes the version's section in Keep a Changelog's shape", () => {
    expect(section).toBe(
      "## [0.2.0] - 2026-09-26\n\n### Added\n\n- Save a recipe (a100000)\n\n### Fixed\n\n- **list:** keep order (b200000)\n",
    );
    expect(keepAChangelogSection("0.0.1", "2026-09-26", {})).toBe(
      "## [0.0.1] - 2026-09-26\n\nNo user-facing change.\n",
    );
  });

  it("starts a new changelog with the Keep a Changelog preamble", () => {
    const text = prependChangelogSection(undefined, section, "0.2.0");
    expect(text).toMatch(/^# Changelog\n/);
    expect(text).toContain("https://keepachangelog.com/en/1.1.0/");
    expect(text.endsWith(section)).toBe(true);
  });

  it("puts the section above the earlier ones and below Unreleased, every earlier byte kept", () => {
    const earlier =
      "## [0.1.0] - 2026-09-01\n\n### Added\n\n- The first thing\n\n[0.1.0]: https://example.com/v0.1.0\n";
    const theirs = `# Changelog\n\nMy own words.\n\n## [Unreleased]\n\n- in flight\n\n${earlier}`;
    const next = prependChangelogSection(theirs, section, "0.2.0");
    expect(next).toBe(
      `# Changelog\n\nMy own words.\n\n## [Unreleased]\n\n- in flight\n\n${section}\n${earlier}`,
    );
    expect(next.endsWith(earlier)).toBe(true);
    // A version already in the changelog is never added twice.
    expect(prependChangelogSection(next, section, "0.2.0")).toBe(next);
    expect(prependChangelogSection("## v0.2.0\n\n- old style\n", section, "0.2.0")).toBe(
      "## v0.2.0\n\n- old style\n",
    );
    // A changelog with no release yet: the section is added at its end.
    expect(prependChangelogSection("# Changelog\n", section, "0.2.0")).toBe(
      `# Changelog\n\n${section}`,
    );
  });
});
