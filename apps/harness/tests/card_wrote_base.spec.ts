import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { architectureGate } from "../src/architecture_gate.js";
import { cardGateRunner, gateBaseBranch } from "../src/card_gates.js";

// NEW-gates-2 (gates rules 15, 16): the project gates judge the card against
// the configured integration branch, never a hard-coded `main` (GT-N2-3),
// and see the files the card created and has not committed (GT-N2-4). Real
// git repositories.

const GATES = `[[gate]]
id = "lint"
rung = "lint"
command = "sh"
args = ["-c", "exit 0"]
parser = "generic"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(branch: string, files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "card-wrote-base-")));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", branch);
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
  return root;
}

const BASE_TEST =
  'import { expect, it } from "vitest";\nit("keeps", () => { expect(1 + 1).toBe(2); });\n';

describe("the configured base (GT-N2-3)", () => {
  it("refuses a removed base test when the integration branch is master, named by base_branch", async () => {
    const root = repo("master", {
      ".sekhemet/gates.toml": `[project]\nbase_branch = "master"\n\n${GATES}`,
      "src/a.ts": "export const a = 1;\n",
      "tests/keep.spec.ts": BASE_TEST,
    });
    rmSync(join(root, "tests", "keep.spec.ts"));
    const gatesConfig = loadGatesConfig(root);
    expect(gateBaseBranch(root, gatesConfig)).toBe("master");
    const r = await cardGateRunner({
      repoPath: root,
      gatesConfig,
      restricted: false,
      card: {},
    }).runGates(["lint"], root);
    expect(r.passed).toBe(false);
    const regression = r.failures.find((f) => f.gate === "regression");
    expect(regression?.location.file).toBe("tests/keep.spec.ts");
    expect(regression?.errorExcerpt).toContain("master");
  });

  it("takes the project's integration branch when gates.toml names none", async () => {
    const root = repo("trunk", {
      ".sekhemet/gates.toml": GATES,
      ".sekhemet/config.toml": '[review]\nintegration_branch = "trunk"\n',
      "tests/keep.spec.ts": BASE_TEST,
    });
    writeFileSync(join(root, "tests", "keep.spec.ts"), "");
    const gatesConfig = loadGatesConfig(root);
    expect(gateBaseBranch(root, gatesConfig)).toBe("trunk");
    const r = await cardGateRunner({
      repoPath: root,
      gatesConfig,
      restricted: false,
      card: {},
    }).runGates(["lint"], root);
    expect(r.failures.some((f) => f.gate === "regression")).toBe(true);
  });
});

describe("files the card created and did not commit (GT-N2-4)", () => {
  const BRIEF = "# Brief\n\n## Invariants\n\n- `src/db/` does not import `src/cli.ts`\n";

  it("fails the architecture gate on a new untracked file that breaks an invariant", () => {
    const root = repo("main", {
      ".sekhemet/brief.md": BRIEF,
      "src/cli.ts": "export const cli = 1;\n",
      "src/db/store.ts": "export const store = 1;\n",
    });
    writeFileSync(
      join(root, "src", "db", "new.ts"),
      'import { cli } from "../cli.js";\nexport const n = cli;\n',
    );
    const failures = architectureGate(root, { base: "main" });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.location.file).toBe("src/db/new.ts");
  });

  it("does not judge an ignored file", () => {
    const root = repo("main", {
      ".sekhemet/brief.md": BRIEF,
      ".gitignore": "src/db/gen/\n",
      "src/cli.ts": "export const cli = 1;\n",
    });
    mkdirSync(join(root, "src", "db", "gen"), { recursive: true });
    writeFileSync(join(root, "src", "db", "gen", "x.ts"), 'import { cli } from "../../cli.js";\n');
    expect(architectureGate(root, { base: "main" })).toEqual([]);
  });
});
