import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateFailure, GateResult, GateRunner } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { regressionFailures, withRegressionGate } from "../src/regression_gate.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "regr-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [f, body] of Object.entries(files)) write(root, f, body);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), body);
}

const testFailure = (file: string): GateFailure => ({
  rung: "test",
  gate: "unit",
  layer: "functional",
  exitCode: 1,
  errorExcerpt: `FAIL ${file} > encrypts`,
  suggestedFixFiles: [file],
  location: { file },
  suggestedAction: "Make the implementation satisfy this assertion.",
});

describe("the regression gate", () => {
  it("names a failing test that main already guarantees as a regression", () => {
    // An accepted card's tests are what main guarantees. When a later card
    // breaks one, the plain test failure pointed the Worker at the test file —
    // protected, and belonging to finished work — instead of at its own change.
    const root = repo({ "tests/crypto.spec.ts": "x", "src/crypto.ts": "a", "src/vault.ts": "" });
    write(root, "src/crypto.ts", "b");
    const [f] = regressionFailures(root, [testFailure("tests/crypto.spec.ts")], {
      ownTests: ["vault.spec.ts"],
    });
    expect(f?.gate).toBe("regression");
    expect(f?.suggestedFixFiles).toEqual(["src/crypto.ts"]);
    expect(f?.suggestedAction).toMatch(/passed on main/);
    expect(f?.suggestedAction).toMatch(/src\/crypto\.ts/);
    expect(f?.suggestedAction).toMatch(/Do not edit the test/);
  });

  it("leaves the card's own failing acceptance test alone", () => {
    const root = repo({ "tests/vault.spec.ts": "x" });
    const own = testFailure("tests/vault.spec.ts");
    expect(regressionFailures(root, [own], { ownTests: ["vault.spec.ts"] })).toEqual([own]);
  });

  it("leaves a test that is new on this branch alone", () => {
    const root = repo({ "src/a.ts": "" });
    write(root, "tests/new.spec.ts", "x");
    const f = testFailure("tests/new.spec.ts");
    expect(regressionFailures(root, [f])).toEqual([f]);
  });

  it("fails a card that deletes or empties a test main had", () => {
    // Not every project protects tests/ in gates.toml; a test that is gone
    // cannot fail, so a suite that only runs what exists never notices.
    const root = repo({ "tests/a.spec.ts": "x", "tests/b.spec.ts": "y" });
    rmSync(join(root, "tests/a.spec.ts"));
    write(root, "tests/b.spec.ts", "  \n");
    const found = regressionFailures(root, []).map((f) => f.location?.file);
    expect(found.sort()).toEqual(["tests/a.spec.ts", "tests/b.spec.ts"]);
  });

  it("judges nothing outside a git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "regr-nogit-"));
    const f = testFailure("tests/a.spec.ts");
    expect(regressionFailures(root, [f])).toEqual([f]);
  });

  it("runs on every verification and fails the result it wraps", async () => {
    const root = repo({ "tests/a.spec.ts": "x" });
    rmSync(join(root, "tests/a.spec.ts"));
    const inner: GateRunner = {
      runGates: async (): Promise<GateResult> => ({ passed: true, failures: [] }) as GateResult,
    };
    const res = await withRegressionGate(inner).runGates(["typecheck"], root);
    expect(res.passed).toBe(false);
    expect(res.failures[0]?.gate).toBe("regression");
  });
});
