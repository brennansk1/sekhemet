import { writeSync } from "node:fs";
import { plainStatus } from "@sekhemet/ui";
import type { AcceptRefusedError } from "../accept.js";
import type { EgressRow } from "../egress_view.js";

/**
 * The one result type of `--json` (surface item 20c, NEW-surface-10; DEC-53
 * c11): `run`, `status`, `accept` and `doctor` each print exactly one object
 * of it on stdout and nothing else there. Each command's object has a
 * published JSON Schema, `apps/harness/data/schemas/cli/<command>.schema.json`,
 * and `cli_json.spec.ts` fails when the built binary's output and the schema
 * disagree (SUR-72).
 */

/** Surface item 18: 0 success, 1 failure, 2 a usage error or a missing confirmation. */
export type CliExit = 0 | 1 | 2;

interface ResultBase<C extends string> {
  command: C;
  /** `exitCode === 0`. */
  ok: boolean;
  /** The exit code the command gives, with or without `--json` (SUR-70). */
  exitCode: CliExit;
  /** The outcome in one sentence: what the prose says last. */
  message: string;
}

/** An issue as a script reads it: its key, title, stored state and the board's word for it. */
export interface IssueRef {
  id: string;
  title: string;
  /** The stored state (`ready`, `review`, …). */
  status: string;
  /** The state in plain words, as Status says it (`plainStatus`: *Waiting for review*, *On hold*, …). */
  state: string;
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  skipped?: boolean;
  /** The check could not give a verdict (gates rule 9); never a pass. */
  unavailable?: boolean;
}

export interface RunResult extends ResultBase<"run"> {
  issue?: IssueRef;
  /** Every blocking check passed and the issue reached Review. */
  passed?: boolean;
  stopReason?: string;
  steps?: { used: number; budget: number };
  checks?: CheckOutcome[];
  /** The Coding model the issue ran on. */
  model?: string;
}

export interface StatusResult extends ResultBase<"status"> {
  /** Each board column, in the board's order, with its issues. */
  columns?: { name: string; issues: (IssueRef & { steps?: { used: number; budget: number } })[] }[];
  /** The Ready issues in the order the queue takes them (wave2 `orderForQueue`). */
  next?: IssueRef[];
  /** What waits on a person: issues In review, and issues on hold. */
  waiting?: (IssueRef & { why: "review" | "on_hold" })[];
  /** Decisions waiting, each naming its person, in plain words (PM-N9-5). */
  decisions?: string[];
  /** In review is full: finished issues wait for a person. */
  reviewFull?: boolean;
}

/** An AI review finding as `review` numbers it and `accept --ack` names it (CLI-01). */
export interface FindingRef {
  number: number;
  verdict: string;
  text: string;
  acknowledged: boolean;
}

export interface AcceptResult extends ResultBase<"accept"> {
  issue?: IssueRef;
  accepted?: boolean;
  /** The squashed commit on the integration branch. */
  commit?: string;
  /** The pull request opened instead, when the project merges through one. */
  pullRequest?: string;
  /** How a checkout on the integration branch catches up (RG-S5-2). */
  notice?: string;
  /** Why Accept refused (`AcceptRefusedError` codes, or `usage`); the schema lists them. */
  refusal?: AcceptRefusedError["code"] | "usage";
  /** The AI review's findings on the change, numbered, with which are acknowledged. */
  findings?: FindingRef[];
  /** Implementation files not yet looked at (`sekhemet review` shows them). */
  files?: string[];
}

export interface DoctorResult extends ResultBase<"doctor"> {
  /** No check failed (SUR-61). */
  ready?: boolean;
  /** *Ready to run an issue*, or *Not ready* naming the first missing step (SUR-61). */
  verdict?: string;
  /** Each check; one that is not a pass carries its next step (SUR-62). */
  checks?: { name: string; status: "pass" | "warn" | "fail"; detail: string; do?: string }[];
}

/** `sekhemet egress --json` (security item 33a): what left the machine, newest first. */
export interface EgressResult extends ResultBase<"egress"> {
  rows?: EgressRow[];
}

export type CliResult = RunResult | StatusResult | AcceptResult | DoctorResult | EgressResult;
export type CliCommandName = CliResult["command"];

