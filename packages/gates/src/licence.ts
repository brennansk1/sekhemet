import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The one licence classifier (design-stage P7, DEC-08): the reuse survey,
 * Seshat's and the Researcher's `find_library`, and the licence gate all
 * judge a licence here, so the same string never gets two verdicts.
 *
 * A string is read as an SPDX expression (`spdx-expression-parse`); a
 * string that is not one is corrected term by term (`spdx-correct`, and an
 * exact case-insensitive SPDX id first, since the corrector turns
 * `gpl-3.0-only` into `GPL-3.0-or-later`). Each term gets a category from a
 * vendored ScanCode LicenseDB snapshot (CC-BY-4.0, see
 * `data/scancode-licensedb/README.md`), looked up by SPDX id: ScanCode's own
 * key `bsl-1.0` is the Business Source License, while SPDX `BSL-1.0` is
 * Boost's. The expression's verdict is the first tier, best first, whose
 * terms alone satisfy it (`spdx-satisfies`), so an AND carries every term's
 * obligations and an OR lets the user pick the best choice. The expression
 * handed to `spdx-satisfies` is re-written from the parsed tree with
 * upper-case operators: it parses with its own, older `spdx-expression-parse`
 * (3.x), which rejects the lower-case `or` the 5.x parser here accepts.
 */

export type LicenceVerdict =
  | "permissive"
  | "weak_copyleft"
  | "strong_copyleft"
  | "proprietary"
  | "unknown"
  | "absent";

/**
 * What a search does with a candidate (DS-P7-2): recommend a permissive one,
 * flag weak copyleft, exclude and name anything else, and drop a candidate
 * with no licence silently.
 */
export type LicenceAction = "recommend" | "flag" | "exclude" | "drop";

export interface LicenceTerm {
  /** The term as written in the expression, e.g. `GPL-2.0-only WITH Classpath-exception-2.0`. */
  id: string;
  /** The ScanCode LicenseDB key of the licence, when the snapshot has it. */
  licenseKey?: string;
  /** Its ScanCode category, e.g. `Permissive`, `Copyleft Limited`. */
  category?: string;
  verdict: Exclude<LicenceVerdict, "absent">;
}

export interface LicenceClassification {
  verdict: LicenceVerdict;
  action: LicenceAction;
  /** Only a permissive licence is safe to depend on in any project. */
  usable: boolean;
  /** The SPDX expression that was judged, after any correction. */
  spdx?: string;
  /** Each licence term of the expression, in order, without repeats. */
  terms: LicenceTerm[];
  /** How the verdict was reached: corrections, each term's category, the deciding terms. */
  reasons: string[];
}

export interface LicenceCategory {
  /** The SPDX id as the snapshot writes it. */
  spdx: string;
  licenseKey: string;
  category: string;
  isException: boolean;
}

interface SpdxLeaf {
  license: string;
  plus?: true;
  exception?: string;
}
interface SpdxConjunction {
  left: SpdxNode;
  conjunction: "and" | "or";
  right: SpdxNode;
}
type SpdxNode = SpdxLeaf | SpdxConjunction;

const require = createRequire(import.meta.url);
const parse = require("spdx-expression-parse") as (expression: string) => SpdxNode;
const satisfies = require("spdx-satisfies") as (expression: string, approved: string[]) => boolean;
const correct = require("spdx-correct") as (
  identifier: string,
  options?: { upgrade?: boolean },
) => string | null;

// `../data` resolves from both src/ and dist/, which sit side by side.
const DATA_URL = new URL("../data/scancode-licensedb/categories.json", import.meta.url);

let categories: Map<string, LicenceCategory> | undefined;

