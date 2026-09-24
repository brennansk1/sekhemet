import { describe, expect, it } from "vitest";
import { SkillsRegistry } from "../src/skills.js";

describe("@sekhemet/context Skills & Prompts Engine", () => {
  const skills = new SkillsRegistry();
  skills.registerSkill({
    name: "tdd-contract",
    description: "Contract-first TDD discipline: tests written first, immutable test fixtures.",
    triggers: ["test", "spec", "tdd"],
    content:
      "## TDD Discipline\n1. Write failing tests first.\n2. Never modify assertions to pass.",
  });

  skills.registerSkill({
    name: "ast-refactor",
    description: "Surgical AST symbol refactoring without non-semantic changes.",
    triggers: ["refactor", "rename", "ast"],
    content: "## AST Refactor\nUse replace_lines for surgical edits.",
  });

  it("produces compact 1-line per skill summary for prompt budget preservation", () => {
    const summary = skills.getCompactSummary();
    expect(summary).toContain("tdd-contract");
    expect(summary).toContain("ast-refactor");
    // Summary should be concise, not full content
    expect(summary).not.toContain("Write failing tests first");
  });

  it("progressively discloses full skill instructions only when triggers match", () => {
    const matched = skills.resolveActiveSkills("Write test suite for auth module", [
      "tests/auth.spec.ts",
    ]);

    expect(matched.length).toBe(1);
    expect(matched[0]?.name).toBe("tdd-contract");
    expect(matched[0]?.content).toContain("Write failing tests first");

    // ast-refactor should NOT be loaded
    expect(matched.some((s) => s.name === "ast-refactor")).toBe(false);
  });
});
