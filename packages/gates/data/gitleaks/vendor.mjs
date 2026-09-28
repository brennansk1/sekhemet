// Re-vendors gitleaks' default rule file (MIT) from a downloaded release.
// It makes no network request: download `config/gitleaks.toml` and
// `LICENSE` of one gitleaks release first, with the owner's approval
// (DEC-08), then run
//   node packages/gates/data/gitleaks/vendor.mjs <gitleaks.toml> <LICENSE> <vX.Y.Z> <YYYY-MM-DD>
// It copies both files here byte for byte, prints their SHA-256 and the rule
// count for README.md, and — once `packages/gates` is built — names every
// rule whose pattern JavaScript cannot run (those are reported as not run
// by the bundled scan, never skipped silently). Record the new version,
// date, hashes and count in README.md and NOTICE; `gitleaks_vendored.spec.ts`
// checks the file against the README, and `gitleaks_rules.spec.ts` that
// every rule runs.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [source, licence, version, retrieved] = process.argv.slice(2);
if (
  !source ||
  !licence ||
  !/^v\d+\.\d+\.\d+$/.test(version ?? "") ||
  !/^\d{4}-\d{2}-\d{2}$/.test(retrieved ?? "")
) {
  console.error("usage: vendor.mjs <gitleaks.toml> <LICENSE> <vX.Y.Z> <YYYY-MM-DD>");
  process.exit(2);
}
const toml = readFileSync(source);
const text = readFileSync(licence);
if (!/^MIT License/.test(text.toString("utf8"))) {
  console.error("LICENSE is not gitleaks' MIT licence; nothing written");
  process.exit(1);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
writeFileSync(new URL("./gitleaks.toml", import.meta.url), toml);
writeFileSync(new URL("./LICENSE", import.meta.url), text);
const rules = toml.toString("utf8").match(/^\[\[rules\]\]$/gm) ?? [];
console.log(`gitleaks ${version}, retrieved ${retrieved}`);
console.log(`gitleaks.toml SHA-256 ${sha(toml)} (${rules.length} \`[[rules]]\`)`);
console.log(`LICENSE SHA-256 ${sha(text)}`);

const built = new URL("../../dist/gitleaks_rules.js", import.meta.url);
if (existsSync(built)) {
  const { parseGitleaksRules } = await import(built.href);
  const set = parseGitleaksRules(toml.toString("utf8"), version);
  console.log(`${set.rules.length} of ${set.total} rules run in JavaScript`);
  for (const r of set.notRun) console.log(`not run: ${r.id}: ${r.reason}`);
} else {
  console.log("build packages/gates (npx tsc -b) to check which rules run in JavaScript");
}
