/**
 * Real tool output for the gate parsers (gates rule 23; GT-M6-1, GT-M6-2).
 *
 * Each `seed*` function writes a tiny, deliberately broken project into a
 * directory. `record()` runs the real tool on each one and stores what it
 * printed under `fixtures/<tool>/<case>.json`, with the project's directory
 * replaced by `$ROOT`. The parser tests read those recordings, and re-seed the
 * same project when a parser needs the files (a missing export's real exports)
 * or when the repro command has to be run for real.
 *
 * Record again after a tool upgrade:
 *   node packages/gates/tests/fixtures/real_tools.mjs
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..", "..", "..");
const BIN = join(REPO, "node_modules", ".bin");

/** The repository's own tools, by absolute path. */
export const TOOLS = {
  tsc: join(REPO, "node_modules", "typescript", "bin", "tsc"),
  vitest: join(REPO, "node_modules", "vitest", "vitest.mjs"),
  biome: join(BIN, "biome"),
};

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Node's type declarations, linked from the repository's pnpm store. */
function linkNodeTypes(root) {
  const store = join(REPO, "node_modules", ".pnpm");
  const dir = readdirSync(store)
    .filter((d) => d.startsWith("@types+node@"))
    .sort()
    .pop();
  if (!dir) throw new Error("no @types/node in the pnpm store");
  mkdirSync(join(root, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(store, dir, "node_modules", "@types", "node"),
    join(root, "node_modules", "@types", "node"),
  );
}

/**
 * A TypeScript project with one error of each kind the remedies answer:
 * a missing export (relative and package, and one tsc answers with "did you
 * mean", TS2724), an unknown name that another
 * module exports, an unknown member (of a project type and of a package
 * type), an unknown literal property, and a plain type mismatch. `src/ledger.ts` imports `src/types.ts`, and both fail,
 * so the import-graph order can be checked on real output (GT-M6-7).
 */
export function seedTsc(root) {
  write(root, {
    "package.json": '{ "name": "seed-tsc", "type": "module", "private": true }\n',
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    "src/types.ts": [
      "export interface Entry {",
      "  id: number;",
      "  amount: number;",
      "  note?: string;",
      "}",
      "",
      "export function makeEntry(id: number, amount: number): Entry {",
      "  return { id, amount };",
      "}",
      "",
      'export const total: number = "zero";',
      "",
    ].join("\n"),
    "src/ledger.ts": [
      'import { type Entry, Ledger } from "./types.js";',
      'import { DatabaseSync, OpenDatabase } from "node:sqlite";',
      'import type { Entri } from "./types.js";',
      "",
      "export function first(entries: Entry[]): number {",
      "  const e = makeEntry(1, 2);",
      "  return e.amout + entries.length;",
      "}",
      "",
      "export function second(entry: Entry): number {",
      "  return entry.amout;",
      "}",
      "",
      "export const sample: Entry = { id: 1, amount: 2, extra: true };",
      "export const db = new DatabaseSync(':memory:');",
      "db.execute('select 1');",
      "export type Unused = Ledger | OpenDatabase | Entri;",
      "",
    ].join("\n"),
  });
  linkNodeTypes(root);
}

/** A Vitest project with two tests in one file, one of them failing. */
export function seedVitest(root) {
  write(root, {
    "package.json": '{ "name": "seed-vitest", "type": "module", "private": true }\n',
    "src/ledger.js": "export function add(a, b) {\n  return a + b + 1;\n}\n",
    "tests/ledger.spec.js": [
      'import { describe, expect, it } from "vitest";',
      'import { add } from "../src/ledger.js";',
      "",
      'describe("ledger", () => {',
      '  it("adds two amounts", () => {',
      "    expect(add(1, 1)).toBe(2);",
      "  });",
      "",
      '  it("keeps a string as it is", () => {',
      '    expect(String("a")).toBe("a");',
      "  });",
      "});",
      "",
    ].join("\n"),
  });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    realpathSync(join(REPO, "node_modules", "vitest")),
    join(root, "node_modules", "vitest"),
  );
}

