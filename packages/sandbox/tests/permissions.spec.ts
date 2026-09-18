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
});
