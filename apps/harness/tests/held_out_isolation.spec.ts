import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Measurement MS-T11-3: the held-out acceptance suite is never where a
// role's prompt could see it. A search test: no code that builds a prompt —
// the context, loop, planner, models, gates and harness sources, their copy
// modules included — names the held-out directory or asset, and nothing that
// prepares a run copies it. Only the scorer (packages/eval) reads it.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HELD_OUT = /held[_-]out|fixtures\/held|held-out-acceptance-suite/i;

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (e === "node_modules" || e === "dist") return [];
    return statSync(full).isDirectory() ? files(full, ext) : ext.test(e) ? [full] : [];
  });
}

/** Code without comments: a comment that mentions the suite reads nothing. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("the held-out suite stays out of every prompt (MS-T11-3)", () => {
  it("no prompt-building source or copy module names it", () => {
    const sources = [
      ...[
        "context",
        "loop",
        "planner",
        "models",
        "gates",
        "kernel",
        "board",
        "sync",
        "sandbox",
        "ui",
      ].flatMap((p) => files(join(ROOT, "packages", p, "src"), /\.ts$/)),
      ...files(join(ROOT, "apps", "harness", "src"), /\.ts$/),
    ];
    expect(sources.length).toBeGreaterThan(100);
    const naming = sources.filter((f) => HELD_OUT.test(code(readFileSync(f, "utf8"))));
    expect(naming.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("only the scorer reads it, and nothing that prepares a run copies it", () => {
    const readers = files(join(ROOT, "packages", "eval", "src"), /\.ts$/)
      .filter((f) => HELD_OUT.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f))
      .sort();
    expect(readers).toEqual([
      "packages/eval/src/eval_assets.ts",
      "packages/eval/src/planning_measure.ts",
    ]);
    for (const script of ["run_suite.mjs", "seed_project.mjs", "seed_chronicle.mjs"]) {
      expect(HELD_OUT.test(code(readFileSync(join(ROOT, "scripts", script), "utf8"))), script).toBe(
        false,
      );
    }
  });

  it("no frozen-suite fixture carries a held-out test", () => {
    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const heldOut = new Set(files(join(ROOT, "fixtures", "held_out"), /\.ts$/).map(sha));
    expect(heldOut.size).toBeGreaterThan(0);
    const suite = JSON.parse(readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8")) as {
      fixtures: { name: string }[];
    };
    for (const { name } of suite.fixtures) {
      const leaked = files(join(ROOT, "fixtures", name), /\.ts$/).filter((f) =>
        heldOut.has(sha(f)),
      );
      expect(leaked, name).toEqual([]);
    }
  });
});
