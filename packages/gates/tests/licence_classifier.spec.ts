import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LINKING_EXCEPTIONS,
  classifyLicence,
  licenceCategories,
  licenceFromTroveClassifiers,
} from "../src/licence.js";

// Design-stage P7 (DEC-08): one SPDX licence classifier, shared by the reuse
// survey and the licence gate. Every verdict here is computed by the
// production classifier from the vendored ScanCode LicenseDB categories.

const DATA = new URL("../data/scancode-licensedb/", import.meta.url);

describe("DS-P7-1: permissive licences are permissive", () => {
  it.each([
    "MIT-0",
    "Zlib",
    "BlueOak-1.0.0",
    "BSL-1.0",
    "MIT AND Apache-2.0",
    "Apache 2.0",
    "BSD-3-Clause",
  ])("%s", (licence) => {
    const c = classifyLicence(licence);
    expect(c.verdict).toBe("permissive");
    expect(c.action).toBe("recommend");
    expect(c.usable).toBe(true);
  });

  it("reads BSL-1.0 as the Boost licence, not ScanCode's key bsl-1.0 (Business Source)", () => {
    const c = classifyLicence("BSL-1.0");
    expect(c.terms).toEqual([
      { id: "BSL-1.0", licenseKey: "boost-1.0", category: "Permissive", verdict: "permissive" },
    ]);
  });

  it("corrects `Apache 2.0` to the SPDX id and says so", () => {
    const c = classifyLicence("Apache 2.0");
    expect(c.spdx).toBe("Apache-2.0");
    expect(c.reasons.join("\n")).toContain('corrected "Apache 2.0" to "Apache-2.0"');
  });

  it("names both terms of an AND", () => {
    const c = classifyLicence("MIT AND Apache-2.0");
    expect(c.spdx).toBe("MIT AND Apache-2.0");
    expect(c.terms.map((t) => t.id)).toEqual(["MIT", "Apache-2.0"]);
  });
});

describe("DS-P7-2: copyleft is flagged or excluded, and absent is dropped", () => {
  it.each(["LGPL-3.0-or-later", "MPL-2.0"])("%s is weak copyleft, flagged", (licence) => {
    const c = classifyLicence(licence);
    expect(c.verdict).toBe("weak_copyleft");
    expect(c.action).toBe("flag");
    expect(c.usable).toBe(false);
  });

  it.each(["GPL-3.0-only", "AGPL-3.0"])("%s is strong copyleft, excluded and named", (licence) => {
    const c = classifyLicence(licence);
    expect(c.verdict).toBe("strong_copyleft");
    expect(c.action).toBe("exclude");
    expect(c.usable).toBe(false);
    expect(c.terms.map((t) => t.id)).toEqual([licence]);
    expect(c.reasons.join("\n")).toContain(licence);
  });

  it.each([undefined, null, "", "   ", "NONE", "UNKNOWN"])("%j is absent, dropped", (licence) => {
    const c = classifyLicence(licence);
    expect(c.verdict).toBe("absent");
    expect(c.action).toBe("drop");
    expect(c.usable).toBe(false);
    expect(c.terms).toEqual([]);
    expect(c.spdx).toBeUndefined();
  });
});

describe("AND takes every obligation, OR the best choice", () => {
  it("an OR with a permissive choice is permissive", () => {
    expect(classifyLicence("GPL-3.0-only OR MIT").verdict).toBe("permissive");
    expect(classifyLicence("(MPL-2.0 OR Apache-2.0)").verdict).toBe("permissive");
  });

  it("an AND with a copyleft term is copyleft", () => {
    expect(classifyLicence("MIT AND GPL-3.0-only").verdict).toBe("strong_copyleft");
    expect(classifyLicence("MIT AND MPL-2.0").verdict).toBe("weak_copyleft");
    expect(classifyLicence("(MIT OR GPL-2.0-only) AND LGPL-2.1-or-later").verdict).toBe(
      "weak_copyleft",
    );
  });

  it("an AND with a proprietary term is proprietary even beside an unknown one", () => {
    expect(classifyLicence("LicenseRef-acme AND SSPL-1.0").verdict).toBe("proprietary");
  });

  it("an OR of an unknown and a proprietary term is unknown", () => {
    expect(classifyLicence("LicenseRef-acme OR SSPL-1.0").verdict).toBe("unknown");
  });

  it("reads an or-later suffix", () => {
    expect(classifyLicence("GPL-2.0+").verdict).toBe("strong_copyleft");
    expect(classifyLicence("LGPL-2.1+").verdict).toBe("weak_copyleft");
  });
});

