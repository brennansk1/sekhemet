import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, run as `node scripts/entry_points.mjs` and checked here.
import { analyze, renderMarkdown } from "../../../scripts/entry_points.mjs";

/**
 * The entry-point report (FINISH_LINE_PLAN C2d, §G 14; FINDINGS_C1 TST-01 and
 * SPEC-01): every criterion marked built is classified by the strongest door
 * a test reaches it through. The fixture holds one positive and one negative
 * case per class; the real repository may never gain a unit-only or no-test
 * built criterion above the recorded ceiling.
 */

type Built = { id: string; class: string; citedByTest: boolean };
type Report = {
  totals: Record<string, number>;
  built: Built[];
  conflicts: { id: string }[];
  orphans: { id: string }[];
  builtUncited: string[];
};

const ROOT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sek-ep-"));
  dirs.push(root);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
}

const SPEC = `# Demo

## 2. Behaviour

- **EPX-1** WHEN a person runs the command THE SYSTEM SHALL answer.
- **EPX-2** WHEN a function is called in process THE SYSTEM SHALL return.
- **EPX-3** WHEN the dispatcher runs the command THE SYSTEM SHALL answer.
- **EPX-4** WHEN Chrome is present THE SYSTEM SHALL draw the page.
- **EPX-5** WHEN nothing tests it THE SYSTEM SHALL still claim it.
- **EPX-6** WHEN the repository is scanned THE SYSTEM SHALL find no secret.
- **EPX-7** WHEN it is only partly built THE SYSTEM SHALL say so.
- **EPX-8** WHEN two rows disagree THE SYSTEM SHALL be a conflict.
- **EPX-9** WHEN no row cites it THE SYSTEM SHALL be an orphan.
- **EPX-10** WHEN a row names a file and no test cites the id THE SYSTEM SHALL link the file.
- **EPX-11** WHEN only a skipped test reaches the door THE SYSTEM SHALL be unit-only.
- **EPX-12** WHEN only the file header cites the id THE SYSTEM SHALL be a weak link.
- **EPX-13** WHEN a helper module spawns the binary THE SYSTEM SHALL count the helper.
- **EPX-14** WHEN the dispatcher and the binary both reach it THE SYSTEM SHALL be strict.
- **EPX-15** WHEN Chrome is required THE SYSTEM SHALL be strict.
- **EPX-16** WHEN the source is read THE SYSTEM SHALL be tested.
- **EPX-17** WHEN a row says "to -18" THE SYSTEM SHALL cite both.
- **EPX-18** WHEN it is the range's end THE SYSTEM SHALL be cited.
- **EPX-19** WHEN a row says "through EPX-20" THE SYSTEM SHALL cite both.
- **EPX-20** WHEN it is the range's end THE SYSTEM SHALL be cited.
- **EPX-21** WHEN a built row's Change cell names another id THE SYSTEM SHALL keep this one built.
- **EPX-22** WHEN only a Change cell names it THE SYSTEM SHALL read it as not built.
- **EPX-23** WHEN a row says "to 24 seconds" THE SYSTEM SHALL cite only this one.
- **EPX-24** WHEN a number follows "to" without a prefix THE SYSTEM SHALL not be cited.

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| The door (EPX-1–4) | built | cli.spec.ts | — |
| Unclaimed (EPX-5, EPX-6) | built | — | — |
| Partial thing (EPX-7) | partial | — | — |
| Agreement EPX-8 | built | — | — |
| Disagreement | partial | EPX-8 again. | — |
| Named file (EPX-10) | built | header.spec.ts | — |
| More (EPX-11..EPX-16) | built | — | — |
| Words (EPX-17 to -18) | built | — | — |
| Through (EPX-19 through EPX-20) | built | — | — |
| Done (EPX-21) | built | — | the rest, EPX-22 |
| Timeout (EPX-23) | built | it waits up to EPX-23 to 24 seconds | — |
`;

const SPAWN = `const BIN = "apps/harness/dist/index.js";\n`;

const FILES: Record<string, string> = {
  "docs/design/specs/demo.md": SPEC,
  "apps/harness/tests/cli.spec.ts": `${SPAWN}import { spawnSync } from "node:child_process";
it("EPX-1: answers through the binary", () => { spawnSync(process.execPath, [BIN, "ask"]); });
it("EPX-2: returns in process", () => { expect(add(1, 2)).toBe(3); });
// EPX-3
it("dispatches", async () => { await runWave2Command("release", ["confirm"]); });
describe.runIf(hasChrome)("EPX-4", () => {
  it("draws", async () => { await page.goto(url); });
});
describe("EPX-15", () => {
  it("draws", async () => { await page.goto(url); });
});
it("EPX-14 dispatch", async () => { await runWave2Command("x", []); });
it("EPX-14 binary", () => { spawnSync(process.execPath, [BIN, "x"]); });
it.skip("EPX-11 skipped door", () => { spawnSync(process.execPath, [BIN, "x"]); });
it("EPX-16 in process", () => { expect(scan()).toEqual([]); });
`,
  "apps/harness/tests/header.spec.ts": `${SPAWN}// This file covers EPX-12.
import { spawnSync } from "node:child_process";


it("a door", () => { spawnSync(process.execPath, [BIN, "x"]); });
it("a unit", () => { expect(1).toBe(1); });
`,
  "apps/harness/tests/helper_fixture.ts": `import { spawnSync } from "node:child_process";
export const BIN = "../dist/index.js";
export function sekhemet(args: string[]) { return spawnSync(process.execPath, [BIN, ...args]); }
`,
  "packages/demo/tests/helper.spec.ts": `import { sekhemet } from "../../../apps/harness/tests/helper_fixture.js";
it("EPX-13 through the helper", () => { sekhemet(["ask"]); });
`,
};

