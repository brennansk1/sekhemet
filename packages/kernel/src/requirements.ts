import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";

/**
 * Versioned requirements and their links (kernel rule 36, NEW-kernel-8:
 * K-N8-1, K-N8-2). Everything is read from the ledger — `requirement/created`,
 * `requirement/revised`, `trace/linked`, `trace/confirmed` — so there is no
 * table to drift from it. A requirement's text is free text: the private part.
 */
export type TraceFrom = "card" | "test";

export interface TraceLink {
  requirementId: string;
  from: TraceFrom;
  /** A card id, or a test id (file plus test name). */
  ref: string;
  /** The requirement version the link was made or last confirmed against. */
  version: number;
  /** Made against an earlier version, not re-confirmed, and its card not superseded. */
  suspect: boolean;
}

interface Row {
  type: string;
  payload: string;
}

export class RequirementLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
  ) {}

  private events(types: string[], requirementId?: string): Record<string, unknown>[] {
    const marks = types.map(() => "?").join(", ");
    const rows = (requirementId === undefined
      ? this.db
          .prepare(`SELECT type, payload FROM events WHERE type IN (${marks}) ORDER BY seq`)
          .all(...types)
      : this.db
          .prepare(
            `SELECT type, payload FROM events WHERE type IN (${marks})
                 AND COALESCE(json_extract(payload, '$.requirementId'), json_extract(payload, '$.id')) = ?
               ORDER BY seq`,
          )
          .all(...types, requirementId)) as unknown as Row[];
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as object), __type: r.type }));
  }

  /** The requirement's current version, or undefined when it was never created. */
  public version(id: string): number | undefined {
    let version: number | undefined;
    for (const e of this.events(["requirement/created", "requirement/revised"], id)) {
      version = Number(e.version);
    }
    return version;
  }

  /**
   * Create a requirement (K-N8-2): its id is `REQ-<n>`, one more than the
   * highest ever used, or the one given — refused when it was ever used.
   */
  public async create(
    input: { id?: string; title: string },
    principal: string,
  ): Promise<{ id: string; version: number }> {
    const used = this.events(["requirement/created"]).map((e) => String(e.id));
    let id = input.id;
    if (id !== undefined && used.includes(id)) {
      throw new Error(`Requirement id ${id} was used before; a requirement id is never reused`);
    }
    if (id === undefined) {
      const highest = used.reduce((n, u) => {
        const m = /^REQ-(\d+)$/.exec(u);
        return m ? Math.max(n, Number(m[1])) : n;
      }, 0);
      id = `REQ-${highest + 1}`;
    }
    await this.log.append({
      actor: "human",
      type: "requirement/created",
      payload: { id, version: 1 },
      principal,
      private: { title: input.title },
    });
    return { id, version: 1 };
  }

  /** Revise it (K-N8-1): `requirement/revised {id, version}`; earlier links go suspect. */
  public async revise(id: string, input: { title: string }, principal: string): Promise<number> {
    const current = this.version(id);
    if (current === undefined) throw new Error(`No requirement ${id}`);
    const version = current + 1;
    await this.log.append({
      actor: "human",
      type: "requirement/revised",
      payload: { id, version },
      principal,
      private: { title: input.title },
    });
    return version;
  }

  /** A machine-written link, made against the requirement's current version. */
  public async link(
    input: { requirementId: string; from: TraceFrom; ref: string },
    actor = "planner",
  ): Promise<void> {
    const version = this.version(input.requirementId);
    if (version === undefined) throw new Error(`No requirement ${input.requirementId}`);
    await this.log.append({
      actor,
      type: "trace/linked",
      ...(input.from === "card" ? { cardId: input.ref } : {}),
      payload: { requirementId: input.requirementId, version, from: input.from, ref: input.ref },
    });
  }

  /** A principal re-confirms a link against the current version (K-N8-2): `trace/confirmed`. */
  public async confirm(
    input: { requirementId: string; from: TraceFrom; ref: string },
    principal: string,
  ): Promise<void> {
    if (!principal) throw new Error("A link is re-confirmed by a principal; none was given");
    const version = this.version(input.requirementId);
    if (version === undefined) throw new Error(`No requirement ${input.requirementId}`);
    await this.log.append({
      actor: "human",
      type: "trace/confirmed",
      ...(input.from === "card" ? { cardId: input.ref } : {}),
      payload: { requirementId: input.requirementId, version, from: input.from, ref: input.ref },
      principal,
    });
  }

  /** The requirement's links, each with the version it stands on and whether it is suspect. */
  public links(requirementId: string): TraceLink[] {
    const current = this.version(requirementId) ?? 0;
    const byKey = new Map<string, TraceLink>();
    for (const e of this.events(["trace/linked", "trace/confirmed"], requirementId)) {
      const from = e.from as TraceFrom;
      const ref = String(e.ref);
      const key = `${from}\u0000${ref}`;
      const version = Number(e.version);
      const prior = byKey.get(key);
      // A machine re-link never moves a link past a version it was not confirmed at.
      const next =
        e.__type === "trace/confirmed" || !prior ? version : Math.min(prior.version, version);
      byKey.set(key, { requirementId, from, ref, version: next, suspect: false });
    }
    const superseded = (ref: string): boolean =>
      (
        this.db.prepare("SELECT status FROM cards WHERE id = ?").get(ref) as
          | { status: string }
          | undefined
      )?.status === "rejected";
    return [...byKey.values()].map((l) => ({
      ...l,
      suspect: l.version < current && !(l.from === "card" && superseded(l.ref)),
    }));
  }
}
