import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteFailures,
  finalizeFailures,
  importGraph,
  missingFailureFields,
  rankFailures,
} from "../src/rank.js";
import type { GateFailure, GateRung } from "../src/types.js";

// Gates rules 19-20; GT-M6-6 and GT-M6-7; F14 (the cap applied once, after
// every gate has reported).

const failure = (rung: GateRung, file: string, excerpt = `${rung} in ${file}`): GateFailure => ({
  rung,
  gate: rung,
  layer: "static",
  exitCode: 1,
  errorExcerpt: excerpt,
  suggestedFixFiles: [file],
  location: { file, line: 1 },
  expected: "no error",
  actual: excerpt,
  minimalRepro: `pnpm ${rung}`,
  suggestedAction: "Fix it.",
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** src/a.ts <- src/b.ts <- src/c.ts, and src/d.ts on its own. */
function chain(): string {
  const root = mkdtempSync(join(tmpdir(), "rank-"));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), 'import { a } from "./a.js";\nexport const b = a;\n');
  writeFileSync(
    join(root, "src", "c.ts"),
    'import { b } from "./b.js";\nimport type { X } from "./missing.js";\nexport const c = b;\n',
  );
  writeFileSync(join(root, "src", "d.ts"), 'import { readFileSync } from "node:fs";\n');
  return root;
}

describe("the import graph", () => {
  it("resolves relative imports to project files and ignores packages and missing files", () => {
    const graph = importGraph(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], chain());
    expect([...(graph.get("src/b.ts") ?? [])]).toEqual(["src/a.ts"]);
    expect([...(graph.get("src/c.ts") ?? [])]).toEqual(["src/b.ts"]);
    expect([...(graph.get("src/d.ts") ?? [])]).toEqual([]);
  });
});

describe("ranking (rule 20)", () => {
  it("puts a failure in an imported file before one in its importer (GT-M6-7)", () => {
    const root = chain();
    const ranked = rankFailures(
      [failure("typecheck", "src/b.ts"), failure("typecheck", "src/a.ts")],
      3,
      root,
    );
    expect(ranked.map((f) => f.location?.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("follows the import graph transitively", () => {
    const root = chain();
    const ranked = rankFailures(
      [failure("typecheck", "src/c.ts"), failure("typecheck", "src/a.ts")],
      3,
      root,
    );
    expect(ranked.map((f) => f.location?.file)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("orders by rung before the import graph", () => {
    const root = chain();
    const ranked = rankFailures(
      [failure("lint", "src/a.ts"), failure("test", "src/c.ts"), failure("typecheck", "src/b.ts")],
      3,
      root,
    );
    expect(ranked.map((f) => f.rung)).toEqual(["typecheck", "test", "lint"]);
  });

  it("breaks a tie in the graph by how many failures name the file", () => {
    const root = chain();
    const ranked = rankFailures(
      [
        failure("typecheck", "src/d.ts", "d once"),
        failure("typecheck", "src/a.ts", "a first"),
        failure("typecheck", "src/a.ts", "a second"),
      ],
      3,
      root,
    );
    expect(ranked.map((f) => f.errorExcerpt)).toEqual(["a first", "a second", "d once"]);
  });
});

describe("the cap is applied once, after every gate (F14)", () => {
  it("ranks declared and built-in failures together and keeps three", () => {
    const declared = [failure("typecheck", "src/a.ts")];
    const builtin = [
      failure("security", "src/x.ts"),
      failure("hygiene", "src/y.ts"),
      failure("robustness", "src/z.ts"),
    ];
    const shown = finalizeFailures([...builtin, ...declared], { limit: 3 });
    expect(shown).toHaveLength(3);
    expect(shown[0]?.rung).toBe("typecheck");
  });
});

describe("every failure is complete (GT-M6-6)", () => {
  it("names each missing or empty field", () => {
    const partial = { ...failure("test", "src/a.ts"), minimalRepro: "", suggestedAction: " " };
    expect(missingFailureFields(partial)).toEqual(["minimalRepro", "suggestedAction"]);
    const { location: _drop, ...rest } = failure("test", "src/a.ts");
    expect(missingFailureFields(rest as GateFailure)).toEqual(["location"]);
  });

  it("names an incomplete failure in the assertion used by tests", () => {
    const bad = { ...failure("test", "src/a.ts"), expected: "" };
    expect(() => assertCompleteFailures([bad], "the pipeline")).toThrow(
      /the pipeline: a test failure from gate test lacks expected/,
    );
  });

  it("fills an incomplete failure and records the defect, rather than throwing mid-turn", () => {
    const bad = { ...failure("test", "src/a.ts"), expected: "", minimalRepro: "" };
    const defects: string[] = [];
    const [f] = finalizeFailures([bad], { onIncomplete: (d) => defects.push(d) });
    expect(missingFailureFields(f ?? ({} as never))).toEqual([]);
    expect(f?.minimalRepro).toBe("check");
    expect(defects).toEqual(["a test failure from gate test lacks expected, minimalRepro"]);
  });
});

describe("what can hide and what must not (review of B2.3)", () => {
  it("ranks a gate that could not run after every real failure", () => {
    const notRun = { ...failure("typecheck", "."), gate: "secrets", notRun: true };
    const ranked = rankFailures([notRun, failure("lint", "src/a.ts")], 3);
    expect(ranked.map((f) => f.gate)).toEqual(["lint", "secrets"]);
  });

  it("gives no reference weight to the whole-change location", () => {
    const whole = (excerpt: string) => ({ ...failure("typecheck", "."), errorExcerpt: excerpt });
    const ranked = rankFailures([whole("a"), whole("b"), failure("typecheck", "src/x.ts", "x")], 3);
    // Counted, "." would weigh 2 and push the real file's failure last.
    expect(ranked.map((f) => f.errorExcerpt)).toEqual(["x", "a", "b"]);
  });

  it("keeps a slot for an integrity or secrets failure that three test failures would hide", () => {
    const tests = [1, 2, 3].map((n) => failure("test", `src/t${n}.ts`, `test ${n}`));
    const secret = { ...failure("security", "src/k.ts", "a credential"), gate: "secrets" };
    const shown = finalizeFailures([...tests, secret], { limit: 3 });
    expect(shown.map((f) => f.errorExcerpt)).toEqual(["test 1", "test 2", "a credential"]);
  });
});
