import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/repo_map.js";

/**
 * The repo map carries the data contract a card builds on. Suite run 5's
 * vault card used a column, `created_at`, the table does not have: the map
 * showed `openVaultDb(path): DatabaseSync` but not the schema db.ts creates,
 * and `SecretRecord` by name but not its fields. Meanwhile half the map was
 * other cards' future tests, each "(no exports)".
 */
describe("the repo map carries the data contract", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "repomap-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "acceptance"));
    writeFileSync(
      join(root, "src", "types.ts"),
      "export interface SecretRecord {\n  project: string;\n  key: string;\n  createdAt: number;\n}\n",
    );
    writeFileSync(
      join(root, "src", "db.ts"),
      [
        'import { DatabaseSync } from "node:sqlite";',
        "export function openVaultDb(path: string): DatabaseSync {",
        "  const db = new DatabaseSync(path);",
        "  db.exec(`CREATE TABLE IF NOT EXISTS secrets (",
        "    project TEXT NOT NULL,",
        "    key TEXT NOT NULL,",
        "    created INTEGER NOT NULL",
        "  )`);",
        "  return db;",
        "}",
      ].join("\n"),
    );
    writeFileSync(join(root, "src", "vault.ts"), "");
    writeFileSync(join(root, "acceptance", "cli.spec.ts"), "it('x', () => {});\n");
    return root;
  };

  it("shows interface fields, not just the name", () => {
    const map = buildRepoMap(repo(), ["src/vault.ts"]);
    expect(map).toContain("createdAt: number;");
  });

  it("shows the schema a module creates", () => {
    const map = buildRepoMap(repo(), ["src/vault.ts"]);
    expect(map).toMatch(
      /CREATE TABLE IF NOT EXISTS secrets \(\s*project TEXT NOT NULL,\s*key TEXT NOT NULL,\s*created INTEGER NOT NULL\s*\)/,
    );
  });

  it("keeps the scope file and drops files with nothing to offer", () => {
    const map = buildRepoMap(repo(), ["src/vault.ts"]);
    expect(map).toContain("src/vault.ts");
    expect(map).not.toContain("acceptance/cli.spec.ts");
  });

  it("is byte-stable across calls, so the prompt stays cacheable", () => {
    const root = repo();
    expect(buildRepoMap(root, ["src/vault.ts"])).toBe(buildRepoMap(root, ["src/vault.ts"]));
  });
});
