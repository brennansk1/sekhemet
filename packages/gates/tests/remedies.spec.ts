import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultParserRegistry, rankFailures, remedyFor } from "../src/parsers.js";
import type { GateFailure } from "../src/types.js";
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

  it("ranks a failing test above style nits, however many the nits are", () => {
    const f = (rung: string, file: string, excerpt: string): GateFailure =>
      ({
        rung,
        gate: rung,
        exitCode: 1,
        errorExcerpt: excerpt,
        suggestedFixFiles: file ? [file] : [],
      }) as GateFailure;
    const ranked = rankFailures(
      [
        f("lint", "src/ledger.ts", "noUnusedTemplateLiteral"),
        f("lint", "src/ledger.ts", "useTemplate"),
        f("lint", "src/ledger.ts", "useLiteralKeys"),
        // Protected test: no fix files, so reference weight alone ranked it last.
        f("test", "", "persists events across reopening"),
      ],
      3,
    );
    expect(ranked[0]?.errorExcerpt).toBe("persists events across reopening");
  });

  it("tells the model how to type database rows instead of casting blindly", () => {
    expect(
      remedyFor("TS2352", "Conversion of type 'Record<string, SQLOutputValue>[]' to type 'Row[]'"),
    ).toMatch(/as unknown as Row\[\]/);
  });
});

describe("a missing export is answered, not described", () => {
  // The first frozen-suite run: told "Read the module and use its actual
  // export", a Worker read the module four times, learned nothing it could
  // act on, and was stopped for repeating itself. A suggested action must be
  // completable in one step, so this one carries what it was sent to fetch.
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "ts2305-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "tokens.ts"),
      [
        "export const SPACING = 4;",
        "export type Tone = 'pass' | 'fail';",
        "export interface CardView { id: string }",
        "const hidden = 1;",
        "export { hidden as VISIBLE };",
      ].join("\n"),
    );
    return dir;
  };
  const failureFor = (cwd: string, member: string) =>
    defaultParserRegistry.parse({
      gate: gate("tsc"),
      exitCode: 2,
      stdout: `src/card_tile.ts(1,15): error TS2305: Module '"./tokens.js"' has no exported member '${member}'.`,
      stderr: "",
      minimalRepro: "tsc --noEmit",
      cwd,
    })[0];

  it("lists what the module actually exports", () => {
    const f = failureFor(project(), "CanvasCard");
    expect(f?.suggestedAction).toContain("does not export CanvasCard");
    expect(f?.suggestedAction).toContain("CardView, SPACING, Tone, VISIBLE");
  });

  it("tells the model it does not need to read the module again", () => {
    expect(failureFor(project(), "CanvasCard")?.suggestedAction).toMatch(
      /no need to read .* again/,
    );
  });

  it("falls back to words when the module cannot be found", () => {
    const f = failureFor(mkdtempSync(join(tmpdir(), "ts2305-empty-")), "CanvasCard");
    expect(f?.suggestedAction).toMatch(/does not export that name/);
  });
});
