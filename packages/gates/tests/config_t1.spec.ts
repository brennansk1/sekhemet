import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GatesConfigTamperError,
  NO_GATES_CONFIG,
  loadGatesConfig,
  verifyGatesConfig,
} from "../src/config.js";

// T1: GT-T1-6 (unknown keys warned, layer inferred from the parser), GT-T1-10
// (no gates.toml is said, never the empty-string hash), GT-T1-13 (the hash is
// the file's bytes, as sha256sum computes it).

describe("gates.toml under one pipeline (T1)", () => {
  let repo: string;
  const writeConfig = (body: string | Buffer): void => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), body);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gates-t1-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("GT-T1-6: warns on an unknown rung, layer or parser, naming the key and the value", () => {
    writeConfig(`
[[gate]]
id = "odd"
rung = "smoke"
layer = "fuzzy"
command = "true"
parser = "mystery"
`);
    const config = loadGatesConfig(repo);
    const warnings = config.warnings ?? [];
    expect(warnings.some((w) => w.includes("rung") && w.includes('"smoke"'))).toBe(true);
    expect(warnings.some((w) => w.includes("layer") && w.includes('"fuzzy"'))).toBe(true);
    expect(warnings.some((w) => w.includes("parser") && w.includes('"mystery"'))).toBe(true);
    // Each names its gate.
    for (const w of warnings) expect(w).toContain("odd");
  });

  it("GT-T1-6: places gitleaks, stryker and playwright gates in security, robustness and visual", () => {
    writeConfig(`
[[gate]]
id = "secret-scan"
command = "gitleaks"
parser = "gitleaks"

[[gate]]
id = "mutants"
command = "stryker"
parser = "stryker"

[[gate]]
id = "screens"
command = "playwright"
parser = "playwright"

[[gate]]
id = "typecheck"
command = "tsc"
parser = "tsc"
`);
    const config = loadGatesConfig(repo);
    const layer = new Map(config.gates.map((g) => [g.id, g.layer]));
    expect(layer.get("secret-scan")).toBe("security");
    expect(layer.get("mutants")).toBe("robustness");
    expect(layer.get("screens")).toBe("visual");
    // The rung is the id when that is a known rung; typecheck is static.
    expect(layer.get("typecheck")).toBe("static");
    expect(config.warnings ?? []).toEqual([]);
  });

  it("GT-T1-6: a known layer written in the file wins over the inferred one", () => {
    writeConfig(`
[[gate]]
id = "scan"
command = "gitleaks"
parser = "gitleaks"
layer = "hygiene"
`);
    expect(loadGatesConfig(repo).gates[0]?.layer).toBe("hygiene");
  });

  it("GT-T1-10: with no gates.toml, records 'no gates.toml', never the empty-string hash", () => {
    const config = loadGatesConfig(repo);
    expect(config.empty).toBe(true);
    expect(config.sha256).toBe(NO_GATES_CONFIG);
    expect(config.sha256).not.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("GT-T1-10: a gates.toml written after the card started is still tamper", () => {
    const pinned = loadGatesConfig(repo).sha256;
    writeConfig('[[gate]]\nid = "unit"\ncommand = "true"\n');
    expect(() => verifyGatesConfig(repo, pinned)).toThrow(GatesConfigTamperError);
  });

  it("GT-T1-13: records the SHA-256 of the file's bytes, as sha256sum computes it", () => {
    // Bytes that do not survive a UTF-8 round trip: a lone 0xff in a comment.
    writeConfig(
      Buffer.concat([
        Buffer.from("# café "),
        Buffer.from([0xff, 0x0a]),
        Buffer.from('[[gate]]\nid = "unit"\ncommand = "true"\n'),
      ]),
    );
    const file = join(repo, ".sekhemet", "gates.toml");
    const expected = execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(
      " ",
    )[0];
    const config = loadGatesConfig(repo);
    expect(config.sha256).toBe(expected);
    expect(config.empty).not.toBe(true);
  });
});