/** The vendored ScanCode categories, by lower-cased SPDX id. */
export function licenceCategories(): ReadonlyMap<string, LicenceCategory> {
  if (categories) return categories;
  const data = JSON.parse(readFileSync(DATA_URL, "utf8")) as {
    entries: Array<{
      license_key: string;
      spdx_license_key: string;
      other_spdx_license_keys?: string[];
      category: string;
      is_exception: boolean;
    }>;
  };
  const map = new Map<string, LicenceCategory>();
  for (const e of data.entries)
    for (const spdx of [e.spdx_license_key, ...(e.other_spdx_license_keys ?? [])])
      map.set(spdx.toLowerCase(), {
        spdx,
        licenseKey: e.license_key,
        category: e.category,
        isException: e.is_exception,
      });
  categories = map;
  return map;
}

/** Best first: an OR takes the earliest tier any choice reaches, an AND the latest. */
const TIERS = ["permissive", "weak_copyleft", "strong_copyleft", "unknown", "proprietary"] as const;
type Tier = (typeof TIERS)[number];

const TIER_OF_CATEGORY: Readonly<Record<string, Tier>> = {
  Permissive: "permissive",
  "Public Domain": "permissive",
  "Copyleft Limited": "weak_copyleft",
  Copyleft: "strong_copyleft",
  Commercial: "proprietary",
  "Proprietary Free": "proprietary",
  "Source-available": "proprietary",
  "Non-Commercial": "proprietary",
  "Free Restricted": "proprietary",
  // Patent License, CLA and Unstated License say nothing about copying.
};

const WORDS: Readonly<Record<Tier, string>> = {
  permissive: "permissive",
  weak_copyleft: "weak copyleft",
  strong_copyleft: "strong copyleft",
  unknown: "of unknown terms",
  proprietary: "proprietary or restricted",
};

const ACTION: Readonly<Record<LicenceVerdict, LicenceAction>> = {
  permissive: "recommend",
  weak_copyleft: "flag",
  strong_copyleft: "exclude",
  proprietary: "exclude",
  unknown: "exclude",
  absent: "drop",
};

function result(
  verdict: LicenceVerdict,
  reasons: string[],
  terms: LicenceTerm[] = [],
  spdx?: string,
): LicenceClassification {
  return {
    verdict,
    action: ACTION[verdict],
    usable: verdict === "permissive",
    ...(spdx ? { spdx } : {}),
    terms,
    reasons,
  };
}

function tryParse(expression: string): SpdxNode | undefined {
  try {
    return parse(expression);
  } catch {
    return undefined;
  }
}

/** One term of a non-SPDX string, corrected; `undefined` when it cannot be. */
function correctTerm(term: string): string | undefined {
  const known = licenceCategories().get(term.toLowerCase())?.spdx;
  if (known && tryParse(known)) return known;
  const corrected = correct(term, { upgrade: false }) ?? undefined;
  return corrected && tryParse(corrected) ? corrected : undefined;
}

/**
 * A string that is not an SPDX expression, corrected term by term: lower-case
 * operators, Cargo's old `MIT/Apache-2.0`, and names like `Apache 2.0`.
 */
function corrected(text: string, reasons: string[]): string | undefined {
  const pieces = text
    .replace(/\s*\/\s*/g, " OR ")
    .split(/(\s+(?:AND|OR|WITH)\s+|[()])/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    if (/^(AND|OR|WITH)$/i.test(piece)) out.push(piece.toUpperCase());
    else if (piece === "(" || piece === ")") out.push(piece);
    else {
      const term = correctTerm(piece);
      if (!term) return undefined;
      if (term !== piece) reasons.push(`corrected "${piece}" to "${term}"`);
      out.push(term);
    }
  }
  const expression = out.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
  return tryParse(expression) ? expression : undefined;
}

/**
 * The SPDX exceptions that let independent code link with the covered
 * library under its own terms, leaving only file-level copyleft: a runtime
 * library's (GCC, GNAT, Swift), a class library's (Classpath, JavaMail) or a
 * general linking exception. Only these lower strong copyleft to weak. An
 * exception for a generated file (Autoconf, Bison, Libtool), an embedded font,
 * the kernel's syscall interface or linking one named library (OpenSSL) leaves
 * the package itself under its licence. Every id is an exception in the
 * ScanCode snapshot (`licence_classifier.spec.ts`).
 */
