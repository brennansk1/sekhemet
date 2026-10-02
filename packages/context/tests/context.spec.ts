import { describe, expect, it } from "vitest";
import { extractSymbolOutline } from "../src/symbol_outline.js";

describe("@sekhemet/context", () => {
  it("extracts clean symbol outline from TypeScript source code", () => {
    const tsCode = `
import { Foo } from "./foo";

export interface UserConfig {
  id: string;
  name: string;
}

export class UserManager {
  constructor(private db: Database) {}

  public async getUser(id: string): Promise<UserConfig | null> {
    const row = await this.db.query("SELECT * FROM users WHERE id = ?", id);
    return row;
  }
}

export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}
`;

    const outline = extractSymbolOutline("src/user.ts", tsCode);
    expect(outline).toContain("src/user.ts");
    expect(outline).toContain("interface UserConfig");
    expect(outline).toContain("class UserManager");
    expect(outline).toContain("getUser(id: string): Promise<UserConfig | null>");
    expect(outline).toContain("function formatName(first: string, last: string): string");
    // Function body should be stripped/omitted
    expect(outline).not.toContain("SELECT * FROM users");
  });
});
