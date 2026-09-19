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
});
