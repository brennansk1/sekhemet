import { readFileSync } from "node:fs";
import { parseToml } from "@sekhemet/kernel";

/**
 * gitleaks' own default rule file, vendored at
 * `packages/gates/data/gitleaks/gitleaks.toml` (v8.30.1, MIT; DEC-43,
 * DEC-44), read as the bundled offline secret rule set. The built-in scan
 * and the gitleaks program then report the same rule ids.
 *
 * gitleaks' patterns are Go (RE2) regular expressions. `goRegexToJs`
 * rewrites the syntax JavaScript spells differently — Go's inline `(?i)` and
 * `(?s)` without RegExp modifier groups (so the rules run on Node 22's V8),
 * `(?P<name>`, `\z`, POSIX classes, a `]` first in a
 * class, Go's `\s` — and refuses what it cannot rewrite exactly (`\Q…\E`,
 * `\p{…}`, `\x{…}`, `\C`, the `U` and `m` flags). A rule it refuses, or whose
 * rewritten pattern JavaScript still cannot compile, is not run and is
 * named in `gitleaksRuleSet().notRun` with the reason; nothing is skipped
 * silently. Known, documented differences that remain: JavaScript's `\S`
 * and `.` treat `\v`, `\r` and Unicode line and space separators as
 * whitespace or line ends where Go does not, and case-insensitive matching
 * does not fold non-ASCII letters (the rules' patterns are ASCII).
 */

export interface GitleaksAllowlist {
  /** gitleaks' `condition`: OR (any configured check) or AND (all of them). */
  condition: "OR" | "AND";
  /** What `regexes` are tested against: the secret (default), the whole match, or its line. */
  regexTarget: "secret" | "match" | "line";
  regexes: RegExp[];
  paths: RegExp[];
  /** Lower-cased; a secret containing one is allowed. */
  stopwords: string[];
  /** Commits (lower-cased hashes) whose findings are allowed; read only by the history scan. */
  commits: string[];
}

export interface SecretRule {
  /** gitleaks' rule id (the id the gitleaks program reports). */
  id: string;
  /** A short name for a person ("GitHub Personal Access Token"). */
  description: string;
  /** The rule's pattern, global; absent for a path-only rule (`pkcs12-file`). */
  pattern?: RegExp;
  /** A secret whose Shannon entropy is at or below this is not reported. */
  minEntropy?: number;
  /** Lower-cased; the rule runs only on text containing one. Empty: always. */
  keywords: string[];
  /** The capture group holding the secret; default the first non-empty group, else the match. */
  secretGroup?: number;
  /** The rule applies only to a file whose path matches. */
  path?: RegExp;
  allowlists: GitleaksAllowlist[];
}

export interface GitleaksRuleSet {
  /** gitleaks' version the file came from. */
  version: string;
  /** How many `[[rules]]` the vendored file holds. */
  total: number;
  rules: SecretRule[];
  /** Rules not run, each with why (a pattern JavaScript cannot run). */
  notRun: { id: string; reason: string }[];
  /** The file's global `[allowlist]`. */
  allowlist: GitleaksAllowlist;
}

export const GITLEAKS_RULES_VERSION = "v8.30.1";

const DATA_URL = new URL("../data/gitleaks/gitleaks.toml", import.meta.url);

const POSIX: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  ascii: "\\x00-\\x7F",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\t\\n\\v\\f\\r ",
  upper: "A-Z",
  word: "\\w",
  xdigit: "0-9A-Fa-f",
};

/** Go's `\s` (RE2: `[\t\n\f\r ]`), narrower than JavaScript's. */
const GO_SPACE = "\\t\\n\\f\\r ";

interface InlineFlags {
  i: boolean;
  s: boolean;
}

