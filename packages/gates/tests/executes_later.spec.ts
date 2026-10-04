import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileEvidence, executesLater } from "../src/evidence.js";

/** NEW-security-1, SEC-32: files that run outside the sandbox later are flagged. */
describe("files that execute later (SEC-32)", () => {
  it("flags every path item 41 names, and nothing else", () => {
    const flagged = executesLater([
      ".githooks/pre-commit",
      ".husky/pre-push",
      ".pre-commit-config.yaml",
      ".gitattributes",
      "sub/.gitattributes",
      ".gitmodules",
      ".vscode/tasks.json",
      ".idea/workspace.xml",
      ".sekhemet/hooks.toml",
      ".sekhemet/mcp.json",
      ".sekhemet/skills/fmt/scripts/run.sh",
      ".HUSKY/pre-commit",
      ".envrc",
      ".github/workflows/ci.yml",
      ".devcontainer/devcontainer.json",
      "src/a.ts",
      "docs/husky.md",
      ".sekhemet/skills/fmt/SKILL.md",
    ]);
    expect(flagged).toEqual([
      ".githooks/pre-commit",
      ".husky/pre-push",
      ".pre-commit-config.yaml",
      ".gitattributes",
      "sub/.gitattributes",
      ".gitmodules",
      ".vscode/tasks.json",
      ".idea/workspace.xml",
      ".sekhemet/hooks.toml",
      ".sekhemet/mcp.json",
      ".sekhemet/skills/fmt/scripts/run.sh",
      ".HUSKY/pre-commit",
      ".envrc",
      ".github/workflows/ci.yml",
      ".devcontainer/devcontainer.json",
    ]);
  });

  it("flags other coding agents' configuration at any depth and in any case (SEC-N12-1)", () => {
    const agents = [
      ".claude/settings.json",
      "packages/web/.claude/commands/ship.md",
      ".cursor/rules/style.mdc",
      ".Cursor/mcp.json",
      ".mcp.json",
      "tools/.mcp.json",
      ".codex/config.toml",
      ".windsurf/rules/a.md",
      ".continue/config.yaml",
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "agents.md",
      "CLAUDE.md",
      "sub/claude.md",
      "mise.toml",
      "apps/x/MISE.TOML",
    ];
    expect(executesLater(agents)).toEqual(agents);
  });

  it("does not flag paths that merely resemble those names (SEC-N12-2)", () => {
    expect(
      executesLater([
        "src/claude.ts",
        "docs/agents.md.bak",
        "cursor/index.ts",
        "src/claude/settings.json",
        "docs/AGENTS.mdx",
        "my.mcp.json",
        "notes/CLAUDE.md.orig",
        "mise.toml.example",
        "github/copilot-instructions.md",
        ".continuerc",
      ]),
    ).toEqual([]);
  });

  it("records them in the evidence bundle", () => {
    const ev = compileEvidence({
      cardId: "c",
      attempt: 1,
      diff: "",
      filesTouched: ["src/a.ts", ".husky/pre-commit"],
      linesAdded: 1,
      linesRemoved: 0,
      gateResult: { passed: true, failures: [], durationMs: 1, rungResults: [] },
      turnsUsed: 1,
      stopReason: "gate_passed",
      checkpointShas: [],
      tokens: { promptTokens: 0, completionTokens: 0 },
      durationMs: 1,
      settings: { modelId: "m", toolArm: "a" },
      gatesConfigSha256: "x",
    });
    expect(ev.executesLater).toEqual([".husky/pre-commit"]);
  });

  it("is shown in the Review evidence as running outside the sandbox later", () => {
    const pane = readFileSync(
      join(import.meta.dirname, "..", "..", "ui", "web", "evidence.js"),
      "utf8",
    );
    expect(pane).toMatch(/ev\.executesLater/);
    expect(pane).toMatch(/Runs outside the sandbox later/);
  });
});
