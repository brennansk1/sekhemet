import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factKeysOf } from "../src/facts.js";
import { PlaybookRegistry, errorPatternMatches, ruleFactKeys } from "../src/playbook.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHRONICLE_PLAYBOOK = resolve(here, "../../../fixtures/chronicle/.sekhemet/playbook.toml");
const TS2375_REMEDY =
  "exactOptionalPropertyTypes is on: an optional property may be absent but may not be set to undefined. Omit the property (`{ valid: false, totalEvents: n }`), or add it only when defined: `...(value !== undefined ? { key: value } : {})`.";

let repo: string;
let file: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sekhemet-pb-"));
  mkdirSync(join(repo, ".sekhemet"));
  file = join(repo, ".sekhemet", "playbook.toml");
  copyFileSync(CHRONICLE_PLAYBOOK, file);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("addTransientRule (Integration review A5)", () => {
  it("adds a rule for this process without touching playbook.toml", () => {
    const before = readFileSync(file, "utf8");
    const pb = new PlaybookRegistry(repo);
    pb.addTransientRule({
      id: "learned_ts2322",
      pattern: "src/",
      instruction: "Map rows field by field.",
      errorPattern: "TS2322",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(pb.isTransient("learned_ts2322")).toBe(true);
    expect(pb.getAllRules().map((r) => r.id)).toContain("learned_ts2322");
    expect(pb.getPersistentRules().map((r) => r.id)).not.toContain("learned_ts2322");
    expect(new PlaybookRegistry(repo).getAllRules().map((r) => r.id)).not.toContain(
      "learned_ts2322",
    );
  });

  it("a later save (addRule) writes neither the transient rule nor loses the file's comments", () => {
    const pb = new PlaybookRegistry(repo);
    pb.addTransientRule({ id: "learned_x", pattern: "src/", instruction: "transient" });
    // Shadow a file rule transiently; the file keeps the original.
    pb.addTransientRule({ id: "rule_hash_input_type", pattern: "src/", instruction: "shadow" });
    pb.addRule({ id: "rule_human", pattern: "src/", instruction: "A human kept this one." });
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("# Project Chronicle playbook.\n#\n# Each rule was derived")).toBe(true);
    expect(text).not.toContain("learned_x");
    expect(text).not.toContain('instruction = "shadow"');
    expect(text).toContain("A function that computes a hash cannot require the hash as input.");
    const reloaded = new PlaybookRegistry(repo);
    expect(reloaded.getAllRules().map((r) => r.id)).toEqual([
      "rule_esm_extensions",
      "rule_exact_optional",
      "rule_finish_promptly",
      "rule_hash_input_type",
      "rule_human",
      "rule_node_sqlite",
    ]);
  });

  it("retiring a transient rule never rewrites the file; clearTransientRules drops them all", () => {
    const pb = new PlaybookRegistry(repo);
    const before = readFileSync(file, "utf8");
    pb.addTransientRule({ id: "a", pattern: "src/", instruction: "a" });
    pb.addTransientRule({ id: "b", pattern: "src/", instruction: "b" });
    expect(pb.retireRule("a")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    pb.clearTransientRules();
    expect(pb.getAllRules()).toHaveLength(5);
  });
});

describe("matchRules scoping (Integration review A4)", () => {
  it("an error-scoped rule matches only while its error stands", () => {
    const pb = new PlaybookRegistry(repo);
    pb.addTransientRule({
      id: "learned_rows",
      pattern: "src/",
      instruction: "Cast database rows through unknown.",
      errorPattern: "TS2352",
    });
    const card = { cardTitle: "Ledger store", scopeFiles: ["src/ledger.ts"] };
    const ids = (failureText?: string) =>
      pb
        .matchRules({ ...card, ...(failureText !== undefined ? { failureText } : {}) })
        .map((r) => r.id);
    expect(ids()).not.toContain("learned_rows");
    expect(ids("src/ledger.ts:4:1 TS2322: Type 'x'")).not.toContain("learned_rows");
    expect(ids("src/ledger.ts:4:1 TS2352: Conversion of type")).toContain("learned_rows");
    // A code matches as a word, not as a prefix.
    expect(errorPatternMatches("TS2352", "TS23521")).toBe(false);
    expect(errorPatternMatches("Cannot find module '\\w+'", "Cannot find module 'zod'")).toBe(true);
    expect(errorPatternMatches("[unclosed", "an [unclosed bracket")).toBe(true);
  });

  it("a failing gate no longer pulls in another card's rules; it ranks the card's own first", () => {
    const pb = new PlaybookRegistry(repo);
    pb.addTransientRule({
      id: "vanguard_hmac",
      pattern: "src/hmac.ts",
      triggerGate: "typecheck",
      instruction: "Use timingSafeEqual.",
    });
    const matched = pb.matchRules({
      cardTitle: "Ledger",
      scopeFiles: ["src/ledger.ts"],
      triggerGate: "test",
    });
    expect(matched.map((r) => r.id)).not.toContain("vanguard_hmac");
    expect(matched[0]?.id).toBe("rule_finish_promptly"); // the one test-gate rule
  });

  it("scope 'card' excludes error-scoped rules, and errorPattern/factKey persist", () => {
    const pb = new PlaybookRegistry(repo);
    pb.addRule({
      id: "rule_rows",
      pattern: "src/",
      instruction: "Cast rows.",
      errorPattern: "TS2352",
      factKey: "sqlite-rows",
    });
    const reloaded = new PlaybookRegistry(repo);
    const rule = reloaded.getAllRules().find((r) => r.id === "rule_rows");
    expect(rule).toMatchObject({ errorPattern: "TS2352", factKey: "sqlite-rows" });
    expect(
      reloaded
        .matchRules({
          cardTitle: "x",
          scopeFiles: ["src/a.ts"],
          failureText: "TS2352",
          scope: "card",
        })
        .map((r) => r.id),
    ).not.toContain("rule_rows");
  });
});

describe("duplicates between seeded rules and remedies (Integration review A3)", () => {
  it("the seeded exactOptional rule and the TS2375 remedy share a fact key", () => {
    const pb = new PlaybookRegistry(repo);
    const rule = pb.getAllRules().find((r) => r.id === "rule_exact_optional");
    expect(ruleFactKeys(rule as never)).toEqual(["exactOptionalPropertyTypes"]);
    expect(factKeysOf(TS2375_REMEDY)).toEqual(["exactOptionalPropertyTypes"]);
    expect(pb.coveringRule(TS2375_REMEDY)?.id).toBe("rule_exact_optional");
    // TS2307 (any unresolved import) is not node:sqlite: no false cover.
    expect(
      ruleFactKeys(pb.getAllRules().find((r) => r.id === "rule_node_sqlite") as never),
    ).toEqual(["TS2307", "node:sqlite"]);
  });

  it("a rule whose fact the prompt already carries is left out, and same-fact rules collapse", () => {
    const pb = new PlaybookRegistry(repo);
    pb.addTransientRule({
      id: "ts_exact_optional",
      pattern: "src/",
      instruction:
        "exactOptionalPropertyTypes is enabled; never assign undefined to an optional field.",
    });
    const card = { cardTitle: "Verifier", scopeFiles: ["src/verify.ts"] };
    const all = pb.matchRules(card).map((r) => r.id);
    expect(all).toContain("rule_exact_optional");
    expect(all).not.toContain("ts_exact_optional"); // same fact, the seeded rule ranks first
    const covered = pb
      .matchRules({ ...card, coveredKeys: factKeysOf(TS2375_REMEDY) })
      .map((r) => r.id);
    expect(covered).not.toContain("rule_exact_optional");
    expect(covered).toContain("rule_node_sqlite");
  });
});
