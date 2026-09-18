import { describe, expect, it } from "vitest";
import { findSymbol, listSymbolNames } from "../src/symbols.js";

describe("@sekhemet/loop symbol locator", () => {
  it("finds declarations the previous regex missed", () => {
    const source = `
export default async function* streamAll(limit: number) { yield limit; }

@Injectable()
export abstract class BaseService<T> {
  public async fetch<R>(id: string): Promise<R | null> { return null; }
}

export const handler = async (req: Request): Promise<Response> => new Response();

export interface Options { a: string }
export type Alias = Options | null;
export const enum Mode { On, Off }
`;
    for (const [name, kind] of [
      ["streamAll", "function"],
      ["BaseService", "class"],
      ["handler", "function"],
      ["Options", "interface"],
      ["Alias", "type"],
      ["Mode", "enum"],
    ] as const) {
      const span = findSymbol(source, name);
      expect(span, `${name} not found`).not.toBeNull();
      expect(span?.kind, `${name} kind`).toBe(kind);
    }

    // A class method is addressable too.
    expect(findSymbol(source, "fetch")?.kind).toBe("method");
  });

  it("does not desync on braces inside strings, template literals or comments", () => {
    // The previous brace counter walked every character, so a `}` inside a
    // string ended the body early and corrupted the file on rewrite.
    const source = `
export function tricky(): string {
  const a = "a } brace in a string";
  const b = '{ another }';
  const c = \`template \${"}"} literal\`;
  // a } in a line comment
  /* and a } in a block comment */
  return a + b + c;
}

export const after = 1;
`;
    const span = findSymbol(source, "tricky");
    expect(span).not.toBeNull();

    const body = source.slice(span?.declStart ?? 0, span?.declEnd ?? 0);
    // The whole function must be captured, not a truncated prefix.
    expect(body).toContain("return a + b + c;");
    expect(body.endsWith("}")).toBe(true);
    expect(body).not.toContain("export const after");
  });

  it("reports the declaration's own indentation so a rewrite can match it", () => {
    const source = "class A {\n    method() {\n      return 1;\n    }\n}\n";
    expect(findSymbol(source, "method")?.indent).toBe("    ");
  });

  it("handles a bodiless declaration terminated by a semicolon", () => {
    const span = findSymbol("export type Id = string;\nexport const x = 1;\n", "Id");
    expect(span?.bodyOpen).toBe(-1);
    expect(span?.kind).toBe("type");
  });

  it("returns null for an absent symbol instead of throwing", () => {
    expect(findSymbol("export const a = 1;", "nope")).toBeNull();
  });

  it("does not match a symbol whose name is merely a prefix of another", () => {
    const source = "export const userName = 1;\nexport const user = 2;\n";
    const span = findSymbol(source, "user");
    expect(span).not.toBeNull();
    // Word-boundary matching must select `user`, not `userName`.
    expect(source.slice(span?.declStart ?? 0, span?.declEnd ?? 0)).toContain("user = 2");
  });

  it("lists declared symbol names for a useful not-found message", () => {
    const names = listSymbolNames("export const a = 1;\nexport function b() {}\nclass C {}\n");
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("C");
  });

  it("is CRLF tolerant", () => {
    expect(findSymbol("export function f() {\r\n  return 1;\r\n}\r\n", "f")?.kind).toBe("function");
  });
});
