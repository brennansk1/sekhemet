import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractSymbolOutline } from "@sekhemet/context";
import { factsOfText } from "@sekhemet/gates";

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
      // Data contracts are their own section (dataContracts), appended by the
      // session to whichever map it uses; repeating them here doubled them.
      outlines.push(outline);
    } catch {
      // Unreadable or non-UTF8 file: omit rather than poison the map.
    }
  }

  return outlines.join("\n\n");
}

/** The data-contract section's budget: enough for a small project's types and schema. */
const MAX_CONTRACT_CHARS = 2400;

/**
 * The data contracts outside the card's scope — interface fields and tables —
 * as their own prompt section, appended to whichever map the session uses.
 * The first version added them only to the flat fallback map, which runs when
 * the ranked map is empty, so in production they never reached the prompt
 * (Phase A review, 2026-09-22). Sorted by file, so the text is byte-stable.
 */
export function dataContracts(root: string, scopeFiles: readonly string[] = []): string {
  const scope = new Set(scopeFiles.map((f) => f.replace(/^\.\//, "")));
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(abs);
      else if (
        SOURCE_EXT.test(name) &&
        !/\.(spec|test)\./.test(name) &&
        info.size <= MAX_FILE_BYTES
      ) {
        files.push(abs);
      }
    }
  }
  const sections: string[] = [];
  let used = 0;
  for (const abs of files.sort()) {
    const rel = relative(root, abs);
    if (scope.has(rel) || /(^|\/)(tests?|acceptance)\//.test(rel)) continue;
    let contract: string[];
    try {
      contract = dataContract(rel, readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    if (!contract.length) continue;
    const block = `${rel}:\n${contract.join("\n")}`;
    if (used + block.length > MAX_CONTRACT_CHARS) break;
    sections.push(block);
    used += block.length;
  }
  return sections.join("\n\n");
}

/** Bodies longer than this are shown by name only. */
const MAX_BODY_LINES = 15;

/**
 * The data contract a module defines, which a signature does not show: the
 * fields of its exported interfaces and object types, and the tables it
 * creates. Suite run 5's vault card guessed a column, `created_at`, that the
 * schema in db.ts calls `created`; the map had shown only `openVaultDb`.
 */
function dataContract(file: string, src: string): string[] {
  const out: string[] = [];
  // Exported interfaces and object types, from the source index (T2, GT-T2-3).
  for (const d of factsOfText(file, src).declarations) {
    if (!d.topLevel || !d.exported || d.isDefault || !d.typeOnly || d.bodyOpen === -1) continue;
    const body = src.slice(d.start, d.bodyClose + 1);
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
