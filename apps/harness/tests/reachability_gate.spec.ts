import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GateRunner, declaredStage } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import {
  findUnreachable,
  reachabilityGate,
  withReachabilityGate,
} from "../src/reachability_gate.js";

/**
 * A repository at a committed base, so a card's changes can be judged
 * against it the way the gate judges a card's branch.
 */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

const write = (root: string, file: string, body: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), body);
};

describe("the reachability gate", () => {
  it("passes a leaf whose exports the acceptance contract requires", () => {
    // Leaves are built before their callers. The hasher card adds functions
    // the ledger card uses later; at the moment it completes, only its own
    // acceptance test requires them — and that is enough.
    const root = repo({
      "acceptance/hasher.spec.ts": 'import { hashEvent } from "../src/hasher.js";\n',
      "src/hasher.ts": "",
    });
    write(root, "src/hasher.ts", "export function hashEvent() { return ''; }\n");
    expect(findUnreachable(root)).toEqual([]);
  });

  it("fails an export nothing uses and nothing requires", () => {
    // The pattern that produced eleven dead modules while building this
    // harness: written, tested, never wired in.
    const root = repo({
      "acceptance/hasher.spec.ts": 'import { hashEvent } from "../src/hasher.js";\n',
      "src/hasher.ts": "",
    });
    write(
      root,
      "src/hasher.ts",
      "export function hashEvent() { return ''; }\nexport function unusedHelper() {}\n",
    );
    expect(findUnreachable(root)).toEqual([{ file: "src/hasher.ts", name: "unusedHelper" }]);
  });

  it("counts production imports as use", () => {
    const root = repo({ "src/util.ts": "", "src/app.ts": "" });
    write(root, "src/util.ts", "export const pad = 1;\n");
    write(root, "src/app.ts", 'import { pad } from "./util.js";\nconsole.log(pad);\n');
    expect(findUnreachable(root)).toEqual([]);
  });

  it("does not count a card's own unit tests as use", () => {
    // "Code reachable only from tests is DEAD" — the audit's own rule. A unit
    // test that is not part of the acceptance contract proves nothing wires
    // the code in.
    const root = repo({ "src/util.ts": "" });
    write(root, "src/util.ts", "export const pad = 1;\n");
    write(root, "tests/util.spec.ts", 'import { pad } from "../src/util.js";\n');
    expect(findUnreachable(root)).toEqual([{ file: "src/util.ts", name: "pad" }]);
  });

  it("judges only exports this card added, never code someone else left", () => {
    const root = repo({ "src/old.ts": "export const legacy = 1;\n" });
    write(root, "src/old.ts", "export const legacy = 1;\nexport const fresh = 2;\n");
    expect(findUnreachable(root).map((d) => d.name)).toEqual(["fresh"]);
  });

  it("treats an entry point's exports as a public surface", () => {
    const root = repo({ "src/index.ts": "" });
    write(root, "src/index.ts", "export const api = 1;\n");
    expect(findUnreachable(root)).toEqual([]);
  });

  it("counts an export the card's own spec asked for", () => {
    // Found by the harness's own suite: "Write src/a.ts exporting a" has asked
    // for `a` before any test or caller exists, and failing that card would
    // mean the gate refused the very thing it was built to deliver.
    const root = repo({ "src/a.ts": "" });
    write(root, "src/a.ts", "export const a = 1;\nexport const extra = 2;\n");
    expect(findUnreachable(root, "main", { text: "Write src/a.ts exporting a." })).toEqual([
      { file: "src/a.ts", name: "extra" },
    ]);
  });

  it("counts the card's declared acceptance tests without an acceptance/ directory", () => {
    const root = repo({ "src/a.ts": "" });
    write(root, "src/a.ts", "export const pad = 1;\n");
    write(root, "tests/a.spec.ts", 'import { pad } from "../src/a.js";\n');
    expect(findUnreachable(root, "main", { tests: ["a.spec.ts"] })).toEqual([]);
  });

  it("gives a remedy the model can complete in one step", () => {
    const root = repo({ "src/util.ts": "" });
    write(root, "src/util.ts", "export const pad = 1;\n");
    const [f] = reachabilityGate(root);
    expect(f?.gate).toBe("reachability");
    expect(f?.suggestedAction).toMatch(/wire it into/);
    expect(f?.suggestedAction).toMatch(/remove the export/);
  });

  // GT-T2-1: the regex reader saw neither form (gates review F2, reproduced).
  it("counts an export used only as `ns.name` through `import * as ns` (GT-T2-1)", () => {
    const root = repo({ "src/util.ts": "", "src/app.ts": "" });
    write(root, "src/util.ts", "export const pad = 1;\nexport const unused = 2;\n");
    write(root, "src/app.ts", 'import * as util from "./util.js";\nconsole.log(util.pad);\n');
    expect(findUnreachable(root)).toEqual([{ file: "src/util.ts", name: "unused" }]);
  });

  it("counts every export of a module whose namespace is used whole (GT-T2-1)", () => {
    const root = repo({ "src/util.ts": "", "src/app.ts": "" });
    write(root, "src/util.ts", "export const pad = 1;\nexport const trim = 2;\n");
    write(root, "src/app.ts", 'import * as util from "./util.js";\nregister(util);\n');
    expect(findUnreachable(root)).toEqual([]);
  });

  it("counts an export re-exported through `export *` from an entry point (GT-T2-1)", () => {
    const root = repo({ "src/index.ts": "", "src/util.ts": "" });
    write(root, "src/index.ts", 'export * from "./util.js";\n');
    write(root, "src/util.ts", "export const pad = 1;\n");
    expect(findUnreachable(root)).toEqual([]);
  });

  it("follows `export *` through a barrel that is not itself an entry point (GT-T2-1)", () => {
    const root = repo({ "src/index.ts": "", "src/lib/all.ts": "", "src/lib/util.ts": "" });
    write(root, "src/index.ts", 'export * from "./lib/all.js";\n');
    write(root, "src/lib/all.ts", 'export * from "./util.js";\n');
    write(root, "src/lib/util.ts", "export const pad = 1;\n");
    expect(findUnreachable(root)).toEqual([]);
  });

  // GT-IX-1: a verdict read from a file the parser had to recover is not a pass.
  const passing: GateRunner = {
    runGates: async () => ({ passed: true, failures: [], durationMs: 0, rungResults: [] }),
  };

  it("reports `partial` naming a file it read from a recovered parse, never a pass (GT-IX-1)", async () => {
    // Someone else's file, broken at the base: its uses cannot be trusted.
    const root = repo({
      "src/util.ts": "",
      "src/app.ts": 'import { pad } from "./util.js";\nlog(pad;\n',
    });
    write(root, "src/util.ts", "export const pad = 1;\n");
    const r = await withReachabilityGate(passing).runGates(["test"], root);
    const outcome = r.rungResults?.find((o) => o.gate === "reachability");
    expect(outcome?.partial).toEqual([
      { file: "src/app.ts", reason: expect.stringMatching(/^line \d+: /) },
    ]);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.note).toMatch(/partial: src\/app\.ts/);
    // Review M2: not the card's file, so nothing for the Worker to repair —
    // a named failure routed to a person, never an unnamed one.
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      gate: "reachability",
      forPerson: true,
      location: { file: "src/app.ts" },
    });
    expect(r.failures[0]?.notRun).toBeUndefined();
    // Through the pipeline it stays a named, partial failure, never "unavailable".
    const stage = await declaredStage(withReachabilityGate(passing), ["test"], root).run({
      passed: true,
    });
    const piped = stage.outcomes.find((o) => o.gate === "reachability");
    expect(piped?.unavailable).toBeUndefined();
    expect(piped?.partial?.[0]?.file).toBe("src/app.ts");
    expect(stage.failures.map((f) => f.forPerson)).toEqual([true]);
  });

  it("forgives a partial on a file the onboarding baseline recorded, and lists it (M2)", async () => {
    const root = repo({
      "src/util.ts": "",
      "src/app.ts": 'import { pad } from "./util.js";\nlog(pad;\n',
    });
    write(root, "src/util.ts", "export const pad = 1;\n");
    const baselinePartial = [{ file: "src/app.ts", reason: "line 2: ')' expected." }];
    const r = await withReachabilityGate(passing, {}, "main", { baselinePartial }).runGates(
      ["test"],
      root,
    );
    const outcome = r.rungResults?.find((o) => o.gate === "reachability");
    expect(r.failures).toEqual([]);
    expect(outcome?.passed).toBe(true);
    expect(outcome?.partial).toEqual([
      { file: "src/app.ts", reason: expect.stringMatching(/^line \d+: /), baselined: true },
    ]);
    expect(outcome?.note).toMatch(/onboarding baseline/);
  });

  it("fails a changed file it cannot parse cleanly, with the syntax error to fix (GT-IX-1)", async () => {
    const root = repo({ "src/util.ts": "" });
    write(root, "src/util.ts", "export const pad = (;\n");
    const r = await withReachabilityGate(passing).runGates(["test"], root);
    expect(r.passed).toBe(false);
    const [f] = r.failures;
    expect(f?.location?.file).toBe("src/util.ts");
    expect(f?.suggestedAction).toMatch(/syntax error/);
    expect(r.rungResults?.find((o) => o.gate === "reachability")?.partial?.[0]?.file).toBe(
      "src/util.ts",
    );
  });

  it("counts a workspace package's declared entry point as a public surface (IX-5)", () => {
    const root = repo({
      "package.json": '{ "name": "root", "private": true }\n',
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": '{ "name": "@x/a", "version": "1.0.0", "main": "./src/api.ts" }\n',
      "packages/a/src/api.ts": "",
      "packages/a/src/util.ts": "",
    });
    write(root, "packages/a/src/api.ts", 'export * from "./util.js";\n');
    write(root, "packages/a/src/util.ts", "export const pad = 1;\n");
    expect(findUnreachable(root)).toEqual([]);
  });

  it("still fails an export only a non-entry barrel re-exports and nothing imports", () => {
    const root = repo({ "src/lib/all.ts": "", "src/lib/util.ts": "" });
    write(root, "src/lib/all.ts", 'export * from "./util.js";\n');
    write(root, "src/lib/util.ts", "export const pad = 1;\n");
    expect(findUnreachable(root)).toEqual([{ file: "src/lib/util.ts", name: "pad" }]);
  });
});
