/**
 * The Semgrep rule set shipped with Sekhemet (GT-N5-4, DEC-44).
 *
 * When a project has no `.sekhemet/semgrep.yml`, the semgrep gate runs these
 * rules instead of skipping. They are Sekhemet's own (Semgrep's registry
 * forbids redistribution), usable offline, and the evidence names them by
 * version and content hash. The rule file is written in YAML's JSON-compatible
 * flow style, so it is a Semgrep config and also readable with JSON.parse.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BundledRuleSet {
  /** Absolute path of the rule file, for `semgrep scan --config <path>`. */
  path: string;
  name: string;
  version: string;
  /** sha256 of the rule file's bytes. */
  sha256: string;
  rules: number;
}

// `../rules` resolves from both src/ and dist/, which sit side by side.
const RULES_URL = new URL("../rules/semgrep/sekhemet-offline.yml", import.meta.url);
const MANIFEST_URL = new URL("../rules/semgrep/manifest.json", import.meta.url);

let cached: BundledRuleSet | undefined;

/**
 * The bundled rule set. Throws when the rule file and its manifest disagree on
 * the rule count or version, so a stale manifest never names the wrong rules.
 */
export function bundledSemgrepRuleSet(): BundledRuleSet {
  if (cached) return cached;
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as {
    name: string;
    version: string;
    rules: number;
  };
  const bytes = readFileSync(RULES_URL);
  const rules = (
    JSON.parse(bytes.toString("utf8")) as {
      rules: Array<{ metadata?: { ruleset_version?: string } }>;
    }
  ).rules;
  if (rules.length !== manifest.rules) {
    throw new Error(
      `bundled semgrep rules: the manifest counts ${manifest.rules} rules, the rule file holds ${rules.length}`,
    );
  }
  const stale = rules.find((r) => r.metadata?.ruleset_version !== manifest.version);
  if (stale) {
    throw new Error(
      `bundled semgrep rules: a rule is marked version ${stale.metadata?.ruleset_version}, the manifest says ${manifest.version}`,
    );
  }
  cached = {
    path: fileURLToPath(RULES_URL),
    name: manifest.name,
    version: manifest.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rules: rules.length,
  };
  return cached;
}

/** How evidence names a rule set, e.g. `sekhemet-offline 1.0.0 (sha256 0123456789ab…)`. */
export function ruleSetLabel(r: Pick<BundledRuleSet, "name" | "version" | "sha256">): string {
  return `${r.name} ${r.version} (sha256 ${r.sha256.slice(0, 12)}…)`;
}
