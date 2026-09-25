import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultParserRegistry } from "../src/parsers.js";
import { missingFailureFields, rankFailures } from "../src/rank.js";
import type { GateDefinition, GateFailure, GateLayer, GateRung } from "../src/types.js";
// @ts-expect-error: a plain ESM script shared with the recorder.
import { TOOLS, seedCargo, seedTsc, seedVitest } from "./fixtures/real_tools.mjs";

// Gates rules 19, 21-23; GT-M6-1, GT-M6-2, GT-M6-3, GT-M6-6, GT-M6-7. Every
// parser is tested against output the real tool printed (fixtures/, recorded
// by fixtures/real_tools.mjs), never against output written by hand.

interface Recording {
  tool: string;
  case: string;
  command: string;
  repro: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const recording = (tool: string, name: string): Recording =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", tool, `${name}.json`), "utf8"));

const gate = (id: string, rung: GateRung, layer: GateLayer, parser: string): GateDefinition => ({
  id,
  rung,
  layer,
  command: "pnpm",
  args: [id],
  timeoutMs: 60_000,
  parser,
  blocking: true,
});

const dirs: string[] = [];
function seeded(seed: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gates-real-")));
  dirs.push(root);
  seed(root);
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function parse(
  rec: Recording,
  def: GateDefinition,
  cwd: string,
  minimalRepro = rec.repro,
): GateFailure[] {
  const fill = (s: string) => s.replaceAll("$ROOT", cwd);
  return defaultParserRegistry.parse({
    gate: def,
    exitCode: rec.exitCode,
    stdout: fill(rec.stdout),
    stderr: fill(rec.stderr),
    minimalRepro,
    cwd,
  });
}

const sh = (command: string, cwd: string) =>
  spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1", CARGO_TARGET_DIR: join(cwd, "target") },
  });

const byCode = (failures: GateFailure[], code: string) =>
  failures.find((f) => f.actual?.startsWith(`${code}:`));

describe("tsc on real output (GT-M6-2, GT-M6-3)", () => {
  const typecheck = gate("typecheck", "typecheck", "static", "tsc");

  it("gives one complete failure per diagnostic, located in the project", () => {
    const root = seeded(seedTsc);
    const failures = parse(recording("tsc", "errors"), typecheck, root);
    expect(failures).toHaveLength(8);
    for (const f of failures) {
      expect(missingFailureFields(f), f.errorExcerpt).toEqual([]);
      expect(f.location?.file).toMatch(/^src\/(ledger|types)\.ts$/);
      expect(f.location?.line).toBeGreaterThan(0);
    }
  });

  it("lists a relative module's real exports for TS2305", () => {
    const failures = parse(recording("tsc", "errors"), typecheck, seeded(seedTsc));
    const f = failures.find((x) => x.actual?.includes("'Ledger'"));
    expect(f?.suggestedAction).toContain("src/types.ts does not export Ledger");
    expect(f?.suggestedAction).toContain("Entry, makeEntry, total");
  });

  it("lists a package's real exports for TS2305", () => {
    const failures = parse(recording("tsc", "errors"), typecheck, seeded(seedTsc));
    const f = failures.find((x) => x.actual?.includes("'OpenDatabase'"));
    expect(f?.suggestedAction).toContain("node:sqlite does not export OpenDatabase");
    expect(f?.suggestedAction).toContain("DatabaseSync");
    expect(f?.suggestedAction).toContain("StatementSync");
  });

  it("lists a module's real exports for TS2724, as real tsc prints it", () => {
    const f = byCode(parse(recording("tsc", "errors"), typecheck, seeded(seedTsc)), "TS2724");
    expect(f?.actual).toContain("has no exported member named 'Entri'");
    expect(f?.suggestedAction).toContain("src/types.ts does not export Entri");
    expect(f?.suggestedAction).toContain("Entry, makeEntry, total");
  });

  it("names the module that exports an unknown name for TS2304", () => {
    const f = byCode(parse(recording("tsc", "errors"), typecheck, seeded(seedTsc)), "TS2304");
    expect(f?.suggestedAction).toContain("src/types.ts exports makeEntry");
    expect(f?.suggestedAction).toContain('import { makeEntry } from "./types.js";');
  });

  it("lists the real members for TS2551, TS2353 and a package type's TS2339", () => {
    const failures = parse(recording("tsc", "errors"), typecheck, seeded(seedTsc));
    expect(byCode(failures, "TS2551")?.suggestedAction).toContain(
      "Its members are exactly: amount, id, note",
    );
    expect(byCode(failures, "TS2353")?.suggestedAction).toContain(
      "Its members are exactly: amount, id, note",
    );
    const member = byCode(failures, "TS2339")?.suggestedAction ?? "";
    expect(member).toContain("DatabaseSync has no member execute");
    expect(member).toMatch(/\bexec\b.*\bprepare\b/);
  });

  it("never tells the model to read a file to find exports or members", () => {
    const failures = parse(recording("tsc", "errors"), typecheck, seeded(seedTsc));
    for (const code of ["TS2305", "TS2724", "TS2304", "TS2339", "TS2353", "TS2551"]) {
      for (const f of failures.filter((x) => x.actual?.startsWith(`${code}:`))) {
        expect(f.suggestedAction, code).not.toMatch(/\bread\b/i);
      }
    }
  });

  it("ranks the imported file's failure before the importer's within the rung (GT-M6-7)", () => {
    const root = seeded(seedTsc);
    const ranked = rankFailures(parse(recording("tsc", "errors"), typecheck, root), 3, root);
    expect(ranked[0]?.location?.file).toBe("src/types.ts");
  });
});