export const LINKING_EXCEPTIONS: ReadonlySet<string> = new Set([
  "Classpath-exception-2.0",
  "Classpath-exception-2.0-short",
  "eCos-exception-2.0",
  "erlang-otp-linking-exception",
  "Fawkes-Runtime-exception",
  "FLTK-exception",
  "freertos-exception-2.0",
  "GCC-exception-2.0",
  "GCC-exception-2.0-note",
  "GCC-exception-3.1",
  "GNAT-exception",
  "gnu-javamail-exception",
  "GNU-compiler-exception",
  "GPL-3.0-linking-exception",
  "GPL-3.0-linking-source-exception",
  "harbour-exception",
  "Independent-modules-exception",
  "LGPL-3.0-linking-exception",
  "LLVM-exception",
  "mif-exception",
  "OCaml-LGPL-linking-exception",
  "Qwt-exception-1.0",
  "Swift-exception",
  "SWI-exception",
  "WxWindows-exception-3.1",
]);
const LINKING = new Set([...LINKING_EXCEPTIONS].map((id) => id.toLowerCase()));

/** The expression from its tree, operators upper-case, for `spdx-satisfies`' own parser. */
function render(node: SpdxNode, parent?: "and" | "or"): string {
  if (!("conjunction" in node)) return leafText(node);
  const text = `${render(node.left, node.conjunction)} ${node.conjunction.toUpperCase()} ${render(node.right, node.conjunction)}`;
  return parent && parent !== node.conjunction ? `(${text})` : text;
}

function leaves(node: SpdxNode, out: SpdxLeaf[] = []): SpdxLeaf[] {
  if ("conjunction" in node) {
    leaves(node.left, out);
    leaves(node.right, out);
  } else out.push(node);
  return out;
}

const leafText = (l: SpdxLeaf) =>
  `${l.license}${l.plus ? "+" : ""}${l.exception ? ` WITH ${l.exception}` : ""}`;

/**
 * Licences ruled on over ScanCode's category, by lower-cased SPDX id, each
 * with its reason. Only a lead's or the owner's recorded ruling adds one
 * (design-stage P7): Beerware, CC-BY-4.0 and WTFPL stay as ScanCode says.
 */
const RULED: ReadonlyMap<string, { verdict: Tier; reason: string }> = new Map([
  [
    "json",
    {
      verdict: "proprietary",
      reason:
        "JSON: excluded by the lead's ruling (review of B4.5) over ScanCode's Permissive: its clause \"The Software shall be used for Good, not Evil\" restricts the field of use, so it is widely treated as non-free, and the OSI has not approved it",
    },
  ],
]);

function classifyTerm(leaf: SpdxLeaf, reasons: string[]): LicenceTerm {
  const id = leafText(leaf);
  const hit = licenceCategories().get(leaf.license.toLowerCase());
  if (!hit || hit.isException) {
    reasons.push(`${id}: not in the ScanCode LicenseDB snapshot`);
    return { id, verdict: "unknown" };
  }
  let verdict: Tier = TIER_OF_CATEGORY[hit.category] ?? "unknown";
  reasons.push(`${leaf.license}: ${hit.category} (ScanCode ${hit.licenseKey})`);
  const ruled = RULED.get(leaf.license.toLowerCase());
  if (ruled) {
    verdict = ruled.verdict;
    reasons.push(ruled.reason);
  }
  if (leaf.exception) {
    const ex = licenceCategories().get(leaf.exception.toLowerCase());
    const linking = ex?.isException === true && LINKING.has(leaf.exception.toLowerCase());
    reasons.push(
      ex?.isException
        ? `${leaf.exception}: ${ex.category} exception (ScanCode ${ex.licenseKey})${linking ? ", a linking exception" : ", not a linking exception"}`
        : `${leaf.exception}: not an exception in the ScanCode LicenseDB snapshot`,
    );
    // A linking exception (GCC's, Classpath) leaves only file-level copyleft;
    // AGPL's network clause is not about linking, so it stays.
    if (verdict === "strong_copyleft" && linking && !/^AGPL/i.test(leaf.license))
      verdict = "weak_copyleft";
  }
  return { id, licenseKey: hit.licenseKey, category: hit.category, verdict };
}

