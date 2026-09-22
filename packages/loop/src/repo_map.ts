import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractSymbolOutline } from "@sekhemet/context";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sekhemet", "coverage", ".next"]);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
const MAX_FILES = 120;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Build an architectural repo map: one symbol outline per source file.
 *
 * Files are visited in sorted order so the resulting text is byte-stable across
 * turns. That stability is what lets the prompt prefix stay cacheable — on this
 * hardware prefill dominates turn latency, so a map that reshuffles between
 * turns silently costs far more than it informs.
 */
export function buildRepoMap(root: string, scopeFiles: string[] = []): string {
  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop() as string;
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of [...entries].sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(abs);
      else if (info.isFile() && SOURCE_EXT.test(name) && info.size <= MAX_FILE_BYTES) {
        files.push(abs);
      }
    }
  }

  files.sort();

  // Scope files lead the map: they are what the card is allowed to change, so
  // they deserve the model's attention before anything else.
  const scopeSet = new Set(scopeFiles.map((f) => f.replace(/^\.\//, "")));
  const ordered = [
    ...files.filter((f) => scopeSet.has(relative(root, f))),
    ...files.filter((f) => !scopeSet.has(relative(root, f))),
  ];

  const outlines: string[] = [];
  for (const abs of ordered.slice(0, MAX_FILES)) {
    const rel = relative(root, abs);
    try {
      const src = readFileSync(abs, "utf8");
      const outline = extractSymbolOutline(rel, src);
      // A file with nothing to build on is noise in a 16k window — suite run
      // 5's map was half other cards' future tests, each "(no exports)". The
      // card's own scope files always stay: they are what it may change.
      if (!scopeSet.has(rel) && /\(no export(?:s|ed symbols)\)\s*$/.test(outline)) continue;
      outlines.push([outline, ...dataContract(src)].join("\n"));
    } catch {
      // Unreadable or non-UTF8 file: omit rather than poison the map.
    }
  }

  return outlines.join("\n\n");
}

/** Bodies longer than this are shown by name only. */
const MAX_BODY_LINES = 15;

/**
 * The data contract a module defines, which a signature does not show: the
 * fields of its exported interfaces and object types, and the tables it
 * creates. Suite run 5's vault card guessed a column, `created_at`, that the
 * schema in db.ts calls `created`; the map had shown only `openVaultDb`.
 */
function dataContract(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/export\s+(?:interface|type)\s+\w+[^{=;]*(?:=\s*)?\{/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = -1;
    for (let i = start + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) continue;
    const body = src.slice(start, end);
    if (body.split("\n").length <= MAX_BODY_LINES) out.push(indent(body));
  }
  for (const m of src.matchAll(/CREATE\s+TABLE[^(]*\([^;`'"]*?\)/gi)) {
    out.push(indent(m[0].replace(/\s+/g, " ")));
  }
  return out;
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
