import { execFileSync } from "node:child_process";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  type RunGatesOptions,
  type RungOutcome,
  announceGateStart,
  gateCopy,
  unavailableGate,
} from "@sekhemet/gates";
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

/**
 * A range git cannot read (wave 9 B10): an unknown ref, a commit before the
 * first. Never read as "no commit lacks a trailer" — the command refuses it
 * and the gate is `unavailable` (gates rule 9), never a pass.
 */
export class TrailerRangeError extends Error {
  constructor(
    readonly range: string,
    readonly gitMessage: string,
  ) {
    super(`git cannot read the range ${range}${gitMessage ? `: ${gitMessage}` : ""}`);
    this.name = "TrailerRangeError";
  }
}

/** Every commit in `range` and those that lack a trailer; throws {@link TrailerRangeError}. */
export function trailerReport(
  root: string,
  range: string,
): { commits: number; violations: TrailerViolation[] } {
  let log = "";
  try {
    log = execFileSync("git", ["log", "--format=%H%x1f%B%x1e", range, "--"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const first = stderr
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "");
    throw new TrailerRangeError(range, (first ?? "").replace(/^fatal:\s*/, ""));
  }
  const out: TrailerViolation[] = [];
  let commits = 0;
  for (const entry of log.split("\x1e")) {
    if (!entry.trim()) continue;
    commits++;
    const [sha = "", body = ""] = entry.trim().split("\x1f");
    const subject = body.split("\n")[0] ?? "";
    // Git's own merge commits are not authored work.
    if (/^Merge (branch|remote-tracking branch|pull request) /.test(subject)) continue;
    const missing = missingTrailers(body, { checkpoint: /^checkpoint:/.test(subject) });
    if (missing.length) out.push({ sha, subject, missing });
  }
  return { commits, violations: out };
}

export function checkTrailers(root: string, range: string): TrailerViolation[] {
  return trailerReport(root, range).violations;
}

/** The branch's trailer failures, or why the check could not read the branch. */
function trailerCheck(
  root: string,
  base: string,
): { failures: GateFailure[]; unavailable?: RungOutcome } {
  try {
    return { failures: trailerGate(root, base) };
  } catch (err) {
    if (!(err instanceof TrailerRangeError)) throw err;
    // Gates rule 9: not the card's work. `notRun` stops the card for a person
    // (done_pending_gates); the Worker's repair budget is never spent on it.
    const { outcome, failure } = unavailableGate(
      "trailers",
      "hygiene",
      "hygiene",
      err.message,
      `git log ${err.range}`,
    );
    return { unavailable: outcome, failures: [failure] };
  }
}

export function trailerGate(root: string, base = "main"): GateFailure[] {
  return checkTrailers(root, `${base}..HEAD`).map((v) => ({
    rung: "hygiene",
    gate: "trailers",
    layer: "hygiene",
    exitCode: 1,
    errorExcerpt: `commit ${v.sha.slice(0, 10)} "${v.subject.slice(0, 60)}" lacks ${v.missing.join(", ")}`,
    suggestedFixFiles: [],
    location: { file: "." },
    actual: v.missing.join(", "),
    minimalRepro: `git log --format=%B -n 1 ${v.sha}`,
    expected: "Card, Agent-Model, Agent-Harness, Agent-Role, Co-authored-by",
    suggestedAction: gateCopy.handCommit,
  }));
}

/** Wrap a gate runner so every verification checks the branch's trailers. */
export function withTrailerGate(inner: GateRunner, base = "main"): GateRunner {
  return {
    // GT-M6-5: the gate this wrapper adds, for `note`'s enum.
    gateIds: [...(inner.gateIds ?? []), "trailers"],
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd, runOptions);
      // DB-N2-10: the page names this check while it runs.
      announceGateStart(runOptions, { gate: "trailers", rung: "hygiene" });
      const started = Date.now();
      const { failures, unavailable } = trailerCheck(cwd, base);
      const durationMs = Date.now() - started;
      // Gates rule 9: a check that could not read the branch is no verdict.
      const outcome: RungOutcome = unavailable
        ? { ...unavailable, durationMs }
        : {
            gate: "trailers",
            rung: "hygiene",
            layer: "hygiene",
            passed: failures.length === 0,
            exitCode: failures.length === 0 ? 0 : 1,
            durationMs,
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
