import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { cardGateRunner } from "../src/card_gates.js";
import { CARD_ONE_LABEL } from "../src/card_zero.js";

// design-stage DS-P2-3 in the product: card one's functional gate is its own —
// it passes only when card one's test runs and fails at an assertion, judged
// by `checkCardOne` through the project's test gate — in place of the unit
// gate, which a red test could never pass. Every other card keeps the unit
// gate. Real git, real processes, the repository's own Vitest; nothing is
// downloaded.

const REPO = resolve(__dirname, "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sek-card1-")));
  dirs.push(root);
  const vitest = join(REPO, "node_modules", ".bin", "vitest");
  write(
    root,
    ".sekhemet/gates.toml",
    [
      "[[gate]]",
      'id = "unit"',
      'rung = "test"',
      'layer = "functional"',
      `command = ${JSON.stringify(vitest)}`,
      `args = ["run", "--root", ${JSON.stringify(root)}]`,
      'parser = "vitest"',
      "timeout_s = 120",
      "",
    ].join("\n"),
  );
  write(root, ".gitignore", "node_modules\n");
  write(root, "package.json", JSON.stringify({ name: "calc", type: "module" }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  write(
    root,
    "src/calc.ts",
    "export function add(a: number, b: number): number {\n  return 0;\n}\n",
  );
  write(
    root,
    "tests/first.test.ts",
    'import { expect, it } from "vitest";\nimport { add } from "../src/calc.js";\nit("adds two numbers", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
  );
  return root;
}

const runner = (root: string, labels: string[]) =>
  cardGateRunner({
    repoPath: root,
    gatesConfig: loadGatesConfig(root),
    restricted: false,
    // Card one's test is in its scope, written by its Worker (DS-P2-3).
    card: { labels, scopeFiles: ["tests/first.test.ts"] },
  });

describe("card one's functional gate (DS-P2-3)", () => {
  it("passes a test that runs and fails at an assertion, where the unit gate fails it", async () => {
    const root = project();
    const one = await runner(root, [CARD_ONE_LABEL]).runGates(["test"], root);
    expect(one.passed).toBe(true);
    expect(one.rungResults?.some((o) => o.gate === "card-one" && o.passed)).toBe(true);
    expect(one.rungResults?.some((o) => o.gate === "unit")).toBe(false);
    // Any other card: the same red test fails its unit gate.
    const other = await runner(root, []).runGates(["test"], root);
    expect(other.passed).toBe(false);
  }, 120_000);

  it("fails a green test and a test that fails at its import, naming why", async () => {
    const root = project();
    write(
      root,
      "src/calc.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    const green = await runner(root, [CARD_ONE_LABEL]).runGates(["test"], root);
    expect(green.passed).toBe(false);
    expect(green.failures.find((f) => f.gate === "card-one")?.suggestedFixFiles).toEqual([
      "tests/first.test.ts",
    ]);
    rmSync(join(root, "src/calc.ts"));
    const broken = await runner(root, [CARD_ONE_LABEL]).runGates(["test"], root);
    expect(broken.passed).toBe(false);
    expect(broken.failures.find((f) => f.gate === "card-one")?.errorExcerpt).toMatch(/import/);
  }, 120_000);
});
