import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TYPESCRIPT_PARSER_VERSION, factsOfText } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { buildRankedRepoMap, roleLine } from "../src/ranked_repo_map.js";

/**
 * The context's share of the source index (context rules 13a, 13b; T2):
 * roles derived from facts, a package map for a large workspace, and a map
 * that says which parser produced it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-index-"));
  dirs.push(root);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
}

/** A pnpm workspace of `n` packages, each depending on the one before. */
function workspace(n: number): string {
  const files: Record<string, string> = {
    "package.json": '{ "name": "root", "private": true }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  };
  for (let i = 0; i < n; i++) {
    const deps = i > 0 ? { [`@x/p${i - 1}`]: "workspace:*" } : {};
    files[`packages/p${i}/package.json`] = JSON.stringify({
      name: `@x/p${i}`,
      version: "1.0.0",
      main: "./src/index.ts",
      dependencies: deps,
    });
    files[`packages/p${i}/src/index.ts`] =
      `/** Package ${i}'s public surface. */\nexport function run${i}(): number {\n  return ${i};\n}\n`;
    files[`packages/p${i}/src/helper.ts`] = `export const helper${i} = ${i};\n`;
  }
  return tree(files);
}

describe("roles from the index (CX-IX-2)", () => {
  it("derives a one-line role from the first documentation comment and the exports", () => {
    const facts = factsOfText(
      "src/types.ts",
      "/** The ledger's record types.\n * More detail. */\nexport interface Entry { id: string }\nexport type EntryId = string;\n",
    );
    expect(roleLine(facts)).toBe("The ledger's record types. Exports Entry, EntryId.");
    expect(roleLine(factsOfText("src/x.ts", "export const a = 1;\n"))).toBe("Exports a.");
    expect(roleLine(factsOfText("src/y.ts", "const a = 1;\n"))).toBe("No exports.");
  });
});

describe("the package map (CX-IX-1)", () => {
  it("renders one line per package and ranks files only inside the packages the scope touches", () => {
    const root = workspace(12);
    const map = buildRankedRepoMap(root, {
      scopeFiles: ["packages/p3/src/index.ts"],
      budgetTokens: 400,
    });
    const lines = map.text.split("\n");
    expect(lines[0]).toBe("PACKAGES (name: role):");
    expect(lines).toContain("@x/p3: Package 3's public surface. Exports run3. Depends on @x/p2.");
    expect(lines).toContain("@x/p0: Package 0's public surface. Exports run0.");
    expect(map.files.length).toBeGreaterThan(0);
    expect(map.files.every((f) => f.path.startsWith("packages/p3/"))).toBe(true);
    expect(map.usedTokens).toBeLessThanOrEqual(400);
  });

  it("renders no package map when the packages fit a tenth of the budget", () => {
    const root = workspace(2);
    const map = buildRankedRepoMap(root, { scopeFiles: [], budgetTokens: 1200 });
    expect(map.text).not.toContain("PACKAGES");
    expect(map.files.some((f) => f.path.startsWith("packages/p0/"))).toBe(true);
    expect(map.files.some((f) => f.path.startsWith("packages/p1/"))).toBe(true);
  });
});

describe("the parser that produced the map (CX-IX-3)", () => {
  it("names the parser and its version with the map", () => {
    const root = tree({ "src/a.ts": "export const a = 1;\n" });
    expect(buildRankedRepoMap(root).producedBy).toEqual({
      parser: "typescript",
      parserVersion: TYPESCRIPT_PARSER_VERSION,
    });
  });
});