describe("the entry-point report", () => {
  const report = analyze(fixture(FILES)) as Report;
  const cls = (id: string) => report.built.find((b) => b.id === id)?.class;

  it.each([
    ["entry-strict", "EPX-1", "a test citing the id spawns the built binary"],
    ["entry-strict", "EPX-13", "the spawn is in a helper module the test imports"],
    ["entry-strict", "EPX-14", "a lenient and a strict test: the strict one wins"],
    ["entry-strict", "EPX-15", "a browser test under a plain describe"],
    ["entry-lenient", "EPX-3", "the only door is the in-process argv dispatcher"],
    ["entry-conditional", "EPX-4", "the only door runs under describe.runIf"],
    ["unit-only", "EPX-2", "the citing test calls a function in process"],
    ["unit-only", "EPX-10", "no test cites it; a door in the file its row names is a weak link"],
    ["unit-only", "EPX-11", "the only door is skipped"],
    ["unit-only", "EPX-12", "only a file header cites it, so the file's door is a weak link"],
    ["no-test", "EPX-5", "no test cites it and its row names no file"],
    ["n/a", "EPX-6", "a static property of the source"],
  ])("classifies %s: %s (%s)", (expected, id) => {
    expect(cls(id)).toBe(expected);
  });

  it("does not grant n/a or no-test to criteria that are not static or have tests", () => {
    expect(cls("EPX-16")).toBe("unit-only");
    expect(cls("EPX-2")).not.toBe("no-test");
  });

  it("counts only criteria a built row cites, and names conflicts and orphans (SPEC-01)", () => {
    expect(cls("EPX-7")).toBeUndefined();
    expect(cls("EPX-9")).toBeUndefined();
    expect(cls("EPX-8")).toBe("no-test");
    expect(report.conflicts.map((c) => c.id)).toEqual(["EPX-8"]);
    expect(report.orphans.map((o) => o.id)).toEqual(["EPX-9", "EPX-24"]);
    expect(report.builtUncited).toContain("EPX-10");
    expect(report.builtUncited).not.toContain("EPX-1");
  });

  it("expands the word ranges the specs use, but not a bare number after `to`", () => {
    for (const id of ["EPX-17", "EPX-18", "EPX-19", "EPX-20", "EPX-23"])
      expect(cls(id), id).toBe("no-test");
    expect(cls("EPX-24")).toBeUndefined();
  });

  it("reads an id in a row's Change cell as not built, never as built", () => {
    expect(cls("EPX-21")).toBe("no-test");
    expect(cls("EPX-22")).toBeUndefined();
    expect(report.orphans.map((o) => o.id)).not.toContain("EPX-22");
  });

  it("totals every class and renders a table per spec", () => {
    const sum = Object.values(report.totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.built.length);
    const md = renderMarkdown(report) as string;
    expect(md).toMatch(/^## demo\.md$/m);
    expect(md).toMatch(/\| EPX-1 \| entry-strict \|/);
  });
});

describe("the entry-point report over this repository (§G 14, SPEC-01)", () => {
  type Ceiling = { unitOnly: number; noTest: number; conflicts?: number; orphans?: number };
  const CEILING = "docs/reference/entry_points_ceiling.json";
  let report: Report & { criteria: number; builtCount: number; testFiles: number };
  beforeAll(() => {
    report = analyze(ROOT) as typeof report;
  }, 120_000);
  const measured = (): Ceiling => ({
    unitOnly: report.totals["unit-only"] as number,
    noTest: report.totals["no-test"] as number,
    conflicts: report.conflicts.length,
    orphans: report.orphans.length,
  });

  it("records exactly the tree's unit-only, no-test, conflict and orphan counts", () => {
    const ceiling = JSON.parse(readFileSync(join(ROOT, CEILING), "utf8")) as Ceiling;
    expect({
      unitOnly: ceiling.unitOnly,
      noTest: ceiling.noTest,
      conflicts: ceiling.conflicts,
      orphans: ceiling.orphans,
    }).toEqual(measured());
  });

  it("never records more than the merge base with main did: the counts only fall", () => {
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let before: Ceiling | undefined;
    try {
      const base = git("merge-base", "HEAD", "main").trim();
      before = JSON.parse(git("show", `${base}:${CEILING}`)) as Ceiling;
    } catch {
      before = undefined; // no main, or the file is new since the merge base
    }
    const now = JSON.parse(readFileSync(join(ROOT, CEILING), "utf8")) as Ceiling;
    for (const k of ["unitOnly", "noTest", "conflicts", "orphans"] as const) {
      const was = before?.[k];
      if (was !== undefined) expect(now[k], k).toBeLessThanOrEqual(was);
    }
  });

  it("has docs/reference/ENTRY_POINTS.md's totals, per-spec table and status sentence as the tree measures them", () => {
    // The sections that move with a criterion's class; the per-criterion
    // tables name test lines, which every edit to a test moves.
    const summary = (md: string) => {
      const lines = md.split("\n");
      const from = lines.indexOf("## Totals");
      const to = lines.indexOf("## Status truth (SPEC-01)");
      return [...lines.slice(from, to + 3)].filter((l) => !/test files read/.test(l)).join("\n");
    };
    const checkedIn = readFileSync(join(ROOT, "docs/reference/ENTRY_POINTS.md"), "utf8");
    expect(summary(checkedIn), "regenerate it: node scripts/entry_points.mjs").toBe(
      summary(renderMarkdown(report) as string),
    );
  });
});
