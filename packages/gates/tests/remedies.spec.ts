import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultParserRegistry, rankFailures, remedyFor } from "../src/parsers.js";
import type { GateFailure } from "../src/types.js";
import type { GateDefinition } from "../src/types.js";

const gate = (parser: string): GateDefinition => ({
  id: parser,
  rung: parser === "biome" ? "lint" : "typecheck",
  layer: "static",
  command: parser,
  args: [],
  timeoutMs: 1000,
  parser,
  blocking: true,
});

describe("@sekhemet/gates targeted remedies", () => {
  it("gives the narrowing idiom for possibly-undefined index access", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: "src/verifier.ts(17,9): error TS18048: 'event' is possibly 'undefined'.",
      stderr: "",
      minimalRepro: "tsc -b",
    });
    expect(failure?.suggestedAction).toMatch(/if \(item === undefined\) continue/);
    expect(failure?.suggestedAction).toMatch(/non-null assertion/);
  });

  it("recognises a property access on a `| undefined` union as the same problem", () => {
    const remedy = remedyFor(
      "TS2339",
      "Property 'sequenceNumber' does not exist on type 'ChronicleEvent<unknown> | undefined'.",
    );
    expect(remedy).toMatch(/Narrow it/);
    // A genuinely missing property is a different problem and gets no narrowing advice.
    expect(remedyFor("TS2339", "Property 'foo' does not exist on type 'Bar'.")).toBeUndefined();
  });

  it("points a forbidden non-null assertion at the same idiom, not just the rule name", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("biome"),
      exitCode: 1,
      stdout:
        "./src/verifier.ts:13:19 lint/style/noNonNullAssertion ━━━━\n\n  × Forbidden non-null assertion.",
      stderr: "",
      minimalRepro: "biome check",
    });
    expect(failure?.suggestedAction).toMatch(/Narrow it/);
  });

  it("falls back to the generic instruction for an unknown code", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: "src/a.ts(1,1): error TS9999: Something new.",
      stderr: "",
      minimalRepro: "tsc -b",
    });
    expect(failure?.suggestedAction).toBe("Resolve TS9999 at src/a.ts:1.");
  });

  it("explains exactOptionalPropertyTypes: omit the property, never assign undefined", () => {
    expect(remedyFor("TS2375", "Type '{ x: undefined }' is not assignable")).toMatch(
      /Omit the property/,
    );
  });

  it("ranks a failing test above style nits, however many the nits are", () => {
    const f = (rung: string, file: string, excerpt: string): GateFailure =>
      ({
        rung,
        gate: rung,
        exitCode: 1,
        errorExcerpt: excerpt,
        suggestedFixFiles: file ? [file] : [],
      }) as GateFailure;
    const ranked = rankFailures(
      [
        f("lint", "src/ledger.ts", "noUnusedTemplateLiteral"),
        f("lint", "src/ledger.ts", "useTemplate"),
        f("lint", "src/ledger.ts", "useLiteralKeys"),
        // Protected test: no fix files, so reference weight alone ranked it last.
        f("test", "", "persists events across reopening"),
      ],
      3,
    );
    expect(ranked[0]?.errorExcerpt).toBe("persists events across reopening");
  });

  it("tells the model how to type database rows instead of casting blindly", () => {
    expect(
      remedyFor("TS2352", "Conversion of type 'Record<string, SQLOutputValue>[]' to type 'Row[]'"),
    ).toMatch(/as unknown as Row\[\]/);
  });
});

describe("a missing export is answered, not described", () => {
  // The first frozen-suite run: told "Read the module and use its actual
  // export", a Worker read the module four times, learned nothing it could
  // act on, and was stopped for repeating itself. A suggested action must be
  // completable in one step, so this one carries what it was sent to fetch.
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "ts2305-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "tokens.ts"),
      [
        "export const SPACING = 4;",
        "export type Tone = 'pass' | 'fail';",
        "export interface CardView { id: string }",
        "const hidden = 1;",
        "export { hidden as VISIBLE };",
      ].join("\n"),
    );
    return dir;
  };
  const failureFor = (cwd: string, member: string) =>
    defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: `src/card_tile.ts(1,15): error TS2305: Module '"./tokens.js"' has no exported member '${member}'.`,
      stderr: "",
      minimalRepro: "tsc --noEmit",
      cwd,
    })[0];

  it("lists what the module actually exports", () => {
    const f = failureFor(project(), "CanvasCard");
    expect(f?.suggestedAction).toContain("does not export CanvasCard");
    expect(f?.suggestedAction).toContain("CardView, SPACING, Tone, VISIBLE");
  });

  it("never sends the model to read the module (GT-M6-3)", () => {
    const action = failureFor(project(), "CanvasCard")?.suggestedAction;
    expect(action).not.toMatch(/\bread\b/i);
    expect(action).toContain("Import one of those");
  });

  it("falls back to a search the model can run when the module cannot be found", () => {
    const f = failureFor(mkdtempSync(join(tmpdir(), "ts2305-empty-")), "CanvasCard");
    expect(f?.suggestedAction).toContain("./tokens.js does not export CanvasCard");
    expect(f?.suggestedAction).toContain('grep_search with the query `from "./tokens.js"`');
    expect(f?.suggestedAction).not.toMatch(/\bread\b/i);
  });
});

