import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportsFromSource, moduleExports } from "../src/parsers.js";
import { importGraph } from "../src/rank.js";
import { EXPORT_CORPUS } from "./index_corpus.js";

/**
 * Characterization of the gates' export and import readers, recorded from
 * the regex and `preProcessFile` versions before they moved onto the source
 * index (T2, GT-T2-3). Where the index answers better, the test names it.
 */

describe("export and import readers keep their answers (GT-T2-3)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads a module's exported names", () => {
    expect(exportsFromSource(EXPORT_CORPUS)).toEqual([
      "B",
      "I",
      "K",
      "T",
      "arrow",
      "decl",
      "f",
      "g",
      "h",
      "local",
      "reA",
      "renamed",
    ]);
  });

  it("reads a file's exports from disk, undefined when unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-exports-"));
    dirs.push(root);
    writeFileSync(join(root, "m.ts"), EXPORT_CORPUS);
    expect(moduleExports(join(root, "m.ts"))).toEqual(exportsFromSource(EXPORT_CORPUS));
    expect(moduleExports(join(root, "missing.ts"))).toBeUndefined();
  });

  it("builds the project import graph from relative specifiers only", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-graph-"));
    dirs.push(root);
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(
      join(root, "src", "main.ts"),
      [
        'import { a } from "./a.js";',
        'import type { T } from "./lib/index.js";',
        'export * from "./b";',
        'import "./side.js";',
        'const later = () => import("./dyn.js");',
        'import fs from "node:fs";',
        'import { gone } from "./missing.js";',
      ].join("\n"),
    );
    for (const f of ["a.ts", "b.ts", "side.ts", "dyn.ts", "lib/index.ts"]) {
      writeFileSync(join(root, "src", f), f === "a.ts" ? 'import "./b.js";\n' : "\n");
    }
    const graph = importGraph(["src/main.ts"], root);
    const asObject = Object.fromEntries(
      [...graph].map(([k, v]) => [k, [...v].sort()] as const).sort(),
    );
    expect(asObject).toEqual({
      "src/a.ts": ["src/b.ts"],
      "src/b.ts": [],
      "src/dyn.ts": [],
      "src/lib/index.ts": [],
      "src/main.ts": ["src/a.ts", "src/b.ts", "src/dyn.ts", "src/lib/index.ts", "src/side.ts"],
      "src/side.ts": [],
    });
  });
});
