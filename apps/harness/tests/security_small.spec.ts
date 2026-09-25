import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onPath } from "../../../packages/gates/src/builtin.js";
import { checkSyntax } from "../../../packages/loop/src/parse_gate.js";
import { localLicense } from "../src/license_gate.js";
import { tokenMatches } from "../src/wave2_server.js";

/** NEW-security-3: three small hardening items (SEC-35, SEC-36, SEC-37). */
describe("small hardening items (NEW-security-3)", () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks a gate command name without executing a substitution in it (SEC-35)", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sec35-"));
    const marker = join(dir, "marker");
    onPath(`true$(touch ${marker})`);
    onPath(`true\`touch ${marker}\``);
    expect(existsSync(marker)).toBe(false);
    expect(onPath("node")).toBe(true);
  });

  it("runs python3 isolated, so PYTHONPATH cannot shadow the parser (SEC-36)", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sec36-"));
    const marker = join(dir, "marker");
    writeFileSync(
      join(dir, "ast.py"),
      `open(${JSON.stringify(marker)}, "w").write("x")\ndef parse(s): pass\n`,
    );
    vi.stubEnv("PYTHONPATH", dir);
    checkSyntax("a.py", "x = 1\n");
    expect(existsSync(marker)).toBe(false);
    expect(checkSyntax("a.py", "def (:\n").length).toBe(1);
  });

  it("runs pip isolated for a licence lookup (SEC-36)", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sec36b-"));
    const marker = join(dir, "marker");
    mkdirSync(join(dir, "pip"));
    writeFileSync(join(dir, "pip", "__init__.py"), "");
    writeFileSync(
      join(dir, "pip", "__main__.py"),
      `open(${JSON.stringify(marker)}, "w").write("x")\n`,
    );
    vi.stubEnv("PYTHONPATH", dir);
    localLicense(dir, "requirements.txt", "pypi", "requests");
    expect(existsSync(marker)).toBe(false);
  });

  it("compares a trigger token in constant time and exactly (SEC-37)", () => {
    dir = mkdtempSync(join(tmpdir(), "sek-sec37-"));
    expect(tokenMatches("Bearer s3cret-token", "s3cret-token")).toBe(true);
    expect(tokenMatches("Bearer s3cret-tokeN", "s3cret-token")).toBe(false);
    expect(tokenMatches("Bearer s3cret", "s3cret-token")).toBe(false);
    expect(tokenMatches(undefined, "s3cret-token")).toBe(false);
    expect(tokenMatches("Bearer ", undefined)).toBe(false);
  });
});
