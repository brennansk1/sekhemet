import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/permissions.js";

describe("@sekhemet/sandbox PermissionEngine", () => {
  const engine = new PermissionEngine();

  it("denies path traversal attempts outside worktree", () => {
    const res = engine.evaluate({
      toolName: "read_file",
      targetPath: "../../etc/passwd",
    });
    expect(res.allowed).toBe(false);
    expect(res.tier).toBe("deny");
    expect(res.reason).toContain("Path traversal");
  });

  it("denies modifying protected gates or harness configurations", () => {
    const res = engine.evaluate({
      toolName: "write_file",
      targetPath: "gates.toml",
    });
    expect(res.allowed).toBe(false);
    expect(res.tier).toBe("deny");
    expect(res.reason).toContain("Modifying protected gate");
  });

  it("denies writing a .git pointer file or anything in git metadata, at any depth", () => {
    // Phase A security review, 2026-09-22 (S1): the pattern /\.git\// matched
    // ".git/config" but not the ".git" pointer file a worktree has, which
    // tells the harness's unconfined git where the metadata lives.
    for (const targetPath of [".git", "./.git", ".git/config", "sub/.git", "sub/.git/hooks/x"]) {
      const res = engine.evaluate({ toolName: "write_file", targetPath });
      expect(res, targetPath).toMatchObject({
        allowed: false,
        tier: "deny",
        rule: "protected_system",
      });
    }
    // Not a false positive on ordinary names that merely contain "git".
    for (const targetPath of [".gitignore", ".github/workflows/ci.yml", "src/git.ts"]) {
      expect(engine.evaluate({ toolName: "write_file", targetPath }).rule, targetPath).not.toBe(
        "protected_system",
      );
    }
  });

  it("denies implementer from modifying test assertions (Test Immutability Law)", () => {
    const res = engine.evaluate({
      toolName: "write_file",
      targetPath: "tests/auth.spec.ts",
      agentRole: "implementer",
    });
    expect(res.allowed).toBe(false);
    expect(res.tier).toBe("deny");
    expect(res.reason).toContain("Test Immutability Law");
  });

  it("denies modifying files outside card's declared scope", () => {
    const res = engine.evaluate({
      toolName: "write_file",
      targetPath: "src/unauthorized.ts",
      declaredScopeFiles: ["src/auth.ts", "src/types.ts"],
    });
    expect(res.allowed).toBe(false);
    expect(res.tier).toBe("deny");
    expect(res.reason).toContain("outside declared scope");
    // The denial must carry the action, not only the constraint: a Worker
    // told what it may not do, and not what it may, retries the refused
    // write until its budget is gone.
    expect(res.reason).toContain("src/auth.ts, src/types.ts");
    expect(res.reason).toMatch(/Solve it within those files/);
    expect(res.reason).toMatch(/do not retry/);
    expect(res.reason).toMatch(/\bnote\b/);
  });

  it("escalates destructive shell commands to Ask tier", () => {
    const res = engine.evaluate({
      toolName: "run_cmd",
      command: "rm -rf /tmp/data",
    });
    expect(res.allowed).toBe(false);
    expect(res.tier).toBe("ask");
    expect(res.reason).toContain("Destructive command");
  });

  it("allows safe operations within declared scope", () => {
    const res = engine.evaluate({
      toolName: "write_file",
      targetPath: "src/auth.ts",
      declaredScopeFiles: ["src/auth.ts"],
      agentRole: "implementer",
    });
    expect(res.allowed).toBe(true);
    expect(res.tier).toBe("allow");
  });

  it("tags every refusal with the rule that produced it", () => {
    const e = new PermissionEngine();
    const rule = (req: Parameters<PermissionEngine["evaluate"]>[0]) => e.evaluate(req).rule;
    expect(rule({ toolName: "read_file", targetPath: "../x" })).toBe("traversal");
    expect(rule({ toolName: "write_file", targetPath: ".sekhemet/gates.toml" })).toBe(
      "protected_system",
    );
    expect(rule({ toolName: "edit", targetPath: "src/a.spec.ts", agentRole: "implementer" })).toBe(
      "protected_file",
    );
    expect(
      rule({ toolName: "write_file", targetPath: "src/b.ts", declaredScopeFiles: ["src/a.ts"] }),
    ).toBe("scope");
    expect(rule({ toolName: "run_cmd", command: "rm -rf build" })).toBe("destructive");
    expect(rule({ toolName: "run_cmd", command: "curl https://x" })).toBe("network");
    expect(rule({ toolName: "read_file", targetPath: "src/a.ts" })).toBeUndefined();
  });

  it("honours a project's protected globs (gates.toml [project] protected)", () => {
    const e = new PermissionEngine({
      protectedGlobs: ["db/migrations/**", "fixtures/golden/*.json"],
    });
    const write = (targetPath: string) =>
      e.evaluate({ toolName: "write_file", targetPath, agentRole: "implementer" });
    expect(write("db/migrations/0001_init.sql")).toMatchObject({
      tier: "deny",
      allowed: false,
      rule: "protected_file",
    });
    expect(write("fixtures/golden/out.json").allowed).toBe(false);
    // The project's list replaces the defaults it chose not to declare.
    expect(write("src/a.spec.ts").allowed).toBe(true);
    // Reads of a protected file stay allowed; only writes are refused.
    expect(
      e.evaluate({
        toolName: "read_file",
        targetPath: "db/migrations/0001_init.sql",
        agentRole: "implementer",
      }).allowed,
    ).toBe(true);
    expect(e.protectedPatterns).toEqual(["db/migrations/**", "fixtures/golden/*.json"]);
  });

  it("falls back to the built-in test-immutability globs when the list is empty", () => {
    const e = new PermissionEngine({ protectedGlobs: [] });
    expect(e.protectedPatterns).toEqual(["**/*.spec.ts", "**/*.test.ts", "tests/acceptance/**"]);
    expect(
      e.evaluate({ toolName: "edit", targetPath: "tests/x.test.ts", agentRole: "implementer" })
        .allowed,
    ).toBe(false);
  });
});
