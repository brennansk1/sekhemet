import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { documentsOnlyCommit } from "../src/project_done.js";

// design-stage DS-N3-8: a release's tag names the documents commit on the
// proven sha only when that commit changed nothing but the paths the export
// recorded; otherwise the tag names the proven sha. Real git.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "sek-rel-docs-"));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  put("src/a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "proven");
  return { root, git, put, proven: git("rev-parse", "HEAD") };
}

const EXPORTED = ["CHANGELOG.md", "docs/product/releases/0.1.0.md", "docs/product/brief.md"];

describe("a release's documents commit (DS-N3-8)", () => {
  it("is tagged when it changed only the exported documents", () => {
    const r = repo();
    r.put("CHANGELOG.md", "# Changelog\n");
    r.put("docs/product/releases/0.1.0.md", "notes\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "docs");
    const docs = r.git("rev-parse", "HEAD");
    expect(documentsOnlyCommit(r.root, r.proven, docs, EXPORTED)).toEqual({ ok: true, others: [] });
  });

  it("is refused when it touched any other path, or does not sit on the proven sha", () => {
    const r = repo();
    r.put("CHANGELOG.md", "# Changelog\n");
    r.put("src/a.ts", "export const a = 2;\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "docs and code");
    const docs = r.git("rev-parse", "HEAD");
    expect(documentsOnlyCommit(r.root, r.proven, docs, EXPORTED)).toEqual({
      ok: false,
      others: ["src/a.ts"],
    });
    // A documents commit two commits on from the proven sha is not the one exported on it.
    r.put("docs/product/brief.md", "brief\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "docs");
    const later = r.git("rev-parse", "HEAD");
    expect(documentsOnlyCommit(r.root, docs, later, EXPORTED).ok).toBe(true);
    expect(documentsOnlyCommit(r.root, r.proven, later, EXPORTED).ok).toBe(false);
  });
});
