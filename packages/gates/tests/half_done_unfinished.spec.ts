import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanUnfinished } from "../src/half_done.js";

/**
 * DS-TO-8 (design-stage §2.10 step 3): the take-over's half-done detectors
 * beyond stubs and skipped tests — a route or control with no handler, an
 * import of a module that does not exist, and a schema with no migration
 * that creates it. Deterministic, reading files only.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "half-done-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const at = (f: { file: string; line: number; kind: string }) => `${f.file}:${f.line}:${f.kind}`;

describe("DS-TO-8: routes with no handler, missing imports, schemas with no migration", () => {
  it("finds a route registered with no handler, and one whose handler is never defined", () => {
    const root = repo({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "src/server.ts": [
        'import express from "express";',
        "const app = express();",
        'app.get("/health", (_req, res) => res.send("ok"));',
        'app.post("/export");',
        'app.get("/report", buildReport);',
        "function listUsers() {}",
        'app.get("/users", listUsers);',
        "export default app;",
        "",
      ].join("\n"),
      "src/ui.tsx": [
        "export const Save = () => <button onClick={handleSave}>Save</button>;",
        "export const Ok = ({ onOk }: { onOk: () => void }) => <button onClick={onOk}>Ok</button>;",
        "",
      ].join("\n"),
    });
    const found = scanUnfinished(root, ["src/server.ts", "src/ui.tsx"]).filter(
      (f) => f.kind === "no_handler",
    );
    expect(found.map(at)).toEqual([
      "src/server.ts:4:no_handler",
      "src/server.ts:5:no_handler",
      "src/ui.tsx:1:no_handler",
    ]);
  });

  it("finds a relative import of a file that does not exist and a package no manifest declares", () => {
    const root = repo({
      "package.json": JSON.stringify({ dependencies: { zod: "3" } }),
      "src/a.ts": [
        'import { readFileSync } from "node:fs";',
        'import path from "path";',
        'import { z } from "zod";',
        'import { b } from "./b.js";',
        'import { pdf } from "./pdf/render.js";',
        'import { left } from "left-pad-pro";',
        'export type T = typeof import("./types");',
        "export const x = [readFileSync, path, z, b, pdf, left];",
        "",
      ].join("\n"),
      "src/b.ts": "export const b = 1;\n",
      "src/types/index.ts": "export type A = 1;\n",
      "app/mod.py": "from .helpers import go\nfrom .missing_mod import nope\n",
      "app/helpers.py": "def go():\n    pass\n",
    });
    const found = scanUnfinished(root, ["src/a.ts", "src/b.ts", "app/mod.py"]).filter(
      (f) => f.kind === "missing_import",
    );
    expect(found.map(at)).toEqual([
      "app/mod.py:2:missing_import",
      "src/a.ts:5:missing_import",
      "src/a.ts:6:missing_import",
    ]);
    expect(found.find((f) => f.file === "src/a.ts" && f.line === 5)?.detail).toContain(
      "./pdf/render.js",
    );
  });

  it("finds a schema table no migration creates, and none when a migration creates it", () => {
    const root = repo({
      "prisma/schema.prisma": [
        "model User {",
        "  id Int @id",
        "}",
        "",
        "model Invoice {",
        "  id Int @id",
        "}",
        "",
      ].join("\n"),
      "prisma/migrations/20240101_init/migration.sql": 'CREATE TABLE "User" ("id" INTEGER);\n',
      "src/db/schema.ts": [
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";',
        'export const orders = sqliteTable("orders", { id: integer("id") });',
        'export const refunds = sqliteTable("refunds", { id: integer("id") });',
        "",
      ].join("\n"),
      "drizzle/0000_init.sql": "CREATE TABLE IF NOT EXISTS `orders` (`id` integer);\n",
    });
    const found = scanUnfinished(root, [
      "prisma/schema.prisma",
      "prisma/migrations/20240101_init/migration.sql",
      "src/db/schema.ts",
      "drizzle/0000_init.sql",
    ]).filter((f) => f.kind === "no_migration");
    expect(found.map(at)).toEqual([
      "prisma/schema.prisma:5:no_migration",
      "src/db/schema.ts:3:no_migration",
    ]);
  });

  it("reports no schema finding when the repository has no schema at all", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    expect(scanUnfinished(root, ["src/a.ts"])).toEqual([]);
  });
});
