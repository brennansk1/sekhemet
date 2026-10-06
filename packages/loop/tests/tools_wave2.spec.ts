import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDiffForSecrets, scanSecrets } from "@sekhemet/gates";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSyntax } from "../src/parse_gate.js";
import { ToolExecutor } from "../src/tools.js";
import { validateWrite } from "../src/write_contract.js";

// A fake key for the tests, assembled so this file itself holds no literal.
const FAKE_GH = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

describe("loop tools, wave 2 (L7, L9, L10, L16, G6, G7)", () => {
  let root: string;
  let tools: ToolExecutor;
  const run = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: "t", name, arguments: args });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tools-w2-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "build/\n");
    writeFileSync(join(root, "src", "old.ts"), "export const old = 1;\n");
    writeFileSync(
      join(root, "src", "lib.ts"),
      "export function parseDate(s: string): number {\n  return Date.parse(s);\n}\n",
    );
    writeFileSync(
      join(root, "src", "use.ts"),
      'import { parseDate as pd } from "./lib.js";\nexport const t = pd("2026");\n// parseDate is mentioned in a comment only\n',
    );
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build", "out.ts"), "export const built = 1;\n");
    utimesSync(join(root, "src", "old.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["src/**"] });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("find_files lists newest first and respects .gitignore (L7)", async () => {
    const obs = await run("find_files", { pattern: "**/*.ts" });
    const listed = obs.content.split("\n").slice(1);
    expect(listed).not.toContain("build/out.ts");
    expect(listed.at(-1)).toBe("src/old.ts");
    expect(obs.content).toContain("newest first");
  });

  it("find_references resolves through an aliased import, not by text (L9)", async () => {
    const obs = await run("find_references", { symbol: "parseDate" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("TypeScript language service");
    expect(obs.content).toContain("D src/lib.ts:1");
    expect(obs.content).toMatch(/src\/use\.ts:1:\d+/);
    // The comment mentioning the name is not a reference.
    expect(obs.content).not.toContain("src/use.ts:3");
    const def = await run("go_to_definition", { symbol: "parseDate" });
    expect(def.content).toContain("src/lib.ts:1");
    expect(def.content).toContain("parseDate(s: string): number");
  });

  it("find_references falls back to the source index's references, not text, when nothing declares the symbol (T2)", async () => {
    writeFileSync(
      join(root, "src", "globals.ts"),
      '// registerPlugin is a host global\nexport const x = registerPlugin("a");\nconst s = "registerPlugin";\nhost.registerPlugin();\n',
    );
    writeFileSync(join(root, "src", "notes.md"), "registerPlugin in prose\n");
    const obs = await run("find_references", { symbol: "registerPlugin" });
    expect(obs.ok).toBe(true);
    expect(obs.content).toContain("source index");
    expect(obs.content).toContain("src/globals.ts:2:18");
    expect(obs.content).toContain("src/globals.ts:4:6");
    // Neither the comment nor the string is a reference.
    expect(obs.content).not.toContain("src/globals.ts:1:");
    expect(obs.content).not.toContain("src/globals.ts:3:");
    // A file the index has no parser for is searched as text, and said so.
    expect(obs.content).toContain("src/notes.md:1");
  });

  it("docs searches a dependency's README and types at the installed version, and caches (L10)", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { tinylib: "^2.0.0" } }),
    );
    const pkg = join(root, "node_modules", "tinylib");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tinylib", version: "2.3.1" }));
    writeFileSync(
      join(pkg, "README.md"),
      "# tinylib\n\nUse `frobnicate(x, { strict: true })` to frobnicate.\n",
    );
    writeFileSync(
      join(pkg, "index.d.ts"),
      "export declare function frobnicate(x: number, o?: { strict?: boolean }): string;\n",
    );
    const obs = await run("docs", { query: "frobnicate", library: "tinylib" });
    expect(obs.content).toContain("tinylib 2.3.1 (installed)");
    expect(obs.content).toContain("README.md");
    expect(obs.content).toContain("index.d.ts:1");
    expect(readdirSync(join(root, ".sekhemet", "docs-cache"))).toHaveLength(1);
    // Named in the query, the dependency is searched without library=.
    const implicit = await run("docs", { query: "tinylib frobnicate" });
    expect(implicit.content).toContain("tinylib 2.3.1");
  });

  it("falls back to the library's official web docs when the installed copy has nothing (L10 tier 3)", async () => {
    const asked: string[] = [];
    const web = new ToolExecutor({
      worktreePath: root,
      webDocs: async (lib, q) => {
        asked.push(`${lib}:${q}`);
        return `# ${lib}\n${"Use z.string().email() to validate. ".repeat(300)}`;
      },
    });
    const obs = await web.execute({
      id: "w",
      name: "docs",
      arguments: { query: "email", library: "zod" },
    });
    expect(asked).toEqual(["zod:email"]);
    expect(obs.content).toContain("zod: from the official docs (web)");
    expect(obs.content).toContain('<untrusted_content source="docs:zod">');
    expect(obs.content).toContain("(truncated)");
    // Found locally: the web is not asked.
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { tinylib: "1" } }));
    mkdirSync(join(root, "node_modules", "tinylib"), { recursive: true });
    writeFileSync(join(root, "node_modules", "tinylib", "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(root, "node_modules", "tinylib", "README.md"), "email helper here\n");
    await web.execute({
      id: "w2",
      name: "docs",
      arguments: { query: "email", library: "tinylib" },
    });
    expect(asked).toEqual(["zod:email"]);
  });

  it("docs reads a package installed after a lookup that found it only pinned (DS-N9-5)", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { tinylib: "^1" } }));
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/tinylib": { version: "1.2.3" } },
      }),
    );
    const before = await run("docs", { query: "frobnicate", library: "tinylib" });
    expect(before.content).toContain("No documentation found");
    const pkg = join(root, "node_modules", "tinylib");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "tinylib", version: "1.2.3", types: "index.d.ts" }),
    );
    writeFileSync(
      join(pkg, "index.d.ts"),
      "export declare function frobnicate(n: number): void;\n",
    );
    const after = await run("docs", { query: "frobnicate", library: "tinylib" });
    expect(after.content).toContain("tinylib@1.2.3/index.d.ts:1");
  });

  it("docs and dependencies serve Python, Go and Rust at the version in use (DS-N9-5)", async () => {
    // A real venv with an installed distribution, pinned at another version.
    execFileSync("python3", ["-m", "venv", "--without-pip", join(root, ".venv")]);
    const lib = join(root, ".venv", "lib");
    const site = join(lib, readdirSync(lib)[0] as string, "site-packages");
    const info = join(site, "requests-2.32.3.dist-info");
    mkdirSync(info, { recursive: true });
    writeFileSync(
      join(info, "METADATA"),
      "Metadata-Version: 2.1\nName: requests\nVersion: 2.32.3\n\nUse a Session to persist cookies.\n",
    );
    writeFileSync(
      join(info, "RECORD"),
      "requests/sessions.pyi,,\nrequests-2.32.3.dist-info/METADATA,,\n",
    );
    writeFileSync(join(info, "top_level.txt"), "requests\n");
    mkdirSync(join(site, "requests"));
    writeFileSync(
      join(site, "requests", "sessions.pyi"),
      "class Session:\n    def mount(self, prefix: str) -> None: ...\n",
    );
    writeFileSync(join(root, "requirements.txt"), "requests==2.31.0\n");
    // A Cargo crate pinned but absent from the registry sources.
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "app"\n\n[dependencies]\nrand = "0.8"\n',
    );
    writeFileSync(
      join(root, "Cargo.lock"),
      '[[package]]\nname = "rand"\nversion = "0.8.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    const saved = process.env.CARGO_HOME;
    process.env.CARGO_HOME = join(root, "no-cargo-home");
    try {
      const obs = await run("docs", { query: "mount", library: "requests" });
      expect(obs.content).toContain(
        "=== requests 2.32.3 (python, installed; the lockfile pins 2.31.0) ===",
      );
      expect(obs.content).toContain("requests@2.32.3/requests/sessions.pyi:2");
      const key = createHash("sha256")
        .update("python:requests@2.32.3:mount")
        .digest("hex")
        .slice(0, 24);
      expect(readdirSync(join(root, ".sekhemet", "docs-cache"))).toContain(`${key}.txt`);
      // Named in the query, the Python dependency is searched without library=.
      const implicit = await run("docs", { query: "requests cookies" });
      expect(implicit.content).toContain("METADATA");
      const deps = await run("dependencies", {});
      expect(deps.ok).toBe(true);
      expect(deps.content).toContain(
        "requests ==2.31.0 (python, requirements.txt, 2.32.3 installed; the lockfile pins 2.31.0)",
      );
      expect(deps.content).toContain(
        "rand 0.8 (rust, dependencies, not installed; the lockfile pins 0.8.5)",
      );
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "CARGO_HOME");
      else process.env.CARGO_HOME = saved;
    }
  });

  it("refuses a write that adds a credential, and writes atomically (L16, G7, G14)", async () => {
    const obs = await run("write_file", {
      path: "src/config.ts",
      content: `export const token = "${FAKE_GH}";\n`,
    });
    expect(obs.ok).toBe(false);
    expect(obs.content).toContain("would add a credential");
    expect(obs.content).not.toContain(FAKE_GH);
    expect(existsSync(join(root, "src", "config.ts"))).toBe(false);
    const good = await run("write_file", {
      path: "src/config.ts",
      content: "export const token = process.env.TOKEN;\n",
    });
    expect(good.ok).toBe(true);
    expect(readdirSync(join(root, "src")).some((f) => f.includes("sekhemet-tmp"))).toBe(false);
    const v = validateWrite(join(root, "src", "x.ts"), "export const = ;", "src/x.ts");
    expect(v.problems.map((p) => p.rule)).toEqual(["parse"]);
  });

  it("scans added diff lines for secrets with redaction (G14)", () => {
    const diff = `+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+const ok = 1;\n+const key = "${FAKE_GH}";\n`;
    const [f] = scanDiffForSecrets(diff);
    expect(f).toMatchObject({ rule: "github-pat", file: "src/a.ts", line: 2 });
    expect(f?.redacted).not.toContain(FAKE_GH.slice(4, 20));
    expect(scanSecrets('const password = "aaaaaaaaaaaaaaaaaaaaaaaa";', "x")).toEqual([]);
  });

  it("parses JSON, TOML, Python and shell before a write (G6)", () => {
    expect(checkSyntax("a.json", '{"a": 1,}')[0]?.message).toBeTruthy();
    expect(checkSyntax("a.json", '{"a": 1}')).toEqual([]);
    expect(checkSyntax("a.toml", "a = \n")).not.toEqual([]);
    expect(checkSyntax("a.py", "def f(:\n  pass\n")[0]?.line).toBe(1);
    expect(checkSyntax("a.py", "def f():\n    return 1\n")).toEqual([]);
    expect(checkSyntax("a.sh", "if then fi\n").length).toBe(1);
    expect(checkSyntax("a.md", "anything")).toEqual([]);
  });
});
