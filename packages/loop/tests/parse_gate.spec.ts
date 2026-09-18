import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSyntax } from "../src/parse_gate.js";
import { ToolExecutor } from "../src/tools.js";

describe("@sekhemet/loop parse gate", () => {
  let root: string;
  let tools: ToolExecutor;
  const good = "export function f(): number {\n  return 1;\n}\n";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "parsegate-"));
    writeFileSync(join(root, "f.ts"), good);
    tools = new ToolExecutor({ worktreePath: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports syntax errors with a 1-based location", () => {
    const problems = checkSyntax("x.ts", "export function f() {\n  return 1;\n");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.line).toBeGreaterThanOrEqual(2);
    expect(problems[0]?.message.length).toBeGreaterThan(0);
  });

  it("accepts valid code and ignores non-source files", () => {
    expect(checkSyntax("x.ts", good)).toEqual([]);
    expect(checkSyntax("notes.md", "{{{ not code")).toEqual([]);
  });

  it("checks syntax only, leaving type errors to the typecheck gate", () => {
    expect(checkSyntax("x.ts", "const n: number = 'str';\n")).toEqual([]);
  });

  it("refuses an edit that would break a parseable file and leaves it untouched", async () => {
    // Exactly the failure seen live: an edit that drops a closing brace.
    tools.markSeen("f.ts"); // read-before-edit (L17): the agent has read it
    const obs = await tools.execute({
      id: "1",
      name: "edit",
      arguments: { path: "f.ts", search: "  return 1;\n}", replace: "  return 1;" },
    });
    expect(obs.ok).toBe(false);
    expect(obs.content).toContain("would not parse");
    expect(obs.content).toContain("f.ts:");
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(good);
  });

  it("refuses a new file that does not parse", async () => {
    const obs = await tools.execute({
      id: "1",
      name: "write_file",
      arguments: { path: "new.ts", content: "export const x = {" },
    });
    expect(obs.ok).toBe(false);
  });

  it("still lets an already-broken file be repaired one step at a time", async () => {
    writeFileSync(join(root, "broken.ts"), "export function g() {\n  return 1;\n");
    tools.markSeen("broken.ts");
    const obs = await tools.execute({
      id: "1",
      name: "edit",
      arguments: { path: "broken.ts", search: "return 1;", replace: "return 2;" },
    });
    expect(obs.ok).toBe(true);
  });
});
