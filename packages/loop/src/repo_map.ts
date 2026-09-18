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
    try {
      outlines.push(extractSymbolOutline(relative(root, abs), readFileSync(abs, "utf8")));
    } catch {
      // Unreadable or non-UTF8 file: omit rather than poison the map.
    }
  }

  return outlines.join("\n\n");
}
