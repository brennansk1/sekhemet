import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools.js";

/**
 * The executor's contract is that a tool never throws: it returns an
 * observation the model can act on. A failure that explains itself is what
 * lets an agent self-correct, so these tests assert the explanation as much as
 * the outcome.
 */
describe("@sekhemet/loop ToolExecutor", () => {
  let root: string;
  let tools: ToolExecutor;

  const call = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: "t", name, arguments: args });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "toolexec-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "line 1\nline 2\nline 3\n");
    tools = new ToolExecutor({ worktreePath: root, agentRole: "implementer" });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns a denial observation instead of throwing on path traversal", async () => {
    const obs = await call("read_file", { path: "../../../etc/passwd" });
    expect(obs.ok).toBe(false);
    expect(obs.denied).toBe(true);
    // The model must be told not to retry, or it will.
    expect(obs.content).toContain("Do not retry");
  });

  it("numbers lines on read so replace_lines can be used accurately", async () => {
    const obs = await call("read_file", { path: "src/a.ts" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("1│line 1");
    expect(obs.content).toContain("3│line 3");
  });

  it("explains a missing file rather than failing silently", async () => {
    const obs = await call("read_file", { path: "src/missing.ts" });
    expect(obs.ok).toBe(false);
    expect(obs.summary).toContain("file not found");
  });

  it("refuses an ambiguous edit and says how many matches it found", async () => {
    writeFileSync(join(root, "src", "dup.ts"), "const x = 1;\nconst x = 1;\n");
    // The agent has read the file first (read-before-edit, L17).
    await call("read_file", { path: "src/dup.ts" });
    const obs = await call("edit", { path: "src/dup.ts", search: "const x = 1;", replace: "y" });

    expect(obs.ok).toBe(false);
    expect(obs.summary).toContain("ambiguous");
    expect(obs.content).toContain("appears 2 times");
    // Crucially, the file is untouched: an ambiguous edit must not guess.
    expect(readFileSync(join(root, "src", "dup.ts"), "utf8")).toBe("const x = 1;\nconst x = 1;\n");
  });

  it("applies an LF search string to a CRLF file and preserves the line endings", async () => {
    writeFileSync(join(root, "src", "crlf.ts"), "alpha\r\nbeta\r\ngamma\r\n");
    // The agent has read the file first (read-before-edit, L17).
    await call("read_file", { path: "src/crlf.ts" });
    const obs = await call("edit", { path: "src/crlf.ts", search: "beta", replace: "BETA" });

    expect(obs.ok).toBe(true);
    const after = readFileSync(join(root, "src", "crlf.ts"), "utf8");
    expect(after).toBe("alpha\r\nBETA\r\ngamma\r\n");
    // A file that silently converts to LF produces a whole-file diff.
    expect(after.includes("\r\n")).toBe(true);
  });

  it("rejects an out-of-range line replacement instead of clamping it", async () => {
    // The agent has read the file first (read-before-edit, L17).
    await call("read_file", { path: "src/a.ts" });
    const obs = await call("replace_lines", {
      path: "src/a.ts",
      start: 2,
      end: 99,
      replacement: "x",
    });
    expect(obs.ok).toBe(false);
    expect(obs.summary).toContain("out of range");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("line 3");
  });

  it("preserves indentation when replacing a symbol body", async () => {
    writeFileSync(
      join(root, "src", "svc.ts"),
      "export class Svc {\n  greet(): string {\n    return 'old';\n  }\n}\n",
    );
    // The agent has read the file first (read-before-edit, L17).
    await call("read_file", { path: "src/svc.ts" });
    const obs = await call("replace_symbol_body", {
      path: "src/svc.ts",
      symbol: "greet",
      // Deliberately mis-indented input: the executor must normalise it.
      body: "        return 'new';",
    });

    expect(obs.ok).toBe(true);
    const after = readFileSync(join(root, "src", "svc.ts"), "utf8");
    expect(after).toContain("    return 'new';");
    expect(after).not.toContain("        return 'new';");
    expect(after.trimEnd().endsWith("}")).toBe(true);
  });

  it("lists available symbols when the requested one is absent", async () => {
    const obs = await call("read_symbol", { path: "src/a.ts", symbol: "nope" });
    expect(obs.ok).toBe(false);
    // A bare "not found" leaves the model guessing; the alternatives do not.
    expect(obs.content).toContain("Symbols present");
  });

  it("matches real globs in find_files", async () => {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "deep", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "src", "c.md"), "# doc\n");

    const ts = await call("find_files", { pattern: "src/**/*.ts" });
    expect(ts.content).toContain("src/deep/b.ts");
    expect(ts.content).toContain("src/a.ts");
    expect(ts.content).not.toContain("c.md");
  });

  it("supports regular expressions in grep_search", async () => {
    const obs = await call("grep_search", { query: "line [13]" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("src/a.ts:1");
    expect(obs.content).toContain("src/a.ts:3");
    expect(obs.content).not.toContain("line 2");
  });

  it("denies a write outside the card's declared scope", async () => {
    const scoped = new ToolExecutor({
      worktreePath: root,
      agentRole: "implementer",
      scopeFiles: ["src/a.ts"],
    });
    const obs = await scoped.execute({
      id: "t",
      name: "write_file",
      arguments: { path: "src/other.ts", content: "x" },
    });

    expect(obs.denied).toBe(true);
    expect(obs.summary).toContain("DENIED");
  });

  it("admits a glob scope, which plain string matching rejected", async () => {
    const scoped = new ToolExecutor({
      worktreePath: root,
      agentRole: "implementer",
      scopeFiles: ["src/**"],
    });
    const obs = await scoped.execute({
      id: "t",
      name: "write_file",
      arguments: { path: "src/deep/new.ts", content: "export const n = 1;\n" },
    });
    expect(obs.ok).toBe(true);
  });

  it("enforces test immutability for the implementer role", async () => {
    writeFileSync(join(root, "src", "a.spec.ts"), "expect(1).toBe(1);\n");
    const obs = await call("write_file", { path: "src/a.spec.ts", content: "expect(1).toBe(2);" });

    expect(obs.denied).toBe(true);
    expect(obs.content).toContain("PERMISSION DENIED");
  });

  it("refuses an ask-tier command when no approver is attached", async () => {
    const obs = await call("run_cmd", { command: "rm", args: ["-rf", "/"] });
    expect(obs.denied).toBe(true);
    // The full argv is inspected: `rm` alone looks harmless.
    expect(obs.summary.toLowerCase()).toContain("denied");
  });

  it("runs an ask-tier command once an approver allows it", async () => {
    const approving = new ToolExecutor({
      worktreePath: root,
      agentRole: "implementer",
      onApproval: async () => true,
    });
    const obs = await approving.execute({
      id: "t",
      name: "run_cmd",
      arguments: { command: "git", args: ["reset", "--hard"] },
    });
    // Approved, so it is no longer a denial — it may still fail on its merits.
    expect(obs.denied).toBeUndefined();
  });

  it("reports an unknown tool by name", async () => {
    const obs = await call("teleport", { to: "mars" });
    expect(obs.ok).toBe(false);
    expect(obs.summary).toContain("unknown tool");
  });

  it("clamps a large command output while keeping both ends", async () => {
    const obs = await call("run_cmd", {
      command: process.execPath,
      args: ["-e", "for (let i=0;i<4000;i++) console.log('line '+i)"],
    });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("line 0");
    expect(obs.content).toContain("omitted");
    // The tail matters: compilers put their summary at the end.
    expect(obs.content).toContain("line 3999");
  });
});
