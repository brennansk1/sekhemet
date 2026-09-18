import { describe, expect, it } from "vitest";
import { PROMPT_ZONE_1_SYSTEM, buildFullPromptPack } from "../src/prompts.js";
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

  it("builds production 5-zone prompt pack maintaining byte-stable prefix", () => {
    const pack = buildFullPromptPack({
      card: {
        id: "card_8f21",
        tier: "task",
        title: "Implement Seatbelt Sandbox",
        status: "in_progress",
        scopeFiles: ["src/sandbox.ts"],
        stepBudget: 50,
        stepsUsed: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      repoMap: "packages/sandbox/src/index.ts:\n  export interface SandboxOptions",
      activeSkills: skills.resolveActiveSkills("Implement Seatbelt Sandbox", ["src/sandbox.ts"]),
      playbookRules: ["Rule 1: Always check exit codes.", "Rule 2: No drop shadows in CSS."],
      recentTurns: [
        {
          turn: 1,
          action: "write_file",
          result: "File written (42 lines)",
        },
      ],
      gateFailure: {
        rung: "typecheck",
        exitCode: 2,
        errorExcerpt:
          "src/sandbox.ts(12,4): error TS2322: Type 'string' not assignable to 'number'.",
        suggestedFixFiles: ["src/sandbox.ts"],
      },
    });

    // Zone 1: System invariants
    expect(pack.systemPrompt).toContain(PROMPT_ZONE_1_SYSTEM);
    expect(pack.systemPrompt).toContain("SEKHEMET LOCAL CODING EXECUTOR");

    // Zone 2: Skills & Playbook
    expect(pack.systemPrompt).toContain("PROJECT PLAYBOOK");
    expect(pack.systemPrompt).toContain("Rule 1: Always check exit codes");

    // Zone 3: Repo Map
    expect(pack.prompt).toContain("ARCHITECTURAL REPO MAP");
    expect(pack.prompt).toContain("packages/sandbox/src/index.ts");

    // Zone 4: Card Contract & Scope
    expect(pack.prompt).toContain("ACTIVE CARD CONTRACT");
    expect(pack.prompt).toContain("card_8f21");
    expect(pack.prompt).toContain("Step: 2/50");

    // Zone 5: Gate Failures & Recent Turns
    expect(pack.prompt).toContain("GATE FAILURE");
    expect(pack.prompt).toContain("Type 'string' not assignable to 'number'");
  });
});
