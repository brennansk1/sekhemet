import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG, type GatesConfig, NO_GATES_CONFIG } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { verificationSessionOptions } from "../src/card_runner.js";

// GT-N3-5 (gates rule 34b; integration review C6): the style fixer runs once
// with every selected rule, so a verification starts at most one autofix and
// one style-fix process. The command is run with the real Biome.

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIOME = join(REPO, "node_modules", ".bin", "biome");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (rules: string[]): GatesConfig => ({
  project: {
    ...DEFAULT_PROJECT_CONFIG,
    autofix: [BIOME, "check", "--write"],
    styleFix: [BIOME, "lint", "--write", "--unsafe"],
    styleFixRules: rules,
  },
  gates: [],
  sha256: NO_GATES_CONFIG,
  sourcePath: "",
  empty: true,
});

describe("style fixes in one process (GT-N3-5)", () => {
  it("builds one style-fix command selecting every rule", () => {
    const opts = verificationSessionOptions(
      config(["style/noUnusedTemplateLiteral", "style/useTemplate", "complexity/useLiteralKeys"]),
      { repoRoot: "/r", restricted: false },
    );
    expect(opts.styleFixCommands).toEqual([
      [
        BIOME,
        "lint",
        "--write",
        "--unsafe",
        "--only=style/noUnusedTemplateLiteral",
        "--only=style/useTemplate",
        "--only=complexity/useLiteralKeys",
      ],
    ]);
    expect(opts.autofixCommand).toEqual([BIOME, "check", "--write"]);
  });

  it("fixes every selected rule in that one run", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "style-once-")));
    dirs.push(root);
    writeFileSync(
      join(root, "a.ts"),
      'export const c = "z";\nexport const a = `x`;\nexport const b = "a" + c;\n',
    );
    const [argv] =
      verificationSessionOptions(config(["style/noUnusedTemplateLiteral", "style/useTemplate"]), {
        repoRoot: root,
        restricted: false,
      }).styleFixCommands ?? [];
    const [command, ...args] = argv as [string, ...string[]];
    execFileSync(command, [...args, "a.ts"], { cwd: root, stdio: "ignore" });
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(
      'export const c = "z";\nexport const a = "x";\nexport const b = `a${c}`;\n',
    );
  });

  it("builds no style-fix command when no rule is selected", () => {
    const opts = verificationSessionOptions(config([]), { repoRoot: "/r", restricted: false });
    expect(opts.styleFixCommands).toBeUndefined();
  });
});

// GT-N2-2 (gates rule 17): a changelog entry is demanded only of a card
// whose scope holds CHANGELOG.md; another is told in an advisory. The card
// run and `sekhemet gate` both take it from here (GT-T1-1).
describe("the changelog by the card's scope (GT-N2-2)", () => {
  const opts = (scope: string[] | undefined, changelog?: boolean) =>
    verificationSessionOptions(
      {
        ...config([]),
        project: { ...config([]).project, ...(changelog !== undefined ? { changelog } : {}) },
      },
      { repoRoot: "/r", restricted: false, ...(scope ? { scope } : {}) },
    ).builtinGates.changelog;

  it("is an advisory for a card whose scope does not hold CHANGELOG.md", () => {
    expect(opts(["src/a.ts"])).toBe("advisory");
  });
  it("is the project's rule for a card whose scope holds it", () => {
    expect(opts(["src/a.ts", "CHANGELOG.md"])).toBeUndefined();
    expect(opts(["CHANGELOG.md"], true)).toBe(true);
  });
  it("is the project's rule for a scope glob or directory covering CHANGELOG.md, or an empty scope", () => {
    expect(opts(["*.md"])).toBeUndefined();
    expect(opts(["**"])).toBeUndefined();
    expect(opts(["."])).toBeUndefined();
    expect(opts(["./"])).toBeUndefined();
    expect(opts([])).toBeUndefined();
    expect(opts(["docs/*.md", "src/"])).toBe("advisory");
  });
  it("stays off where the project turned it off, and as configured without a scope", () => {
    expect(opts(["src/a.ts"], false)).toBe(false);
    expect(opts(undefined)).toBeUndefined();
  });
});