/** Classify a licence string from a registry, a manifest or a repository. */
export function classifyLicence(expression: string | null | undefined): LicenceClassification {
  const text = (expression ?? "").trim();
  if (!text || /^(NONE|UNKNOWN)$/i.test(text)) return result("absent", ["no licence given"]);
  if (/^UNLICENSED$/i.test(text))
    return result("proprietary", ["UNLICENSED: npm's word for not licensed for use by others"]);
  if (/^SEE LICEN[CS]E IN\b/i.test(text))
    return result("unknown", [`"${text}": a licence file, not an SPDX expression`]);
  if (/^NOASSERTION$/i.test(text))
    return result("unknown", ["NOASSERTION: a licence nobody could name"]);

  const reasons: string[] = [];
  const written = tryParse(text) ? text : corrected(text, reasons);
  const tree = written ? tryParse(written) : undefined;
  if (!written || !tree)
    return result("unknown", [`"${text}" is not an SPDX expression and could not be corrected`]);
  const spdx = render(tree);

  const terms: LicenceTerm[] = [];
  for (const leaf of leaves(tree))
    if (!terms.some((t) => t.id === leafText(leaf))) terms.push(classifyTerm(leaf, reasons));

  for (const tier of TIERS) {
    const rank = TIERS.indexOf(tier);
    const allowed = terms.filter((t) => TIERS.indexOf(t.verdict as Tier) <= rank);
    if (!allowed.length) continue;
    let met: boolean;
    try {
      met = satisfies(
        spdx,
        allowed.map((t) => t.id),
      );
    } catch (err) {
      reasons.push(`${spdx}: ${(err as Error).message}`);
      return result("unknown", reasons, terms, spdx);
    }
    if (met) {
      const deciding = allowed.filter((t) => t.verdict === tier).map((t) => t.id);
      reasons.push(`${WORDS[tier]}: ${deciding.join(", ")}`);
      return result(tier, reasons, terms, spdx);
    }
  }
  // Unreachable: the last tier allows every term, which satisfies any expression.
  return result("unknown", reasons, terms, spdx);
}

/**
 * PyPI's licence trove classifiers (`License :: OSI Approved :: …`), by
 * their last segment, as SPDX ids. A version the classifier leaves open is
 * read as the one PyPI's own guidance maps it to.
 */
