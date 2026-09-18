import { leadingIndent, toLf } from "./text.js";

export interface SymbolSpan {
  /** Offset of the first character of the declaration (after any decorators). */
  declStart: number;
  /** Offset just past the end of the whole declaration, including its body. */
  declEnd: number;
  /** Offset of the `{` opening the body, or -1 for bodiless declarations. */
  bodyOpen: number;
  /** Offset of the matching `}`, or -1 for bodiless declarations. */
  bodyClose: number;
  /** The indentation of the line the declaration starts on. */
  indent: string;
  /** Which pattern matched, useful for error messages and tests. */
  kind: "function" | "class" | "interface" | "type" | "enum" | "const" | "method";
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s: string): string => s.replace(ESCAPE_RE, "\\$&");

/**
 * Candidate declaration patterns, most specific first.
 *
 * Ordering matters: `const foo = () =>` must be tried before a bare `const foo`
 * so an arrow function is treated as a function rather than a value binding.
 */
function candidatePatterns(name: string): { re: RegExp; kind: SymbolSpan["kind"] }[] {
  const n = escapeRe(name);
  return [
    {
      re: new RegExp(
        `^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${n}\\b`,
        "m",
      ),
      kind: "function",
    },
    {
      re: new RegExp(
        `^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`,
        "m",
      ),
      kind: "class",
    },
    { re: new RegExp(`^[ \\t]*(?:export\\s+)?interface\\s+${n}\\b`, "m"), kind: "interface" },
    { re: new RegExp(`^[ \\t]*(?:export\\s+)?type\\s+${n}\\b`, "m"), kind: "type" },
    { re: new RegExp(`^[ \\t]*(?:export\\s+)?(?:const\\s+)?enum\\s+${n}\\b`, "m"), kind: "enum" },
    {
      re: new RegExp(
        `^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${n}\\b[^=\\n]*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=>`,
        "m",
      ),
      kind: "function",
    },
    {
      re: new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`, "m"),
      kind: "const",
    },
    {
      // Class member: `  public async foo<T>(...)` / `  foo(...)` / `  static foo(`
      re: new RegExp(
        `^[ \\t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\(`,
        "m",
      ),
      kind: "method",
    },
  ];
}

/** Scan forward from `open` to the matching close brace, skipping strings and comments. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }

  return -1;
}

/**
 * Locate a named declaration and the exact bounds of its body.
 *
 * Returns `null` rather than throwing so callers can produce a tool observation
 * listing what *is* present, which is far more useful to a model than a stack trace.
 */
export function findSymbol(source: string, name: string): SymbolSpan | null {
  const text = toLf(source);

  for (const { re, kind } of candidatePatterns(name)) {
    const m = re.exec(text);
    if (!m) continue;

    const declStart = m.index;
    const lineStart = text.lastIndexOf("\n", declStart) + 1;
    const lineEnd = text.indexOf("\n", declStart);
    const indent = leadingIndent(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));

    // Find the terminator that closes this declaration: `{` for a body, `;`/newline otherwise.
    const brace = text.indexOf("{", declStart);
    const semi = text.indexOf(";", declStart);
    const hasBody = brace !== -1 && (semi === -1 || brace < semi);

    if (hasBody) {
      const close = matchBrace(text, brace);
      if (close !== -1) {
        return { declStart, declEnd: close + 1, bodyOpen: brace, bodyClose: close, indent, kind };
      }
    }

    if (semi !== -1) {
      return { declStart, declEnd: semi + 1, bodyOpen: -1, bodyClose: -1, indent, kind };
    }

    const eol = text.indexOf("\n", declStart);
    return {
      declStart,
      declEnd: eol === -1 ? text.length : eol,
      bodyOpen: -1,
      bodyClose: -1,
      indent,
      kind,
    };
  }

  return null;
}

/** Top-level-ish symbol names in a file, used to suggest alternatives on a miss. */
export function listSymbolNames(source: string): string[] {
  const re =
    /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const names = new Set<string>();
  let m: RegExpExecArray | null = re.exec(toLf(source));
  while (m !== null) {
    if (m[1]) names.add(m[1]);
    m = re.exec(toLf(source));
  }
  return [...names];
}
