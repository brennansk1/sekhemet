import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  PROGRAM_ALLOWLIST,
  type ProcessSandbox,
  resolveProgram,
  runConfined,
} from "@sekhemet/sandbox";

/** The programs the review diff may run (item 20b, SEC-19a): the harness's fixed allowlist. */
export const REVIEW_PROGRAM_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  difft: PROGRAM_ALLOWLIST.difft ?? [],
};

/** The absolute path of an allowlisted program, or undefined (refused or not installed). */
export function resolveReviewProgram(
  name: string,
  allowlist: Readonly<Record<string, readonly string[]>> = REVIEW_PROGRAM_ALLOWLIST,
): string | undefined {
  return resolveProgram(name, allowlist);
}

export interface ReviewSide {
  /** The file's path in the repository, shown in the diff. */
  path: string;
  /** Content on the base branch; undefined for a new file. */
  before: string | undefined;
  /** Staged content; undefined for a deleted file. */
  after: string | undefined;
}

export interface DifftasticOptions {
  /** Per-file time limit. Default 30 s. */
  timeoutMs?: number;
  /** Per-file memory cap. Default 1 GiB. */
  maxMemoryBytes?: number;
  /** At most this many files; a larger diff is left whole to git's line diff. Default 200. */
  maxFiles?: number;
  sandbox?: ProcessSandbox;
}

/**
 * Difftastic's syntax-aware diff of each file (Y8). The two sides are
 * written to a scratch directory and `program` (already resolved from the
 * allowlist) runs over them confined: no network, the allowlisted
 * environment, time and memory limits, nothing writable but the scratch
 * directory. Undefined when any run fails, so the caller falls back to git.
 */
export async function difftasticDiff(
  program: string,
  sides: readonly ReviewSide[],
  options: DifftasticOptions = {},
): Promise<string | undefined> {
  if (!isAbsolute(program)) return undefined;
  // Past the limit the whole review is git's: a diff half difftastic, half
  // silently missing, would be labelled difftastic while hiding files.
  if (sides.length > (options.maxFiles ?? 200)) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-difft-"));
  try {
    const out: string[] = [];
    for (const [i, side] of sides.entries()) {
      const dir = join(scratch, String(i));
      mkdirSync(dir);
      const before = join(dir, "before");
      const after = join(dir, "after");
      writeFileSync(before, side.before ?? "");
      writeFileSync(after, side.after ?? "");
      // Git's external-diff convention: path, old file/hex/mode, new file/hex/mode.
      const r = await runConfined(
        program,
        [side.path, before, "0000000", "100644", after, "0000000", "100644"],
        {
          root: dir,
          env: { DFT_COLOR: "never", DFT_DISPLAY: "inline" },
          timeoutMs: options.timeoutMs ?? 30_000,
          maxMemoryBytes: options.maxMemoryBytes ?? 1024 * 1024 * 1024,
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
        },
      );
      if (r.exitCode !== 0 || r.timedOut || r.oomKilled) return undefined;
      out.push(r.stdout.trimEnd());
    }
    return out.join("\n\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