const TROVE: Readonly<Record<string, string>> = {
  "Academic Free License (AFL)": "AFL-3.0",
  "Apache Software License": "Apache-2.0",
  "Apple Public Source License": "APSL-2.0",
  "Artistic License": "Artistic-2.0",
  "Attribution Assurance License": "AAL",
  "Blue Oak Model License (BlueOak-1.0.0)": "BlueOak-1.0.0",
  "Boost Software License 1.0 (BSL-1.0)": "BSL-1.0",
  "BSD License": "BSD-3-Clause",
  "CEA CNRS Inria Logiciel Libre License, version 2.1 (CeCILL-2.1)": "CECILL-2.1",
  "CMU License (MIT-CMU)": "MIT-CMU",
  "Common Development and Distribution License 1.0 (CDDL-1.0)": "CDDL-1.0",
  "Common Public License": "CPL-1.0",
  "Eclipse Public License 1.0 (EPL-1.0)": "EPL-1.0",
  "Eclipse Public License 2.0 (EPL-2.0)": "EPL-2.0",
  "Educational Community License, Version 2.0 (ECL-2.0)": "ECL-2.0",
  "Eiffel Forum License": "EFL-2.0",
  "European Union Public Licence 1.0 (EUPL 1.0)": "EUPL-1.0",
  "European Union Public Licence 1.1 (EUPL 1.1)": "EUPL-1.1",
  "European Union Public Licence 1.2 (EUPL 1.2)": "EUPL-1.2",
  "GNU Affero General Public License v3": "AGPL-3.0-only",
  "GNU Affero General Public License v3 or later (AGPLv3+)": "AGPL-3.0-or-later",
  "GNU Free Documentation License (FDL)": "GFDL-1.3-or-later",
  "GNU General Public License (GPL)": "GPL-1.0-or-later",
  "GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
  "GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
  "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
  "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
  "GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
  "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.0-or-later",
  "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
  "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
  "GNU Library or Lesser General Public License (LGPL)": "LGPL-2.0-or-later",
  "Historical Permission Notice and Disclaimer (HPND)": "HPND",
  "IBM Public License": "IPL-1.0",
  "Intel Open Source License": "Intel",
  "ISC License (ISCL)": "ISC",
  "MirOS License (MirOS)": "MirOS",
  "MIT License": "MIT",
  "MIT No Attribution License (MIT-0)": "MIT-0",
  "Motosoto License": "Motosoto",
  "Mozilla Public License 1.0 (MPL)": "MPL-1.0",
  "Mozilla Public License 1.1 (MPL 1.1)": "MPL-1.1",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "Mulan Permissive Software License v2 (MulanPSL-2.0)": "MulanPSL-2.0",
  "Nethack General Public License": "NGPL",
  "Nokia Open Source License": "Nokia",
  "Open Group Test Suite License": "OGTSL",
  "Open Software License 3.0 (OSL-3.0)": "OSL-3.0",
  "PostgreSQL License": "PostgreSQL",
  "Python License (CNRI Python License)": "CNRI-Python",
  "Python Software Foundation License": "PSF-2.0",
  "Qt Public License (QPL)": "QPL-1.0",
  "Ricoh Source Code Public License": "RSCPL",
  "SIL Open Font License 1.1 (OFL-1.1)": "OFL-1.1",
  "Sleepycat License": "Sleepycat",
  "Sun Industry Standards Source License (SISSL)": "SISSL",
  "Sun Public License": "SPL-1.0",
  "The Unlicense (Unlicense)": "Unlicense",
  "Universal Permissive License (UPL)": "UPL-1.0",
  "University of Illinois/NCSA Open Source License": "NCSA",
  "Vovida Software License 1.0": "VSL-1.0",
  "W3C License": "W3C",
  "X.Net License": "Xnet",
  "Zero-Clause BSD (0BSD)": "0BSD",
  "zlib/libpng License": "Zlib",
  "Zope Public License": "ZPL-2.1",
  "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication": "CC0-1.0",
};

/** Classifiers that say a licence is approved, not which one. */
const TROVE_META = new Set(["License :: OSI Approved", "License :: DFSG approved"]);

/**
 * The SPDX expression a PyPI project's licence classifiers state, or
 * `undefined` when it lists none. Every licence classifier counts, joined
 * with AND: PyPI sorts classifiers alphabetically, so the first says nothing
 * about which governs, and a project listing Apache and GPL may be bound by
 * GPL. A classifier with no SPDX equivalent becomes a `LicenseRef-` term,
 * which is unknown, so the project is never judged on the others alone.
 */
export function licenceFromTroveClassifiers(
  classifiers: readonly string[] | null | undefined,
): string | undefined {
  const terms: string[] = [];
  for (const c of classifiers ?? []) {
    const trimmed = c.trim();
    if (!trimmed.startsWith("License ::") || TROVE_META.has(trimmed)) continue;
    const name = trimmed.split("::").at(-1)?.trim() ?? "";
    const id =
      TROVE[name] ??
      `LicenseRef-trove-${name.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-|-$/g, "")}`;
    if (!terms.includes(id)) terms.push(id);
  }
  return terms.length ? terms.join(" AND ") : undefined;
}
