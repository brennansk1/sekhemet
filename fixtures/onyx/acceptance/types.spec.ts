import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CryptoEnvelope,
  ScanMatch,
  ScanRule,
  SecretRecord,
  VaultConfig,
} from "../src/types.js";

/**
 * Contract tests for card_onyx_1_types. A types-only card gated by tsc alone
 * can merge a contract that compiles but is wrong, making later cards
 * unsatisfiable; these only typecheck when the contract is exactly as specified.
 */
describe("onyx contract", () => {
  it("makes VaultConfig.iterations optional and everything else required", () => {
    const minimal: VaultConfig = { dbPath: "/tmp/v.db", passphrase: "p" };
    expect(minimal.iterations).toBeUndefined();
    expectTypeOf<VaultConfig["iterations"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<VaultConfig["dbPath"]>().toEqualTypeOf<string>();
    expectTypeOf<VaultConfig["passphrase"]>().toEqualTypeOf<string>();
  });

  it("defines a CryptoEnvelope of four required base64 strings", () => {
    const envelope: CryptoEnvelope = { salt: "s", iv: "i", tag: "t", ciphertext: "c" };
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "iv", "salt", "tag"]);
    expectTypeOf<CryptoEnvelope>().toEqualTypeOf<{
      salt: string;
      iv: string;
      tag: string;
      ciphertext: string;
    }>();
  });

  it("defines SecretRecord with a numeric updatedAt", () => {
    expectTypeOf<SecretRecord>().toEqualTypeOf<{
      project: string;
      key: string;
      value: string;
      updatedAt: number;
    }>();
  });

  it("restricts ScanRule to the four named rules and types ScanMatch exactly", () => {
    expectTypeOf<ScanRule>().toEqualTypeOf<
      "private-key" | "aws-access-key" | "github-pat" | "high-entropy"
    >();
    const match: ScanMatch = { file: "a.ts", line: 3, rule: "github-pat", excerpt: "ghp_…" };
    expect(match.line).toBe(3);
    expectTypeOf<ScanMatch["rule"]>().toEqualTypeOf<ScanRule>();
    expectTypeOf<ScanMatch["line"]>().toEqualTypeOf<number>();
  });
});