/** Go's inline flag letters applied to a state, or why they cannot be. */
function applyFlags(state: InlineFlags, f: string): InlineFlags | { error: string } {
  if (/[^is-]/.test(f)) return { error: `the inline flag (?${f})` };
  const [on = "", off = ""] = f.split("-");
  return {
    i: off.includes("i") ? false : on.includes("i") ? true : state.i,
    s: off.includes("s") ? false : on.includes("s") ? true : state.s,
  };
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const swapCase = (c: number) => (c >= 97 ? c - 32 : c + 32);
const CLASS_ESCAPES: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A class member: its text, and the codes it stands for when it is a literal. */
interface ClassAtom {
  text: string;
  code?: number;
  /** A POSIX class: the ranges it covers, for case closure. */
  ranges?: [number, number][];
  dash?: boolean;
}

/** The other-case letters a class must add so it matches case-insensitively. */
function caseClosure(atoms: ClassAtom[]): string {
  const add: [number, number][] = [];
  const range = (lo: number, hi: number) => {
    for (const [a, b] of [
      [97, 122],
      [65, 90],
    ] as const) {
      const from = Math.max(lo, a);
      const to = Math.min(hi, b);
      if (from <= to) add.push([swapCase(from), swapCase(to)]);
    }
  };
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k] as ClassAtom;
    const dash = atoms[k + 1];
    const b = atoms[k + 2];
    if (a.code !== undefined && dash?.dash && b?.code !== undefined) {
      range(a.code, b.code);
      k += 2;
      continue;
    }
    for (const [lo, hi] of a.ranges ?? []) range(lo, hi);
    if (a.code !== undefined && isLetter(a.code)) range(a.code, a.code);
  }
  return add
    .map(([lo, hi]) =>
      lo === hi ? String.fromCharCode(lo) : `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`,
    )
    .join("");
}

const POSIX_RANGES: Record<string, [number, number][]> = {
  lower: [[97, 122]],
  upper: [[65, 90]],
};

/**
 * A Go (RE2) pattern as a JavaScript one with the same meaning, or why it
 * cannot be rewritten exactly. The result uses no RegExp modifier group
 * (`(?i:…)`), which V8 before 12.5 refuses and Node 22 — the declared floor
 * — ships V8 12.4. A leading `(?i)` that nothing later turns off becomes the
 * `i` flag. Any other inline `i` or `s` is expanded where it applies, the
 * way RE2 scopes it (the rest of the enclosing group, across its
 * alternatives): a letter becomes `[xX]`, a class gains its other-case
 * letters, and `.` under `s` becomes `[\s\S]`. `(?m)` is refused: it has no
 * exact expansion.
 */
