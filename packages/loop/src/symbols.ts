import { type DeclarationFact, factsOfText } from "@sekhemet/gates";
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

/**
 * Which declaration a name means when a file declares it more than once,
 * most specific first: a function before a class, an arrow-function `const`
 * before a plain value, a class member last.
 */
const PRIORITY: {
  kind: SymbolSpan["kind"];
  matches: (d: DeclarationFact) => boolean;
}[] = [
  { kind: "function", matches: (d) => d.kind === "function" },
  { kind: "class", matches: (d) => d.kind === "class" },
  { kind: "interface", matches: (d) => d.kind === "interface" },
  { kind: "type", matches: (d) => d.kind === "type" },
  { kind: "enum", matches: (d) => d.kind === "enum" },
  { kind: "function", matches: (d) => isVariable(d) && d.arrow === true },
  { kind: "const", matches: isVariable },
  { kind: "method", matches: (d) => d.kind === "method" },
];

function isVariable(d: DeclarationFact): boolean {
  return d.kind === "const" || d.kind === "let" || d.kind === "var";
}

/** The declarations the source index finds in `text` (T2, GT-T2-3). */
function declarationsOf(text: string, fileName: string): DeclarationFact[] {
  return factsOfText(fileName, text).declarations;
}

/**
 * Locate a named declaration and the exact bounds of its body, from the
 * source index's syntax tree: braces inside strings, templates and comments
 * never desync it, and a comment or a string naming the symbol is never
 * mistaken for it.
 *
 * Returns `null` rather than throwing so callers can produce a tool observation
 * listing what *is* present, which is far more useful to a model than a stack trace.
 */
export function findSymbol(
  source: string,
  name: string,
  fileName = "symbol.ts",
): SymbolSpan | null {
  const text = toLf(source);
  const named = declarationsOf(text, fileName).filter((d) => d.name === name);
  for (const { kind, matches } of PRIORITY) {
    const candidates = named.filter(matches);
    // An overloaded function: the implementation, the one with a body.
    const d = candidates.find((c) => c.bodyOpen !== -1) ?? candidates[0];
    if (!d) continue;
    const lineStart = text.lastIndexOf("\n", d.start - 1) + 1;
    const lineEnd = text.indexOf("\n", lineStart);
    return {
      declStart: lineStart,
      declEnd: d.end,
      bodyOpen: d.bodyOpen,
      bodyClose: d.bodyClose,
      indent: leadingIndent(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)),
      kind,
    };
  }
  return null;
}

/** Declared symbol names in a file (members excluded), used to suggest alternatives on a miss. */
export function listSymbolNames(source: string, fileName = "symbol.ts"): string[] {
  const names = new Set<string>();
  for (const d of declarationsOf(toLf(source), fileName)) {
    if (d.kind !== "method" && d.kind !== "namespace") names.add(d.name);
  }
  return [...names];
}
