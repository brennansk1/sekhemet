import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectGateTemplate,
  gateTemplate,
  loadGatesConfig,
  renderGatesToml,
} from "../src/index.js";

describe("gate templates by language (G27)", () => {
  const dirs: string[] = [];
  const repo = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "gate-tpl-"));
    dirs.push(d);
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("detects the package manager and uses the scripts the project has", () => {
    const d = repo({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "jest" } }),
      "package-lock.json": "{}",
    });
    expect(detectGateTemplate(d)).toBe("npm");
    const gates = gateTemplate(d) ?? [];
    expect(gates.map((g) => [g.id, g.command, g.args.join(" "), g.parser])).toEqual([
      ["typecheck", "npm", "run build", "tsc"],
      ["unit", "npm", "run test", "jest"],
    ]);
    // Without a gates.toml, the loader uses the template.
    expect(loadGatesConfig(d).gates.map((g) => g.id)).toEqual(["typecheck", "unit"]);
  });

  it("has Python, Rust and Go ladders, and renders a gates.toml that loads back", () => {
    expect(
      gateTemplate(repo({ "pyproject.toml": "" }))?.map((g) => g.args.slice(0, 2).join(" ")),
    ).toEqual(["-m ruff", "-m mypy", "-m pytest"]);
    expect(gateTemplate(repo({ "Cargo.toml": "" }))?.[0]?.command).toBe("cargo");
    // Rust's gates are read by the cargo parser, proven on real output (GT-M6-2).
    expect(gateTemplate(repo({ "Cargo.toml": "" }))?.map((g) => g.parser)).toEqual([
      "cargo",
      "cargo",
      "cargo",
    ]);
    const go = repo({ "go.mod": "module x" });
    const toml = renderGatesToml(gateTemplate(go) ?? []);
    const parsed = parseToml(toml) as { gate: { id: string; command: string }[] };
    expect(parsed.gate.map((g) => `${g.id}:${g.command}`)).toEqual([
      "typecheck:go",
      "lint:go",
      "unit:go",
    ]);
    expect(detectGateTemplate(repo({ "README.md": "" }))).toBeUndefined();
  });

  it("derives a format gate from the project's own formatter when its configuration exists (GT-N5-1)", () => {
    const fmt = (files: Record<string, string>) =>
      (gateTemplate(repo(files)) ?? [])
        .filter((g) => g.id === "format")
        .map((g) => [g.command, g.args.join(" "), g.parser, g.rung, g.layer]);
    const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
    expect(fmt({ "package.json": pkg, "pnpm-lock.yaml": "", "biome.json": "{}" })).toEqual([
      ["pnpm", "exec biome format .", "biome", "lint", "static"],
    ]);
    expect(fmt({ "package.json": pkg, "package-lock.json": "{}", ".prettierrc": "{}" })).toEqual([
      ["npx", "prettier --check .", "generic", "lint", "static"],
    ]);
    expect(
      fmt({ "package.json": JSON.stringify({ prettier: {}, scripts: {} }), "yarn.lock": "" }),
    ).toEqual([["yarn", "prettier --check .", "generic", "lint", "static"]]);
    // Biome's check already formats: no second gate for the same thing.
    expect(
      fmt({
        "package.json": JSON.stringify({ scripts: { lint: "biome check ." } }),
        "biome.json": "{}",
      }),
    ).toEqual([]);
    expect(fmt({ "package.json": pkg })).toEqual([]);
    expect(fmt({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" })).toEqual([
      ["python3", "-m ruff format --check .", "generic", "lint", "static"],
    ]);
    expect(fmt({ "requirements.txt": "", "ruff.toml": "" })).toHaveLength(1);
    expect(fmt({ "pyproject.toml": "[project]\nname = 'x'\n" })).toEqual([]);
    expect(fmt({ "Cargo.toml": "", "rustfmt.toml": "edition = '2021'" })).toEqual([
      ["cargo", "fmt --check", "generic", "lint", "static"],
    ]);
    expect(fmt({ "Cargo.toml": "", ".rustfmt.toml": "" })).toHaveLength(1);
    expect(fmt({ "Cargo.toml": "" })).toEqual([]);
  });
});