export function goRegexToJs(src: string): { source: string; flags: string } | { error: string } {
  let body = src;
  let flags = "";
  let initial: InlineFlags = { i: false, s: false };
  let nativeI = false;
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(src);
  if (lead) {
    const st = applyFlags(initial, lead[1] as string);
    if ("error" in st) return st;
    initial = st;
    body = src.slice(lead[0].length);
    // The whole pattern is case-insensitive unless a later group turns it off.
    if (st.i && !/\(\?[a-zA-Z]*-[a-zA-Z]*i/.test(body)) {
      nativeI = true;
      flags = "i";
    }
  }
  let out = "";
  // The inline flags in force in each open group.
  const frames: InlineFlags[] = [initial];
  const top = () => frames[frames.length - 1] as InlineFlags;
  const foldI = () => top().i && !nativeI;
  const letter = (code: number) =>
    `[${String.fromCharCode(code)}${String.fromCharCode(swapCase(code))}]`;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === undefined) return { error: "a trailing backslash" };
      if (next === "z") out += "$";
      else if (next === "A") out += "^";
      else if (next === "s") out += `[${GO_SPACE}]`;
      else if (next === "Q" || next === "E") return { error: "\\Q…\\E quoting" };
      else if (next === "p" || next === "P") return { error: "a Unicode class (\\p)" };
      else if (next === "C") return { error: "\\C (any byte)" };
      else if (next === "x" && body[i + 2] === "{") return { error: "\\x{…}" };
      else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
        const code = Number.parseInt(body.slice(i + 2, i + 4), 16);
        out += foldI() && isLetter(code) ? letter(code) : body.slice(i, i + 4);
        i += 4;
        continue;
      } else out += `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === "[") {
      // A character class, copied to its end.
      let j = i + 1;
      let neg = "";
      const atoms: ClassAtom[] = [];
      if (body[j] === "^") {
        neg = "^";
        j++;
      }
      if (body[j] === "]") {
        atoms.push({ text: "\\]", code: 93 });
        j++;
      }
      let closed = false;
      while (j < body.length) {
        const c = body[j] as string;
        if (c === "\\") {
          const n = body[j + 1];
          if (n === undefined) return { error: "a trailing backslash" };
          if (n === "s") atoms.push({ text: GO_SPACE });
          else if (n === "p" || n === "P") return { error: "a Unicode class (\\p)" };
          else if (n === "Q" || n === "E") return { error: "\\Q…\\E quoting" };
          else if (n === "x" && body[j + 2] === "{") return { error: "\\x{…}" };
          else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(j + 2, j + 4))) {
            atoms.push({
              text: body.slice(j, j + 4),
              code: Number.parseInt(body.slice(j + 2, j + 4), 16),
            });
            j += 4;
            continue;
          } else if (CLASS_ESCAPES[n] !== undefined) {
            atoms.push({ text: `\\${n}`, code: CLASS_ESCAPES[n] });
          } else if (/[a-zA-Z0-9]/.test(n)) atoms.push({ text: `\\${n}` });
          else atoms.push({ text: `\\${n}`, code: n.charCodeAt(0) });
          j += 2;
          continue;
        }
        if (c === "[" && body[j + 1] === ":") {
          const m = /^\[:(\^?)([a-z]+):\]/.exec(body.slice(j));
          if (m) {
            const set = POSIX[m[2] as string];
            if (!set || m[1]) return { error: `the POSIX class [:${m[1]}${m[2]}:]` };
            atoms.push({ text: set, ranges: POSIX_RANGES[m[2] as string] ?? [] });
            j += m[0].length;
            continue;
          }
        }
        if (c === "[") {
          atoms.push({ text: "\\[", code: 91 });
          j++;
          continue;
        }
        if (c === "]") {
          j++;
          closed = true;
          break;
        }
        atoms.push({ text: c, code: c.charCodeAt(0), ...(c === "-" ? { dash: true } : {}) });
        j++;
      }
      if (!closed) return { error: "an unclosed character class" };
      out += `[${neg}${atoms.map((a) => a.text).join("")}${foldI() ? caseClosure(atoms) : ""}]`;
      i = j;
      continue;
    }
    if (ch === "(") {
      const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(body.slice(i));
      if (named) {
        out += `(?<${named[1]}>`;
        frames.push({ ...top() });
        i += named[0].length;
        continue;
      }
      const inline = /^\(\?([a-zA-Z]*(?:-[a-zA-Z]*)?)([:)])/.exec(body.slice(i));
      if (inline && (inline[1] as string).length > 0) {
        const st = applyFlags(top(), inline[1] as string);
        if ("error" in st) return st;
        if (inline[2] === ")") {
          // A bare flag: the rest of this group.
          frames[frames.length - 1] = st;
        } else {
          out += "(?:";
          frames.push(st);
        }
        i += inline[0].length;
        continue;
      }
      if (body.startsWith("(?:", i)) {
        out += "(?:";
        i += 3;
      } else {
        out += "(";
        i++;
      }
      frames.push({ ...top() });
      continue;
    }
    if (ch === ")") {
      if (frames.length === 1) return { error: "an unbalanced )" };
      out += ")";
      frames.pop();
      i++;
      continue;
    }
    if (ch === "." && top().s) {
      out += "[\\s\\S]";
      i++;
      continue;
    }
    const code = ch.charCodeAt(0);
    out += foldI() && isLetter(code) ? letter(code) : ch;
    i++;
  }
  if (frames.length !== 1) return { error: "an unclosed group" };
  return { source: out, flags };
}

/** A Go pattern compiled for JavaScript, or why not. */
function compile(src: string, flags = ""): RegExp | { error: string } {
  const js = goRegexToJs(src);
  if ("error" in js) return js;
  try {
    return new RegExp(js.source, flags + js.flags);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A short name for a person from gitleaks' sentence ("Uncovered a GitHub
 * Personal Access Token, potentially leading to …" gives "GitHub Personal
 * Access Token"); the rule id when the sentence names nothing short.
 */
export function ruleName(id: string, description: string): string {
  const name = description
    .replace(
      /^(?:Discovered|Identified|Uncovered|Detected|Found|Captured|Located)\s+(?:an?\s+)?(?:(?:possible|potential)\s+)?/i,
      "",
    )
    .split(
      /,|\.(?:\s|$)|\s+(?:potentially|which|that|risking|posing|exposing|compromising|jeopardizing|allowing|enabling|in|for|could)\s/,
    )[0]
    ?.trim();
  if (
    !name ||
    name.length > 60 ||
    /^(?:pattern|authorization|basic|password)\b|\sis\s/i.test(name)
  ) {
    return `credential (${id})`;
  }
  return name;
}

type Raw = Record<string, unknown>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

function allowlistOf(raw: Raw, where: string): GitleaksAllowlist | { error: string } {
  const regexes: RegExp[] = [];
  const paths: RegExp[] = [];
  for (const [list, into] of [
    [strings(raw.regexes), regexes],
    [strings(raw.paths), paths],
  ] as const) {
    for (const p of list) {
      const r = compile(p);
      if (r instanceof RegExp) into.push(r);
      // An allowlist pattern that cannot run would report what gitleaks
      // allows; the whole rule is then not run rather than over-reporting.
      else return { error: `${where} allowlist pattern ${JSON.stringify(p)}: ${r.error}` };
    }
  }
  return {
    condition: String(raw.condition ?? "OR").toUpperCase() === "AND" ? "AND" : "OR",
    regexTarget:
      raw.regexTarget === "match" ? "match" : raw.regexTarget === "line" ? "line" : "secret",
    regexes,
    paths,
    stopwords: strings(raw.stopwords).map((s) => s.toLowerCase()),
    commits: strings(raw.commits).map((s) => s.toLowerCase()),
  };
}

/** The rule set of a gitleaks configuration's text (the vendored file's, or a test's). */
export function parseGitleaksRules(
  toml: string,
  version = GITLEAKS_RULES_VERSION,
): GitleaksRuleSet {
  const doc = parseToml(toml) as Raw;
  const rawRules = Array.isArray(doc.rules) ? (doc.rules as Raw[]) : [];
  const rules: SecretRule[] = [];
  const notRun: { id: string; reason: string }[] = [];
  for (const raw of rawRules) {
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) {
      notRun.push({ id: "(no id)", reason: "a rule without an id" });
      continue;
    }
    const fail = (reason: string) => notRun.push({ id, reason });
    let pattern: RegExp | undefined;
    if (typeof raw.regex === "string" && raw.regex) {
      const r = compile(raw.regex, "g");
      if (!(r instanceof RegExp)) {
        fail(`its pattern: ${r.error}`);
        continue;
      }
      pattern = r;
    }
    let path: RegExp | undefined;
    if (typeof raw.path === "string" && raw.path) {
      const r = compile(raw.path);
      if (!(r instanceof RegExp)) {
        fail(`its path: ${r.error}`);
        continue;
      }
      path = r;
    }
    if (!pattern && !path) {
      fail("neither a pattern nor a path");
      continue;
    }
    const allowlists: GitleaksAllowlist[] = [];
    let broken: string | undefined;
    for (const a of Array.isArray(raw.allowlists) ? (raw.allowlists as Raw[]) : []) {
      const r = allowlistOf(a, id);
      if ("error" in r) {
        broken = r.error;
        break;
      }
      allowlists.push(r);
    }
    if (broken) {
      fail(broken);
      continue;
    }
    const description = typeof raw.description === "string" ? raw.description : id;
    rules.push({
      id,
      description: ruleName(id, description),
      ...(pattern ? { pattern } : {}),
      ...(typeof raw.entropy === "number" && raw.entropy > 0 ? { minEntropy: raw.entropy } : {}),
      keywords: strings(raw.keywords).map((k) => k.toLowerCase()),
      ...(typeof raw.secretGroup === "number" && raw.secretGroup > 0
        ? { secretGroup: raw.secretGroup }
        : {}),
      ...(path ? { path } : {}),
      allowlists,
    });
  }
  const global = allowlistOf((doc.allowlist as Raw | undefined) ?? {}, "global");
  if ("error" in global) throw new Error(`gitleaks rules: ${global.error}`);
  return { version, total: rawRules.length, rules, notRun, allowlist: global };
}

/** The vendored rule file's text: the harness-owned `--config` the gitleaks program runs with. */
export function gitleaksRulesText(): string {
  return readFileSync(DATA_URL, "utf8");
}

let cached: GitleaksRuleSet | undefined;

/** The vendored rule set, read once. */
export function gitleaksRuleSet(): GitleaksRuleSet {
  cached ??= parseGitleaksRules(gitleaksRulesText());
  return cached;
}

/**
 * The reason text for rules the bundled scan could not run, or undefined
 * when every rule of the vendored file runs.
 */
export function rulesNotRunNote(set: GitleaksRuleSet = gitleaksRuleSet()): string | undefined {
  if (set.notRun.length === 0) return undefined;
  return `${set.notRun.length} of ${set.total} bundled secret rules not run (${set.notRun
    .map((r) => r.id)
    .join(", ")}): JavaScript cannot run their patterns`;
}
