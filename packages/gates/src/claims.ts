import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProgram, runConfined } from "@sekhemet/sandbox";
import { RERUN_GATES, gateCopy } from "./copy.js";
import type { CompleteGateFailure, RungOutcome } from "./types.js";

/**
 * The claim gate (gates rule 27a, GT-N5-3; design-stage DS-N2-1..3). A
 * research card's report lists its claims; each executable claim must be
 * reproduced by its script or marked unreproducible with a reason, or the
 * card fails. The gate is declared in `gates.toml` (`[claims]`), so its
 * declaration is covered by the file's pinned hash like any other gate.
 *
 * A claim script is untrusted input: it runs through the sandbox with a
 * private scratch directory as its only writable root, so it can neither
 * write the repository nor reach the network, under a trusted interpreter
 * (Node or Python), never a program the report names.
 */

/** `[claims]` in gates.toml. */
export interface ClaimGateConfig {
  /** The report's path, relative to the project; `{card}` is the research card's id. */
  report: string;
  timeoutMs: number;
}

export const DEFAULT_CLAIMS_REPORT = ".sekhemet/research/{card}.claims.json";

export function parseClaimGateConfig(raw: unknown): ClaimGateConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  return {
    report: typeof t.report === "string" && t.report.trim() ? t.report : DEFAULT_CLAIMS_REPORT,
    timeoutMs: (typeof t.timeout_s === "number" && t.timeout_s > 0 ? t.timeout_s : 60) * 1000,
  };
}

/** One claim as the research report records it. */
export interface ReportedClaim {
  id: string;
  kind: string;
  text: string;
  /** How to reproduce an executable claim: code for a trusted interpreter; exit 0 reproduces it. */
  reproduce?: { language: "node" | "python"; code: string };
  /** Why an executable claim could not be reproduced ("documented, not reproduced"). */
  unreproducible?: string;
}

export type ClaimVerdict =
  | { id: string; verdict: "reproduced" }
  | { id: string; verdict: "unreproducible"; reason: string }
  | { id: string; verdict: "failed"; detail: string };

function fail(excerpt: string, extra: Partial<CompleteGateFailure> = {}): CompleteGateFailure {
  return {
    gate: "claims",
    rung: "test",
    layer: "functional",
    exitCode: 1,
    errorExcerpt: excerpt,
    suggestedFixFiles: [],
    location: { file: "." },
    expected: "every executable claim reproduced, or marked unreproducible with a reason",
    actual: excerpt,
    minimalRepro: RERUN_GATES,
    suggestedAction: gateCopy.rerun(RERUN_GATES),
    ...extra,
  };
}

async function reproduce(
  claim: ReportedClaim & { reproduce: NonNullable<ReportedClaim["reproduce"]> },
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-claim-"));
  try {
    const interpreter =
      claim.reproduce.language === "node"
        ? { program: process.execPath, args: ["-e", claim.reproduce.code] }
        : claim.reproduce.language === "python"
          ? (() => {
              const python = resolveProgram("python3");
              return python
                ? { program: python, args: ["-I", "-c", claim.reproduce.code] }
                : undefined;
            })()
          : undefined;
    if (!interpreter) {
      return { ok: false, detail: `no interpreter for ${String(claim.reproduce.language)}` };
    }
    // The scratch directory is the only writable root: the repository is
    // neither the root nor writable, and there is no egress port.
    const r = await runConfined(interpreter.program, interpreter.args, {
      root: scratch,
      cwd: scratch,
      env: { HOME: scratch },
      timeoutMs,
    });
    const stderr = r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return {
      ok: r.exitCode === 0,
      detail: `exit ${r.exitCode}${stderr ? `: ${stderr}` : ""}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Check a research report's executable claims (GT-N5-3). A missing or
 * unreadable report is not run, never passed (gates rule 9).
 */
export async function runClaimGate(opts: {
  root: string;
  /** Absolute path of the card's claims report. */
  report: string;
  timeoutMs: number;
}): Promise<{ failures: CompleteGateFailure[]; outcome: RungOutcome; verdicts: ClaimVerdict[] }> {
  const started = Date.now();
  const outcome = (passed: boolean, reason?: string): RungOutcome => ({
    gate: "claims",
    rung: "test",
    layer: "functional",
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: Date.now() - started,
    ...(reason ? { reason } : {}),
  });
  let claims: ReportedClaim[] | undefined;
  try {
    const parsed = existsSync(opts.report)
      ? (JSON.parse(readFileSync(opts.report, "utf8")) as { claims?: unknown })
      : undefined;
    if (parsed && Array.isArray(parsed.claims)) claims = parsed.claims as ReportedClaim[];
  } catch {
    claims = undefined;
  }
  if (!claims) {
    const why = `no readable claims report at ${opts.report}`;
    return {
      failures: [
        fail(`claims not run: ${why}`, {
          notRun: true,
          suggestedAction: gateCopy.gateNotRun("claims"),
        }),
      ],
      outcome: { ...outcome(false, why), unavailable: true },
      verdicts: [],
    };
  }
  const failures: CompleteGateFailure[] = [];
  const verdicts: ClaimVerdict[] = [];
  for (const c of claims.filter((x) => x && x.kind === "executable")) {
    const id = String(c.id);
    if (typeof c.unreproducible === "string" && c.unreproducible.trim()) {
      verdicts.push({ id, verdict: "unreproducible", reason: c.unreproducible.trim() });
      continue;
    }
    if (c.reproduce && typeof c.reproduce.code === "string") {
      const r = await reproduce(c as Parameters<typeof reproduce>[0], opts.timeoutMs);
      if (r.ok) {
        verdicts.push({ id, verdict: "reproduced" });
        continue;
      }
      verdicts.push({ id, verdict: "failed", detail: r.detail });
      failures.push(
        fail(`[${id}] did not reproduce: ${r.detail}`, {
          actual: r.detail,
          suggestedAction: gateCopy.claimNotReproduced(id),
        }),
      );
      continue;
    }
    verdicts.push({ id, verdict: "failed", detail: "no reproduction and no reason" });
    failures.push(
      fail(`[${id}] neither reproduced nor marked unreproducible with a reason`, {
        actual: gateCopy.claimNoReproduction,
        suggestedAction: gateCopy.claimUnsettled(id),
      }),
    );
  }
  return { failures, outcome: outcome(failures.length === 0), verdicts };
}
