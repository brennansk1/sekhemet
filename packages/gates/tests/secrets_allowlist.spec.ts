import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/config.js";
import { gitleaksAllowedPaths, scanSecrets } from "../src/secrets.js";

// GT-N5-4's fixtures hold documented example credentials (AWS's example key
// id, private-key header lines). Sekhemet's own secret scan — the built-in
// rules and gitleaks — reads one allowlist, the repository's `.gitleaks.toml`
// from the base branch, so the harness's repository does not flag itself and
// a card cannot allowlist the credential it adds.

const REPO = join(import.meta.dirname, "..", "..", "..");
const FIXTURES = "packages/gates/rules/semgrep/fixtures";
// An AWS key id gitleaks flags (its rule allowlists AWS's documented
// `…EXAMPLE` id), built at run time so this file holds none.
const AWS_KEY = `AWS_ACCESS_KEY_ID = "${"ASIA"}Y34FZKBOKMUTVV7A"\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Sekhemet's own repository allowlists the bundled rules' fixtures", () => {
  it("every fixture with an example credential is found by the rules and allowlisted by .gitleaks.toml", () => {
    const allowed = gitleaksAllowedPaths(readFileSync(join(REPO, ".gitleaks.toml"), "utf8"));
    expect(allowed.length).toBeGreaterThan(0);
    const flagged = readdirSync(join(REPO, FIXTURES))
      .map((f) => `${FIXTURES}/${f}`)
      .filter((path) => scanSecrets(readFileSync(join(REPO, path), "utf8"), path).length > 0);
    // Not vacuous: the fixtures do hold what the scan flags.
    expect(flagged).toEqual(
      expect.arrayContaining([
        `${FIXTURES}/hardcoded-aws-access-key-id.py`,
        `${FIXTURES}/hardcoded-private-key.ts`,
      ]),
    );
    for (const path of flagged)
      expect(
        allowed.some((r) => r.test(path)),
        path,
      ).toBe(true);
    expect(allowed.some((r) => r.test("packages/gates/src/secrets.ts"))).toBe(false);
  });

  it("reads gitleaks' [allowlist] and [[allowlists]] paths, and nothing from an unreadable file", () => {
    expect(
      gitleaksAllowedPaths(
        "[[allowlists]]\npaths = ['''a/''']\n[[allowlists]]\npaths = ['''b/''']\n",
      ).map((r) => r.source),
    ).toEqual(["a\\/", "b\\/"]);
    expect(gitleaksAllowedPaths("not = [toml")).toEqual([]);
    expect(gitleaksAllowedPaths(undefined)).toEqual([]);
  });
});

describe("the secrets gate on a card's diff honours the base's .gitleaks.toml", () => {
  function repoWithAllowlist(): string {
    const root = mkdtempSync(join(tmpdir(), "secrets-allowlist-"));
    dirs.push(root);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@t.t");
    copyFileSync(join(REPO, ".gitleaks.toml"), join(root, ".gitleaks.toml"));
    writeFileSync(join(root, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return root;
  }
  const diffOf = (root: string) => {
    execFileSync("git", ["add", "-A"], { cwd: root });
    return execFileSync("git", ["diff", "--cached", "--unified=0", "main"], {
      cwd: root,
      encoding: "utf8",
    });
  };
  const gate = (root: string) =>
    runBuiltinGates({
      root,
      base: "main",
      diff: diffOf(root),
      project: { ...DEFAULT_PROJECT_CONFIG },
      gates: ["secrets"],
      which: () => false,
    });
  const add = (root: string, path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  it("passes an AWS key id in the fixtures path, and fails it anywhere else", async () => {
    const root = repoWithAllowlist();
    add(root, `${FIXTURES}/new-rule.py`, AWS_KEY);
    expect((await gate(root)).failures).toEqual([]);
    add(root, "src/settings.py", AWS_KEY);
    const r = await gate(root);
    expect(r.failures.map((f) => f.location?.file)).toEqual(["src/settings.py"]);
  });

  it("does not let a card allowlist its own credential in the same change", async () => {
    const root = repoWithAllowlist();
    add(root, ".gitleaks.toml", "[extend]\nuseDefault = true\n[allowlist]\npaths = ['''src/''']\n");
    add(root, "src/settings.py", AWS_KEY);
    expect((await gate(root)).failures.map((f) => f.gate)).toEqual(["secrets"]);
  });
});