describe("exceptions", () => {
  it("a linking exception to a strong copyleft licence makes it weak", () => {
    const c = classifyLicence("GPL-2.0-only WITH Classpath-exception-2.0");
    expect(c.verdict).toBe("weak_copyleft");
    expect(c.terms[0]).toMatchObject({ id: "GPL-2.0-only WITH Classpath-exception-2.0" });
  });

  it("an exception to a permissive licence leaves it permissive", () => {
    expect(classifyLicence("Apache-2.0 WITH LLVM-exception").verdict).toBe("permissive");
  });

  // Review of B4.5: only a linking exception lowers strong copyleft. The
  // Autoconf exception covers the generated configure script, the font
  // exception a document embedding the font, the syscall note programs
  // calling the kernel: the package itself stays GPL.
  it.each([
    "GPL-2.0-only WITH Autoconf-exception-2.0",
    "GPL-3.0-only WITH Font-exception-2.0",
    "GPL-2.0 WITH Linux-syscall-note",
    "GPL-3.0-or-later WITH Bison-exception-2.2",
  ])("%s stays strong copyleft, excluded and named", (licence) => {
    const c = classifyLicence(licence);
    expect(c.verdict).toBe("strong_copyleft");
    expect(c.action).toBe("exclude");
    expect(c.terms.map((t) => t.id)).toEqual([licence]);
  });

  it("a linking exception does not lift AGPL's network clause", () => {
    expect(classifyLicence("AGPL-3.0-only WITH Classpath-exception-2.0").verdict).toBe(
      "strong_copyleft",
    );
  });

  it.each([
    "GPL-3.0-only WITH GCC-exception-3.1",
    "GPL-2.0-or-later WITH GNAT-exception",
    "GPL-3.0-only WITH GPL-3.0-linking-exception",
  ])("%s, a linking exception, is weak copyleft", (licence) => {
    expect(classifyLicence(licence).verdict).toBe("weak_copyleft");
  });

  it("every linking exception named is an exception in the ScanCode snapshot", () => {
    for (const id of LINKING_EXCEPTIONS)
      expect(licenceCategories().get(id.toLowerCase())?.isException, id).toBe(true);
  });
});

describe("lower-case operators (review of B4.5: two parser versions)", () => {
  // spdx-satisfies 6 parses with spdx-expression-parse 3, which rejects the
  // lower-case operators version 5 accepts.
  it.each([
    ["MIT or Apache-2.0", "permissive"],
    ["MIT and Apache-2.0", "permissive"],
    ["MIT and GPL-3.0-only", "strong_copyleft"],
    ["GPL-2.0-only with Classpath-exception-2.0", "weak_copyleft"],
    ["(MIT or GPL-3.0-only) and MPL-2.0", "weak_copyleft"],
  ])("%s → %s", (licence, verdict) => {
    const c = classifyLicence(licence);
    expect(c.reasons.join("\n")).not.toMatch(/Unexpected/);
    expect(c.verdict).toBe(verdict);
  });
});

describe("PyPI trove classifiers (review of B4.5)", () => {
  const osi = (name: string) => `License :: OSI Approved :: ${name}`;
  it.each([
    ["Python Software Foundation License", "permissive"],
    ["ISC License (ISCL)", "permissive"],
    ["The Unlicense (Unlicense)", "permissive"],
    ["MIT License", "permissive"],
    ["Apache Software License", "permissive"],
    ["BSD License", "permissive"],
    ["Mozilla Public License 2.0 (MPL 2.0)", "weak_copyleft"],
    ["GNU Lesser General Public License v3 (LGPLv3)", "weak_copyleft"],
    ["GNU General Public License v2 (GPLv2)", "strong_copyleft"],
    ["GNU Affero General Public License v3", "strong_copyleft"],
  ])("%s → %s", (name, verdict) => {
    expect(classifyLicence(licenceFromTroveClassifiers([osi(name)])).verdict).toBe(verdict);
  });

  it("reads every licence classifier, not the first alphabetically: all obligations apply", () => {
    const expression = licenceFromTroveClassifiers([
      "Development Status :: 5 - Production/Stable",
      osi("Apache Software License"),
      osi("GNU General Public License v2 (GPLv2)"),
    ]);
    const c = classifyLicence(expression);
    expect(c.verdict).toBe("strong_copyleft");
    expect(c.terms.map((t) => t.id)).toEqual(["Apache-2.0", "GPL-2.0-only"]);
  });

  it("a classifier it cannot map is unknown, never skipped", () => {
    const expression = licenceFromTroveClassifiers([
      osi("MIT License"),
      "License :: Freely Distributable",
    ]);
    expect(classifyLicence(expression).verdict).toBe("unknown");
  });

  it("names no licence when no licence classifier is given", () => {
    expect(licenceFromTroveClassifiers(["Programming Language :: Python :: 3"])).toBeUndefined();
    expect(licenceFromTroveClassifiers(["License :: OSI Approved"])).toBeUndefined();
    expect(licenceFromTroveClassifiers(undefined)).toBeUndefined();
  });
});

