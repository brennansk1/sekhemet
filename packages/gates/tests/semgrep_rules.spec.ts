import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledSemgrepRuleSet, ruleSetLabel } from "../src/semgrep_rules.js";

// GT-N5-4: the offline rule set shipped with Sekhemet (DEC-44: Semgrep's registry
// forbids redistribution, so these rules are our own). Every rule is regex-only so
// it can be checked here without Semgrep, with the same fixtures Semgrep's
// `ruleid:` / `ok:` annotations describe.

const RULES_DIR = fileURLToPath(new URL("../rules/semgrep/", import.meta.url));
const FIXTURES_DIR = join(RULES_DIR, "fixtures");
const RULES_FILE = join(RULES_DIR, "sekhemet-offline.yml");

interface Rule {
  id: string;
  message: string;
  severity: string;
  languages: string[];
  "pattern-regex"?: string;
  "pattern-either"?: Array<Record<string, string>>;
  metadata: { ruleset: string; ruleset_version: string; cwe: string };
}

// The rule file is written in YAML's JSON-compatible flow style, so it is both a
// Semgrep config and readable here without a YAML library.
const rules = (JSON.parse(readFileSync(RULES_FILE, "utf8")) as { rules: Rule[] }).rules;
const manifest = JSON.parse(readFileSync(join(RULES_DIR, "manifest.json"), "utf8")) as {
  name: string;
  version: string;
  rules: number;
  languages: string[];
};

const EXT_LANGUAGE: Record<string, string> = { ts: "typescript", js: "javascript", py: "python" };

function regexesOf(rule: Rule): string[] {
  if (rule["pattern-regex"] !== undefined) return [rule["pattern-regex"]];
  return (rule["pattern-either"] ?? []).map((entry) => {
    expect(Object.keys(entry)).toEqual(["pattern-regex"]);
    return entry["pattern-regex"] as string;
  });
}

/** Constructs that PCRE2 and JavaScript read differently, or that one lacks. */
function nonPortable(source: string): string[] {
  const found: string[] = [];
  for (const [label, needle] of [
    ["lookbehind", "(?<"],
    ["named group", "(?P"],
    ["atomic group", "(?>"],
    ["inline flags", "(?i"],
    ["inline flags", "(?s"],
    ["inline flags", "(?m"],
    ["inline flags", "(?x"],
    ["anchor", "\\A"],
    ["anchor", "\\Z"],
    ["anchor", "\\z"],
    ["anchor", "\\G"],
  ] as const) {
    if (source.includes(needle)) found.push(label);
  }
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[") found.push("nested class");
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (source[i + 1] === "^") i++;
      if (source[i + 1] === "]") found.push("leading ] in class");
      continue;
    }
    if (c === "^" || c === "$") found.push(`anchor ${c}`);
    // A quantifier followed by `+` is possessive in PCRE2 and an error or a
    // different meaning in JavaScript (`(?` opens a group, not a quantifier).
    if ("*+?}".includes(c as string) && source[i - 1] !== "(" && source[i + 1] === "+") {
      found.push("possessive");
    }
  }
  return found;
}

function fixtureOf(rule: Rule): string {
  const stem = rule.id.replace(/^sekhemet\./, "");
  const candidates = Object.keys(EXT_LANGUAGE)
    .map((ext) => join(FIXTURES_DIR, `${stem}.${ext}`))
    .filter((p) => existsSync(p));
  expect(candidates, `one fixture for ${rule.id}`).toHaveLength(1);
  return candidates[0] as string;
}

