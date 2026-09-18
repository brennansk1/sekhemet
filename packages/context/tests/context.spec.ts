import { describe, expect, it } from "vitest";
import { DefaultContextEngine } from "../src/engine.js";
import { extractSymbolOutline } from "../src/repo_map.js";
import type { ContextBudget } from "../src/types.js";

describe("@sekhemet/context", () => {
  const engine = new DefaultContextEngine();

  it("extracts clean symbol outline from TypeScript source code", () => {
    const tsCode = `
import { Foo } from "./foo";

export interface UserConfig {
  id: string;
  name: string;
}

export class UserManager {
  constructor(private db: Database) {}

  public async getUser(id: string): Promise<UserConfig | null> {
    const row = await this.db.query("SELECT * FROM users WHERE id = ?", id);
    return row;
  }
}

export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}
`;

    const outline = extractSymbolOutline("src/user.ts", tsCode);
    expect(outline).toContain("src/user.ts");
    expect(outline).toContain("interface UserConfig");
    expect(outline).toContain("class UserManager");
    expect(outline).toContain("getUser(id: string): Promise<UserConfig | null>");
    expect(outline).toContain("function formatName(first: string, last: string): string");
    // Function body should be stripped/omitted
    expect(outline).not.toContain("SELECT * FROM users");
  });

  it("builds a ContextPack respecting budget constraints", async () => {
    const budget: ContextBudget = {
      maxTokens: 4000,
      systemBudget: 500,
      repoMapBudget: 500,
      filesBudget: 2000,
      historyBudget: 1000,
    };

    const files = [
      {
        filePath: "packages/a.ts",
        content: "export const a = 1;\n".repeat(10),
      },
    ];

    const pack = await engine.buildPack({
      cardId: "card_ctx1",
      systemPrompt: "You are Sekhemet local coding harness.",
      prompt: "Implement the feature.",
      files,
      repoSymbols: ["packages/a.ts:\n  export const a: number;"],
      budget,
    });

    expect(pack.systemPrompt).toBe("You are Sekhemet local coding harness.");
    expect(pack.fileSnippets.length).toBe(1);
    expect(pack.fileSnippets[0]?.isTruncated).toBe(false);
    expect(pack.totalEstimatedTokens).toBeLessThan(budget.maxTokens);
  });

  it("truncates large files when exceeding the filesBudget", async () => {
    const budget: ContextBudget = {
      maxTokens: 1000,
      systemBudget: 200,
      repoMapBudget: 200,
      filesBudget: 300, // small file budget (~1200 chars)
      historyBudget: 300,
    };

    const largeFile = {
      filePath: "large.ts",
      content:
        "export const line = 'a very long sentence that consumes tokens repeatedly';\n".repeat(100),
    };

    const pack = await engine.buildPack({
      cardId: "card_large",
      systemPrompt: "System",
      prompt: "Do work",
      files: [largeFile],
      repoSymbols: [],
      budget,
    });

    expect(pack.fileSnippets.length).toBe(1);
    expect(pack.fileSnippets[0]?.isTruncated).toBe(true);
    expect(pack.fileSnippets[0]?.content).toContain("[TRUNCATED");
  });

  it("produces byte-identical prefix across consecutive calls with same system and repo map", async () => {
    const budget: ContextBudget = {
      maxTokens: 4000,
      systemBudget: 500,
      repoMapBudget: 500,
      filesBudget: 2000,
      historyBudget: 1000,
    };

    const pack1 = await engine.buildPack({
      cardId: "card_prefix",
      systemPrompt: "Constant System Prompt",
      prompt: "Turn 1 prompt",
      files: [],
      repoSymbols: ["index.ts:\n  export const v: string;"],
      budget,
    });

    const pack2 = await engine.buildPack({
      cardId: "card_prefix",
      systemPrompt: "Constant System Prompt",
      prompt: "Turn 2 different prompt",
      files: [],
      repoSymbols: ["index.ts:\n  export const v: string;"],
      budget,
    });

    // Byte-identical prefix
    expect(pack1.systemPrompt).toBe(pack2.systemPrompt);
    expect(pack1.repoMapText).toBe(pack2.repoMapText);
  });
});
