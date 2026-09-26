import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspPool, type LspServerCommand } from "@sekhemet/context";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_CATALOG } from "../src/tool_catalog.js";
import { ToolExecutor } from "../src/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE: LspServerCommand = {
  command: process.execPath,
  args: [join(here, "..", "..", "context", "tests", "support", "fake_lsp.mjs")],
};
const MISSING: LspServerCommand = { command: "definitely-not-a-language-server", args: [] };

/** NEW-worker-loop-7 and NEW-worker-loop-6 through the Worker's tools; real processes. */
describe("symbol tools through the LSP client", () => {
  const roots: string[] = [];
  const pools: LspPool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.closeAll();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-tools-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function greet() {\n  return 1;\n}\n");
    writeFileSync(join(root, "src", "b.ts"), 'import { greet } from "./a.js";\ngreet();\n');
    writeFileSync(join(root, "lib", "c.ts"), 'import { greet } from "../src/a.js";\ngreet();\n');
    writeFileSync(join(root, "a.py"), "def greet():\n  return 1\n\ngreet()\n");
    return root;
  };
  const tools = (
    root: string,
    servers: Record<string, LspServerCommand>,
    extra: Partial<ConstructorParameters<typeof ToolExecutor>[0]> = {},
  ) => {
    const pool = new LspPool({ servers, requestTimeoutMs: 5_000 });
    pools.push(pool);
    return {
      pool,
      exec: new ToolExecutor({
        worktreePath: root,
        agentRole: "implementer",
        lspPool: pool,
        ...extra,
      }),
    };
  };
  const call = (t: ToolExecutor, name: string, args: Record<string, unknown>) =>
    t.execute({ id: "c", name, arguments: args });

  it("WL-N7-1: a TypeScript symbol's references come from the TypeScript language server", async () => {
    const root = project();
    const { exec } = tools(root, { typescript: FAKE });
    const obs = await call(exec, "find_references", { symbol: "greet", file: "src/a.ts" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("typescript language server");
    const def = await call(exec, "go_to_definition", { symbol: "greet", file: "src/a.ts" });
    expect(def.ok).toBe(true);
    expect(def.content).toContain("src/a.ts:1:");
  });

  it("WL-N7-3: an absent Python server falls back to text search and says so, once per run", async () => {
    const root = project();
    const { exec, pool } = tools(root, { python: MISSING });
    const obs = await call(exec, "find_references", { symbol: "greet", file: "a.py" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toMatch(/python language server is unavailable/);
    expect(obs.content).toContain("a.py");
    const again = await call(exec, "find_references", { symbol: "greet", file: "a.py" });
    expect(again.content).toMatch(/python language server is unavailable/);
    expect(pool.size).toBe(0);
  });

  it("WL-N7-3: an absent TypeScript server falls back to the in-process TypeScript service", async () => {
    const root = project();
    const { exec } = tools(root, { typescript: MISSING });
    const obs = await call(exec, "find_references", { symbol: "greet", file: "src/a.ts" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("TypeScript language service");
  });

  it("WL-N6-1: rename_symbol applies every site in one call and records the lines as tool-applied", async () => {
    const root = project();
    const { exec } = tools(root, { typescript: FAKE }, { scopeFiles: ["src/**", "lib/**"] });
    const obs = await call(exec, "rename_symbol", {
      path: "src/a.ts",
      symbol: "greet",
      new_name: "welcome",
    });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("function welcome()");
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe(
      'import { welcome } from "./a.js";\nwelcome();\n',
    );
    expect(readFileSync(join(root, "lib", "c.ts"), "utf8")).toContain("welcome();");
    expect(exec.toolAppliedLines()).toEqual({
      tool: "rename_symbol",
      files: { "lib/c.ts": 2, "src/a.ts": 1, "src/b.ts": 2 },
    });
    expect(TOOL_CATALOG.some((t) => t.name === "rename_symbol")).toBe(true);
  });

  it("WL-N6-2: refuses a rename that reaches outside the scope, naming the files, unless the card's change is mechanical", async () => {
    const root = project();
    const { exec } = tools(root, { typescript: FAKE }, { scopeFiles: ["src/**"] });
    const obs = await call(exec, "rename_symbol", {
      path: "src/a.ts",
      symbol: "greet",
      new_name: "welcome",
    });
    expect(obs.ok).toBe(false);
    expect(obs.content).toContain("lib/c.ts");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("function greet()");
    const mech = tools(
      root,
      { typescript: FAKE },
      { scopeFiles: ["src/**"], mechanicalChange: true },
    );
    const done = await call(mech.exec, "rename_symbol", {
      path: "src/a.ts",
      symbol: "greet",
      new_name: "welcome",
    });
    expect(done.ok).toBe(true);
    expect(readFileSync(join(root, "lib", "c.ts"), "utf8")).toContain("welcome();");
  });

  // M2: a rename applies each edit's text, not the bare new name, so a
  // property used in shorthand or destructuring keeps the object's shape.
  const shapes = () => {
    const root = project();
    writeFileSync(join(root, "src", "box.ts"), "export interface Box {\n  foo: number;\n}\n");
    writeFileSync(
      join(root, "src", "use.ts"),
      [
        'import type { Box } from "./box.js";',
        "export function make(foo: number): Box {",
        "  return { foo };",
        "}",
        "export function read(o: Box): number {",
        "  const { foo } = o;",
        "  return foo;",
        "}",
        "",
      ].join("\n"),
    );
    return root;
  };

  it("M2: the in-process rename keeps shorthand and destructuring shapes (prefix and suffix text)", async () => {
    const root = shapes();
    const { exec } = tools(root, { typescript: MISSING }, { scopeFiles: ["src/**", "lib/**"] });
    const obs = await call(exec, "rename_symbol", {
      path: "src/box.ts",
      symbol: "foo",
      new_name: "size",
    });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(root, "src", "box.ts"), "utf8")).toContain("size: number;");
    const use = readFileSync(join(root, "src", "use.ts"), "utf8");
    expect(use).toContain("return { size: foo };");
    expect(use).toContain("const { size: foo } = o;");
    expect(use).toContain("return foo;");
    expect(use).toContain("make(foo: number)");
  });

  it("M2: a language server's rename applies each edit's newText", async () => {
    const root = shapes();
    const { exec } = tools(root, { typescript: FAKE }, { scopeFiles: ["src/**", "lib/**"] });
    const obs = await call(exec, "rename_symbol", {
      path: "src/box.ts",
      symbol: "foo",
      new_name: "size",
    });
    expect(obs.ok).toBe(true);
    // The fake server answers a shorthand site as `size: foo`, as tsserver does.
    expect(readFileSync(join(root, "src", "use.ts"), "utf8")).toContain("return { size: foo };");
  });

  it("WL-N6-1 without a server: the in-process TypeScript service renames", async () => {
    const root = project();
    const { exec } = tools(root, { typescript: MISSING }, { scopeFiles: ["src/**", "lib/**"] });
    const obs = await call(exec, "rename_symbol", {
      path: "src/a.ts",
      symbol: "greet",
      new_name: "welcome",
    });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toContain("welcome();");
  });
});
