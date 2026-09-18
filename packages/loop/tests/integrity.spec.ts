import { describe, expect, it } from "vitest";
import { integrityFailures, scanDiffIntegrity } from "../src/integrity.js";

const diff = (file: string, ...added: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    ...added.map((l) => `+${l}`),
  ].join("\n");

describe("@sekhemet/loop integrity gate", () => {
  it("flags checks that were switched off instead of satisfied", () => {
    const v = scanDiffIntegrity(
      [
        diff(
          "src/a.ts",
          "// @ts-ignore",
          "const x = y as any;",
          "export function f(v: any) {}",
          "// biome-ignore lint/style/noNonNullAssertion: fine",
        ),
        diff(
          "tests/extra.spec.ts",
          "it.skip('hard case', () => {});",
          "describe.only('x', () => {});",
          "expect(true).toBe(true);",
        ),
      ].join("\n"),
    );
    expect(v.map((x) => x.pattern)).toEqual([
      "ts-ignore",
      "as-any",
      "as-any",
      "lint-suppression",
      "skipped-test",
      "focused-test",
      "vacuous-assert",
    ]);
  });

  it("ignores protected acceptance tests the harness staged, and honest code", () => {
    const v = scanDiffIntegrity(
      [
        diff("tests/ledger.spec.ts", "it.skip('staged by the harness', () => {});"),
        diff("src/b.ts", "const company = { anyone: 1 };", "const v: unknown = JSON.parse(s);"),
      ].join("\n"),
      ["tests/ledger.spec.ts"],
    );
    expect(v).toEqual([]);
  });

  it("turns violations into gate failures with the honest fix", () => {
    const [f] = integrityFailures(scanDiffIntegrity(diff("src/a.ts", "// @ts-ignore")));
    expect(f?.gate).toBe("integrity");
    expect(f?.suggestedAction).toMatch(/Remove the suppression/);
  });
});
