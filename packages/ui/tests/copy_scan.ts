/**
 * The copy scan DEC-31 is checked with (dashboard NEW-dashboard-7, DB-N7-1):
 * every string literal of a source, comments and regex literals left out,
 * with identifiers stripped, read for a retired display word. Shared by the
 * dashboard's test (`professional_language.spec.ts`) and the CLI's
 * (`apps/harness/tests/cli_language.spec.ts`).
 */

/** The retired display words, each with the professional word that replaces it (DEC-31). */
export const RETIRED: { re: RegExp; use: string }[] = [
  { re: /\bworkers?\b/i, use: "Agent (assignee) or Coding model (role)" },
  { re: /\bplanners?\b/i, use: "Planning model" },
  {
    re: /\bthe reviewer\b|\breviewer(?:'s)? (?:findings?|model|family)\b|\badversarial reviewer\b/i,
    use: "AI review or Review model",
  },
  { re: /\bthe researcher\b|\bresearcher (?:web access|model)\b/i, use: "Research model" },
  { re: /\bgates?\b/i, use: "checks" },
  { re: /\bcycles?\b(?! time)/i, use: "sprint" },
  { re: /\b(?:un)?qualif(?:y|ied|ies|ication)\b/i, use: "verified on this machine" },
  { re: /indistinguishable/i, use: "no clear difference" },
  { re: /walking skeleton/i, use: "release (walking skeleton only inside Tips)" },
  { re: /must-haves?\b/i, use: "Must have / requirements done" },
  { re: /nice-to-haves?/i, use: "Could have" },
  { re: /\bkano\b/i, use: "Must have / Should have / Could have" },
  { re: /\bslices?\b/i, use: "release" },
  { re: /\blearn (?:layer|mode)\b/i, use: "Tips" },
  { re: /\bevidence bundles?\b/i, use: "the issue's Checks and Activity tabs" },
  { re: /\bdepth profiles?\b/i, use: "the project's Type" },
  // *Card* is the tile on a board and nothing else (DEC-31, NAMING): copy says
  // *issue*, and *board card* is the one way to name the tile. Event names
  // (`card/step`), routes (`#/card/…`) and hyphenated names (`card-zero`,
  // `--shadow-card`) are identifiers, not copy.
  {
    re: /(?<![-\w/#])(?<!\bboard(?:'s)? )cards?(?![-\w/])/i,
    use: "issue (card only for the tile on a board: board card)",
  },
  // DEC-52 (NEW-dashboard-23) and the C1 rename table (FINDINGS_C1): the
  // professional words where the product had coined its own. The code keeps
  // `owner`, `ledger`, `parked`, `appetite`; CLI verbs stay as aliases.
  {
    re: /\bsen[dt](?:s|ing)?[ -]back\b|\bsend(?:s|ing)? (?:it|them|this issue|one) back\b/i,
    use: "Request changes",
  },
  {
    re: /(?<![-/.])\b(?:un)?park(?:s|ed|ing)?\b(?![-/])/i,
    use: "Put on hold / On hold / Take off hold",
  },
  { re: /(?<![-\w/])ledger(?![-\w/])|\bevent log\b|\baudit trail\b/i, use: "Activity log" },
  { re: /\bsuspect\b/i, use: "Needs re-checking" },
  { re: /strength unmet/i, use: "Tests too weak" },
  { re: /\bDone when\b(?! (?:it|its|the|all)\b)/, use: "Acceptance criteria" },
  { re: /\bMay edit\b/, use: "Files in scope" },
  { re: /\bappetite\b/i, use: "Size limit" },
  { re: /\bNeed you\b/, use: "Needs you" },
  { re: /\bthe harness\b|\bharness (?:error|overhead|loads)\b/i, use: "Sekhemet" },
  { re: /\bPM\b/, use: "Seshat" },
  { re: /notice budget/i, use: "notification limit" },
  {
    re: /\bfacts rail\b|\bstored states?\b|\babout enabler\b/i,
    use: "Details / status / enablers",
  },
  { re: /accept-holder/i, use: "a person on the Accept rule" },
  { re: /\bprincipals?\b/i, use: "person" },
  { re: /[a-z]\((?:s|es)\)/, use: "plural()" },
  { re: /\b[Tt]he agent\b/, use: "the Agent" },
  {
    re: /\bmodel registry\b|\bregistry (?:hash|model|entry|lookup)\b|\bthe registry\b|^Registry$|\bskills registry\b/i,
    use: "Sekhemet's model list / Published hash",
  },
  { re: /bake-?offs?\b/i, use: "benchmark" },
  { re: /Seshat's review\b/, use: "Seshat's notes" },
  { re: /sub-researchers?|criterion lint|scope bound|size horizon/i, use: "a plain description" },
  {
    re: /inference socket|escape probe|M0 protocol|golden set/i,
    use: "Model server / Sandbox / first-run benchmark / Research quality",
  },
  { re: /\b(?:TRUNCATED|REWRITTEN|WROTE OUTSIDE|VERIFIED|DRIFTED)\b/, use: "sentence case" },
];

/**
 * What a dashboard page must never print (FINDINGS_C1 R-12, R-13; §A Error
 * messages): an API path with its verb, an HTTP status as the explanation, an
 * environment switch, or a spec, decision or milestone id. Read from the raw
 * literal, because `words` strips identifiers.
 */
export const RAW_RETIRED: { re: RegExp; use: string }[] = [
  { re: /\b(?:GET|POST|PUT|PATCH|DELETE) \/api\//, use: "what failed, in plain words" },
  { re: /\breturned \d{3}\b|\bHTTP \d{3}\b/, use: "what failed, in plain words" },
  { re: /\bSEKHEMET_[A-Z_]+=/, use: "the setting's name in Configuration" },
  {
    re: /\b(?:DEC|SEC|SUR|TEAM|SPEC|EXT)-\d+\b|\b(?:MD|PM|DB|DS|RG|WL|KN|RT|SU)-N\d+|\bNEW-[a-z]+-\d+|\bB\d\.\d+\b/,
    use: "the plain sentence alone",
  },
];

/** The raw-text findings of one literal (`RAW_RETIRED`), interpolations left out. */
export function rawRetiredIn(text: string): string[] {
  const t = text.replace(/\$\{\}/g, " ");
  return RAW_RETIRED.filter((r) => r.re.test(t)).map((r) => `${t.match(r.re)?.[0]} → ${r.use}`);
}

/**
 * The words a person reads in a literal: its text and the attributes a person
 * or a screen reader reads (`aria-label`, `title`, `placeholder`, `alt`), with
 * the identifiers stripped.
 */
export function words(s: string): string {
  const read = [...s.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  return [s, ...read].map(identifiersOut).join(" ").trim();
}

/** What is an identifier, not a word a person reads, and is stripped before the check. */
export function identifiersOut(s: string): string {
  return (
    s
      // Interpolations are code, not copy.
      .replace(/\$\{[^}]*\}/g, " ")
      // CLI flags (`--worker`), which are names a person types, not words.
      .replace(/(?<![\w-])--[a-z][\w-]*/g, " ")
      // HTML attributes and their values (classes, data- names, ids, hrefs).
      .replace(/\b[\w-]+="[^"]*"/g, " ")
      .replace(/\[[\w-]+(?:="[^"]*")?\]/g, " ")
      // API paths, file names, CLI commands and query terms.
      .replace(/\/api\/\S*/g, " ")
      .replace(/\b[\w-]+\.(?:toml|json|ts|js|md)\b/g, " ")
      .replace(/\bsekhemet [a-z-]+(?: [a-z-]+)?/g, " ")
      .replace(/\b[\w-]+:[\w@,-]+/g, " ")
      // Hyphenated, dotted or underscored identifiers (`c-cycle`, `gate_results`).
      .replace(/\b\w+(?:[-_.]\w+)+\b/g, (m) => (/^[a-z]+(?:-[a-z]+)+$/i.test(m) ? m : " "))
      .replace(/<[^>]*>/g, " ")
  );
}

/**
 * Every string literal in a JS or TS source, comments and regex literals left
 * out. A template literal is one text with each `${…}` as a gap; the code in
 * the gap is scanned too, so a template nested in it is a literal of its own.
 */
export function literals(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let i = 0;
  let line = 1;
  const REGEX_BEFORE = /(?:[(,=:[!&|?{};]|\breturn|\btypeof|\bcase)$/;
  function quoted(q: string): void {
    const start = line;
    let s = "";
    for (i++; i < src.length && src[i] !== q; i++) {
      if (src[i] === "\\") {
        s += src[++i];
        continue;
      }
      if (src[i] === "\n") line++;
      s += src[i];
    }
    i++;
    out.push({ line: start, text: s });
  }
  function template(): void {
    const start = line;
    let s = "";
    for (i++; i < src.length && src[i] !== "`"; ) {
      if (src[i] === "\\") {
        s += src[i + 1];
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        s += " ${} ";
        code(true);
      } else {
        if (src[i] === "\n") line++;
        s += src[i++];
      }
    }
    i++;
    out.push({ line: start, text: s });
  }
  function code(inGap: boolean): void {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === "/" && d === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === "/" && d === "*") {
        const end = src.indexOf("*/", i + 2);
        const to = end < 0 ? src.length : end + 2;
        for (; i < to; i++) if (src[i] === "\n") line++;
      } else if (c === "/" && REGEX_BEFORE.test(src.slice(Math.max(0, i - 12), i).trimEnd())) {
        // A regex literal: skipped, so an apostrophe in it starts no string.
        let inClass = false;
        for (i++; i < src.length && src[i] !== "\n"; i++) {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) break;
        }
        i++;
      } else if (c === '"' || c === "'") {
        quoted(c);
      } else if (c === "`") {
        template();
      } else if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        i++;
        if (inGap && depth === 0) return;
        depth--;
      } else i++;
    }
  }
  code(false);
  return out;
}

/** The retired words in one text, after identifiers are stripped. */
export function retiredIn(text: string): string[] {
  const w = words(text);
  // One bare token is an identifier, not copy, unless it is a retired label on
  // its own. A word written a space away from a template's gap is a sentence
  // fragment (`gate ${id}` reads "gate 3"), so it is copy (fix-review C4,
  // onboard's CI lines). `literals` writes a gap as " ${} ", so a space in
  // the source shows as two; `qualify-${role}` and `/${role}/qualify` stay
  // identifiers.
  const besideGap = /[A-Za-z][:,]?\s{2}\$\{\}|\$\{\}\s{2}[A-Za-z]/.test(text);
  if (!/\s/.test(w.trim()) && !besideGap) {
    const m =
      /^(?:Workers?|Planners?|Cycles?|Gates?|Indistinguishable|Qualified|Contract|Storage)$/.exec(
        w.trim(),
      );
    if (m) return [`${m[0]} → a DEC-31 word`];
    // A capitalised token on its own is a label (a tag, a heading): the full list applies.
    if (!/^[A-Z]/.test(w.trim())) return [];
  }
  return RETIRED.filter((r) => r.re.test(w)).map((r) => `${w.match(r.re)?.[0]} → ${r.use}`);
}
