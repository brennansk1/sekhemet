import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateRunner } from "@sekhemet/gates";
import { afterEach, describe, expect, it } from "vitest";
import { withLicenseGate } from "../src/license_gate.js";

// B2.3 review, major 3: the licence gate never passes a check it did not run.

const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "license-"));
  dirs.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=T", ...a], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

describe("the licence gate never vanishes", () => {
  it("reports itself as not run when it throws", async () => {
    const root = repo();
    // A manifest it cannot read: package.json is a directory.
    mkdirSync(join(root, "package.json"));
    const r = await withLicenseGate(passing, root).runGates(["test"], root);
    const f = r.failures.find((x) => x.gate === "licenses");
    expect(f?.notRun).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.rungResults?.find((o) => o.gate === "licenses")?.passed).toBe(false);
  });

  it("records a skip, not a pass, when there is no base to compare against", async () => {
    const root = mkdtempSync(join(tmpdir(), "license-nobase-"));
    dirs.push(root);
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: root });
    const r = await withLicenseGate(passing, root).runGates(["test"], root);
    expect(r.rungResults?.find((o) => o.gate === "licenses")).toMatchObject({
      skipped: true,
      reason: "no main branch to compare against",
    });
  });
});
