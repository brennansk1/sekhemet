import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanSecrets } from "@sekhemet/gates";
import { checkSyntax } from "./parse_gate.js";

/**
 * The write contract (L16, G7): every agent write passes, in order,
 *   1. scope and permissions   (the ToolExecutor's authorize step, before this),
 *   2. parse                   (G6: the result must parse if the file did),
 *   3. secret scan             (G14's rules, on what this write introduces),
 * and then lands atomically: a temp file in the same directory, renamed
 * over the target, so a crash or a full disk never leaves a half-written
 * source file behind.
 */
export interface WriteProblem {
  rule: "parse" | "secret";
  message: string;
}

export interface WriteVerdict {
  ok: boolean;
  problems: WriteProblem[];
}

export function validateWrite(abs: string, content: string, displayPath: string): WriteVerdict {
  const problems: WriteProblem[] = [];
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;

  // Never break a parseable file; a broken one must stay repairable edit by edit.
  const alreadyBroken = before !== undefined && checkSyntax(abs, before).length > 0;
  if (!alreadyBroken) {
    for (const p of checkSyntax(abs, content)) {
      problems.push({
        rule: "parse",
        message: `${displayPath}:${p.line}:${p.column} ${p.message}`,
      });
    }
  }

  // Only secrets this write adds: a key already in the file is the gate's
  // finding on the diff, not a reason to block every later edit of it.
  const existing = new Set(
    before !== undefined
      ? scanSecrets(before, displayPath).map((f) => `${f.rule}:${f.redacted}`)
      : [],
  );
  for (const f of scanSecrets(content, displayPath)) {
    if (existing.has(`${f.rule}:${f.redacted}`)) continue;
    problems.push({
      rule: "secret",
      message: `${displayPath}:${f.line} looks like a ${f.description} (${f.redacted})`,
    });
  }
  return { ok: problems.length === 0, problems };
}

/** Write via a temp file in the same directory and an atomic rename. */
export function atomicWrite(abs: string, content: string): void {
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.sekhemet-tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
