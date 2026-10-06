/**
 * The import statements of Python and Go source, read word by word (design-
 * stage DS-N9-15; the Python adapter's re-exports, DS-N9-2). The source
 * index parses TypeScript and JavaScript and has no adapter for these
 * languages (gates IX-1: `unsupported`), so this module is the one place
 * that reads them, and it uses no import regular expression (gates
 * GT-T2-3). It moves into the index when the index gains these languages.
 */

/** One name a Python import binds. */
export interface PythonImport {
  /** `module`: `import a.b [as c]`; `from`: `from a.b import x [as y]`. */
  kind: "module" | "from";
  /** The module as written (`a.b`, `.sub`). */
  module: string;
  /** For `from`: the name imported from the module. */
  imported?: string;
  /** The name the statement binds in this file. */
  local: string;
  /** `import a.b as c`: the module is bound under another name. */
  aliased: boolean;
  /** The statement starts at column 0. */
  topLevel: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FROM = "from";
const IMPORT = "import";
const AS = "as";

/** A line without its `#` comment (a `#` inside a string is rare in an import line). */
const code = (line: string): string => {
  const at = line.indexOf("#");
  return at < 0 ? line : line.slice(0, at);
};

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Every name Python import statements bind in `text`, in order. */
export function pythonImports(text: string): PythonImport[] {
  const out: PythonImport[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = code(lines[i] as string);
    const w = words(line);
    const topLevel = line.length > 0 && !/^\s/.test(line);
    if (w[0] === FROM && w[2] === IMPORT && w[1]) {
      const module = w[1];
      // The names after the keyword, joined across parentheses or backslashes.
      let names = line.slice(
        line.indexOf(IMPORT, line.indexOf(module) + module.length) + IMPORT.length,
      );
      if (names.trim().startsWith("(")) {
        while (!names.includes(")") && i + 1 < lines.length)
          names += ` ${code(lines[++i] as string)}`;
        names = names.replace("(", " ").replace(")", " ");
      } else {
        while (names.trimEnd().endsWith("\\") && i + 1 < lines.length)
          names = `${names.trimEnd().slice(0, -1)} ${code(lines[++i] as string)}`;
      }
      for (const part of names.split(",")) {
        const p = words(part);
        const imported = p[0];
        if (!imported || !IDENT.test(imported)) continue;
        const local = p[1] === AS && p[2] && IDENT.test(p[2]) ? p[2] : imported;
        out.push({ kind: "from", module, imported, local, aliased: local !== imported, topLevel });
      }
      continue;
    }
    if (w[0] !== IMPORT) continue;
    for (const part of line.trim().slice(IMPORT.length).split(",")) {
      const p = words(part);
      const module = p[0];
      if (!module || !module.split(".").every((x) => IDENT.test(x))) continue;
      const aliased = p[1] === AS && p[2] !== undefined && IDENT.test(p[2]);
      out.push({
        kind: "module",
        module,
        local: aliased ? (p[2] as string) : (module.split(".")[0] as string),
        aliased,
        topLevel,
      });
    }
  }
  return out;
}

/** One Go import: its path, and the name it is bound to when the file gives one. */
export interface GoImport {
  path: string;
  alias?: string;
}

/** A Go import spec (`"path"`, `alias "path"`) as its parts; undefined for anything else. */
function goSpec(text: string): GoImport | undefined {
  const w = words(text.replace(/\/\/.*$/, ""));
  const quoted = (s: string | undefined) =>
    s && s.length > 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : undefined;
  if (w.length === 1) {
    const path = quoted(w[0]);
    return path ? { path } : undefined;
  }
  if (w.length === 2) {
    const path = quoted(w[1]);
    const alias = w[0] as string;
    return path && (IDENT.test(alias) || alias === "_" || alias === ".")
      ? { path, alias }
      : undefined;
  }
  return undefined;
}

/** Every import of a Go file, single and grouped, in order. */
export function goImports(text: string): GoImport[] {
  const out: GoImport[] = [];
  let grouped = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (grouped) {
      if (line.startsWith(")")) {
        grouped = false;
        continue;
      }
      const spec = goSpec(line);
      if (spec) out.push(spec);
      continue;
    }
    const w = words(line);
    if (w[0] !== IMPORT) continue;
    const rest = line.slice(IMPORT.length).trim();
    if (rest.startsWith("(")) {
      const inner = rest.slice(1).trim();
      if (inner.endsWith(")")) {
        const spec = goSpec(inner.slice(0, -1));
        if (spec) out.push(spec);
      } else {
        grouped = true;
        const spec = goSpec(inner);
        if (spec) out.push(spec);
      }
      continue;
    }
    const spec = goSpec(rest);
    if (spec) out.push(spec);
  }
  return out;
}
