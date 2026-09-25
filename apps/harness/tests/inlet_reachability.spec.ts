import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Measurement MS-T8-8: the eval package holds no inlet function that no
// command reaches — each is wired into one of the six inlets or cut as dead
// code (DEC-09). A search test over comment-stripped source: the roots are
// the names the harness's command modules use; an eval export is reached when
// a root names it or the body of a reached eval export does. Every exported
// function or class of the inlet modules must be reached.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const INLET_MODULES = ["loops.ts", "synthesis.ts", "history.ts", "mutation.ts", "guardrails.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.ts$/.test(e) && !/\.(spec|test)\.ts$/.test(e) ? [full] : [];
  });
}

/** Source without comments, so a name in a docstring reaches nothing. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const words = (text: string) => new Set(text.match(/\b[A-Za-z_]\w*\b/g) ?? []);

describe("every eval inlet function is reachable from a command (MS-T8-8)", () => {
  // Roots: every name the harness's commands use.
  const roots = new Set<string>();
  for (const f of sources(join(ROOT, "apps", "harness", "src"))) {
    for (const w of words(stripComments(readFileSync(f, "utf8")))) roots.add(w);
  }
  // Each eval export's body, by name.
  const bodies = new Map<string, string>();
  for (const f of sources(join(ROOT, "packages", "eval", "src"))) {
    const text = stripComments(readFileSync(f, "utf8"));
    const parts = text.split(/^(?=export )/m);
    for (const part of parts) {
      const name = /^export (?:async )?(?:function|class|const) ([A-Za-z_]\w*)/.exec(part)?.[1];
      if (name) bodies.set(name, part);
    }
  }
  const reached = new Set<string>();
  const queue = [...roots].filter((n) => bodies.has(n));
  while (queue.length) {
    const name = queue.pop() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    for (const w of words(bodies.get(name) ?? "")) {
      if (w !== name && bodies.has(w) && !reached.has(w)) queue.push(w);
    }
  }

  it("strips comments before looking", () => {
    expect(stripComments("// usesX\nconst a = 1; /* usesY */ const u = 'http://x';")).toBe(
      "\nconst a = 1;  const u = 'http://x';",
    );
  });

  for (const mod of INLET_MODULES) {
    const text = stripComments(readFileSync(join(ROOT, "packages", "eval", "src", mod), "utf8"));
    const names = [
      ...text.matchAll(/^export (?:async )?(?:function|class|const) ([A-Za-z_]\w*)/gm),
    ].map((m) => m[1] as string);

    it(`${mod}: its ${names.length} exported function(s) are reached from a command`, () => {
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => !reached.has(n))).toEqual([]);
    });
  }
});
