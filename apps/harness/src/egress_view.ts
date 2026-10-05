import type { EventLog, EventRecord } from "@sekhemet/kernel";

/**
 * What leaves the machine, shown (security item 33a, NEW-security-11;
 * dashboard §2.16 item 5, NEW-dashboard-24; FINDINGS INS-08). The rows of
 * Configuration › Project › *Network activity* and of `sekhemet egress`, one
 * reader for both, so the two show the same rows for the same ledger
 * (DB-N24-1). It reads the recorded `harness/egress`, `card/egress`,
 * `model/downloaded` and `engine/downloaded` (models MD-N19-4) events and
 * records nothing (SEC-N11-2, DB-N24-3).
 */

export const EGRESS_EVENT_TYPES = [
  "harness/egress",
  "card/egress",
  "model/downloaded",
  "engine/downloaded",
] as const;

/** SEC-N11-3, DB-N24-2: the words when no row is recorded (or none matches the filters). */
export const NOTHING_LEFT = "Nothing has left this machine.";

export interface EgressRow {
  /** The recorded time, ISO. */
  at: string;
  host: string;
  /** Its purpose in plain words. */
  purpose: string;
  allowed: boolean;
  /** Why it was refused, when it was. */
  reason?: string;
  /** The size in plain units, when the record carries one. */
  size?: string;
  /** What caused it: an issue (its key and title), a person, or Sekhemet itself. */
  cause:
    | { kind: "issue"; id: string; title: string }
    | { kind: "person"; name: string }
    | { kind: "sekhemet" };
  /** The record's private part was erased (`ledger/erased`): shown as erased. */
  erased?: boolean;
}

export interface EgressFilters {
  /** Only records at or after this time (an ISO date or time). */
  since?: string;
  /** Only refused requests. */
  refusedOnly?: boolean;
}

export interface EgressContext {
  /** An issue's title and project, for its row's cause; undefined when it is unknown. */
  issue?: (id: string) => { title: string; projectId?: string } | undefined;
  /** A person's name; undefined when none is recorded. */
  personName?: (principal: string) => string | undefined;
  /** The install's own person, named *You* when no name is recorded. */
  localPrincipal?: string;
  /**
   * Whether the reader may see a record of this project (undefined: one of
   * the workspace's own requests, tied to no issue). Default: everything.
   */
  canSee?: (projectId: string | undefined) => boolean;
  /** The project the view is for: an issue's request of another project is not its row. */
  project?: string;
}

const PURPOSES: Record<string, string> = {
  "integration:github": "GitHub integration",
  "integration:forgejo": "Forgejo integration",
  "integration:slack": "Slack notifications",
  "integration:email": "Email notifications",
  "integration:push": "Push notifications",
  "remote:push": "Push to the remote",
  research: "Research",
  planning: "Planning research",
  "supply-chain": "Package registry check",
  "model lookup": "Model lookup",
  "model download": "Model download",
  // Models rule 6b: *Get the inference engine*, each redirect hop its own row.
  "engine download": "Engine download",
};

/** A recorded purpose id in plain words. */
export function purposeWords(purpose: string | undefined): string {
  if (!purpose) return "Network request";
  const known = PURPOSES[purpose];
  if (known) return known;
  const words = purpose.replace(/^integration:/, "").replace(/[:_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Payload = Record<string, unknown>;

/** A size in plain units, 1,024-based: bytes, KB, MB or GB. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Parses a `--since` or *Since* value: an ISO date or time; undefined when it is neither. */
export function parseSince(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function rowOf(e: EventRecord, ctx: EgressContext): EgressRow | undefined {
  const p = (e.payload ?? {}) as Payload;
  const at = str(p.at) ?? e.createdAt;
  let host: string;
  let purpose: string;
  let allowed: boolean;
  let bytes: number | undefined;
  let reason: string | undefined;
  if (e.type === "model/downloaded") {
    host = str(p.source) ?? "unknown host";
    purpose = purposeWords("model download");
    allowed = true;
    bytes = num(p.bytes);
  } else if (e.type === "engine/downloaded") {
    host = str(p.source) ?? "unknown host";
    purpose = `${purposeWords("engine download")}, llama.cpp ${str(p.release) ?? ""}`.trim();
    allowed = true;
    bytes = num(p.bytes);
  } else if (e.type === "card/egress") {
    host = str(p.host) ?? "unknown host";
    purpose =
      p.via === "generator" ? "Project generator's packages" : "The issue's allowed network";
    allowed = p.allowed === true;
    bytes = num(p.bytes);
    reason = str(p.reason);
  } else {
    host = str(p.host) ?? "unknown host";
    purpose = purposeWords(str(p.purpose));
    allowed = p.allowed === true;
    reason = str(p.reason);
  }
  const issue = e.cardId ? ctx.issue?.(e.cardId) : undefined;
  const projectId = issue?.projectId;
  if (e.cardId && ctx.project && projectId && projectId !== ctx.project) return undefined;
  if (ctx.canSee && !ctx.canSee(e.cardId ? projectId : undefined)) return undefined;
  const principal = e.principal ?? str(p.principal);
  const cause: EgressRow["cause"] = e.cardId
    ? { kind: "issue", id: e.cardId, title: issue?.title ?? e.cardId }
    : principal
      ? {
          kind: "person",
          name:
            ctx.personName?.(principal) ??
            (principal === ctx.localPrincipal ? "You" : "A teammate"),
        }
      : { kind: "sekhemet" };
  return {
    at,
    host,
    purpose,
    allowed,
    ...(!allowed && reason ? { reason } : {}),
    ...(bytes !== undefined ? { size: sizeWords(bytes) } : {}),
    cause,
    ...(e.erasedBySeq !== undefined ? { erased: true } : {}),
  };
}

/**
 * The recorded requests that left (or tried to leave) the machine, newest
 * first, as the reader may see them (SEC-N11-2, DB-N24-1..3). Reads only.
 */
export async function egressRows(
  log: Pick<EventLog, "getEventsByTypes">,
  filters: EgressFilters = {},
  ctx: EgressContext = {},
): Promise<EgressRow[]> {
  const since = parseSince(filters.since);
  const events = await log.getEventsByTypes([...EGRESS_EVENT_TYPES], 1, 1_000_000);
  const rows: EgressRow[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const row = rowOf(events[i] as EventRecord, ctx);
    if (!row) continue;
    if (filters.refusedOnly && row.allowed) continue;
    if (since && Date.parse(row.at) < Date.parse(since)) continue;
    rows.push(row);
  }
  return rows;
}

/** The cause in words: *CHR-12 Implement canonical JSON*, a person's name, or *Sekhemet*. */
export function causeWords(cause: EgressRow["cause"]): string {
  return cause.kind === "issue"
    ? `${cause.id} ${cause.title}`
    : cause.kind === "person"
      ? cause.name
      : "Sekhemet";
}

/** `sekhemet egress`'s lines: one per row, or *Nothing has left this machine.* */
export function egressLines(rows: readonly EgressRow[]): string[] {
  if (rows.length === 0) return [NOTHING_LEFT];
  return rows.map((r) =>
    [
      r.at.replace("T", " ").replace(/\.\d+Z$|Z$/, ""),
      r.allowed ? "Allowed" : "Refused",
      r.host,
      r.purpose,
      r.size ?? "",
      causeWords(r.cause),
      r.reason ? `(${r.reason})` : "",
      r.erased ? "[details erased]" : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}