describe("an unknown member is answered with the type's real members", () => {
  // Suite runs 4 and 5, on two different models: Nail wrote
  // `db.lastInsertRowId` (TS2339 on DatabaseSync); Cyber-Tiel passed
  // `{ create: true }` to new DatabaseSync (TS2353 on DatabaseSyncOptions)
  // and then asked tool_search for the type's declaration eight times. The
  // failure should carry what it was looking for.
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "ts2339-"));
    mkdirSync(join(dir, "node_modules", "@types", "node"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "@types", "node", "sqlite.d.ts"),
      [
        'declare module "node:sqlite" {',
        "  interface DatabaseSyncOptions {",
        "    open?: boolean | undefined;",
        "    readOnly?: boolean | undefined;",
        "    enableForeignKeyConstraints?: boolean | undefined;",
        "  }",
        "  class DatabaseSync implements Disposable {",
        "    constructor(path: string, options?: DatabaseSyncOptions);",
        "    close(): void;",
        "    exec(sql: string): void;",
        "    prepare(sql: string): StatementSync;",
        "    readonly isOpen: boolean;",
        "  }",
        "}",
      ].join("\n"),
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "types.ts"),
      "export interface Entry {\n  id: number;\n  hash: string;\n}\n",
    );
    return dir;
  };
  const parse = (cwd: string, line: string) =>
    defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: line,
      stderr: "",
      minimalRepro: "tsc --noEmit",
      cwd,
    })[0];

  it("lists a library class's members for a property that does not exist (TS2339)", () => {
    const f = parse(
      project(),
      "src/ledger.ts(92,31): error TS2339: Property 'lastInsertRowId' does not exist on type 'DatabaseSync'.",
    );
    expect(f?.suggestedAction).toContain("DatabaseSync has no member lastInsertRowId");
    expect(f?.suggestedAction).toContain("close, exec, isOpen, prepare");
    expect(f?.suggestedAction).not.toContain("constructor");
  });

  it("lists an options type's keys for an unknown key in an object literal (TS2353)", () => {
    const f = parse(
      project(),
      "src/db.ts(8,51): error TS2353: Object literal may only specify known properties, and 'create' does not exist in type 'DatabaseSyncOptions'.",
    );
    expect(f?.suggestedAction).toContain("DatabaseSyncOptions has no member create");
    expect(f?.suggestedAction).toContain("enableForeignKeyConstraints, open, readOnly");
    expect(f?.suggestedAction).toMatch(/no need to look/);
  });

  it("finds Node's types where pnpm keeps them, unhoisted", () => {
    // The first version looked only in node_modules/@types/node; checked
    // against the real suite repository it found nothing, because pnpm keeps
    // @types/node under .pnpm/@types+node@<version>/.
    const dir = mkdtempSync(join(tmpdir(), "ts2353-pnpm-"));
    const types = join(
      dir,
      "node_modules",
      ".pnpm",
      "@types+node@22.1.0",
      "node_modules",
      "@types",
      "node",
    );
    mkdirSync(types, { recursive: true });
    writeFileSync(
      join(types, "sqlite.d.ts"),
      "interface DatabaseSyncOptions {\n  open?: boolean;\n  readOnly?: boolean;\n}\n",
    );
    const f = parse(
      dir,
      "src/db.ts(8,51): error TS2353: Object literal may only specify known properties, and 'create' does not exist in type 'DatabaseSyncOptions'.",
    );
    expect(f?.suggestedAction).toContain("Its members are exactly: open, readOnly");
  });

  it("finds the project's own types too", () => {
    const f = parse(
      project(),
      "src/ledger.ts(3,9): error TS2339: Property 'sequence' does not exist on type 'Entry'.",
    );
    expect(f?.suggestedAction).toContain("Entry has no member sequence");
    expect(f?.suggestedAction).toContain("hash, id");
  });
});

