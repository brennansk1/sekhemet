import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiMembers, moduleApiSummary } from "../src/api_surface.js";
import { dataContracts } from "../src/repo_map.js";
import { findSymbol, listSymbolNames } from "../src/symbols.js";
import { ToolExecutor } from "../src/tools.js";

/**
 * Characterization of the loop's symbol tools, recorded from the regex
 * parsers before they moved onto the source index (T2, GT-T2-3), so the
 * migration keeps every answer an existing caller relies on. Where the index
 * answers better than the regex did, the difference is named in the test.
 */

const CORPUS = `import { readFileSync } from "node:fs";

/** Loads things. */
export async function load(path: string): Promise<string> {
  return readFileSync(path, "utf8");
}

export default class Store<T> extends Base {
  private items: T[] = [];
  public get size(): number { return this.items.length; }
  async add(item: T): Promise<void> {
    this.items.push(item);
  }
}

export interface Row {
  id: number;
  name: string;
}

export type Id = string;
export type Shape = { w: number; h: number };
export enum Color { Red, Green }
export const handler = async (req: Request): Promise<Response> => {
  return new Response();
};
export const config = { retries: 3 };
let counter = 0;
function helper(): void {
  function nested() {}
  nested();
}
`;

const SPAN_NAMES = [
  "load",
  "Store",
  "size",
  "add",
  "Row",
  "Id",
  "Shape",
  "Color",
  "handler",
  "config",
  "counter",
  "helper",
  "nested",
];

describe("findSymbol and listSymbolNames keep their answers (GT-T2-3)", () => {
  it("locates each declaration with the same span, body and indentation", () => {
    const spans = Object.fromEntries(
      SPAN_NAMES.map((n) => {
        const s = findSymbol(CORPUS, n);
        return [n, s && { ...s, text: CORPUS.slice(s.declStart, s.declEnd) }];
      }),
    );
    expect(spans).toMatchSnapshot();
  });

  it("lists the declared names", () => {
    expect(listSymbolNames(CORPUS)).toMatchSnapshot();
  });
});

describe("the read_file outline keeps its lines (GT-T2-3)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("outlines a long file's top-level declarations and test blocks with line numbers", async () => {
    const root = mkdtempSync(join(tmpdir(), "golden-outline-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    const filler = Array.from({ length: 210 }, (_, i) => `// filler ${i}`).join("\n");
    writeFileSync(join(root, "src", "big.ts"), `${CORPUS}\n${filler}\n`);
    writeFileSync(
      join(root, "src", "big.spec.ts"),
      `import { it, describe } from "vitest";\ndescribe("the store", () => {\n  it("adds", () => {});\n});\ntest("alone", () => {});\n${filler}\n`,
    );
    const exec = (path: string) =>
      new ToolExecutor({ worktreePath: root }).execute({
        id: "1",
        name: "read_file",
        arguments: { path },
      });
    const outline = (content: string) =>
      content
        .split("\n")
        .filter((l) => /^\s+\d+ {2}\S/.test(l))
        .join("\n");
    expect(outline((await exec("src/big.ts")).content)).toMatchSnapshot();
    expect(outline((await exec("src/big.spec.ts")).content)).toMatchSnapshot();
  });
});

describe("data contracts and module API summaries keep their text (GT-T2-3)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("shows exported interface and object-type bodies outside the scope", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-contracts-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "types.ts"), CORPUS);
    expect(dataContracts(root, [])).toMatchSnapshot();
  });

  it("summarises an ambient module's classes and functions, following `export *` once", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-api-"));
    dirs.push(root);
    const types = join(root, "node_modules", "@types", "node");
    mkdirSync(types, { recursive: true });
    writeFileSync(
      join(types, "kv.d.ts"),
      [
        'declare module "kv" {',
        "  export class Store {",
        "    constructor(path: string);",
        "    get(key: string): string | undefined;",
        "    set(key: string, value: string): void;",
        "    readonly size: number;",
        "  }",
        "  export function open(path: string): Store;",
        "  function hidden(): void;",
        "}",
        'declare module "node:kv" {',
        '  export * from "kv";',
        "}",
      ].join("\n"),
    );
    expect(moduleApiSummary(root, "kv")).toMatchSnapshot();
    expect(moduleApiSummary(root, "node:kv")).toMatchSnapshot();
    expect(apiMembers(root, "Store")).toMatchSnapshot();
  });
});
