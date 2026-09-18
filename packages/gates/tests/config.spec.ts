import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GATES,
  GatesConfigTamperError,
  hashGatesConfig,
  loadGatesConfig,
  verifyGatesConfig,
} from "../src/config.js";

describe("@sekhemet/gates configuration", () => {
  let repo: string;

  const writeConfig = (body: string): void => {
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), body, "utf8");
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gates-config-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("falls back to the built-in ladder when a project ships no config", () => {
    const config = loadGatesConfig(repo);
    expect(config.gates.map((g) => g.id)).toEqual(DEFAULT_GATES.map((g) => g.id));
    // A project without config must still get real gates, not none.
    expect(config.gates.every((g) => g.blocking)).toBe(true);
    expect(config.project.maxFiles).toBe(3);
    expect(config.project.maxDiffLines).toBe(200);
  });

  it("parses declared gates with layers, argv, timeouts and parsers", () => {
    writeConfig(`
[project]
protected = ["tests/acceptance/**", "**/*.spec.ts"]
max_files = 2
max_diff_lines = 150

[[gate]]
id = "types"
rung = "typecheck"
layer = "static"
command = "pnpm"
args = ["typecheck"]
timeout_s = 90
parser = "tsc"

[[gate]]
id = "suite"
rung = "test"
layer = "functional"
command = "cargo"
args = ["test", "--all"]
timeout_s = 600
parser = "generic"
blocking = false
baseline_approval = "human"
`);

    const config = loadGatesConfig(repo);
    expect(config.gates).toHaveLength(2);

    const types = config.gates[0];
    expect(types?.layer).toBe("static");
    // Seconds in the file, milliseconds in the runner.
    expect(types?.timeoutMs).toBe(90_000);
    expect(types?.parser).toBe("tsc");

    const suite = config.gates[1];
    // Not every project is pnpm; the runner must honour the declared command.
    expect(suite?.command).toBe("cargo");
    expect(suite?.args).toEqual(["test", "--all"]);
    expect(suite?.timeoutMs).toBe(600_000);
    expect(suite?.blocking).toBe(false);
    expect(suite?.baselineApproval).toBe("human");

    expect(config.project.protected).toEqual(["tests/acceptance/**", "**/*.spec.ts"]);
    expect(config.project.maxFiles).toBe(2);
  });

  it("hashes the file's exact bytes so any edit changes the digest", () => {
    writeConfig("[project]\nmax_files = 3\n");
    const first = loadGatesConfig(repo).sha256;

    writeConfig("[project]\nmax_files = 4\n");
    const second = loadGatesConfig(repo).sha256;

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(second).toBe(hashGatesConfig("[project]\nmax_files = 4\n"));
  });

  it("refuses to run when gates.toml changed since the card started", () => {
    writeConfig(`
[[gate]]
id = "unit"
rung = "test"
layer = "functional"
command = "pnpm"
args = ["test"]
timeout_s = 60
parser = "vitest"
`);
    const pinned = loadGatesConfig(repo).sha256;

    // Re-verifying an unchanged file is fine.
    expect(verifyGatesConfig(repo, pinned).gates).toHaveLength(1);

    // An agent weakening its own verification must not have it honoured.
    writeConfig(`
[[gate]]
id = "unit"
rung = "test"
layer = "functional"
command = "true"
args = []
timeout_s = 60
parser = "generic"
`);

    expect(() => verifyGatesConfig(repo, pinned)).toThrow(GatesConfigTamperError);
    try {
      verifyGatesConfig(repo, pinned);
    } catch (err) {
      // The message must name both hashes so the tamper is auditable.
      expect((err as Error).message).toContain(pinned);
      expect((err as Error).message).toContain("refusing to run gates");
    }
  });

  it("tolerates comments, multi-line arrays and non-string scalars", () => {
    writeConfig(`
# gates for this project
[project]
protected = [
  "a/**",   # first
  "b/**",
]
max_files = 3
strict = true
ratio = 0.01
`);
    const config = loadGatesConfig(repo);
    expect(config.project.protected).toEqual(["a/**", "b/**"]);
    expect(config.project.maxFiles).toBe(3);
  });
});