/** A result with only the four fields every command's object has. */
export function baseResult<C extends CliCommandName>(
  command: C,
  exitCode: CliExit,
  message: string,
): ResultBase<C> {
  return { command, ok: exitCode === 0, exitCode, message };
}

/** An issue as `--json` names it. */
export function issueRef(card: { id: string; title: string; status: string }): IssueRef {
  return { id: card.id, title: card.title, status: card.status, state: plainStatus(card.status) };
}

let realStdout: ((text: string) => void) | undefined;
let printed = false;

/**
 * From here on, everything written to stdout goes to stderr — the progress
 * the command and the code it calls print — so that stdout holds only the
 * one object {@link printJsonResult} writes.
 */
export function enterJsonMode(): void {
  if (realStdout) return;
  realStdout = (text) => {
    // Synchronous: the process may exit right after (a pipe on macOS is asynchronous).
    writeSync(1, text);
  };
  const stderr = process.stderr;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
}

/** The one object on stdout; a second is never printed. */
export function printJsonResult(value: CliResult | { ok: false; error: string }): void {
  if (printed) return;
  printed = true;
  (realStdout ?? ((t: string) => writeSync(1, t)))(`${JSON.stringify(value)}\n`);
}

/**
 * Item 20c: an error that reached the top under `--json` is still item 18a's
 * one line on stderr, and stdout then holds `{"ok": false, "error": <that line>}`.
 * Nothing when the command was not run with `--json`, or its object is out.
 */
export function jsonFatal(line: string): void {
  if (!realStdout || printed) return;
  printJsonResult({ ok: false, error: line });
}

/**
 * Surface item 18b (S1B-B19): a refusal is said one way, whichever command
 * gives it — one line `sekhemet: <what>` and, when there is a step that
 * moves things on, the next line `  Do: <that step>`, as `doctor` prints its
 * next steps (SUR-62). A refusal is never the crash line of item 18a.
 */
export function refusalLines(what: string, next?: string): string[] {
  return [`sekhemet: ${what}`, ...(next ? [`  Do: ${next}`] : [])];
}

/** Print a refusal on stderr (item 18b). */
export function printRefusal(what: string, next?: string): void {
  for (const line of refusalLines(what, next)) console.error(line);
}

/** Edit distance, for "did you mean" (commands and issue IDs). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** Where every issue's ID is listed: the hint an unknown ID ends with. */
export const LIST_ISSUES_STEP = "sekhemet status lists every issue with its ID";

/**
 * An ID no issue has (item 18b): what was asked for, the closest ID when one
 * is within two edits (a typo), and where the IDs are listed.
 */
export function noIssueRefusal(
  id: string,
  knownIds: readonly string[],
): { what: string; next: string } {
  const best = knownIds
    .map((k) => ({ k, d: editDistance(id, k) }))
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))[0];
  const close = best && best.d <= 2 ? best.k : undefined;
  return {
    what: close ? `no issue ${id}. Did you mean ${close}?` : `no issue ${id}`,
    next: LIST_ISSUES_STEP,
  };
}

/**
 * The step that moves an issue on from its stored state (item 18b): the
 * `Do:` line of a refusal that turned on the issue's state — Accept on an
 * issue not In review, a triage verb on an issue in the wrong column.
 */
export function nextStepFor(card: { id: string; status: string }): string | undefined {
  switch (card.status) {
    case "backlog":
      return `finish the issues ${card.id} depends on first; sekhemet status shows them`;
    case "planning":
      return `sekhemet approve ${card.id} (it leaves Planning once its acceptance criteria are approved)`;
    case "ready":
      return `sekhemet run ${card.id} (it reaches In review when its checks pass)`;
    case "in_progress":
    case "verify":
      return `wait for its run to reach In review, or stop it: sekhemet abort ${card.id}`;
    case "review":
      return `sekhemet review ${card.id}`;
    case "parked":
      return `sekhemet unpark ${card.id}`;
    case "rejected":
      return `sekhemet reopen ${card.id}`;
    case "done":
      return `to undo its accept: sekhemet revert ${card.id}`;
    default:
      return undefined;
  }
}
