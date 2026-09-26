import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuiltinGates } from "../src/builtin.js";
import { builtinGateIds } from "../src/builtin.js";
import { runClaimGate } from "../src/claims.js";
import { loadGatesConfig } from "../src/config.js";

// Gates rule 27a, GT-N5-3 (design-stage DS-N2-2, DS-N2-3): a research card's
// executable claims are checked by a claim gate declared in gates.toml and
// covered by its pinned hash. A claim runs confined, with no network and no
// write access to the repository; one neither reproduced nor marked
// unreproducible with a reason fails the card.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claims-"));
  mkdirSync(join(root, ".sekhemet", "research"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const report = (card: string, claims: unknown[]) =>
  writeFileSync(
    join(root, ".sekhemet", "research", `${card}.claims.json`),
    JSON.stringify({ claims }),
  );

describe("the claim gate is declared in gates.toml and hash-pinned", () => {
  it("reads [claims] and changes the pinned hash", () => {
    writeFileSync(join(root, ".sekhemet", "gates.toml"), "[project]\nmax_files = 3\n");
    const without = loadGatesConfig(root);
    expect(without.project.claims).toBeUndefined();
    writeFileSync(
      join(root, ".sekhemet", "gates.toml"),
      '[project]\nmax_files = 3\n\n[claims]\nreport = ".sekhemet/research/{card}.claims.json"\ntimeout_s = 20\n',
    );
    const withClaims = loadGatesConfig(root);
    expect(withClaims.project.claims).toEqual({
      report: ".sekhemet/research/{card}.claims.json",
      timeoutMs: 20_000,
    });
    expect(withClaims.sha256).not.toBe(without.sha256);
    expect(builtinGateIds(withClaims.project)).toContain("claims");
    expect(builtinGateIds(without.project)).not.toContain("claims");
  });

  it("runs only for a research card, and only when declared", async () => {
    report("r1", [{ id: "c1", kind: "executable", text: "x" }]);
    const project = { protected: [], maxFiles: 3, maxDiffLines: 200 };
    const undeclared = await runBuiltinGates({
      root,
      base: "main",
      diff: "",
      project,
      gates: [],
      researchCardId: "r1",
    });
    expect(undeclared.outcomes).toEqual([]);
    const declared = await runBuiltinGates({
      root,
      base: "main",
      diff: "",
      project: {
        ...project,
        claims: { report: ".sekhemet/research/{card}.claims.json", timeoutMs: 5000 },
      },
      gates: [],
      researchCardId: "r1",
    });
    expect(declared.outcomes.map((o) => [o.gate, o.layer, o.passed])).toEqual([
      ["claims", "functional", false],
    ]);
    expect(declared.failures[0]?.errorExcerpt).toMatch(
      /\[c1\] neither reproduced nor marked unreproducible with a reason/,
    );
  });
});

describe.runIf(platform() === "darwin")("claims run confined (GT-N5-3)", () => {
  const run = (claims: unknown[]) => {
    report("r1", claims);
    return runClaimGate({
      root,
      report: join(root, ".sekhemet", "research", "r1.claims.json"),
      timeoutMs: 20_000,
    });
  };

  it("passes a reproduced claim and one marked unreproducible with a reason; ignores other kinds", async () => {
    const r = await run([
      {
        id: "c1",
        kind: "executable",
        text: "Array.prototype.at(-1) returns the last element",
        reproduce: { language: "node", code: "if ([1, 2, 3].at(-1) !== 3) process.exit(1)" },
      },
      {
        id: "c2",
        kind: "executable",
        text: "left-pad 1.3 pads with spaces",
        unreproducible: "needs the package from the network, which claims may not reach",
      },
      { id: "c3", kind: "citational", text: "the RFC says so" },
    ]);
    expect(r.failures).toEqual([]);
    expect(r.verdicts).toEqual([
      { id: "c1", verdict: "reproduced" },
      { id: "c2", verdict: "unreproducible", reason: expect.stringContaining("network") },
    ]);
  }, 60_000);

  it("fails a claim whose run fails, one with neither run nor reason, and one with an empty reason", async () => {
    const r = await run([
      {
        id: "c1",
        kind: "executable",
        text: "Math.max() of nothing is 0",
        reproduce: { language: "node", code: "if (Math.max() !== 0) process.exit(3)" },
      },
      { id: "c2", kind: "executable", text: "fetch exists" },
      { id: "c3", kind: "executable", text: "x", unreproducible: "  " },
    ]);
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      expect.stringMatching(/^\[c1\] did not reproduce: exit 3/),
      expect.stringMatching(/^\[c2\] neither reproduced nor marked unreproducible/),
      expect.stringMatching(/^\[c3\] neither reproduced nor marked unreproducible/),
    ]);
    for (const f of r.failures) {
      expect(f).toMatchObject({ gate: "claims", rung: "test", layer: "functional" });
      expect(f.suggestedAction.length).toBeGreaterThan(10);
    }
  }, 60_000);

  it("gives a claim no network and no write access to the repository", async () => {
    const marker = join(root, "written-by-claim");
    const r = await run([
      {
        id: "c1",
        kind: "executable",
        text: "the repository is writable",
        reproduce: {
          language: "node",
          code: `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
        },
      },
      {
        id: "c2",
        kind: "executable",
        text: "example.com answers",
        reproduce: {
          language: "node",
          code: 'fetch("http://example.com").then(() => process.exit(0), () => process.exit(4))',
        },
      },
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(r.failures.map((f) => f.errorExcerpt.slice(0, 22))).toEqual([
      "[c1] did not reproduce",
      "[c2] did not reproduce",
    ]);
  }, 60_000);

  it("is not run, never passed, when the card has no claims report", async () => {
    const r = await runClaimGate({ root, report: join(root, "missing.json"), timeoutMs: 1000 });
    expect(r.failures).toEqual([expect.objectContaining({ gate: "claims", notRun: true })]);
  });
});