describe("the strings registries really send", () => {
  it.each([
    ["mit", "permissive"],
    ["MIT/Apache-2.0", "permissive"],
    ["MIT OR Apache 2.0", "permissive"],
    ["mit or gpl-3.0-only", "permissive"],
    ["BSD", "permissive"],
    ["UNLICENSED", "proprietary"],
    ["SSPL-1.0", "proprietary"],
    ["CC-BY-NC-4.0", "proprietary"],
    ["BUSL-1.1", "proprietary"],
    ["SEE LICENSE IN LICENSE.md", "unknown"],
    ["NOASSERTION", "unknown"],
    ["LicenseRef-acme-eula", "unknown"],
    ["a licence of our own", "unknown"],
    ["Unlicense", "permissive"],
    ["CC0-1.0", "permissive"],
    ["0BSD", "permissive"],
    ["ISC", "permissive"],
    ["Python-2.0", "permissive"],
  ])("%s → %s", (licence, verdict) => {
    expect(classifyLicence(licence).verdict).toBe(verdict);
  });

  it("an unknown licence is excluded and explained, never recommended", () => {
    const c = classifyLicence("a licence of our own");
    expect(c.action).toBe("exclude");
    expect(c.reasons.length).toBeGreaterThan(0);
    expect(c.spdx).toBeUndefined();
  });

  it("NOASSERTION means a licence file nobody could name, not no licence", () => {
    expect(classifyLicence("NOASSERTION").action).toBe("exclude");
  });
});

describe("the JSON licence (lead ruling, review of B4.5)", () => {
  it("is excluded and named: its field-of-use clause is not free, and the OSI has not approved it", () => {
    const c = classifyLicence("JSON");
    expect(c.verdict).toBe("proprietary");
    expect(c.action).toBe("exclude");
    expect(c.usable).toBe(false);
    expect(c.terms).toEqual([expect.objectContaining({ id: "JSON", verdict: "proprietary" })]);
    expect(c.reasons.join("\n")).toMatch(/Good, not Evil/);
    expect(c.reasons.join("\n")).toMatch(/OSI/);
  });

  it("carries into an expression: an AND with it is excluded, an OR with a permissive choice is not", () => {
    expect(classifyLicence("MIT AND JSON").verdict).toBe("proprietary");
    expect(classifyLicence("JSON OR MIT").verdict).toBe("permissive");
  });

  it.each(["Beerware", "CC-BY-4.0", "WTFPL"])(
    "%s stays as ScanCode says: permissive",
    (licence) => {
      expect(classifyLicence(licence).verdict).toBe("permissive");
    },
  );
});

describe("the vendored ScanCode LicenseDB snapshot", () => {
  it("is the snapshot the README records, with its source, licence and attribution", () => {
    const raw = readFileSync(new URL("categories.json", DATA));
    const readme = readFileSync(new URL("README.md", DATA), "utf8");
    expect(readme).toContain(createHash("sha256").update(raw).digest("hex"));
    const data = JSON.parse(raw.toString("utf8")) as {
      source: string;
      licence: string;
      sourceSha256: string;
      attribution: string;
    };
    expect(data.source).toBe("https://scancode-licensedb.aboutcode.org/index.json");
    expect(data.licence).toBe("CC-BY-4.0");
    expect(data.attribution).toMatch(/ScanCode LicenseDB/);
    expect(readme).toContain(data.sourceSha256);
    expect(readme).toMatch(/CC-BY-4\.0/);
  });

  it("gives the classifier a category for every current SPDX licence it names", () => {
    const cats = licenceCategories();
    expect(cats.size).toBeGreaterThan(2000);
    expect(cats.get("mit")?.category).toBe("Permissive");
    expect(cats.get("agpl-3.0")?.category).toBe("Copyleft");
  });
});
