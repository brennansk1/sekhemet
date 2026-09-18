import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools.js";

describe("@sekhemet/loop history and dependency tools", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hist-"));
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "db.ts"), "db.run('x');\n");
    git("add", ".");
    git("commit", "-qm", "feat: first db");
    writeFileSync(join(root, "src", "db.ts"), "db.exec('x');\n");
    git("commit", "-qam", "fix(db): DatabaseSync has exec, not run");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3" }, devDependencies: { vitest: "^3" } }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const exec = (name: string, args: Record<string, unknown>) =>
    new ToolExecutor({ worktreePath: root }).execute({ id: "1", name, arguments: args });

  it("finds how the repository already solved a problem, by message and by code", async () => {
    const obs = await exec("git_history", { query: "exec" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("fix(db): DatabaseSync has exec, not run");
    const sha = /([0-9a-f]{7}) fix\(db\)/.exec(obs.content)?.[1] ?? "";
    const show = await exec("git_history", { sha });
    expect(show.content).toContain("+db.exec('x');");
  });

  it("refuses a sha that is not a commit id", async () => {
    expect((await exec("git_history", { sha: "HEAD; rm -rf /" })).ok).toBe(false);
  });

  it("lists installed dependencies to reuse", async () => {
    const obs = await exec("dependencies", {});
    expect(obs.content).toContain("zod@^3 (dependencies, not installed)");
    expect(obs.content).toContain("vitest@^3 (devDependencies");
  });
});
