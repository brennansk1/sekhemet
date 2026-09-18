import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathEscapeError, isInsideWorktree, resolveInWorktree } from "../src/paths.js";

/**
 * Path confinement is the boundary an escaping agent hits first, so these tests
 * attack it rather than demonstrate it.
 */
describe("@sekhemet/loop path confinement", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "confine-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "confine-out-")));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "secret.txt"), "classified\n");
  });

  afterEach(() => {
    for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves ordinary relative paths inside the worktree", () => {
    expect(resolveInWorktree(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
    expect(resolveInWorktree(root, "./src/a.ts")).toBe(join(root, "src", "a.ts"));
    // A file that does not exist yet must still resolve: agents create files.
    expect(resolveInWorktree(root, "src/new/deep.ts")).toBe(join(root, "src", "new", "deep.ts"));
  });

  it("rejects parent traversal in every spelling", () => {
    for (const attempt of [
      "../secret.txt",
      "../../etc/passwd",
      "src/../../etc/passwd",
      "src/./../../etc/passwd",
      "..",
      "src/..//../..",
    ]) {
      expect(() => resolveInWorktree(root, attempt), attempt).toThrow(PathEscapeError);
    }
  });

  it("rejects absolute paths outside the worktree but allows those inside", () => {
    expect(() => resolveInWorktree(root, join(outside, "secret.txt"))).toThrow(PathEscapeError);
    expect(() => resolveInWorktree(root, "/etc/passwd")).toThrow(PathEscapeError);
    expect(resolveInWorktree(root, join(root, "src", "a.ts"))).toBe(join(root, "src", "a.ts"));
  });

  it("follows symlinks before deciding, so a link out is not a way out", () => {
    // String comparison alone would accept this: "escape/secret.txt" looks contained.
    symlinkSync(outside, join(root, "escape"));
    expect(() => resolveInWorktree(root, "escape/secret.txt")).toThrow(PathEscapeError);
    expect(isInsideWorktree(root, "escape/secret.txt")).toBe(false);
  });

  it("rejects a NUL byte rather than letting it truncate the path", () => {
    expect(() => resolveInWorktree(root, "src/a.ts\0.png")).toThrow(PathEscapeError);
  });

  it("reports the attempted path and the resolved destination in the error", () => {
    try {
      resolveInWorktree(root, "../secret.txt");
      throw new Error("expected PathEscapeError");
    } catch (err) {
      expect(err).toBeInstanceOf(PathEscapeError);
      const failure = err as PathEscapeError;
      expect(failure.attemptedPath).toBe("../secret.txt");
      expect(failure.message).toContain("escapes to");
    }
  });

  it("treats the worktree root itself as inside", () => {
    expect(resolveInWorktree(root, ".")).toBe(root);
    expect(isInsideWorktree(root, ".")).toBe(true);
  });

  it("does not confuse a sibling directory sharing a name prefix", () => {
    // `/tmp/root-evil` must not be accepted merely because it starts with `/tmp/root`.
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      expect(() => resolveInWorktree(root, join(sibling, "x.ts"))).toThrow(PathEscapeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