describe("vitest on real output (GT-M6-1)", () => {
  const unit = gate("unit", "test", "functional", "vitest");
  const vitestRun = `node ${TOOLS.vitest} run`;

  for (const name of ["json_one_failing", "text_one_failing"]) {
    it(`${name}: one failing test is one complete failure at the test's line`, () => {
      const failures = parse(recording("vitest", name), unit, seeded(seedVitest));
      expect(failures).toHaveLength(1);
      const [f] = failures;
      expect(missingFailureFields(f as GateFailure)).toEqual([]);
      expect(f?.location).toEqual({ file: "tests/ledger.spec.js", line: 6, column: 23 });
      expect(f?.expected).toBe("2");
      expect(f?.actual).toBe("3");
      expect(f?.minimalRepro).toBe("pnpm test tests/ledger.spec.js -t '^ledger adds two amounts$'");
    });

    it(`${name}: the repro selects the failing test and exits non-zero`, () => {
      const root = seeded(seedVitest);
      const [f] = parse(recording("vitest", name), unit, root, vitestRun);
      const r = sh(f?.minimalRepro ?? "false", root);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/Tests\s+1 failed \| 1 skipped \(2\)/);
    });
  }
});

describe("biome on real output (GT-M6-2)", () => {
  it("gives a complete failure for each lint and format diagnostic", () => {
    const failures = parse(
      recording("biome", "check_text"),
      gate("lint", "lint", "static", "biome"),
      seeded(() => undefined),
    );
    expect(failures.map((f) => f.actual)).toEqual([
      "Use === instead of ==",
      "Do not use template literals if interpolation and special-character handling are not needed.",
      "Formatter would have printed the following content:",
    ]);
    for (const f of failures) {
      expect(missingFailureFields(f), f.errorExcerpt).toEqual([]);
      expect(f.location?.file).toBe("src/a.ts");
    }
    expect(failures.map((f) => f.location?.line)).toEqual([3, 6, 1]);
  });
});

describe("cargo test on real output (GT-M6-2)", () => {
  const unit = gate("unit", "test", "functional", "cargo");

  it("gives one complete failure at the panic, with left and right", () => {
    const failures = parse(recording("cargo", "test_one_failing"), unit, seeded(seedCargo));
    expect(failures).toHaveLength(1);
    const [f] = failures;
    expect(missingFailureFields(f as GateFailure)).toEqual([]);
    expect(f?.location).toEqual({ file: "src/lib.rs", line: 11, column: 9 });
    expect(f?.expected).toBe("2");
    expect(f?.actual).toBe("3");
    expect(f?.minimalRepro).toBe("cargo test tests::adds_two_amounts -- --exact");
  });

  it.runIf(sh("cargo --version", tmpdir()).status === 0)(
    "the repro runs only the failing test and exits non-zero",
    () => {
      const root = seeded(seedCargo);
      const [f] = parse(recording("cargo", "test_one_failing"), unit, root, "cargo test --offline");
      const r = sh(f?.minimalRepro ?? "false", root);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/test result: FAILED\. 0 passed; 1 failed/);
    },
    120_000,
  );
});
