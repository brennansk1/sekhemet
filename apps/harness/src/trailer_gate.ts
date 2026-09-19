import { execFileSync } from "node:child_process";
import type { GateFailure, GateResult, GateRunner, GateRung, RungOutcome } from "@sekhemet/gates";
import { missingTrailers } from "@sekhemet/sync";

/**
 * Commit-trailer enforcement as a harness gate (X26). Every commit on a
 * card's branch carries the attribution contract (Card, Agent-Model,
 * Agent-Harness, Agent-Role, Co-authored-by; checkpoints also Step and
 * GateStatus). A commit made by hand through run_cmd fails verification;
 * the squash onto main is refused by the sync adapter on the same contract.
 * `sekhemet trailers [<range>]` runs the same check for people and CI.
 */
export interface TrailerViolation {
  sha: string;
  subject: string;
  missing: string[];
}

export function checkTrailers(root: string, range: string): TrailerViolation[] {
  let log = "";
  try {
    log = execFileSync("git", ["log", "--format=%H%x1f%B%x1e", range], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out: TrailerViolation[] = [];
  for (const entry of log.split("\x1e")) {
    if (!entry.trim()) continue;
    const [sha = "", body = ""] = entry.trim().split("\x1f");
    const subject = body.split("\n")[0] ?? "";
    // Git's own merge commits are not authored work.
    if (/^Merge (branch|remote-tracking branch|pull request) /.test(subject)) continue;
    const missing = missingTrailers(body, { checkpoint: /^checkpoint:/.test(subject) });
    if (missing.length) out.push({ sha, subject, missing });
  }
  return out;
}

export function trailerGate(root: string, base = "main"): GateFailure[] {
  return checkTrailers(root, `${base}..HEAD`).map((v) => ({
    rung: "hygiene",
    gate: "trailers",
    layer: "hygiene",
    exitCode: 1,
    errorExcerpt: `commit ${v.sha.slice(0, 10)} "${v.subject.slice(0, 60)}" lacks ${v.missing.join(", ")}`,
    suggestedFixFiles: [],
    actual: v.missing.join(", "),
    expected: "Card, Agent-Model, Agent-Harness, Agent-Role, Co-authored-by",
    suggestedAction:
      "Commits on a card branch are the harness's checkpoints; do not commit by hand with run_cmd.",
  }));
}

/** Wrap a gate runner so every verification checks the branch's trailers. */
export function withTrailerGate(inner: GateRunner, base = "main"): GateRunner {
  return {
    runGates: async (rungs: GateRung[], cwd: string): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd);
      const started = Date.now();
      const failures = trailerGate(cwd, base);
      const outcome: RungOutcome = {
        gate: "trailers",
        rung: "hygiene",
        layer: "hygiene",
        passed: failures.length === 0,
        exitCode: failures.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
      };
      return {
        ...res,
        passed: res.passed && failures.length === 0,
        failures: [...res.failures, ...failures],
        rungResults: [...(res.rungResults ?? []), outcome],
      };
    },
  };
}
