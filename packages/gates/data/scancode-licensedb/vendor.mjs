// Rebuilds categories.json from a downloaded ScanCode LicenseDB index.json
// (https://scancode-licensedb.aboutcode.org/index.json, CC-BY-4.0). It makes
// no network request: download the index first, then run
//   node packages/gates/data/scancode-licensedb/vendor.mjs <index.json> <retrieved-date>
// then `npx biome format --write` on categories.json, and record the new
// SHA-256 values in README.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [source, retrieved] = process.argv.slice(2);
if (!source || !/^\d{4}-\d{2}-\d{2}$/.test(retrieved ?? "")) {
  console.error("usage: vendor.mjs <index.json> <YYYY-MM-DD>");
  process.exit(2);
}
const raw = readFileSync(source);
const index = JSON.parse(raw.toString("utf8"));

// Only the fields the classifier reads. A deprecated ScanCode entry is kept
// only for an SPDX id no current entry carries (e.g. `eCos-2.0`).
const ids = (e) => [e.spdx_license_key, ...(e.other_spdx_license_keys ?? [])].filter(Boolean);
const current = new Set(index.filter((e) => !e.is_deprecated).flatMap(ids));
const entries = index
  .filter((e) => e.spdx_license_key)
  .filter((e) => !e.is_deprecated || ids(e).some((id) => !current.has(id)))
  .map((e) => ({
    license_key: e.license_key,
    spdx_license_key: e.spdx_license_key,
    ...(e.other_spdx_license_keys?.length
      ? { other_spdx_license_keys: e.other_spdx_license_keys }
      : {}),
    category: e.category,
    is_exception: Boolean(e.is_exception),
  }))
  .sort((a, b) => a.license_key.localeCompare(b.license_key));

const body = `${JSON.stringify(
  {
    source: "https://scancode-licensedb.aboutcode.org/index.json",
    retrieved,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    licence: "CC-BY-4.0",
    attribution:
      "ScanCode LicenseDB, Copyright (c) nexB Inc. and others (AboutCode), https://scancode-licensedb.aboutcode.org/",
    entries,
  },
  null,
  2,
)}\n`;
const out = new URL("./categories.json", import.meta.url);
writeFileSync(out, body);
console.log(
  `${entries.length} entries; categories.json sha256 ${createHash("sha256").update(body).digest("hex")}`,
);
