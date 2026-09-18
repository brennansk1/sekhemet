import { describe, expect, it } from "vitest";
import { defaultParserRegistry, remedyFor } from "../src/parsers.js";
import type { GateDefinition } from "../src/types.js";

const gate = (parser: string): GateDefinition => ({
  id: parser,
  rung: parser === "biome" ? "lint" : "typecheck",
  layer: "static",
  command: parser,
  args: [],
  timeoutMs: 1000,
  parser,
  blocking: true,
});

describe("@sekhemet/gates targeted remedies", () => {
  it("gives the narrowing idiom for possibly-undefined index access", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: "src/verifier.ts(17,9): error TS18048: 'event' is possibly 'undefined'.",
      stderr: "",
      minimalRepro: "tsc -b",
    });
    expect(failure?.suggestedAction).toMatch(/if \(item === undefined\) continue/);
    expect(failure?.suggestedAction).toMatch(/non-null assertion/);
  });

  it("recognises a property access on a `| undefined` union as the same problem", () => {
    const remedy = remedyFor(
      "TS2339",
      "Property 'sequenceNumber' does not exist on type 'ChronicleEvent<unknown> | undefined'.",
    );
    expect(remedy).toMatch(/Narrow it/);
    // A genuinely missing property is a different problem and gets no narrowing advice.
    expect(remedyFor("TS2339", "Property 'foo' does not exist on type 'Bar'.")).toBeUndefined();
  });

  it("points a forbidden non-null assertion at the same idiom, not just the rule name", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("biome"),
      exitCode: 1,
      stdout:
        "./src/verifier.ts:13:19 lint/style/noNonNullAssertion ━━━━\n\n  × Forbidden non-null assertion.",
      stderr: "",
      minimalRepro: "biome check",
    });
    expect(failure?.suggestedAction).toMatch(/Narrow it/);
  });

  it("falls back to the generic instruction for an unknown code", () => {
    const [failure] = defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: "src/a.ts(1,1): error TS9999: Something new.",
      stderr: "",
      minimalRepro: "tsc -b",
    });
    expect(failure?.suggestedAction).toBe(
      "Resolve TS9999 at src/a.ts:1. Read the surrounding lines before editing.",
    );
  });

  it("explains exactOptionalPropertyTypes: omit the property, never assign undefined", () => {
    expect(remedyFor("TS2375", "Type '{ x: undefined }' is not assignable")).toMatch(
      /Omit the property/,
    );
  });
});
