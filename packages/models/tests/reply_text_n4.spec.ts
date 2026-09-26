import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { extractJsonObject, stripReasoning } from "../src/index.js";

// MD-N4-8: reasoning is stripped once, in the adapter, and every caller reads
// JSON from a reply through one extraction helper.

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Files not yet on the one path, and why; the list may only shrink. */
const NOT_YET: Record<string, string> = {
  "apps/harness/src/learning/reflect.ts":
    "half 1's learning files: three greedy JSON regexes and <think> strips",
  "apps/harness/src/learning/review.ts":
    "half 1's learning files: one greedy JSON regex and a <think> strip",
};

describe("MD-N4-8: one strip, one JSON helper", () => {
  it("strips a closed block, an unterminated one, and reasoning that only closes (a template opened it)", () => {
    expect(stripReasoning("<think>a {x}</think>answer")).toBe("answer");
    expect(stripReasoning("answer<think>cut off")).toBe("answer");
    expect(stripReasoning("planning {1}\n</think>\nanswer")).toBe("answer");
  });

  it("reads the first balanced JSON object, never a greedy span", () => {
    expect(extractJsonObject('Sure: {"a": {"b": 1}} and later {"c": 2}')).toEqual({ a: { b: 1 } });
    expect(extractJsonObject('{"s": "a } in a string"}')).toEqual({ s: "a } in a string" });
    expect(extractJsonObject("no json")).toBeUndefined();
    expect(extractJsonObject('{"a": 1,}')).toEqual({ a: 1 });
  });

  it("no source outside the models package strips <think> or reads JSON with a greedy regex", () => {
    const hits = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          if (
            /<think>\[\\s\\S\]|\/<\\\/think>|lastIndexOf\("<\/think>"\)|\/\\\{\[\\s\\S\]\*\\\}\//.test(
              text,
            )
          )
            hits.add(relative(ROOT, p));
        }
      }
    };
    walk(join(ROOT, "apps", "harness", "src"));
    for (const pkg of ["planner", "loop", "eval", "board", "context", "gates"])
      walk(join(ROOT, "packages", pkg, "src"));
    expect([...hits].filter((f) => !(f in NOT_YET)).sort()).toEqual([]);
    expect(Object.keys(NOT_YET).filter((f) => !hits.has(f))).toEqual([]);
  });
});
