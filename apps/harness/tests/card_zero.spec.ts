import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { designStage } from "@sekhemet/planner";
import { confinedSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  CARD_ONE_LABEL,
  CARD_ZERO_LABEL,
  afterCardZero,
  cardOneCard,
  cardOneVerdict,
  cardZeroCard,
  checkCardOne,
  generatorFor,
  installScaffoldGate,
  scaffoldCheck,
  stepLine,
} from "../src/card_zero.js";

/**
 * design-stage §2.4, DS-P2-1..3: card zero is the ecosystem's own generator,
 * run as a card; its gate checks what the generator left and, once it is
 * done, the project's gates are derived from that output and the generator
 * and its version are written into the brief. Card one is a test whose gate
 * passes only when the test runs and fails at an assertion. Real files, real
 * processes, the repository's own Vitest; nothing is downloaded.
 */

const REPO = resolve(__dirname, "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function dir(prefix = "sek-card0-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** What `npm init -y`, the installs, `tsc --init` and `npm pkg set` leave. */
function typescriptScaffold(root: string) {
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "calc",
      version: "1.0.0",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5.9.2", vitest: "^3.2.7" },
    }),
  );
  write(root, "package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  write(root, "node_modules/typescript/package.json", JSON.stringify({ version: "5.9.2" }));
  write(root, "node_modules/vitest/package.json", JSON.stringify({ version: "3.2.7" }));
}

/** What `uv init` and `uv add --dev pytest` leave. */
function pythonScaffold(root: string) {
  write(
    root,
    "pyproject.toml",
    '[project]\nname = "renamer"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n\n[dependency-groups]\ndev = ["pytest>=8.3.4"]\n',
  );
  write(root, ".python-version", "3.12\n");
  write(
    root,
    "uv.lock",
    'version = 1\nrequires-python = ">=3.12"\n\n[[package]]\nname = "pytest"\nversion = "8.3.4"\nsource = { registry = "https://pypi.org/simple" }\n',
  );
  write(root, "main.py", 'def main():\n    print("Hello from renamer!")\n');
}

/** Run the scaffold gate exactly as `gates.toml` declares it. */
function runScaffoldGate(root: string): number {
  const cfg = loadGatesConfig(root);
  const gate = cfg.gates.find((g) => g.id === "scaffold");
  if (!gate) throw new Error("no scaffold gate");
  const r = spawnSync(gate.command, gate.args, { cwd: root, encoding: "utf8" });
  return r.status ?? 1;
}

