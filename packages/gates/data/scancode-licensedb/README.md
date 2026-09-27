# ScanCode LicenseDB categories (vendored snapshot)

`categories.json` gives the licence classifier (`packages/gates/src/licence.ts`, design-stage P7, DEC-08) a category for each SPDX licence id: Permissive, Public Domain, Copyleft Limited, Copyleft, Commercial, Proprietary Free, Source-available, Non-Commercial, Free Restricted, Patent License, CLA or Unstated License.

- **Source:** <https://scancode-licensedb.aboutcode.org/index.json> (served `Last-Modified: Mon, 21 Sep 2026 16:11:18 GMT`).
- **Retrieved:** 2026-09-27, once, with the owner's approval.
- **Source SHA-256:** `af662e3b47f3c8ad76009a5581196ab7c36d796628e1eb463bbfcbccfc39a30a` (2,733 entries).
- **`categories.json` SHA-256:** `b565a7febcc5bf76afe0db94e2c53af767e3b2f3fd28fb9fad7ad9d6484d97d8` (2,601 entries).
- **Kept:** each entry's `license_key`, `spdx_license_key`, `other_spdx_license_keys` (so a deprecated id such as `AGPL-3.0` is still found), `category` and `is_exception`. Entries without an SPDX id are left out, and so is a deprecated entry whose SPDX ids a current entry already carries. Nothing else was changed.
- **Rebuild:** download the index, run `node packages/gates/data/scancode-licensedb/vendor.mjs <index.json> <YYYY-MM-DD>`, then `npx biome format --write` on `categories.json`, and record the new hashes here (the test `licence_classifier.spec.ts` checks the file against this README).

## Licence and attribution

The data is from the **ScanCode LicenseDB**, Copyright (c) nexB Inc. and others (AboutCode), <https://scancode-licensedb.aboutcode.org/>, licensed under the **Creative Commons Attribution 4.0 International licence (CC-BY-4.0)**, <https://creativecommons.org/licenses/by/4.0/>. Changes: only the fields listed above were kept, and entries were filtered as described. The data is provided as is, without warranty.