/** Lines (1-based) that Semgrep's test annotations say must and must not match. */
function annotations(text: string, id: string): { ruleid: Set<number>; ok: Set<number> } {
  const ruleid = new Set<number>();
  const ok = new Set<number>();
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*(?:\/\/|#)\s*(ruleid|ok):\s*(\S+)\s*$/.exec(line);
    if (!m) return;
    expect(m[2], `annotation on line ${i + 1}`).toBe(id);
    const target = lines[i + 1] ?? "";
    expect(target.trim(), `line ${i + 2} follows an annotation`).not.toMatch(/^(?:\/\/|#)|^$/);
    (m[1] === "ruleid" ? ruleid : ok).add(i + 2);
  });
  return { ruleid, ok };
}

/** Start lines of every match, as Semgrep reports a pattern-regex finding. */
function matchedLines(text: string, sources: string[]): Set<number> {
  const out = new Set<number>();
  for (const source of sources) {
    for (const m of text.matchAll(new RegExp(source, "g"))) {
      expect(m[0].length, `zero-length match of ${source}`).toBeGreaterThan(0);
      out.add(text.slice(0, m.index).split("\n").length);
    }
  }
  return out;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("the bundled offline Semgrep rule set (GT-N5-4, DEC-44)", () => {
  it("holds about thirty rules with unique sekhemet.* ids and complete metadata", () => {
    expect(rules.length).toBeGreaterThanOrEqual(28);
    expect(rules.length).toBeLessThanOrEqual(40);
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^sekhemet\.[a-z0-9-]+$/);
      expect(rule.message.length, rule.id).toBeGreaterThan(20);
      expect(["ERROR", "WARNING"]).toContain(rule.severity);
      expect(rule.languages.length, rule.id).toBeGreaterThan(0);
      for (const lang of rule.languages) {
        expect(["typescript", "javascript", "python"]).toContain(lang);
      }
      expect(rule.metadata.ruleset).toBe(manifest.name);
      expect(rule.metadata.ruleset_version).toBe(manifest.version);
      expect(rule.metadata.cwe, rule.id).toMatch(/^CWE-\d+: \S/);
    }
  });

  it("uses only regular expressions that PCRE2 and JavaScript read alike", () => {
    for (const rule of rules) {
      const keys = Object.keys(rule).filter((k) => k.startsWith("pattern"));
      expect(keys.length, rule.id).toBe(1);
      expect(["pattern-regex", "pattern-either"]).toContain(keys[0]);
      const sources = regexesOf(rule);
      expect(sources.length, rule.id).toBeGreaterThan(0);
      for (const source of sources) {
        expect(nonPortable(source), `${rule.id}: ${source}`).toEqual([]);
        expect(() => new RegExp(source), `${rule.id}: ${source}`).not.toThrow();
      }
    }
  });

  it("agrees with its manifest", () => {
    expect(manifest.name).toBe("sekhemet-offline");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.rules).toBe(rules.length);
    expect(manifest.languages).toEqual([...new Set(rules.flatMap((r) => r.languages))].sort());
  });

  it("has exactly one fixture per rule, in one of the rule's languages", () => {
    const stems = new Set(rules.map((r) => r.id.replace(/^sekhemet\./, "")));
    for (const file of readdirSync(FIXTURES_DIR)) {
      expect(stems.has(file.replace(/\.[a-z]+$/, "")), `orphan fixture ${file}`).toBe(true);
    }
    for (const rule of rules) {
      const ext = fixtureOf(rule).split(".").pop() as string;
      expect(rule.languages, rule.id).toContain(EXT_LANGUAGE[ext]);
    }
  });

  for (const rule of rules) {
    it(`${rule.id} matches exactly its ruleid: lines and none of its ok: lines`, () => {
      const text = readFileSync(fixtureOf(rule), "utf8");
      const { ruleid, ok } = annotations(text, rule.id);
      expect(ruleid.size, "positive cases").toBeGreaterThanOrEqual(2);
      expect(ok.size, "negative cases").toBeGreaterThanOrEqual(2);
      const matched = matchedLines(text, regexesOf(rule));
      expect(sorted(matched)).toEqual(sorted(ruleid));
      for (const line of ok) expect(matched.has(line), `ok: line ${line}`).toBe(false);
    });
  }

  it("names its rule set by version and content hash", () => {
    const set = bundledSemgrepRuleSet();
    expect(set.path).toBe(RULES_FILE);
    expect(set.name).toBe(manifest.name);
    expect(set.version).toBe(manifest.version);
    expect(set.rules).toBe(rules.length);
    expect(set.sha256).toBe(createHash("sha256").update(readFileSync(RULES_FILE)).digest("hex"));
    expect(ruleSetLabel(set)).toBe(
      `${manifest.name} ${manifest.version} (sha256 ${set.sha256.slice(0, 12)}…)`,
    );
  });
});

const hasSemgrep = spawnSync("semgrep", ["--version"], { encoding: "utf8" }).status === 0;

describe.runIf(hasSemgrep)("the same fixtures under real Semgrep", () => {
  for (const rule of rules) {
    it(`${rule.id} reports exactly its ruleid: lines`, () => {
      const fixture = fixtureOf(rule);
      const run = spawnSync(
        "semgrep",
        [
          "scan",
          "--config",
          RULES_FILE,
          "--json",
          "--metrics=off",
          "--disable-version-check",
        ].concat(["--quiet", fixture]),
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      expect(run.status, run.stderr).toBe(0);
      const results = (
        JSON.parse(run.stdout) as { results: Array<{ check_id: string; start: { line: number } }> }
      ).results;
      // Semgrep prefixes a local config's rule ids with the config's directory.
      const mine = results.filter(
        (r) => r.check_id === rule.id || r.check_id.endsWith(`.${rule.id}`),
      );
      const lines = new Set(mine.map((r) => r.start.line));
      const { ruleid } = annotations(readFileSync(fixture, "utf8"), rule.id);
      expect(sorted(lines)).toEqual(sorted(ruleid));
    });
  }
});