describe("DS-P2-1: a TypeScript project's card zero runs npm init, tsc --init and Vitest", () => {
  it("is a card whose steps are the ecosystem generator's own commands", () => {
    const design = designStage("build me a calculator", { greenfield: true });
    const g = generatorFor(design.stack.language);
    const lines = g.steps.map(stepLine);
    expect(lines[0]).toBe("npm init -y");
    expect(lines).toContain("npm install --save-dev typescript vitest");
    expect(lines).toContain("npx tsc --init");
    const card = cardZeroCard(design.stack.language);
    expect(card.labels).toContain(CARD_ZERO_LABEL);
    for (const l of lines) expect(card.spec).toContain(l);
    expect(card.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("its gate fails before the generator ran and passes on what it leaves", () => {
    const root = dir();
    expect(installScaffoldGate(root, "typescript")).toBe("written");
    expect(runScaffoldGate(root)).not.toBe(0);
    expect(scaffoldCheck(root, "typescript").missing).toContain("tsconfig.json");
    typescriptScaffold(root);
    expect(scaffoldCheck(root, "typescript")).toEqual({ ok: true, missing: [] });
    expect(runScaffoldGate(root)).toBe(0);
  });

  it("once done, derives the gates from its output and records the generator and its version", () => {
    const root = dir();
    installScaffoldGate(root, "typescript");
    write(root, ".sekhemet/brief.md", "# Brief: a calculator\n\n## Constraints\n- TypeScript.\n");
    typescriptScaffold(root);
    const out = afterCardZero(root, "typescript");
    expect(out.state).toBe("derived");
    const ids = loadGatesConfig(root).gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["typecheck", "unit"]));
    expect(ids).not.toContain("scaffold");
    const unit = loadGatesConfig(root).gates.find((g) => g.id === "unit");
    expect(unit?.parser).toBe("vitest");
    const brief = readFileSync(join(root, ".sekhemet/brief.md"), "utf8");
    expect(brief).toContain(
      "Generator: npm init, tsc --init and Vitest (TypeScript 5.9.2, Vitest 3.2.7)",
    );
    // Again: nothing changes, and the brief says it once.
    expect(afterCardZero(root, "typescript").state).toBe("already");
    expect(
      readFileSync(join(root, ".sekhemet/brief.md"), "utf8").match(/Generator:/g),
    ).toHaveLength(1);
  });

  it("does nothing while the generator's output is missing, and never over a person's gates", () => {
    const root = dir();
    installScaffoldGate(root, "typescript");
    expect(afterCardZero(root, "typescript").state).toBe("incomplete");
    const mine = dir();
    write(mine, ".sekhemet/gates.toml", "[project]\nmax_files = 3\n");
    expect(installScaffoldGate(mine, "typescript")).toBe("kept");
    typescriptScaffold(mine);
    expect(afterCardZero(mine, "typescript").state).toBe("kept");
    expect(readFileSync(join(mine, ".sekhemet/gates.toml"), "utf8")).toBe(
      "[project]\nmax_files = 3\n",
    );
  });
});

describe("DS-P2-2: a Python project's card zero runs uv init", () => {
  it("runs uv init and derives the gates from its output", () => {
    const g = generatorFor("python");
    expect(g.steps.map((s) => [s.command, ...s.args].join(" "))[0]).toBe("uv init");
    const root = dir();
    installScaffoldGate(root, "python");
    expect(runScaffoldGate(root)).not.toBe(0);
    pythonScaffold(root);
    expect(runScaffoldGate(root)).toBe(0);
    write(root, ".sekhemet/brief.md", "# Brief: renamer\n\n## Constraints\n- Python.\n");
    expect(afterCardZero(root, "python").state).toBe("derived");
    const unit = loadGatesConfig(root).gates.find((g) => g.id === "unit");
    // A uv project runs its tests in its own environment.
    expect([unit?.command, ...(unit?.args ?? [])]).toEqual(["uv", "run", "pytest", "-q"]);
    expect(readFileSync(join(root, ".sekhemet/brief.md"), "utf8")).toContain(
      "Generator: uv init (pytest 8.3.4, Python >=3.12)",
    );
  });
});

describe("DS-P2-3: card one is a test that must fail at an assertion for its reason", () => {
  it("is planned after card zero with its file and its stated reason", () => {
    const design = designStage("build me a calculator", { greenfield: true });
    const card = cardOneCard(design, "typescript");
    expect(card.labels).toContain(CARD_ONE_LABEL);
    // Its test is the Worker's to write, in its scope: never a staged acceptance test.
    expect(card.acceptanceTests).toBeUndefined();
    expect(card.scopeFiles).toEqual(["tests/first.test.ts"]);
    expect(card.acceptanceCriteria[0]).toContain("fails at an assertion");
    expect(card.reason).toContain("a calculator");
    expect(
      cardOneCard(
        designStage("a Python script that renames photos", { greenfield: true }),
        "python",
      ).scopeFiles,
    ).toEqual(["tests/test_first.py"]);
  });

  it("judges each result: only a failure at an assertion passes", () => {
    const at = (kind: string, message = "expected 0 to be 3") => ({
      test: "tests/first.test.ts > adds",
      file: "tests/first.test.ts",
      kind: kind as never,
      message,
    });
    expect(
      cardOneVerdict({ results: [at("assertion")], requireAssertions: true, command: "x" }).passed,
    ).toBe(true);
    expect(
      cardOneVerdict({ results: [at("passed")], requireAssertions: true, command: "x" }).passed,
    ).toBe(false);
    expect(
      cardOneVerdict({
        results: [at("import", "Cannot find module")],
        requireAssertions: true,
        command: "x",
      }).passed,
    ).toBe(false);
    expect(
      cardOneVerdict({
        results: [at("assertion"), at("error")],
        requireAssertions: true,
        command: "x",
      }).passed,
    ).toBe(false);
    expect(cardOneVerdict({ results: [], requireAssertions: true, command: "x" }).passed).toBe(
      false,
    );
    expect(cardOneVerdict({ unavailable: "no test gate" }).passed).toBe(false);
  });

  it("runs the test through the project's test gate, confined, and judges it", async () => {
    const root = dir();
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    write(root, "package.json", JSON.stringify({ name: "calc", type: "module" }));
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
    const gate = {
      id: "unit",
      rung: "test" as const,
      layer: "functional" as const,
      command: join(REPO, "node_modules", ".bin", "vitest"),
      args: ["run", "--root", root],
      timeoutMs: 120_000,
      parser: "vitest",
      blocking: true,
    };
    const sandbox = confinedSandbox(false);
    const red = await checkCardOne({ sandbox, root, gate, tests: ["tests/first.test.ts"] });
    expect(red.passed).toBe(true);
    // Green is not what card one asks for.
    write(
      root,
      "src/calc.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    expect(
      (await checkCardOne({ sandbox, root, gate, tests: ["tests/first.test.ts"] })).passed,
    ).toBe(false);
    // Nor a failure at the import.
    rmSync(join(root, "src/calc.ts"));
    const broken = await checkCardOne({ sandbox, root, gate, tests: ["tests/first.test.ts"] });
    expect(broken.passed).toBe(false);
    expect(broken.detail).toMatch(/import/);
    expect(existsSync(join(root, "tests/first.test.ts"))).toBe(true);
  }, 120_000);
});

describe("DS-P2-1..3 on a ledger: the two cards, in order", () => {
  it("card one waits on card zero", async () => {
    const root = dir();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    const db = new DatabaseSync(join(root, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cardStore = new CardStore(db, log);
    new BoardServiceImpl(cardStore, { entryConditions: true });
    const design = designStage("build me a calculator", { greenfield: true });
    const zero = await cardStore.createCard(
      { ...cardZeroCard(design.stack.language), tier: "task", status: "ready" },
      "human",
    );
    const { reason: _reason, ...fields } = cardOneCard(design, design.stack.language);
    const one = await cardStore.createCard(
      {
        ...fields,
        tier: "task",
        status: "backlog",
        dependsOn: [zero.id],
      },
      "human",
    );
    expect((await cardStore.getCard(one.id))?.dependsOn).toEqual([zero.id]);
    expect((await cardStore.getCard(zero.id))?.labels).toContain(CARD_ZERO_LABEL);
  });
});
