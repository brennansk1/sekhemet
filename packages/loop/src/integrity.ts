import { execFileSync } from "node:child_process";
import { type GateFailure, parseNumstat } from "@sekhemet/gates";

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

/** The card's diff against its base, including files not yet committed. */
export function worktreeDiff(root: string, base = "main"): string {
  try {
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore", timeout: 15_000 });
    return execFileSync("git", ["diff", "--cached", "--unified=0", base], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/**
 * Per-file line deltas of the worktree against `base` (staging everything
 * first, as `worktreeDiff` does), or undefined when git cannot say.
 */
export function worktreeNumstat(
  root: string,
  base = "main",
): { file: string; added: number; removed: number }[] | undefined {
  try {
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore", timeout: 15_000 });
    const text = execFileSync("git", ["diff", "--cached", "--numstat", base], {
      cwd: root,
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

export function integrityFailures(violations: IntegrityViolation[]): GateFailure[] {
  return violations.slice(0, 3).map((v) => ({
    rung: "integrity" as never,
    gate: "integrity",
    exitCode: 1,
    errorExcerpt: `${v.file}: "${v.line}" ${v.why} (${v.pattern})`,
    suggestedFixFiles: [v.file],
    location: { file: v.file },
    suggestedAction:
      "Remove the suppression and fix the underlying problem. A gate passed by switching a check off is not a pass: the reviewer will send it back.",
  }));
}
