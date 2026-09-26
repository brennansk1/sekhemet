import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { bundledSemgrepRuleSet, ruleSetLabel } from "../src/semgrep_rules.js";
import type { GateProjectConfig } from "../src/types.js";

// GT-N5-4 (DEC-44): a project with no .sekhemet/semgrep.yml is scanned with
// the rule set shipped with Sekhemet, offline, and the evidence names the
// rule set's version. semgrep is not installed here: a fake program, run
// through the real confinement, checks the rules it was handed.

const project: GateProjectConfig = { protected: [], maxFiles: 3, maxDiffLines: 200 };

describe.runIf(platform() === "darwin")("the bundled semgrep rule set (GT-N5-4)", () => {
  let root: string;
  let bin: string;
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const diff = () => {
    git("add", "-A");
    return git("diff", "--cached", "--unified=0", "main");
  };
  /** A fake semgrep: exits 7 unless `--config` names a readable copy of the bundled rules. */
  function fakeSemgrep(): string {
    const path = join(bin, "semgrep");
    writeFileSync(
      path,
      `#!/bin/sh
cfg=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--config" ]; then cfg="$a"; fi
  prev="$a"
  last="$a"
done
grep -q '"ruleset": "sekhemet-offline"' "$cfg" || exit 7
printf '%s' '{"results":[{"check_id":"sekhemet.js-eval-dynamic","path":"'"$last"'","start":{"line":2},"extra":{"message":"eval of a dynamic string","severity":"ERROR"}}],"errors":[]}'
exit 1
`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "semgrep-bundled-"));
    bin = mkdtempSync(join(tmpdir(), "semgrep-bin-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.js"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "card");
    writeFileSync(join(root, "a.js"), "export const a = 1;\nexport const run = (s) => eval(s);\n");
  });
  afterEach(() => {
    for (const d of [root, bin]) rmSync(d, { recursive: true, force: true });
  });

  it("scans with the bundled rules when the project has none, and names their version", async () => {
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["semgrep"],
      programs: { semgrep: [fakeSemgrep()] },
    });
    const o = r.outcomes.find((x) => x.gate === "semgrep");
    expect(o?.skipped).toBeUndefined();
    expect(o?.passed).toBe(false);
    const set = bundledSemgrepRuleSet();
    expect(o?.note).toBe(`semgrep rules: ${ruleSetLabel(set)}`);
    expect(o?.note).toContain(set.version);
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      "a.js:2 sekhemet.js-eval-dynamic: eval of a dynamic string",
    ]);
  }, 60_000);

  it("uses the project's own rules as the base holds them, and says so", async () => {
    // The project's rules are on the base, committed before the card.
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "semgrep.yml"), "rules: [] # the base's\n");
    git("add", ".sekhemet/semgrep.yml");
    git("commit", "-q", "-m", "rules");
    git("branch", "-f", "main", "card");
    const clean = join(bin, "semgrep");
    writeFileSync(
      clean,
      `#!/bin/sh
cfg=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--config" ]; then cfg="$a"; fi
  prev="$a"
done
grep -q "the base's" "$cfg" || exit 7
printf '%s' '{"results":[],"errors":[]}'
`,
    );
    chmodSync(clean, 0o755);
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["semgrep"],
      programs: { semgrep: [clean] },
    });
    const o = r.outcomes.find((x) => x.gate === "semgrep");
    expect(r.failures).toEqual([]);
    expect(o).toMatchObject({
      passed: true,
      note: "semgrep rules: .sekhemet/semgrep.yml (the project's, as the base holds it)",
    });
  }, 60_000);

  it("a card cannot silence a finding with its own semgrep.yml", async () => {
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    writeFileSync(join(root, ".sekhemet", "semgrep.yml"), "rules: []\n");
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["semgrep"],
      programs: { semgrep: [fakeSemgrep()] },
    });
    expect(r.outcomes.find((x) => x.gate === "semgrep")?.note).toBe(
      `semgrep rules: ${ruleSetLabel(bundledSemgrepRuleSet())}`,
    );
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      "a.js:2 sekhemet.js-eval-dynamic: eval of a dynamic string",
    ]);
  }, 60_000);

  it("a card cannot silence a finding with a nosemgrep comment", async () => {
    writeFileSync(
      join(root, "a.js"),
      "export const a = 1;\nexport const run = (s) => eval(s); // nosemgrep\n",
    );
    // Like semgrep: a `nosemgrep` comment hides the finding unless --disable-nosem is given.
    const path = join(bin, "semgrep");
    writeFileSync(
      path,
      `#!/bin/sh
nosem=on
for a in "$@"; do
  if [ "$a" = "--disable-nosem" ]; then nosem=off; fi
  last="$a"
done
if [ "$nosem" = on ] && grep -q nosemgrep "$last"; then printf '%s' '{"results":[],"errors":[]}'; exit 0; fi
printf '%s' '{"results":[{"check_id":"sekhemet.js-eval-dynamic","path":"'"$last"'","start":{"line":2},"extra":{"message":"eval of a dynamic string","severity":"ERROR"}}],"errors":[]}'
exit 1
`,
    );
    chmodSync(path, 0o755);
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      gates: ["semgrep"],
      programs: { semgrep: [path] },
    });
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      "a.js:2 sekhemet.js-eval-dynamic: eval of a dynamic string",
    ]);
  }, 60_000);
});
