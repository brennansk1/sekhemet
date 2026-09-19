import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, shared with vitest.config.ts.
import { isIntegrationSpec, splitSpecs } from "../../../scripts/test_split.mjs";
import { runWave2Command } from "../src/wave2.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;

describe("X23: test:unit and test:integration", () => {
  it("splits every spec into exactly one suite by what it touches", () => {
    const s = splitSpecs(ROOT) as { unit: string[]; integration: string[] };
    expect(s.unit.filter((f) => s.integration.includes(f))).toEqual([]);
    expect(s.integration).toContain("apps/harness/tests/e2e_lifecycle.spec.ts");
    expect(s.integration).toContain("packages/eval/tests/fixture_repo.spec.ts");
    expect(s.unit).toContain("packages/context/tests/condenser.spec.ts");
    expect(isIntegrationSpec('execFileSync("git", ["init"])')).toBe(true);
    expect(isIntegrationSpec("const db = new DatabaseSync(':memory:')")).toBe(false);
    expect(scripts["test:unit"]).toBe("vitest run --project unit");
    expect(scripts["test:integration"]).toBe("vitest run --project integration");
  });
});

describe("X22: kernel and board tests use real SQLite files (DoD 2.A.1)", () => {
  it("no kernel or board spec opens an in-memory database", () => {
    const offenders: string[] = [];
    for (const pkg of ["kernel", "board"]) {
      const dir = join(ROOT, "packages", pkg, "tests");
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const text = readFileSync(join(dir, f), "utf8");
        if (/DatabaseSync\(\s*["']:memory:["']/.test(text)) offenders.push(`${pkg}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("X24: pnpm dev", () => {
  it("builds, then watches the build and runs the dashboard from it", () => {
    expect(scripts.dev).toBe("node scripts/dev.mjs");
    const out = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/dev.mjs"), "--dry-run", "--port", "4999"],
      { encoding: "utf8" },
    ).split("\n");
    expect(out[0]).toMatch(/tsc -b$/);
    expect(out[1]).toMatch(/tsc -b --watch/);
    expect(out[2]).toMatch(/--watch .*apps\/harness\/dist\/index\.js serve --repo .* --port 4999$/);
  });
});

describe("X21: sekhemet fixture", () => {
  it("writes a miniature repository from the generator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-fixcli-"));
    const lines: string[] = [];
    const k = { repoPath: dir } as never;
    expect(
      await runWave2Command("fixture", ["rust", join(dir, "r")], k, {
        print: (l) => lines.push(l),
      }),
    ).toBe(0);
    expect(existsSync(join(dir, "r", "Cargo.toml"))).toBe(true);
    expect(lines[0]).toMatch(/Wrote a rust fixture/);
    expect(await runWave2Command("fixture", ["cobol", dir], k, { print: () => undefined })).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
