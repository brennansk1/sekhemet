import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NodeGitSyncAdapter,
  conventionalSquashMessage,
  groupByIntent,
  missingTrailers,
  modelCoAuthor,
} from "../src/git_adapter.js";

let repo: string;
let adapter: NodeGitSyncAdapter;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const cp = (cardId: string, step: number, model = "nail") =>
  adapter.commitCheckpoint({
    cardId,
    step,
    gateStatus: "pass",
    agentModel: model,
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sek-sync2-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@x");
  write(repo, "packages/core/src/a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  adapter = new NodeGitSyncAdapter(repo, "proj");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("Y2/Y3: attributed, idempotent checkpoints", () => {
  it("adds the model as co-author and does not stack empty commits", async () => {
    const wt = await adapter.createWorktree("c1", "main", "Add b");
    write(wt, "packages/core/src/b.ts", "export const b = 2;\n");
    const first = await cp("c1", 1);
    expect(git("log", "-1", "--format=%B", first)).toContain(
      `Co-authored-by: ${modelCoAuthor("nail")}`,
    );
    const again = await cp("c1", 2);
    expect(again).toBe(first);
    expect(git("rev-parse", "refs/sekhemet/steps/c1/step_2")).toBe(first);
    write(wt, "packages/core/src/b.ts", "export const b = 3;\n");
    expect(await cp("c1", 3)).not.toBe(first);
  });
});

describe("Y4: squash into an intent-grouped Conventional Commit", () => {
  it("derives type and scope from the change and collects every co-author", async () => {
    const wt = await adapter.createWorktree("c2", "main", "Fix rounding bug");
    write(wt, "packages/core/src/a.ts", "export const a = 2;\n");
    await cp("c2", 1, "nail");
    write(wt, "packages/core/tests/a.spec.ts", "// test\n");
    await cp("c2", 2, "dirk");
    await adapter.squashAndMerge(
      "c2",
      "main",
      "feat(c2): Fix rounding bug",
      { "Agent-Harness": "sekhemet" },
      "Fix rounding bug",
    );
    const msg = git("log", "main", "-1", "--format=%B");
    expect(msg.split("\n")[0]).toBe("fix(core): fix rounding bug");
    expect(msg).toContain("Source: packages/core/src/a.ts");
    expect(msg).toContain("Tests: packages/core/tests/a.spec.ts");
    expect(msg).toContain(`Co-authored-by: ${modelCoAuthor("dirk")}`);
    expect(msg).toContain(`Co-authored-by: ${modelCoAuthor("nail")}`);
    expect(msg).toContain("Card: c2");
  });

  it("keeps a message that is not the harness placeholder", () => {
    expect(conventionalSquashMessage("c9", "feat: mine", ["x.ts"])).toBe("feat: mine");
    expect(conventionalSquashMessage("c9", "feat(c9): Update docs", ["docs/a.md"])).toBe(
      "docs(docs): update docs\n\nDocs: docs/a.md",
    );
    expect(groupByIntent(["package.json", "src/x.ts", "README.md"])).toEqual({
      source: ["src/x.ts"],
      tests: [],
      config: ["package.json"],
      docs: ["README.md"],
    });
  });
});

describe("Y1/Y7: stacked branches", () => {
  it("bases a child on its parent's branch and restacks it after the parent lands", async () => {
    const pw = await adapter.createWorktree("parent", "main", "Parent");
    write(pw, "packages/core/src/p.ts", "export const p = 1;\n");
    await cp("parent", 1);
    expect(adapter.resolveBaseBranch("parent")).toBe("sekhemet/proj/parent-parent");
    expect(adapter.resolveBaseBranch("nobody")).toBe("main");
    const cw = await adapter.createWorktree("child", "main", "Child", "parent");
    expect(readFileSync(join(cw, "packages/core/src/p.ts"), "utf8")).toContain("p = 1");
    write(cw, "packages/core/src/c.ts", "export const c = 1;\n");
    await cp("child", 1);
    await adapter.squashAndMerge("parent", "main", "feat(parent): Parent", {}, "Parent");
    const res = await adapter.restackChildren("parent", "main");
    expect(res).toEqual([{ cardBranch: "sekhemet/proj/child-child", ok: true }]);
    // The child's own diff is now only its own file.
    const files = git("diff", "--name-only", "main...sekhemet/proj/child-child");
    expect(files).toBe("packages/core/src/c.ts");
  });
});

describe("Y6: rebase before Verify, conflicts typed", () => {
  it("rebases cleanly, and returns a typed conflict with the rebase aborted", async () => {
    const wt = await adapter.createWorktree("r1", "main", "R1");
    write(wt, "packages/core/src/r.ts", "export const r = 1;\n");
    write(repo, "packages/core/src/other.ts", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "main moved");
    const ok = await adapter.rebaseOntoIntegration("r1");
    expect(ok).toMatchObject({ ok: true, rebased: true });
    expect(readFileSync(join(wt, "packages/core/src/other.ts"), "utf8")).toBe("x\n");

    write(wt, "packages/core/src/a.ts", "export const a = 'card';\n");
    write(repo, "packages/core/src/a.ts", "export const a = 'main';\n");
    git("add", "-A");
    git("commit", "-q", "-m", "conflicting");
    const bad = await adapter.rebaseOntoIntegration("r1");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.failure.kind).toBe("rebase_conflict");
      expect(bad.failure.files).toEqual(["packages/core/src/a.ts"]);
      expect(bad.failure.excerpt).toContain("<<<<<<<");
    }
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" })).toBe("");
    expect(readFileSync(join(wt, "packages/core/src/a.ts"), "utf8")).toContain("card");
  });
});

