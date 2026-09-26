import type { CardChange } from "@sekhemet/kernel";
import type { ProcessSandbox } from "@sekhemet/sandbox";

/**
 * The red/green table (gates rule 6b; DEFINITION_OF_DONE §5.1 item 1;
 * GT-N8-2): one rule per card `change`, read by the card runner's red-first
 * check and by the gates. The rule is chosen by `change` alone — never by
 * `kind` or `split`, which select tools and display.
 *
 * "At an assertion" (rule 6, GT-TQ-1) and the stand-in implementations
 * (rule 6a, GT-TQ-10) are NEW-gates-6's; this table says which way the base
 * must go.
 */
export interface RedGreenRule {
  change: CardChange;
  /** What the card's tests must do on the base, before any work. */
  onBase: "red" | "green";
  /** Green on the base is the card's proof, so it is never `vacuous_tests`. */
  greenOnBaseIsProof: boolean;
  /** What must hold after the change. */
  after: string;
  /** The rule as rule 6b states it. */
  rule: string;
}

export const RED_GREEN_RULES: Readonly<Record<CardChange, RedGreenRule>> = {
  feature: {
    change: "feature",
    onBase: "red",
    greenOnBaseIsProof: false,
    after: "the acceptance tests pass",
    rule: "acceptance tests red at an assertion on the base before any work (a types-only card is red on the typecheck); green after",
  },
  fix: {
    change: "fix",
    onBase: "red",
    greenOnBaseIsProof: false,
    after: "the reproduction test passes",
    rule: "a reproduction test red at an assertion on the base before any work (a build-repair card: the declared build command failing on the base); green after",
  },
  characterize: {
    change: "characterize",
    onBase: "green",
    greenOnBaseIsProof: true,
    after: "the tests still pass, and fail against stand-in implementations of the code they cover",
    rule: "tests green on the base, pinning today's behaviour, and red against stand-in implementations; a test that fails on the base is refused",
  },
  refactor: {
    change: "refactor",
    onBase: "green",
    greenOnBaseIsProof: true,
    after:
      "every existing test passes and the scope files' exported surface is unchanged unless declared",
    rule: "no new behaviour tests; every existing test green on the base and on the change; no public behaviour change",
  },
  upgrade: {
    change: "upgrade",
    onBase: "green",
    greenOnBaseIsProof: true,
    after: "the tests named on the card pass after the version change",
    rule: "the version change is a tool step; the tests named on the card pass on the base and after it; each failing site becomes a child fix card",
  },
};

/** The rule of a card's `change`; a card with none is a `feature` (GT-N8-1). */
export function redGreenRule(change: CardChange | undefined): RedGreenRule {
  return RED_GREEN_RULES[change ?? "feature"];
}

/**
 * What the red-first check found before any work:
 * - `fails`: red on the base, as a red-first rule requires;
 * - `green`: green on the base, which is the proof of a green-first rule;
 * - `vacuous`: green where red was required (`vacuous_tests`);
 * - `refused`: red where green was required (a green-first card's tests do
 *   not hold on the base);
 * - `unknown`: the gates could not run; the check says nothing.
 */
export type RedFirstStatus = "fails" | "green" | "vacuous" | "refused" | "unknown";

export interface RedFirstVerdict {
  status: RedFirstStatus;
  /** The stop a refusal ends the card with. */
  stopReason?: "vacuous_tests" | "tests_not_red_for_reason" | "base_not_green";
  detail: string;
}

/**
 * Judge the base run of a card's tests by its `change` (rule 6b). `base` is
 * the gate result on the untouched code: passed, or failed only because the
 * gates could not run.
 */
export function judgeRedFirst(
  change: CardChange | undefined,
  base: { passed: boolean; onlyNotRun: boolean },
  tests: readonly string[],
): RedFirstVerdict {
  const rule = redGreenRule(change);
  const names = tests.join(", ");
  if (!base.passed && base.onlyNotRun) {
    return { status: "unknown", detail: "the gates could not run on the base" };
  }
  if (rule.onBase === "red") {
    return base.passed
      ? {
          status: "vacuous",
          stopReason: "vacuous_tests",
          detail: `${names} already pass against the untouched implementation, so they cannot tell whether this card did anything.`,
        }
      : { status: "fails", detail: `${names} fail on the base, as a ${rule.change} card's must` };
  }
  return base.passed
    ? {
        status: "green",
        detail: `${names} pass on the base: a ${rule.change} card's proof (${rule.after})`,
      }
    : {
        status: "refused",
        stopReason: "base_not_green",
        detail: `${names} fail on the base, but a ${rule.change} card's tests must pass there: ${rule.rule}.`,
      };
}

/** What a confinement denial prints (Seatbelt's and seccomp's EPERM, sandbox-exec itself). */
const SANDBOX_DENIAL = /Operation not permitted|\bEPERM\b|sandbox-exec:|\bdeny\(\d+\)/;

/** The build command a build-repair card names (rule 6b, DEC-43). */
export interface BuildRepairCommand {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

export interface BuildRepairVerdict extends RedFirstVerdict {
  exitCode: number;
  /** The first error line the build printed: the step that failed. */
  failingStep?: string;
}

/**
 * A build-repair card's red check (rule 6b): no test can run on a base that
 * does not build, so red is the declared build command failing on the base,
 * run confined with no network, its exit code and failing step recorded. A
 * build that already succeeds is refused as not red.
 */
export async function buildRepairRedCheck(
  sandbox: ProcessSandbox,
  build: BuildRepairCommand,
): Promise<BuildRepairVerdict> {
  const shown = [build.command, ...build.args].join(" ");
  let result: Awaited<ReturnType<ProcessSandbox["execute"]>>;
  try {
    result = await sandbox.execute(build.command, build.args, {
      allowedPaths: [build.cwd],
      allowNetwork: false,
      timeoutMs: build.timeoutMs ?? 600_000,
      cwd: build.cwd,
    });
  } catch (err) {
    return {
      status: "unknown",
      exitCode: -1,
      detail: `${shown} could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (result.notStarted) {
    return { status: "unknown", exitCode: result.exitCode, detail: `${shown} did not start` };
  }
  // A build cut short or refused by the harness says nothing about the base:
  // a timeout, a memory kill or a sandbox denial is unknown, never red.
  if (result.timedOut || result.oomKilled) {
    return {
      status: "unknown",
      exitCode: result.exitCode,
      detail: `${shown} ${result.timedOut ? `timed out after ${build.timeoutMs ?? 600_000}ms` : "was killed for memory"} on the base, so whether it fails there is unknown`,
    };
  }
  const denial = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .find((l) => SANDBOX_DENIAL.test(l));
  if (result.exitCode !== 0 && denial) {
    return {
      status: "unknown",
      exitCode: result.exitCode,
      detail: `${shown} was denied by the sandbox on the base (${denial.trim().slice(0, 200)}), so whether it fails there is unknown`,
    };
  }
  if (result.exitCode === 0) {
    return {
      status: "refused",
      stopReason: "tests_not_red_for_reason",
      exitCode: 0,
      detail: `${shown} already succeeds on the base, so a build-repair card has nothing to repair.`,
    };
  }
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((l) => l.trim());
  const failingStep =
    lines.find((l) => /error|fail|cannot|not found/i.test(l)) ?? lines.find((l) => l.length > 0);
  return {
    status: "fails",
    exitCode: result.exitCode,
    ...(failingStep ? { failingStep: failingStep.slice(0, 300) } : {}),
    detail: `${shown} fails on the base (exit ${result.exitCode})${failingStep ? `: ${failingStep.slice(0, 200)}` : ""}`,
  };
}