/** A file with Biome diagnostics: `==`, a needless template, and formatting. */
export function seedBiome(root) {
  write(root, {
    "package.json": '{ "name": "seed-biome", "private": true }\n',
    "src/a.ts": [
      "export function same(a: number, b: number): boolean {",
      "  const unused = 1;",
      "  return a == b;",
      "}",
      "",
      "export const label = `plain`;",
      "",
    ].join("\n"),
  });
}

/** A Rust crate with one failing test and one passing test. */
export function seedCargo(root) {
  write(root, {
    "Cargo.toml":
      '[package]\nname = "seed_cargo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    "src/lib.rs": [
      "pub fn add(a: i32, b: i32) -> i32 {",
      "    a + b + 1",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "",
      "    #[test]",
      "    fn adds_two_amounts() {",
      "        assert_eq!(add(1, 1), 2);",
      "    }",
      "",
      "    #[test]",
      "    fn keeps_zero() {",
      "        assert_eq!(0, 0);",
      "    }",
      "}",
      "",
    ].join("\n"),
  });
}

/** Each recorded case: the seed, the command and its arguments. */
export const CASES = [
  {
    tool: "tsc",
    name: "errors",
    seed: seedTsc,
    command: process.execPath,
    args: [TOOLS.tsc, "-p", "tsconfig.json"],
    repro: "pnpm typecheck",
  },
  {
    tool: "vitest",
    name: "json_one_failing",
    seed: seedVitest,
    command: process.execPath,
    args: [TOOLS.vitest, "run", "--reporter=json"],
    repro: "pnpm test",
  },
  {
    tool: "vitest",
    name: "text_one_failing",
    seed: seedVitest,
    command: process.execPath,
    args: [TOOLS.vitest, "run"],
    repro: "pnpm test",
  },
  {
    tool: "biome",
    name: "check_text",
    seed: seedBiome,
    command: TOOLS.biome,
    args: ["check", "."],
    repro: "pnpm lint",
  },
  {
    tool: "cargo",
    name: "test_one_failing",
    seed: seedCargo,
    command: "cargo",
    args: ["test", "--offline", "--quiet"],
    repro: "cargo test",
  },
];

/** Run one case in a fresh directory; the directory is replaced by `$ROOT`. */
export function runCase(c) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sekhemet-${c.tool}-`)));
  try {
    c.seed(root);
    const r = spawnSync(c.command, c.args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "1",
        CARGO_TARGET_DIR: join(root, "target"),
      },
    });
    const scrub = (s) =>
      (s ?? "")
        .split(root)
        .join("$ROOT")
        .replaceAll("/private$ROOT", "$ROOT")
        .split(REPO)
        .join("$REPO");
    return {
      tool: c.tool,
      case: c.name,
      command: [c.command === process.execPath ? "node" : c.command, ...c.args]
        .map((a) => a.replace(REPO, "$REPO"))
        .join(" "),
      repro: c.repro,
      exitCode: r.status ?? -1,
      stdout: scrub(r.stdout),
      stderr: scrub(r.stderr),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function version(command, args) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
}

export function record() {
  const versions = {
    tsc: version(process.execPath, [TOOLS.tsc, "--version"]),
    vitest: version(process.execPath, [TOOLS.vitest, "--version"]),
    biome: version(TOOLS.biome, ["--version"]),
    cargo: version("cargo", ["--version"]),
  };
  for (const c of CASES) {
    if (c.tool === "cargo" && !version("cargo", ["--version"])) continue;
    const out = runCase(c);
    const dir = join(HERE, c.tool);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${c.name}.json`),
      `${JSON.stringify({ ...out, version: versions[c.tool] }, null, 2)}\n`,
    );
    process.stdout.write(`${c.tool}/${c.name}: exit ${out.exitCode}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) record();
