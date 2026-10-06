import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSourceIndexCache,
  createSourceIndex,
  sourceIndexCacheStats,
} from "../src/index/source_index.js";
import { TYPESCRIPT_PARSER_VERSION, typescriptAdapter } from "../src/index/typescript.js";
import { moduleExports } from "../src/parsers.js";
import { packageGates, workspacePlan } from "../src/workspace.js";
import { EXPORT_CORPUS } from "./index_corpus.js";

/**
 * The source index (gates rule 28, T2): one AST-backed reader of what a file
 * imports, exports, re-exports, declares and references, with the parse's
 * provenance on every fact, a resolver that never guesses, and a cache that
 * can be deleted without changing an answer.
 */

const REPO = resolve(import.meta.dirname, "..", "..", "..");

describe("the source index's facts (IX-1)", () => {
  it("carries language, parser, version and parse status on every file's facts", () => {
    const facts = typescriptAdapter.facts("src/m.ts", EXPORT_CORPUS);
    expect(facts).toMatchObject({
      file: "src/m.ts",
      language: "typescript",
      parser: "typescript",
      parserVersion: TYPESCRIPT_PARSER_VERSION,
      parseStatus: "ok",
    });
    expect(TYPESCRIPT_PARSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads imports by kind: value, type, namespace, side effect, dynamic and require", () => {
    const facts = typescriptAdapter.facts(
      "src/m.ts",
      [
        'import def, { a, type B, c as d } from "./a.js";',
        'import type { T } from "./t.js";',
        'import * as ns from "./ns.js";',
        'import "./side.js";',
        'const lazy = () => import("./dyn.js");',
        'const cjs = require("./cjs.js");',
        "export const use = ns.alpha + ns.beta() + def + a + d;",
      ].join("\n"),
    );
    const bySpec = Object.fromEntries(facts.imports.map((i) => [i.specifier, i]));
    expect(bySpec["./a.js"]).toMatchObject({
      kind: "value",
      bindings: [
        { imported: "default", local: "def", typeOnly: false },
        { imported: "a", local: "a", typeOnly: false },
        { imported: "B", local: "B", typeOnly: true },
        { imported: "c", local: "d", typeOnly: false },
      ],
    });
    expect(bySpec["./t.js"]).toMatchObject({
      kind: "type",
      bindings: [{ imported: "T", typeOnly: true }],
    });
    expect(bySpec["./ns.js"]).toMatchObject({
      kind: "namespace",
      namespace: { local: "ns", members: ["alpha", "beta"], escapes: false },
    });
    expect(bySpec["./side.js"]?.kind).toBe("side-effect");
    expect(bySpec["./dyn.js"]?.kind).toBe("dynamic");
    expect(bySpec["./cjs.js"]?.kind).toBe("require");
  });

  it("GT-T2-5: reads the names a dynamic import is destructured into or read as", () => {
    const facts = typescriptAdapter.facts(
      "src/m.ts",
      [
        "export async function f() {",
        '  const { a, b: c } = await import("./d1.js");',
        '  const e = (await import("./d2.js")).e;',
        '  const m = await import("./d3.js");',
        '  const { x, ...rest } = await import("./d4.js");',
        '  void import("./d5.js").then((n) => n);',
        "  return [a, c, e, m.g, m.h(), x, rest];",
        "}",
      ].join("\n"),
    );
    const bySpec = Object.fromEntries(facts.imports.map((i) => [i.specifier, i]));
    expect(bySpec["./d1.js"]?.bindings.map((b) => [b.imported, b.local])).toEqual([
      ["a", "a"],
      ["b", "c"],
    ]);
    expect(bySpec["./d2.js"]?.bindings.map((b) => b.imported)).toEqual(["e"]);
    expect(bySpec["./d3.js"]?.namespace).toEqual({
      local: "m",
      members: ["g", "h"],
      escapes: false,
    });
    // A rest element or a module object passed on reads unknown names.
    expect(bySpec["./d4.js"]?.bindings).toEqual([]);
    expect(bySpec["./d4.js"]?.namespace).toBeUndefined();
    expect(bySpec["./d5.js"]?.bindings).toEqual([]);
    expect(bySpec["./d5.js"]?.namespace).toBeUndefined();
  });

  it("marks a namespace used whole as escaping", () => {
    const facts = typescriptAdapter.facts(
      "src/m.ts",
      'import * as api from "./api.js";\nregister(api);\n',
    );
    expect(facts.imports[0]?.namespace).toEqual({ local: "api", members: [], escapes: true });
  });

  it("separates a file's own exports from its re-exports", () => {
    const facts = typescriptAdapter.facts("src/m.ts", EXPORT_CORPUS);
    expect(facts.exports.map((e) => e.name).sort()).toEqual([
      "B",
      "I",
      "K",
      "T",
      "arrow",
      "decl",
      "default",
      "f",
      "h",
      "local",
      "renamed",
    ]);
    expect(facts.exports.find((e) => e.name === "default")?.local).toBe("g");
    expect(facts.exports.find((e) => e.name === "I")?.typeOnly).toBe(true);
    expect(facts.exports.find((e) => e.name === "renamed")?.local).toBe("inner");
    expect(facts.reExports).toEqual([
      {
        specifier: "./a.js",
        kind: "named",
        names: [{ imported: "a", exported: "reA", typeOnly: false }],
        line: 4,
      },
    ]);
    const star = typescriptAdapter.facts(
      "src/i.ts",
      'export * from "./x.js";\nexport * as y from "./y.js";\n',
    );
    expect(star.reExports.map((r) => [r.kind, r.specifier, r.namespace])).toEqual([
      ["star", "./x.js", undefined],
      ["namespace", "./y.js", "y"],
    ]);
  });

  it("lists top-level declarations, never a comment, a string or a nested local", () => {
    const facts = typescriptAdapter.facts("src/m.ts", EXPORT_CORPUS);
    const top = facts.declarations.filter((d) => d.topLevel).map((d) => `${d.kind} ${d.name}`);
    expect(top).toEqual([
      "function f",
      "function g",
      "function h",
      "class K",
      "interface I",
      "type T",
      "const arrow",
      "const decl",
      "const local",
      "function inner",
      "const s",
    ]);
    expect(facts.declarations.find((d) => d.name === "nested")?.topLevel).toBe(false);
    expect(facts.declarations.some((d) => d.name === "commented" || d.name === "inString")).toBe(
      false,
    );
    expect(facts.references.map((r) => r.name)).toContain("ns");
  });

  it("records each reference with its position, never one in a comment or a string", () => {
    const facts = typescriptAdapter.facts(
      "src/m.ts",
      [
        'import { total } from "./math.js";',
        "// total is summed here",
        'const label = "total";',
        "export const sum = total([1]) + obj.total;",
      ].join("\n"),
    );
    expect(facts.references.filter((r) => r.name === "total")).toEqual([
      { name: "total", line: 1, column: 10, start: 9, member: false },
      { name: "total", line: 4, column: 20, start: 101, member: false },
      { name: "total", line: 4, column: 37, start: 118, member: true },
    ]);
  });

  it("lists operator tokens with positions for the mutation operators, never in strings or comments", () => {
    const facts = typescriptAdapter.facts(
      "src/m.ts",
      'const s = "a < b"; // x === y\nexport const ok = a < b && c === true;\n',
    );
    expect(facts.operators.map((o) => `${o.line}:${o.column} ${o.text}`)).toEqual([
      "2:21 <",
      "2:25 &&",
      "2:30 ===",
      "2:34 true",
    ]);
  });

  it("says `recovered` with the first syntax error for a file that does not parse cleanly", () => {
    const facts = typescriptAdapter.facts("src/broken.ts", "export function f( {\n");
    expect(facts.parseStatus).toBe("recovered");
    expect(facts.parseReason).toMatch(/^line \d+: ./);
  });

  it("says `unsupported` for a language with no adapter, never an empty `ok`", () => {
    const root = mkdtempSync(join(tmpdir(), "index-py-"));
    writeFileSync(join(root, "m.py"), "import os\n");
    const facts = createSourceIndex(root).facts("m.py");
    expect(facts?.parseStatus).toBe("unsupported");
    expect(facts?.parseReason).toMatch(/no adapter/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the resolver (IX-2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "index-resolve-"));
    dirs.push(root);
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    return root;
  };

  it("returns a file, an external package or `unresolved`, never a guess", () => {
    const root = tree({ "src/a.ts": "", "src/lib/index.ts": "", "src/m.ts": "" });
    const r = (s: string) => typescriptAdapter.resolve("src/m.ts", s, root);
    expect(r("./a.js")).toEqual({ kind: "file", path: "src/a.ts" });
    expect(r("./lib")).toEqual({ kind: "file", path: "src/lib/index.ts" });
    expect(r("./lib/index.js")).toEqual({ kind: "file", path: "src/lib/index.ts" });
    expect(r("node:fs")).toEqual({ kind: "package", name: "node:fs" });
    expect(r("@scope/pkg/sub/path")).toEqual({ kind: "package", name: "@scope/pkg" });
    expect(r("lodash/fp")).toEqual({ kind: "package", name: "lodash" });
    expect(r("./gone.js")).toEqual({ kind: "unresolved", specifier: "./gone.js" });
    expect(r("../../../../outside.js")).toEqual({
      kind: "unresolved",
      specifier: "../../../../outside.js",
    });
  });

  it("lists a barrel's names through `export *`, so a remedy can name them (GT-M6-3)", () => {
    const root = tree({
      "src/index.ts": 'export * from "./a.js";\nexport * from "./b.js";\nexport const own = 1;\n',
      "src/a.ts": "export function alpha() {}\nexport type A = string;\n",
      "src/b.ts": 'export { beta } from "./c.js";\n',
      "src/c.ts": "export const beta = 2;\n",
    });
    const index = createSourceIndex(root);
    expect(index.exportedNames("src/index.ts")).toEqual({
      names: ["A", "alpha", "beta", "own"],
      complete: true,
    });
    expect(moduleExports(join(root, "src", "index.ts"))).toEqual(["A", "alpha", "beta", "own"]);
  });

  it("says a barrel's list is incomplete when an `export *` target cannot be resolved", () => {
    const root = tree({ "src/index.ts": 'export * from "./gone.js";\nexport const own = 1;\n' });
    expect(createSourceIndex(root).exportedNames("src/index.ts")).toEqual({
      names: ["own"],
      complete: false,
    });
    expect(moduleExports(join(root, "src", "index.ts"))).toBeUndefined();
  });
});

describe("workspace facts (IX-5)", () => {
  it("records the packages, their entry points and their dependencies, from the workspace reader", () => {
    const root = mkdtempSync(join(tmpdir(), "index-ws-"));
    const files: Record<string, string> = {
      "package.json": '{ "name": "root", "private": true }\n',
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": JSON.stringify({
        name: "@x/a",
        version: "1.0.0",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./api": "./dist/api.js",
        },
      }),
      "packages/a/tsconfig.json":
        '{ "compilerOptions": { "outDir": "./dist", "rootDir": "./src" } }\n',
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/a/src/api.ts": "export const api = 1;\n",
      "packages/b/package.json": JSON.stringify({
        name: "@x/b",
        version: "1.0.0",
        main: "./lib/main.js",
        dependencies: { "@x/a": "workspace:*" },
      }),
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    const ws = createSourceIndex(root).workspace();
    expect(ws?.packages).toEqual([
      {
        name: "@x/a",
        dir: "packages/a",
        deps: [],
        entryPoints: [
          { subpath: ".", target: "./dist/index.js", file: "packages/a/src/index.ts" },
          { subpath: "./api", target: "./dist/api.js", file: "packages/a/src/api.ts" },
        ],
      },
      {
        name: "@x/b",
        dir: "packages/b",
        deps: ["@x/a"],
        // No such file and no build mapping for it: unresolved, never guessed.
        entryPoints: [{ subpath: ".", target: "./lib/main.js" }],
      },
    ]);
    expect(createSourceIndex(join(root, "packages", "a")).workspace()).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the fact cache (IX-3)", () => {
  it("serves unchanged text from the cache, and deleting the cache changes no answer", () => {
    clearSourceIndexCache();
    const root = mkdtempSync(join(tmpdir(), "index-cache-"));
    writeFileSync(join(root, "m.ts"), EXPORT_CORPUS);
    const first = createSourceIndex(root).facts("m.ts");
    const before = sourceIndexCacheStats();
    const second = createSourceIndex(root).facts("m.ts");
    expect(sourceIndexCacheStats().hits).toBe(before.hits + 1);
    expect(second).toEqual(first);
    clearSourceIndexCache();
    expect(sourceIndexCacheStats().entries).toBe(0);
    expect(createSourceIndex(root).facts("m.ts")).toEqual(first);
    writeFileSync(join(root, "m.ts"), `${EXPORT_CORPUS}export const more = 1;\n`);
    expect(
      createSourceIndex(root)
        .facts("m.ts")
        ?.exports.map((e) => e.name),
    ).toContain("more");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("tests reachable from a scope (GT-N3-2)", () => {
  it("names the test files that import a changed file, directly or through others", () => {
    const root = mkdtempSync(join(tmpdir(), "index-impacted-"));
    const files: Record<string, string> = {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
      "src/c.ts": "export const c = 3;\n",
      "tests/b.spec.ts": 'import { b } from "../src/b.js";\n',
      "tests/c.spec.ts": 'import { c } from "../src/c.js";\n',
      "tests/ns.spec.ts": 'import * as all from "../src/a.js";\n',
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    const index = createSourceIndex(root);
    const tests = ["tests/b.spec.ts", "tests/c.spec.ts", "tests/ns.spec.ts"];
    expect(index.reachableTests(["src/a.ts"], tests)).toEqual([
      "tests/b.spec.ts",
      "tests/ns.spec.ts",
    ]);
    // A changed test file is its own impacted test.
    expect(index.reachableTests(["tests/c.spec.ts"], tests)).toEqual(["tests/c.spec.ts"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("one parser, one index (IX-4, GT-T2-3)", () => {
  const tracked = (): string[] =>
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f))
      // `fixtures/` holds the target projects the harness builds, not its code.
      .filter((f) => !/(^|\/)fixtures\//.test(f));

  it("finds `typescript` imported only by the TypeScript adapter (IX-4)", () => {
    const name = ["type", "script"].join("");
    const importOf = new RegExp(
      `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)["']${name}(?:/[^"']*)?["']`,
    );
    const importers = tracked().filter((f) => importOf.test(readFileSync(join(REPO, f), "utf8")));
    expect(importers).toEqual(["packages/gates/src/index/typescript.ts"]);
  });

  it("leaves no import or export regular expression in the gates, the loop or the harness (GT-T2-3)", () => {
    // A regular expression that reads source for `import` or `export`: the
    // keyword followed by a regex whitespace class or word boundary.
    const keywordRegex = /\b(?:im|ex)port(?:\\\\?s|\\\\?b)/;
    /** Regexes over other text than source, each with the reason. */
    const notSource = new Map([
      ["apps/harness/src/architecture_gate.ts", "the brief's invariant sentence form"],
    ]);
    const offenders = tracked()
      .filter((f) => /^(packages\/(gates|loop)|apps\/harness)\/src\//.test(f))
      .flatMap((f) =>
        readFileSync(join(REPO, f), "utf8")
          .split("\n")
          .map((line, i) => ({ f, line, n: i + 1 }))
          .filter(({ line }) => keywordRegex.test(line))
          .filter(({ f, line }) => !(notSource.has(f) && /not\\s\+import\\s\+/.test(line)))
          .map(({ f, n, line }) => `${f}:${n}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});

// Security items 19–21: the source index's own git (`ls-files`) and the
// workspace reader's (`show <base>:<package>/.sekhemet/gates.toml`) run with
// the guarded environment in a card's worktree, so a program the
// repository's config names — an fsmonitor hook, a smudge or textconv
// filter — never runs.
describe("the source index's and the workspace reader's git are guarded (security items 19–21)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("never runs a program the repository's config names", () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), "index-guard-")));
    scratch.push(main);
    const git = (cwd: string, ...a: string[]) =>
      execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const put = (root: string, files: Record<string, string>) => {
      for (const [p, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), text);
      }
    };
    put(main, {
      "package.json": '{ "name": "root", "private": true }\n',
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": '{ "name": "@x/a", "version": "1.0.0" }\n',
      "packages/a/src/a.ts": "export const a = 1;\n",
      "packages/a/.sekhemet/gates.toml": '[[gate]]\nid = "t"\nrung = "test"\ncommand = "true"\n',
    });
    git(main, "init", "-q", "-b", "main");
    git(main, "config", "user.email", "t@t.t");
    git(main, "config", "user.name", "T");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "seed");
    const worktree = join(main, ".sekhemet", "worktrees", "card-1");
    git(main, "worktree", "add", "-q", "-b", "sekhemet/card-1", worktree);
    // Config added after the worktree was made: each program writes a marker if git runs it.
    const marker = join(main, "ran");
    const hook = join(main, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho x >> ${marker}\ncat\n`);
    chmodSync(hook, 0o755);
    git(main, "config", "core.fsmonitor", hook);
    git(main, "config", "filter.evil.smudge", hook);
    git(main, "config", "diff.evil.textconv", hook);
    writeFileSync(
      join(worktree, ".gitattributes"),
      "*.ts filter=evil diff=evil\n*.toml diff=evil\n",
    );
    writeFileSync(join(worktree, "packages", "a", "src", "b.ts"), "export const b = 2;\n");
    // The index still lists the files (it walks the tree when git refuses).
    expect(createSourceIndex(worktree).files()).toContain("packages/a/src/b.ts");
    const plan = workspacePlan(worktree, ["packages/a/src/b.ts"]);
    expect(plan?.touched).toEqual(["@x/a"]);
    // The package's gates cannot be read from the base: unavailable, never its scripts.
    const gates = packageGates(worktree, plan as NonNullable<typeof plan>, { base: "main" });
    expect(gates.map((g) => [g.def.id, g.unreadable])).toEqual([
      ["@x/a:gates", expect.stringMatching(/core\.fsmonitor/)],
    ]);
    expect(() => readFileSync(marker, "utf8")).toThrow();
    // Without the dangerous config, the guarded git reads the base's file.
    git(main, "config", "--unset", "core.fsmonitor");
    git(main, "config", "--unset", "filter.evil.smudge");
    git(main, "config", "--unset", "diff.evil.textconv");
    const read = packageGates(worktree, plan as NonNullable<typeof plan>, { base: "main" });
    expect(read.map((g) => g.def.id)).toEqual(["@x/a:t"]);
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });
});
