import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userPaths } from "./user_dir.js";

/**
 * The lost-record log (runtime item 29a, NEW-runtime-19: RUN-89; FINDINGS_C1
 * REL-03). A ledger or dossier write that does not guard the work it records
 * — a step's span, a Worker's question, a breaker's trip, a send-back's
 * reason — is reported here when it fails, rather than swallowed: one warn
 * line, and one NDJSON line in `<user dir>/logs/<workspace id>/lost-records.ndjson`
 * that `doctor` counts. It is a diagnostic, not a durable channel: it holds
 * no fact the ledger needs, and writing it never throws.
 */

export interface LostRecord {
  at: string;
  kind: string;
  error: string;
  cardId?: string;
}

/** Where a workspace's lost records are logged; `unknown` before its ledger has an id. */
export function lostRecordsPath(workspaceId: string | undefined): string {
  return join(userPaths().logs, workspaceId ?? "unknown", "lost-records.ndjson");
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 500);
}

/** Report one record that could not be written (RUN-89). Never throws. */
export function reportLostRecord(
  kind: string,
  err: unknown,
  where: { workspaceId?: string | undefined; cardId?: string | undefined } = {},
): void {
  const line: LostRecord = {
    at: new Date().toISOString(),
    kind,
    error: messageOf(err),
    ...(where.cardId ? { cardId: where.cardId } : {}),
  };
  console.warn(
    `sekhemet: ${kind} not recorded: ${line.error}${where.cardId ? ` (${where.cardId})` : ""}`,
  );
  try {
    const path = lostRecordsPath(where.workspaceId);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // The log is a diagnostic: the warn line above is what is left.
  }
}

/** How many records a workspace has lost (for `doctor`). */
export function countLostRecords(workspaceId: string | undefined): number {
  const path = lostRecordsPath(workspaceId);
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** A reporter bound to a workspace, for the places that only know the record's kind. */
export function lostRecordReporter(
  workspaceId: () => string | undefined,
  cardId?: string,
): (kind: string, err: unknown) => void {
  return (kind, err) => reportLostRecord(kind, err, { workspaceId: workspaceId(), cardId });
}
