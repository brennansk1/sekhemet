import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnreachable, reachabilityGate } from "../src/reachability_gate.js";

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
});
