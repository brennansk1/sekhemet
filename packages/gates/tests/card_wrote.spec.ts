import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { loadGatesConfig } from "../src/config.js";
import type { GateProjectConfig } from "../src/types.js";

// NEW-gates-2 (gates rules 15-17): judge only what the card wrote — a
// vulnerability the base already had is not the card's (GT-N2-1), a missing
// changelog entry outside the card's scope is an advisory (GT-N2-2), and the
// base is the configured branch (`base_branch`, GT-N2-3). Real git, and a
// scanner run as a real subprocess.

const project: GateProjectConfig = { protected: [], maxFiles: 3, maxDiffLines: 200 };

let root: string;
let bin: string;
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const diff = () => {
  git("add", "-A");
  return git("diff", "--cached", "--unified=0", "main");
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "card-wrote-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "card-wrote-bin-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
});
afterEach(() => {
  for (const d of [root, bin]) rmSync(d, { recursive: true, force: true });
});

/**
 * An osv-scanner stand-in: it reads the lockfile it is given and reports
 * every `vulnerable-*` or `evil-*` package in it, as osv-scanner's JSON does.
 */
function fakeOsv(): string {
  const path = join(bin, "osv-scanner");
  writeFileSync(
    path,
    `#!/bin/sh
f=""
while [ $# -gt 0 ]; do [ "$1" = "--lockfile" ] && f="$2"; shift; done
out=""; sep=""
for p in $(grep -oE '(vulnerable|evil)-[a-z]+@[0-9.]+' "$f"); do
  n=\${p%@*}; v=\${p#*@}
  out="$out$sep{\\"package\\":{\\"name\\":\\"$n\\",\\"version\\":\\"$v\\"},\\"vulnerabilities\\":[{\\"id\\":\\"GHSA-$n\\"}]}"
  sep=","
done
echo "{\\"results\\":[{\\"packages\\":[$out]}]}"
[ -n "$out" ] && exit 1
exit 0
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function seedLock(lock: string): void {
  writeFileSync(join(root, "package-lock.json"), lock);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
}

const osvRun = async () =>
  runBuiltinGates({
    root,
    base: "main",
    diff: diff(),
    project,
    gates: ["osv"],
    programs: { "osv-scanner": [fakeOsv()] },
  });

describe("vulnerabilities the card added, not the base's (GT-N2-1)", () => {
  it("passes when the base already had a vulnerable dependency and the card adds none", async () => {
    seedLock('{ "deps": ["vulnerable-left@1.0.0"] }\n');
    writeFileSync(
      join(root, "package-lock.json"),
      '{ "deps": ["vulnerable-left@1.0.0", "safe-right@2.0.0"] }\n',
    );
    const r = await osvRun();
    const osv = r.outcomes.find((o) => o.gate === "osv");
    expect(osv).toMatchObject({ passed: true });
    expect(osv?.skipped).toBeUndefined();
    expect(r.failures).toEqual([]);
    // The base's copy of the lockfile is the harness's: nothing is left behind.
    expect(readdirSync(root).sort()).toEqual([".git", "a.ts", "package-lock.json"]);
  });

  it("fails on exactly the vulnerable dependency the card added", async () => {
    seedLock('{ "deps": ["vulnerable-left@1.0.0"] }\n');
    writeFileSync(
      join(root, "package-lock.json"),
      '{ "deps": ["vulnerable-left@1.0.0", "evil-pkg@0.1.0"] }\n',
    );
    const r = await osvRun();
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.errorExcerpt).toContain("evil-pkg@0.1.0");
    expect(r.failures[0]?.errorExcerpt).not.toContain("vulnerable-left");
  });

  it("sees a changed lockfile the attributes mark -diff, which the text diff shows only as binary", async () => {
    writeFileSync(join(root, ".gitattributes"), "package-lock.json -diff\n");
    seedLock('{ "deps": ["vulnerable-left@1.0.0"] }\n');
    writeFileSync(
      join(root, "package-lock.json"),
      '{ "deps": ["vulnerable-left@1.0.0", "evil-pkg@0.1.0"] }\n',
    );
    expect(diff()).not.toContain("evil-pkg");
    const r = await osvRun();
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      expect.stringContaining("evil-pkg@0.1.0"),
    ]);
  });

  it("scans every lockfile the card changed, nested ones too, each against its own base", async () => {
    mkdirSync(join(root, "packages", "x"), { recursive: true });
    writeFileSync(join(root, "yarn.lock"), "vulnerable-left@1.0.0\n");
    writeFileSync(join(root, "packages", "x", "package-lock.json"), '{ "deps": [] }\n');
    seedLock('{ "deps": ["safe-left@1.0.0"] }\n');
    writeFileSync(join(root, "package-lock.json"), '{ "deps": ["safe-left@1.0.1"] }\n');
    writeFileSync(join(root, "yarn.lock"), "vulnerable-left@1.0.0\nevil-yarn@0.2.0\n");
    writeFileSync(
      join(root, "packages", "x", "package-lock.json"),
      '{ "deps": ["evil-nested@0.3.0"] }\n',
    );
    const r = await osvRun();
    const found = r.failures.map((f) => `${f.location.file}: ${f.errorExcerpt}`).sort();
    expect(found).toEqual([
      expect.stringMatching(/^packages\/x\/package-lock\.json: evil-nested@0\.3\.0/),
      expect.stringMatching(/^yarn\.lock: evil-yarn@0\.2\.0/),
    ]);
    expect(readdirSync(root).sort()).toEqual([
      ".git",
      "a.ts",
      "package-lock.json",
      "packages",
      "yarn.lock",
    ]);
  });

  it("records a skip, never a pass, when the card changed no lockfile", async () => {
    seedLock('{ "deps": ["vulnerable-left@1.0.0"] }\n');
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    const r = await osvRun();
    expect(r.outcomes.find((o) => o.gate === "osv")).toMatchObject({
      skipped: true,
      reason: "the card changed no lockfile",
    });
    expect(r.failures).toEqual([]);
  });
});

describe("a changelog entry only when CHANGELOG.md is the card's (GT-N2-2)", () => {
  beforeEach(() => {
    writeFileSync(join(root, "CHANGELOG.md"), "# Changes\n");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "card");
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  });

  it("reports a missing entry as an advisory when CHANGELOG.md is outside the card's scope", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, changelog: "advisory" },
      gates: ["hygiene"],
    });
    expect(r.failures.filter((f) => /CHANGELOG/.test(f.errorExcerpt))).toEqual([]);
    expect(r.advisories.join("\n")).toMatch(/CHANGELOG\.md/);
  });

  it("still fails a card whose scope holds CHANGELOG.md and wrote no entry", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["hygiene"],
    });
    expect(r.failures.some((f) => /CHANGELOG/.test(f.errorExcerpt))).toBe(true);
  });
});

describe("the base branch (GT-N2-3)", () => {
  it("reads `base_branch` from gates.toml", () => {
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "gates.toml"), '[project]\nbase_branch = "master"\n');
    expect(loadGatesConfig(root).project.baseBranch).toBe("master");
  });

  it("warns on a base_branch that is not a branch name, and ignores it", () => {
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "gates.toml"), '[project]\nbase_branch = "-x --exec"\n');
    const c = loadGatesConfig(root);
    expect(c.project.baseBranch).toBeUndefined();
    expect((c.warnings ?? []).join("\n")).toContain("base_branch");
  });
});