describe("Y8: structural diff grouped by intent", () => {
  it("groups files and falls back to git when difftastic is absent", async () => {
    const wt = await adapter.createWorktree("d1", "main", "D1");
    write(wt, "packages/core/src/a.ts", "export const a = 5;\n");
    write(wt, "packages/core/tests/a.test.ts", "//\n");
    const d = await adapter.structuralDiff("d1");
    expect(["git", "difftastic"]).toContain(d.engine);
    expect(d.groups.source).toEqual(["packages/core/src/a.ts"]);
    expect(d.groups.tests).toEqual(["packages/core/tests/a.test.ts"]);
    expect(d.text).toContain("a.ts");
  });
});

describe("X26: the trailer contract", () => {
  it("names what a message is missing, checkpoints needing Step and GateStatus", () => {
    const full =
      "feat: x\n\nCard: c\nAgent-Model: m\nAgent-Harness: h\nAgent-Role: implementer\nCo-authored-by: A <a@x>";
    expect(missingTrailers(full)).toEqual([]);
    expect(missingTrailers("fix: y\n\nAgent-Model: m")).toEqual([
      "Card",
      "Agent-Harness",
      "Agent-Role",
      "Co-authored-by",
    ]);
    expect(missingTrailers(full, { checkpoint: true })).toEqual(["Step", "GateStatus"]);
    // A trailer quoted in the body is not a trailer.
    expect(missingTrailers(`fix: z\n\nsee "Card: c" above\n\nAgent-Model: m`)).toContain("Card");
  });

  it("a squash inherits the checkpoints' trailers and always carries a co-author", async () => {
    const wt = await adapter.createWorktree("c7", "main", "Add q");
    write(wt, "packages/core/src/q.ts", "export const q = 1;\n");
    await cp("c7", 1, "nail");
    await adapter.squashAndMerge("c7", "main", "feat(c7): Add q", {}, "Add q");
    const msg = git("log", "main", "-1", "--format=%B");
    expect(missingTrailers(msg)).toEqual([]);
    expect(msg).toContain("Agent-Model: nail");
    expect(msg).toContain("Agent-Role: implementer");
  });

  it("refuses to squash a branch whose trailers cannot be completed", async () => {
    const wt = await adapter.createWorktree("c8", "main", "Hand");
    write(wt, "packages/core/src/h.ts", "export const h = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-q", "-m", "by hand"], { cwd: wt });
    await expect(
      adapter.squashAndMerge("c8", "main", "feat(c8): Hand", {}, "Hand"),
    ).rejects.toThrow(
      /missing trailer\(s\): Agent-Model, Agent-Harness, Agent-Role, Co-authored-by/,
    );
    expect(git("status", "--porcelain")).toBe("");
  });
});
