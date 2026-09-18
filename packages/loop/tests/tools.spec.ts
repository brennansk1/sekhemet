import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { MockInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";

describe("@sekhemet/loop Full Tool Catalog", () => {
  let tempWorktree: string;
  const sandbox = new ProcessSandbox();
  const gateRunner = new DeterministicGateRunner(sandbox);

  beforeEach(() => {
    tempWorktree = mkdtempSync(join(tmpdir(), "sekhemet-tools-test-"));
    writeFileSync(join(tempWorktree, "main.ts"), "line 1\nline 2\nline 3\nline 4\nline 5\n");
    writeFileSync(join(tempWorktree, "utils.ts"), "export const helper = () => true;\n");
  });

  afterEach(() => {
    try {
      rmSync(tempWorktree, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("executes read_file with line ranges", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t1",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    const lines = await session.executeReadFile("main.ts", 2, 4);
    expect(lines).toBe("line 2\nline 3\nline 4");
  });

  it("executes replace_lines for surgical line replacement", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t2",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    await session.executeReplaceLines("main.ts", 2, 3, "replaced 2 and 3");
    const updated = await session.readFile("main.ts");
    expect(updated).toBe("line 1\nreplaced 2 and 3\nline 4\nline 5\n");
  });

  it("executes list_dir and find_files across worktree", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t3",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    const dir = await session.executeListDir(".");
    expect(dir).toContain("main.ts");
    expect(dir).toContain("utils.ts");

    const found = await session.executeFindFiles("*.ts");
    expect(found).toContain("main.ts");
    expect(found).toContain("utils.ts");
  });

  it("executes grep_search finding occurrences with line numbers", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t4",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    const matches = await session.executeGrepSearch("helper");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.file).toBe("utils.ts");
    expect(matches[0]?.content).toContain("export const helper");
  });

  it("executes run_cmd in isolated ProcessSandbox", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t5",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    const res = await session.executeRunCmd("node", ["-e", "console.log('cmd executed');"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("cmd executed");
  });

  it("executes read_symbol and replace_symbol_body surgically", async () => {
    writeFileSync(
      join(tempWorktree, "service.ts"),
      `export class Greeter {
  public greet(name: string): string {
    return "Hello, " + name;
  }
}
`,
    );

    const session = new CardExecutionSessionImpl({
      cardId: "card_t6",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    const symbolCode = await session.readSymbol("service.ts", "Greeter");
    expect(symbolCode).toContain("class Greeter");
    expect(symbolCode).toContain("public greet");

    await session.replaceSymbolBody(
      "service.ts",
      "Greeter",
      `public greet(name: string): string {\n    return "Welcome, " + name;\n  }`,
    );

    const updated = await session.readFile("service.ts");
    expect(updated).toContain("Welcome, ");

    const refs = await session.findReferences("Greeter");
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.file).toBe("service.ts");
  });

  it("executes edit with exact uniqueness requirement", async () => {
    const session = new CardExecutionSessionImpl({
      cardId: "card_t7",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    await session.executeEdit("main.ts", "line 3", "line 3 (modified)");
    const updated = await session.readFile("main.ts");
    expect(updated).toContain("line 3 (modified)");

    // Should throw if search string does not exist
    await expect(session.executeEdit("main.ts", "non-existent", "bar")).rejects.toThrow(
      "Search string not found",
    );
  });

  it("executes insert_after_symbol, note, and docs", async () => {
    writeFileSync(
      join(tempWorktree, "api.ts"),
      `export function endpoint() {
  return 200;
}
`,
    );

    writeFileSync(join(tempWorktree, "README.md"), "# Sekhemet Test Docs\nAPI documentation\n");

    const session = new CardExecutionSessionImpl({
      cardId: "card_t8",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: new MockInferenceAdapter("m"),
      gateRunner,
    });

    await session.insertAfterSymbol("api.ts", "endpoint", "export const version = '1.0.0';");
    const updated = await session.readFile("api.ts");
    expect(updated).toContain("export const version = '1.0.0';");

    await session.executeNote("Execution note recorded");
    expect(session.getNotes()).toContain("Execution note recorded");

    const docResult = await session.executeDocs("API documentation");
    expect(docResult).toContain("Sekhemet Test Docs");
  });
});