describe("members and exports come from the syntax tree, and say exactly only when complete", () => {
  const tsc = (cwd: string, line: string) =>
    defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: line,
      stderr: "",
      minimalRepro: "tsc --noEmit",
      cwd,
    })[0];
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "members-"));
    mkdirSync(join(dir, "src"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
    return dir;
  };

  it("counts async methods, getters, initialised properties and inherited members", () => {
    const dir = project({
      "store.ts": [
        "class Base {",
        "  close(): void {}",
        "}",
        "export class Store extends Base {",
        "  count = 0;",
        "  async load(): Promise<void> {}",
        "  get size(): number { return this.count; }",
        "  static open(): Store { return new Store(); }",
        "}",
      ].join("\n"),
    });
    const f = tsc(
      dir,
      "src/a.ts(1,1): error TS2339: Property 'nope' does not exist on type 'Store'.",
    );
    // Instance members only: a static method is not a member of the instance type.
    expect(f?.suggestedAction).toContain("Its members are exactly: close, count, load, size");
  });

  it("says the members include, not exactly, when a base type is outside what it can read", () => {
    const dir = project({
      "store.ts":
        'import { Remote } from "remote-lib";\nexport class Store extends Remote {\n  load(): void {}\n}\n',
    });
    const f = tsc(
      dir,
      "src/a.ts(1,1): error TS2339: Property 'nope' does not exist on type 'Store'.",
    );
    expect(f?.suggestedAction).toContain("Its members include: load");
    expect(f?.suggestedAction).not.toContain("exactly");
  });

  it("says include, not exactly, when the list is cut", () => {
    const members = Array.from(
      { length: 45 },
      (_, i) => `  m${String(i).padStart(2, "0")}: number;`,
    );
    const dir = project({ "big.ts": `export interface Big {\n${members.join("\n")}\n}\n` });
    const f = tsc(
      dir,
      "src/a.ts(1,1): error TS2339: Property 'nope' does not exist on type 'Big'.",
    );
    expect(f?.suggestedAction).toContain("Its members include:");
    expect(f?.suggestedAction).not.toContain("exactly");
  });

  it("falls back to a search for a barrel that re-exports everything", () => {
    const dir = project({
      "index.ts": 'export * from "./tokens.js";\nexport const VERSION = 1;\n',
      "tokens.ts": "export const SPACING = 4;\n",
    });
    const f = tsc(
      dir,
      `src/a.ts(1,10): error TS2305: Module '"./index.js"' has no exported member 'Missing'.`,
    );
    expect(f?.suggestedAction).toContain('grep_search with the query `from "./index.js"`');
    expect(f?.suggestedAction).not.toContain("exactly");
  });

  it("never reads a module outside the worktree", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.ts"), "export const TOKEN = 1;\n");
    const dir = project({});
    const rel = relative(join(dir, "src"), join(outside, "secret.js"));
    const f = tsc(
      dir,
      `src/a.ts(1,10): error TS2305: Module '"${rel}"' has no exported member 'Missing'.`,
    );
    expect(f?.suggestedAction).not.toContain("TOKEN");
  });

  it("suggests import type for an interface, and names where it searched", () => {
    const dir = project({ "types.ts": "export interface Entry { id: number }\n" });
    const found = tsc(dir, "src/a.ts(1,1): error TS2304: Cannot find name 'Entry'.");
    expect(found?.suggestedAction).toContain('import type { Entry } from "./types.js";');
    const missing = tsc(dir, "src/a.ts(1,1): error TS2304: Cannot find name 'Nowhere'.");
    expect(missing?.suggestedAction).toContain("no module under src/ exports it");
  });
});

describe("jest's --json report is read like vitest's", () => {
  it("finds a failing test in a report that starts with numFailedTestSuites", () => {
    const report = {
      numFailedTestSuites: 1,
      numTotalTestSuites: 1,
      testResults: [
        {
          name: "/w/tests/a.test.js",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["a"],
              title: "adds",
              status: "failed",
              failureMessages: [
                "Error: expect(received).toBe(expected)\n    at /w/tests/a.test.js:4:9",
              ],
            },
          ],
        },
      ],
    };
    const [f] = defaultParserRegistry.parse({
      gate: { ...gate("jest"), rung: "test" },
      exitCode: 1,
      stdout: JSON.stringify(report),
      stderr: "",
      minimalRepro: "npx jest",
      cwd: "/w",
    });
    expect(f?.location).toEqual({ file: "tests/a.test.js", line: 4, column: 9 });
  });
});

describe("remedies claim only what they read (B2.3 confirmation)", () => {
  const tsc = (cwd: string, line: string) =>
    defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: line,
      stderr: "",
      minimalRepro: "tsc --noEmit",
      cwd,
    })[0];
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "claims-"));
    mkdirSync(join(dir, "src"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
    return dir;
  };

  it("says include, not exactly, for a type declared in more than one file", () => {
    const dir = project({
      "a.ts": "export interface Entry { id: number }\n",
      "b.ts": "interface Entry { amount: number }\n",
    });
    const f = tsc(
      dir,
      "src/c.ts(1,1): error TS2339: Property 'nope' does not exist on type 'Entry'.",
    );
    expect(f?.suggestedAction).toContain("Its members include:");
  });

  it("sends a relative module it cannot resolve to a search", () => {
    const f = tsc(
      project({}),
      `src/a.ts(1,10): error TS2305: Module '"./nowhere.js"' has no exported member 'X'.`,
    );
    expect(f?.suggestedAction).toContain('grep_search with the query `from "./nowhere.js"`');
  });

  it("does not follow a symlinked directory out of the worktree", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-types-"));
    writeFileSync(join(outside, "leak.ts"), "export interface Secret { token: string }\n");
    const dir = project({});
    symlinkSync(outside, join(dir, "src", "linked"));
    const f = tsc(
      dir,
      "src/a.ts(1,1): error TS2339: Property 'nope' does not exist on type 'Secret'.",
    );
    expect(f?.suggestedAction).not.toContain("token");
    const name = tsc(dir, "src/a.ts(1,1): error TS2304: Cannot find name 'Secret'.");
    expect(name?.suggestedAction).not.toContain("linked/leak");
  });
});
