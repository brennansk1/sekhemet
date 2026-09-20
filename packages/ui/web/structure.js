// Structural reading of a diff (U16, U8): files grouped by intent (source,
// tests, config, docs, like the sync adapter's squash grouping), and within
// each file the declarations the change adds, removes or edits. Whitespace-only
// hunks are named, not shown. Pure: tested as-is.

const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const CONFIG =
  /(^|\/)(package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|biome\.json|Cargo\.(toml|lock)|pyproject\.toml|requirements[^/]*\.txt|go\.(mod|sum)|\.github\/.+|[^/]+\.(toml|ya?ml|ini|cfg))$/;
const DOCS = /\.(md|mdx|rst|txt)$|(^|\/)docs\//;

export function intentOf(path) {
  if (TEST.test(path)) return "tests";
  if (DOCS.test(path)) return "docs";
  if (CONFIG.test(path)) return "config";
  return "source";
}

const DECL = [
  // TypeScript / JavaScript
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^\s*(?:public|private|protected|static|async|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
  // Python
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // Rust / Go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function"]);

export function declName(line) {
  for (const re of DECL) {
    const m = re.exec(line);
    if (m?.[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  return undefined;
}

/** The declaration a hunk sits in, from git's funcname context after `@@`. */
function hunkContext(header) {
  const ctx = /^@@[^@]*@@\s*(.*)$/.exec(header)?.[1] ?? "";
  return ctx ? declName(ctx) : undefined;
}

/**
 * @param files parseUnifiedDiff output
 * @returns {{ path, intent, added, removed, whitespaceOnly: number,
 *   symbols: { name, change: "added"|"removed"|"changed" }[] }[]}
 */
export function structuralSummary(files) {
  return files.map((f) => {
    const added = new Set();
    const removed = new Set();
    const touched = new Set();
    let whitespaceOnly = 0;
    for (const h of f.hunks) {
      const plus = h.lines.filter((l) => l.type === "add").map((l) => l.text);
      const minus = h.lines.filter((l) => l.type === "del").map((l) => l.text);
      const squash = (xs) => xs.join("").replace(/\s+/g, "");
      if ((plus.length || minus.length) && squash(plus) === squash(minus)) {
        whitespaceOnly++;
        continue;
      }
      for (const t of plus) {
        const n = declName(t);
        if (n) added.add(n);
      }
      for (const t of minus) {
        const n = declName(t);
        if (n) removed.add(n);
      }
      // Edits inside a declaration: the nearest declaration above the change.
      let current = hunkContext(h.header);
      for (const l of h.lines) {
        const n = declName(l.text);
        if (n && l.type !== "del") current = n;
        if ((l.type === "add" || l.type === "del") && current) touched.add(current);
      }
    }
    const symbols = [];
    for (const n of added)
      symbols.push({ name: n, change: removed.has(n) ? "changed" : "added" });
    for (const n of removed) if (!added.has(n)) symbols.push({ name: n, change: "removed" });
    for (const n of touched)
      if (!added.has(n) && !removed.has(n)) symbols.push({ name: n, change: "changed" });
    return {
      path: f.path,
      intent: intentOf(f.path),
      added: f.added,
      removed: f.removed,
      status: f.status,
      whitespaceOnly,
      symbols,
    };
  });
}

