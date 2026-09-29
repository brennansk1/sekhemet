import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
import { AUDIT_CATEGORIES, AUDIT_TYPES, type AuditEntry, auditCsv, auditEntry } from "@sekhemet/ui";
import { type Access, type Level, refuse } from "./access.js";
import { personName } from "./members.js";

/**
 * The audit log (teams item 27, TEAM-27; dashboard §2.17 item 5): the event
 * log read as a table of actor, action, target and time, newest first,
 * filtered by person (who did it or whom it was about), action (a kind of
 * `AUDIT_CATEGORIES`, or one event type) and project, and exported as CSV or
 * JSON. It is a read of the ledger, not a second store, and reads only the
 * public part of each event. Only an Admin may open it (`audit.view`); a
 * refusal is recorded like any other (TEAM-4).
 */

export interface AuditQuery {
  person?: string;
  /** A category id (`sign_in`, `level`, …) or one event type. */
  action?: string;
  project?: string;
  /** Entries older than this seq (the next page). */
  before?: number;
  limit?: number;
}

interface Row {
  seq: number;
  type: string;
  actor: string;
  payload: string;
  principal: string | null;
  on_behalf_of: string | null;
  created_at: string;
  card_project: string | null;
}

export const AUDIT_PAGE = 200;
export const AUDIT_EXPORT_MAX = 50_000;

/** The event types an `action` filter names: a category's, or the one type. */
function typesFor(action: string | undefined): readonly string[] {
  if (!action) return AUDIT_TYPES;
  const category = AUDIT_CATEGORIES.find((c) => c.id === action);
  if (category) return category.types;
  return AUDIT_TYPES.includes(action) ? [action] : [];
}

export function auditEntries(
  db: DatabaseSync,
  q: AuditQuery,
  names: { person(p: string): string | undefined; project(id: string): string | undefined },
): { entries: AuditEntry[]; next?: number } {
  const types = typesFor(q.action);
  if (types.length === 0) return { entries: [] };
  const limit = Math.max(1, Math.min(q.limit ?? AUDIT_PAGE, AUDIT_EXPORT_MAX));
  const where: string[] = [`e.type IN (${types.map(() => "?").join(",")})`];
  const args: (string | number)[] = [...types];
  if (q.before !== undefined) {
    where.push("e.seq < ?");
    args.push(q.before);
  }
  if (q.person) {
    where.push(
      "(e.principal = ? OR e.on_behalf_of = ? OR json_extract(e.payload, '$.principal') = ?)",
    );
    args.push(q.person, q.person, q.person);
  }
  if (q.project) {
    // A release's lead names its project as `projectId` (teams item 28).
    where.push(
      "(json_extract(e.payload, '$.project') = ? OR json_extract(e.payload, '$.projectId') = ? OR c.project_id = ?)",
    );
    args.push(q.project, q.project, q.project);
  }
  const rows = db
    .prepare(
      `SELECT e.seq, e.type, e.actor, e.payload, e.principal, e.on_behalf_of, e.created_at,
              c.project_id AS card_project
         FROM events e LEFT JOIN cards c ON c.id = e.card_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.seq DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as unknown as Row[];
  const entries: AuditEntry[] = [];
  for (const r of rows.slice(0, limit)) {
    const entry = auditEntry(
      {
        seq: r.seq,
        at: r.created_at,
        type: r.type,
        actor: r.actor,
        principal: r.principal,
        onBehalfOf: r.on_behalf_of,
        cardProject: r.card_project,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      },
      names,
    );
    if (entry) entries.push(entry);
  }
  const last = rows[limit - 1];
  return rows.length > limit && last ? { entries, next: last.seq } : { entries };
}

export interface AuditRouteDeps {
  db: DatabaseSync;
  log: EventLog;
  access: Access;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  principalOf: (req: IncomingMessage) => string;
  /** A personal token's scope: the ceiling of the check (teams item 15). */
  ceilingOf?: (req: IncomingMessage) => Level | undefined;
  projectName: (id: string) => string | undefined;
  /** Every release, for its name in an entry (DEC-31): its title, else *Release N* in its project. */
  releases?: () => Promise<{ id: string; projectId: string; title?: string }[]>;
}

/** A release's name as Status says it: its title, else *Release N* by its place in the project. */
export function releaseNames(
  releases: { id: string; projectId: string; title?: string }[],
): (project: string, id: string) => string | undefined {
  const byProject = new Map<string, Map<string, string>>();
  for (const r of releases) {
    const names = byProject.get(r.projectId) ?? new Map<string, string>();
    names.set(r.id, r.title?.trim() ? r.title.trim() : `Release ${names.size + 1}`);
    byProject.set(r.projectId, names);
  }
  return (project, id) => byProject.get(project)?.get(id);
}

/** `GET /api/audit` (TEAM-27): the page, or `?format=csv|json` for the export. */
export function handleAuditRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  query: URLSearchParams,
  deps: AuditRouteDeps,
): boolean {
  if (url !== "/api/audit") return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    deps.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  const who = deps.principalOf(req);
  const decision = deps.access.decide(
    who,
    "audit.view",
    undefined,
    undefined,
    deps.ceilingOf?.(req),
  );
  if (!decision.allowed) {
    refuse(res, deps.json, deps.log, decision, { principal: who });
    return true;
  }
  const num = (k: string) => {
    const v = query.get(k);
    return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const format = query.get("format");
  const before = num("before");
  const exporting = format === "csv" || format === "json";
  const q: AuditQuery = {
    ...(query.get("person") ? { person: query.get("person") as string } : {}),
    ...(query.get("action") ? { action: query.get("action") as string } : {}),
    ...(query.get("project") ? { project: query.get("project") as string } : {}),
    ...(before !== undefined ? { before } : {}),
    limit: exporting ? AUDIT_EXPORT_MAX : (num("limit") ?? AUDIT_PAGE),
  };
  void respond(res, q, format, exporting, deps).catch((err: unknown) => {
    if (!res.headersSent) {
      deps.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return true;
}

async function respond(
  res: ServerResponse,
  q: AuditQuery,
  format: string | null,
  exporting: boolean,
  deps: AuditRouteDeps,
): Promise<void> {
  const cache = new Map<string, string | undefined>();
  const release = deps.releases ? releaseNames(await deps.releases()) : undefined;
  const names = {
    person: (p: string) => {
      if (!cache.has(p)) cache.set(p, personName(deps.db, p));
      return cache.get(p);
    },
    project: deps.projectName,
    ...(release ? { release } : {}),
  };
  const page = auditEntries(deps.db, q, names);
  if (!exporting) {
    deps.json(res, 200, page);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const body = format === "csv" ? auditCsv(page.entries) : JSON.stringify(page, null, 2);
  res.writeHead(200, {
    "Content-Type":
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="audit-${day}.${format}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}
