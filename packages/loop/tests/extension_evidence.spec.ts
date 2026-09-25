import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsRegistry } from "@sekhemet/context";
import type { GateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

// extensibility EXT-10, EXT-22a, EXT-25: hook load errors, skills left out
// for missing tools, and skill bodies cut to their budget are recorded on the
// card's evidence. A real git repository and worktree.

const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const adapter: LocalInferenceAdapter = {
  modelId: "m",
  supportedArms: ["arm_a_flat", "arm_b_json"],
  generate: async () => ({
    text: "",
    toolCalls: [
      {
        id: "1",
        name: "write_file",
        arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
      },
      { id: "2", name: "finish_card", arguments: {} },
    ],
    usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
  }),
};

describe("extension facts on the card's evidence (EXT-10, EXT-22a, EXT-25)", () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ext-ev-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("records the hook load errors, the omitted skills and the truncated ones", async () => {
    const skills = new SkillsRegistry();
    skills.registerSkill({
      name: "browse",
      description: "Browse the web",
      triggers: [],
      content: "Open pages.",
      tools: ["no_such_tool"],
    });
    skills.registerSkill({
      name: "alpha-guide",
      description: "How to change alpha",
      triggers: ["alpha"],
      content: `# One\n${"word ".repeat(40)}\n# Two\n${"more ".repeat(400)}\n`,
      budgetTokens: 80,
    });
    const card: CardRecord = {
      id: "card_ext",
      tier: "task",
      title: "Change alpha",
      status: "in_progress",
      scopeFiles: ["src/a.ts"],
      stepBudget: 3,
      stepsUsed: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const r = await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 3,
      modelAdapter: adapter,
      gateRunner: passing,
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.ts"],
      skillsRegistry: skills,
      hookErrors: ["/repo/.sekhemet/hooks.toml: unknown event 'card/nope'"],
    }).run();
    expect(r.evidence.extensions).toEqual({
      hookErrors: ["/repo/.sekhemet/hooks.toml: unknown event 'card/nope'"],
      skillsOmitted: [{ name: "browse", missingTools: ["no_such_tool"] }],
      skillsTruncated: [expect.objectContaining({ name: "alpha-guide", budgetTokens: 80 })],
    });
    const cut = r.evidence.extensions?.skillsTruncated?.[0];
    expect(cut?.keptTokens).toBeLessThanOrEqual(80);
    expect(cut?.originalTokens).toBeGreaterThan(80);
  });

  it("adds nothing when there is nothing to report", async () => {
    const card: CardRecord = {
      id: "card_plain",
      tier: "task",
      title: "Change alpha",
      status: "in_progress",
      scopeFiles: ["src/a.ts"],
      stepBudget: 3,
      stepsUsed: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const r = await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 3,
      modelAdapter: adapter,
      gateRunner: passing,
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.ts"],
    }).run();
    expect(r.evidence.extensions).toBeUndefined();
  });
});
