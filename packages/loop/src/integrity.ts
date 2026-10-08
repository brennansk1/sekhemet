import { execFileSync } from "node:child_process";
import { type GateFailure, gateCopy, parseNumstat } from "@sekhemet/gates";
import { gitEnvFor } from "@sekhemet/sync";

/**
 * The integrity gate: did the gates pass honestly?
 *
 * ARIS (arXiv 2605.03042) names the central failure of long-running agents
 * "plausible unsupported success": results that look valid but are not
 * licensed by the evidence. For a coding agent that means passing the gates
 * by switching them off: a `@ts-ignore`, an `as any`, a lint suppression, a
 * skipped or focused test. Tests and types then say "pass" about code they no
 * longer check. This scans the lines the card added and fails verification
 * when any of them disables a check, with the reason and the honest fix.
 */
interface Pattern {
  id: string;
  re: RegExp;
  why: string;
  /** Only in test files (a skipped test is fine in neither, but .only is a test-file thing). */
  testsOnly?: boolean;
}

const PATTERNS: Pattern[] = [
  {
    id: "ts-ignore",
    re: /@ts-(?:ignore|nocheck|expect-error)\b/,
    why: "silences the type checker",
  },
  {
    id: "as-any",
    re: /\bas\s+any\b|:\s*any\b(?!\w)|<any>/,
    why: "turns off type checking for the value",
  },
  {
    id: "lint-suppression",
    re: /biome-ignore|eslint-disable|@ts-expect-error/,
    why: "suppresses a lint rule instead of fixing it",
  },
  {
    id: "skipped-test",
    re: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(/,
    why: "skips a test",
  },
  {
    id: "focused-test",
    re: /\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/,
    why: "runs only some tests, hiding the rest",
  },
  {
    id: "vacuous-assert",
    re: /expect\(\s*(?:true|1)\s*\)\.toBe\(\s*(?:true|1)\s*\)/,
    why: "asserts nothing",
    testsOnly: true,
  },
];

export interface IntegrityViolation {
  file: string;
  line: string;
  pattern: string;
  why: string;
}

/** Violations among the added lines of a unified diff. */
export function scanDiffIntegrity(
  diff: string,
  protectedFiles: string[] = [],
): IntegrityViolation[] {
  const out: IntegrityViolation[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (protectedFiles.includes(file)) continue;
    const line = raw.slice(1);
    const isTest = /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$/.test(file);
    for (const p of PATTERNS) {
      if (p.testsOnly && !isTest) continue;
      if (p.re.test(line)) {
        out.push({ file, line: line.trim().slice(0, 160), pattern: p.id, why: p.why });
        break;
      }
    }
  }
  return out;
}

/**
 * The card's diff against its base, including files not yet committed;
 * undefined when git cannot produce it, so the gates that judge the diff say
 * they did not run rather than pass an empty one. A card worktree whose git
 * metadata fails the preflight throws `GitMetadataError` before any git
 * command runs (SEC-2): the card stops `git_metadata_tampered`.
 */
export function worktreeDiff(root: string, base = "main"): string | undefined {
  // A card worktree is preflighted and pinned (security items 18–21).
  const env = gitEnvFor(root);
  try {
    execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "ignore", timeout: 15_000 });
    return execFileSync(
      "git",
      ["diff", "--cached", "--unified=0", "--no-ext-diff", "--no-textconv", base],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    return undefined;
  }
}

/**
 * Per-file line deltas of the worktree against `base` (staging everything
 * first, as `worktreeDiff` does), or undefined when git cannot say. Pinned
 * and preflighted like `worktreeDiff` (SEC-2: a rewritten `.git` pointer
 * throws before `git add` can write another repository's index).
 */
export function worktreeNumstat(
  root: string,
  base = "main",
): { file: string; added: number; removed: number }[] | undefined {
  const env = gitEnvFor(root);
  try {
    execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "ignore", timeout: 15_000 });
    const text = execFileSync("git", ["diff", "--cached", "--numstat", base], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseNumstat(text);
  } catch {
    return undefined;
  }
}

/**
 * Integrity violations as failures with all six fields (gates rule 19). The
 * repro shows the card's lines in the file against `base`.
 */
export function integrityFailures(violations: IntegrityViolation[], base = "main"): GateFailure[] {
  return violations.slice(0, 3).map((v) => ({
    rung: "hygiene",
    gate: "integrity",
    layer: "hygiene",
    exitCode: 1,
    errorExcerpt: `${v.file}: "${v.line}" ${v.why} (${v.pattern})`,
    suggestedFixFiles: [v.file],
    location: { file: v.file },
    expected: "no check switched off in the card's lines",
    actual: `${v.pattern}: ${v.line}`,
    minimalRepro: `git diff ${base} -- ${v.file}`,
    suggestedAction: gateCopy.integrity,
  }));
}
