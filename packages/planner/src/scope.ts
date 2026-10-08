import {
  ASSUMED_FILE_TOKENS,
  ASSUMED_TEST_TOKENS,
  MAX_SCOPE_FILES,
  PACK_OVERHEAD_TOKENS,
} from "./constants.js";
import { slugify } from "./text.js";
import type { CodebaseMap, SpidrSliceKind } from "./types.js";

const DEFAULT_SOURCE_DIR = "src";
const DEFAULT_TEST_DIR = "tests";

/**
 * Conventional file name per slice, used only when the codebase map offers
 * nothing that already matches the capability.
 *
 * A guessed path is still better than a shared one: two stories that both
 * claim `src/service.ts` cannot run concurrently, which is what the INVEST
 * independence check exists to prevent.
 */
function conventionalName(slice: SpidrSliceKind, slug: string, ext = ".ts"): string {
  switch (slice) {
    case "interface":
      return `${slug}_types${ext}`;
    case "data":
      return `${slug}_store${ext}`;
    case "path":
      return `${slug}${ext}`;
    case "rule":
      return `${slug}_rules${ext}`;
    case "spike":
      return `${slug}_spike${ext}`;
  }
}

/**
 * Test files never enter implementation scope.
 *
 * The gates protect `**` + `/*.spec.ts` from the implementer, so a card that
 * claimed one would be told at the bounds gate that it may not touch its own
 * scope. Acceptance tests get their own path instead.
 */
function isTestFile(filePath: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(filePath);
}

/** Score a candidate file by how many of the capability's words it contains. */
function relevance(filePath: string, keywords: readonly string[]): number {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (keyword.length > 2 && lower.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

export interface ScopeSelection {
  files: string[];
  /** Files that already exist in the map, as opposed to files to be created. */
  existing: string[];
  /** Symbols the map knows about in the selected files. */
  symbols: string[];
}

/**
 * Pick at most {@link MAX_SCOPE_FILES} files for a slice.
 *
 * Existing files that mention the capability win over invented ones, because a
 * card that edits the file the behaviour already lives in is a card whose diff
 * a human can read.
 */
export function selectScopeFiles(
  slice: SpidrSliceKind,
  keywords: readonly string[],
  map: CodebaseMap | undefined,
  taken: ReadonlySet<string> = new Set(),
  maxFiles: number = MAX_SCOPE_FILES,
): ScopeSelection {
  const slug = slugify(keywords.join(" "));
  const files: string[] = [];
  const existing: string[] = [];

  const candidates = (map?.files ?? [])
    .filter((f) => !taken.has(f) && !isTestFile(f))
    .map((f) => ({ file: f, score: relevance(f, keywords) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length);

  for (const candidate of candidates) {
    if (files.length >= maxFiles) {
      break;
    }
    files.push(candidate.file);
    existing.push(candidate.file);
  }

  if (files.length === 0) {
    const sourceDir = map?.sourceDir ?? DEFAULT_SOURCE_DIR;
    const ext = map?.sourceExt ?? ".ts";
    const base = `${sourceDir}/${conventionalName(slice, slug, ext)}`;
    /** Two slices with the same slug would otherwise collide and be serialized. */
    let invented = base;
    let suffix = 2;
    while (taken.has(invented)) {
      invented = `${base.slice(0, -ext.length)}_${suffix}${ext}`;
      suffix += 1;
    }
    files.push(invented);
  }

  const symbols: string[] = [];
  for (const file of existing) {
    for (const symbol of map?.symbols?.[file] ?? []) {
      symbols.push(symbol);
    }
  }

  return { files: files.slice(0, maxFiles), existing, symbols };
}

/** Acceptance test path for a slice, kept out of the implementation scope. */
export function acceptanceTestPath(
  slice: SpidrSliceKind,
  keywords: readonly string[],
  map?: CodebaseMap,
): string {
  const testDir = map?.testDir ?? DEFAULT_TEST_DIR;
  return `${testDir}/${slugify(keywords.join(" "))}_${slice}.spec.ts`;
}

/**
 * Projected context-pack size for a story.
 *
 * Measured sizes are used when the codebase map carries them; otherwise every
 * file is charged {@link ASSUMED_FILE_TOKENS}. Assuming a size is honest here
 * because the check it feeds is a ceiling — over-estimating splits a card that
 * might have fit, under-estimating ships one that cannot.
 */
export function estimatePackTokens(
  scopeFiles: readonly string[],
  testFiles: readonly string[],
  promptText: string,
  map?: CodebaseMap,
): number {
  let total = PACK_OVERHEAD_TOKENS + Math.ceil(promptText.length / 4);
  for (const file of scopeFiles) {
    total += map?.fileTokens?.[file] ?? ASSUMED_FILE_TOKENS;
  }
  total += testFiles.length * ASSUMED_TEST_TOKENS;
  return total;
}
