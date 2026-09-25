import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";

/**
 * Item 20b: gitleaks, osv-scanner and semgrep read the card's files. They are
 * found by absolute path from the fixed allowlist and run confined to the
 * worktree with the allowlisted environment.
 */
describe.runIf(platform() === "darwin")("the security scanners run confined", () => {
  let root: string;
  let outside: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scan-root-"));
    outside = mkdtempSync(join(tmpdir(), "scan-out-"));
    bin = mkdtempSync(join(tmpdir(), "scan-bin-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [root, outside, bin]) rmSync(d, { recursive: true, force: true });
  });

  function fake(name: string, stdout: string): string {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/bin/sh\nenv > ${JSON.stringify(join(root, `env-${name}.txt`))}\necho escaped > ${JSON.stringify(join(outside, `marker-${name}`))} 2>/dev/null\necho '${stdout}'\nexit 0\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  it("get no token and write no marker outside the worktree", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-canary-token");
    vi.stubEnv("SEKHEMET_CANARY_API_KEY", "sk-canary");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    mkdirSync(join(root, ".sekhemet"));
    writeFileSync(join(root, ".sekhemet", "semgrep.yml"), "rules: []\n");
    const programs = {
      gitleaks: [fake("gitleaks", "[]")],
      "osv-scanner": [fake("osv-scanner", "{}")],
      semgrep: [fake("semgrep", '{"results":[]}')],
    };
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export const a = 1;\n",
      project: { protected: [], maxFiles: 3, maxDiffLines: 200 },
      gates: ["secrets", "osv", "semgrep"],
      programs,
    });
    expect(r.failures).toEqual([]);
    for (const name of Object.keys(programs)) {
      // Each ran, inside the worktree...
      const env = readFileSync(join(root, `env-${name}.txt`), "utf8");
      // ...with no credential in its environment...
      expect(env, name).not.toContain("ghp-canary-token");
      expect(env, name).not.toContain("sk-canary");
      // ...and could not write outside it.
      expect(existsSync(join(outside, `marker-${name}`)), name).toBe(false);
    }
  });

  it("a scanner found only on PATH is never run", async () => {
    const hijack = fake("gitleaks", "[]");
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    await runBuiltinGates({
      root,
      base: "main",
      diff: "+++ b/src/a.ts\n+x\n",
      project: { protected: [], maxFiles: 3, maxDiffLines: 200 },
      gates: ["secrets"],
      programs: { gitleaks: ["/nonexistent/gitleaks"] },
    });
    expect(hijack.startsWith("/")).toBe(true);
    expect(existsSync(join(root, "env-gitleaks.txt"))).toBe(false);
  });
});
