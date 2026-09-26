import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import { ERASED_MARKER, type EventRecord } from "./types.js";

/**
 * Versioned requirements and their links (kernel rule 36, NEW-kernel-8:
 * K-N8-1, K-N8-2), and the requirement graph's records (planner-pm P13:
 * PM-P13-1, -11, -12). Everything is read from the ledger —
 * `requirement/created`, `requirement/revised`, `requirement/cut`,
 * `trace/linked`, `trace/confirmed` — so there is no table to drift from it.
 * A requirement's title and its criteria's text are free text: the private part.
 */
export type TraceFrom = "card" | "test";

export interface TraceLink {
  requirementId: string;
  from: TraceFrom;
  /** A card id, or a test id (file plus test name). */
  ref: string;
  /** The requirement version the link was made or last confirmed against. */
  version: number;
  /**
   * Made against an earlier version and neither re-confirmed by a principal
   * nor resolved by an accepted change card at the current version; a link
   * from a superseded (rejected) card is never suspect (PM-P13-11, -12).
   */
  suspect: boolean;
}

/** The Kano class of a requirement (planner-pm §2.15.1). */
export type KanoClass = "must-be" | "performance" | "attractive";

export const KANO_CLASSES: readonly KanoClass[] = ["must-be", "performance", "attractive"];

/** One acceptance criterion of a requirement: a stable id and its (private) text. */
export interface RequirementCriterion {
  id: string;
  text: string;
}

/** A requirement as its events leave it (PM-P13-1). */
export interface Requirement {
  id: string;
  version: number;
  projectId?: string;
  /** The release slice it belongs to. */
  sliceId?: string;
  /** Requirement ids it depends on ("show results" depends on "load data"). */
  dependsOn: string[];
  kano?: KanoClass;
  /** A must-have, or a nice-to-have (`~`); a requirement written before the mark is a must-have. */
  mustHave: boolean;
  criteria: RequirementCriterion[];
  /** The private title; `ERASED_MARKER` after an erasure. */
  title?: string;
  /** A person cut it from its slice (PM-P13-9). */
  cut: boolean;
}

export interface RequirementInput {
  id?: string;
  title: string;
  /** Taken from the slice when omitted and a slice is named. */
  projectId?: string;
  sliceId?: string;
  dependsOn?: string[];
  kano?: KanoClass;
  /** `true` when omitted. */
  mustHave?: boolean;
  criteria?: RequirementCriterion[];
}

/** A revision restates only what changed; the rest carries forward. */
export type RequirementRevision = Partial<Omit<RequirementInput, "id" | "projectId">>;

const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const REQUIREMENT_EVENTS = ["requirement/created", "requirement/revised", "requirement/cut"];

interface Row {
  seq: number;
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
          .prepare(`SELECT seq, type, payload FROM events WHERE type IN (${marks}) ORDER BY seq`)
          .all(...types)
      : this.db
          .prepare(
            `SELECT seq, type, payload FROM events WHERE type IN (${marks})
                 AND COALESCE(json_extract(payload, '$.requirementId'), json_extract(payload, '$.id')) = ?
               ORDER BY seq`,
          )
          .all(...types, requirementId)) as unknown as Row[];
    return rows.map((r) => ({
      ...(JSON.parse(r.payload) as object),
      __type: r.type,
      __seq: r.seq,
    }));
  }

  /** The event sequence a requirement's version was set at (its creation or a later revision). */
  private versionSeq(id: string, version: number): number | undefined {
    for (const e of this.events(["requirement/created", "requirement/revised"], id)) {
      if (Number(e.version) === version) return e.__seq as number;
    }
    return undefined;
  }

  /** The sequence a card's status last became `done`, or undefined if it never has. */
  private cardDoneSeq(id: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS s FROM events WHERE card_id = ? AND type = 'card/status_changed'
           AND json_extract(payload, '$.toStatus') = 'done'`,
      )
      .get(id) as { s: number | null } | undefined;
    return row?.s ?? undefined;
  }

  /** The requirement's current version, or undefined when it was never created. */
  public version(id: string): number | undefined {
    let version: number | undefined;
    for (const e of this.events(["requirement/created", "requirement/revised"], id)) {
      version = Number(e.version);
    }
    return version;
  }

  /** The project of a slice that was created, or undefined (slices live in `SliceLedger`). */
  private sliceProject(sliceId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.projectId') AS p FROM events
           WHERE type = 'slice/created' AND json_extract(payload, '$.sliceId') = ? LIMIT 1`,
      )
      .get(sliceId) as { p: string } | undefined;
    return row?.p;
  }

  private cardStatus(id: string): string | undefined {
    return (
      this.db.prepare("SELECT status FROM cards WHERE id = ?").get(id) as
        | { status: string }
        | undefined
    )?.status;
  }

  /** Every requirement, in creation order, with its private text. */
  public async list(filter: { projectId?: string; sliceId?: string } = {}): Promise<Requirement[]> {
    const byId = new Map<string, Requirement>();
    for (const e of await this.log.getEventsByTypes(REQUIREMENT_EVENTS)) {
      const p = e.payload as Record<string, unknown>;
      const id = String(p.id);
      if (e.type === "requirement/cut") {
        const r = byId.get(id);
        if (r) r.cut = true;
        continue;
      }
      const r: Requirement = byId.get(id) ?? {
        id,
        version: 1,
        dependsOn: [],
        mustHave: true,
        criteria: [],
        cut: false,
      };
      applyRequirementEvent(r, e);
      byId.set(id, r);
    }
    return [...byId.values()].filter(
      (r) =>
        (filter.projectId === undefined || r.projectId === filter.projectId) &&
        (filter.sliceId === undefined || r.sliceId === filter.sliceId),
    );
  }

  /** One requirement, or undefined. */
  public async get(id: string): Promise<Requirement | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  /** The requirements of a slice, in creation order (PM-P13-1). */
  public async bySlice(sliceId: string): Promise<Requirement[]> {
    return this.list({ sliceId });
  }

  /**
   * Must-have requirements, not cut, that no card traces to — a link from a
   * rejected card does not count (PM-P13-3). Their slice cannot be proven.
   */
  public async unplannedMustHaves(
    filter: { projectId?: string; sliceId?: string } = {},
  ): Promise<Requirement[]> {
    return (await this.list(filter)).filter(
      (r) =>
        r.mustHave &&
        !r.cut &&
        !this.links(r.id).some((l) => l.from === "card" && this.cardStatus(l.ref) !== "rejected"),
    );
  }

  /** What is refused in a requirement's fields, checked before anything is appended. */
  private async check(
    id: string,
    input: RequirementRevision & { projectId?: string },
    current?: Requirement,
  ): Promise<{ projectId?: string }> {
    const all = await this.list();
    const known = new Set(all.map((r) => r.id));
    for (const dep of input.dependsOn ?? []) {
      if (dep === id || !known.has(dep)) {
        throw new Error(
          `Requirement ${id}: it cannot depend on ${dep}, which is not another requirement`,
        );
      }
    }
    if (input.dependsOn !== undefined && current) {
      // A cycle can only be closed by a revision: follow the others' edges back to this one.
      const edges = new Map(all.map((r) => [r.id, r.dependsOn] as const));
      edges.set(id, input.dependsOn);
      const stack = [...input.dependsOn];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const at = stack.pop() as string;
        if (at === id) {
          throw new Error(
            `Requirement ${id}: depending on ${input.dependsOn.join(", ")} closes a cycle`,
          );
        }
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(edges.get(at) ?? []));
      }
    }
    if (input.kano !== undefined && !KANO_CLASSES.includes(input.kano)) {
      throw new Error(`Requirement ${id}: the Kano class is one of ${KANO_CLASSES.join(", ")}`);
    }
    if (input.criteria !== undefined) {
      const ids = input.criteria.map((c) => c.id);
      if (!ids.every((c) => typeof c === "string" && CRITERION_ID.test(c))) {
        throw new Error(`Requirement ${id}: a criterion id is letters, digits, '.', '_' or '-'`);
      }
      if (new Set(ids).size !== ids.length) {
        throw new Error(`Requirement ${id}: a criterion id appears twice`);
      }
    }
    let projectId = input.projectId ?? current?.projectId;
    if (input.sliceId !== undefined) {
      const sliceProject = this.sliceProject(input.sliceId);
      if (sliceProject === undefined) {
        throw new Error(`Requirement ${id}: no slice ${input.sliceId}`);
      }
      if (projectId !== undefined && projectId !== sliceProject) {
        throw new Error(
          `Requirement ${id}: slice ${input.sliceId} belongs to project ${sliceProject}, not ${projectId}`,
        );
      }
      projectId = sliceProject;
    } else if (input.projectId !== undefined) {
      if (!this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)) {
        throw new Error(`Requirement ${id}: no project ${input.projectId}`);
      }
    }
    return projectId === undefined ? {} : { projectId };
  }

  /**
   * Create a requirement (K-N8-2, PM-P13-1): its id is `REQ-<n>`, one more
   * than the highest ever used, or the one given — refused when it was ever used.
   */
  public async create(
    input: RequirementInput,
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
    const { projectId } = await this.check(id, input);
    await this.log.append({
      actor: "human",
      type: "requirement/created",
      payload: {
        id,
        version: 1,
        ...(projectId !== undefined ? { projectId } : {}),
        ...structuralFields(input),
        mustHave: input.mustHave ?? true,
      },
      principal,
      private: privateFields(input),
    });
    return { id, version: 1 };
  }

  /**
   * Revise it (K-N8-1, PM-P13-11): `requirement/revised {id, version, …what
   * changed}`; every link made against an earlier version goes suspect.
   */
  public async revise(id: string, input: RequirementRevision, principal: string): Promise<number> {
    const current = await this.get(id);
    if (current === undefined) throw new Error(`No requirement ${id}`);
    const { projectId } = await this.check(id, input, current);
    const version = current.version + 1;
    const priv = privateFields(input);
    await this.log.append({
      actor: "human",
      type: "requirement/revised",
      payload: {
        id,
        version,
        ...(input.sliceId !== undefined &&
        projectId !== current.projectId &&
        projectId !== undefined
          ? { projectId }
          : {}),
        ...structuralFields(input),
      },
      principal,
      ...(Object.keys(priv).length > 0 ? { private: priv } : {}),
    });
    return version;
  }

  /**
   * A machine-written link, made against the requirement's current version.
   * `changeFor` names the suspect link (a card or test id) this card is the
   * change card for: once this card is accepted at the current version, that
   * link is no longer suspect (PM-P13-12).
   */
  public async link(
    input: { requirementId: string; from: TraceFrom; ref: string; changeFor?: string },
    actor = "planner",
  ): Promise<void> {
    const version = this.version(input.requirementId);
    if (version === undefined) throw new Error(`No requirement ${input.requirementId}`);
    if (input.changeFor !== undefined && (input.from !== "card" || input.changeFor === input.ref)) {
      throw new Error(
        `A change card is a card linked for another card's or test's suspect link; ${input.from} ${input.ref} cannot be one for ${input.changeFor}`,
      );
    }
    await this.log.append({
      actor,
      type: "trace/linked",
      ...(input.from === "card" ? { cardId: input.ref } : {}),
      payload: {
        requirementId: input.requirementId,
        version,
        from: input.from,
        ref: input.ref,
        ...(input.changeFor !== undefined ? { changeFor: input.changeFor } : {}),
      },
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
    // Refs whose suspect link an accepted change card at the current version resolves.
    const changed = new Set<string>();
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
      // PM-P13-12: a change card resolves a suspect link only once it was
      // accepted (moved to `done`) after the revision it answers — a card
      // that happened to already be done before that revision, later named
      // as the change card by reusing its id, clears nothing (K-N9-4-style
      // ordering guard on an event's own sequence, not merely its recorded
      // version, which a stale or reused link can share by coincidence).
      const revisedAt = version === current ? this.versionSeq(requirementId, version) : undefined;
      const doneAt = this.cardDoneSeq(ref);
      if (
        e.__type === "trace/linked" &&
        typeof e.changeFor === "string" &&
        version === current &&
        this.cardStatus(ref) === "done" &&
        revisedAt !== undefined &&
        doneAt !== undefined &&
        doneAt > revisedAt
      ) {
        changed.add(e.changeFor);
      }
    }
    return [...byKey.values()].map((l) => ({
      ...l,
      suspect:
        l.version < current &&
        !(l.from === "card" && this.cardStatus(l.ref) === "rejected") &&
        !changed.has(l.ref),
    }));
  }

  /** Every link from one card or test, across requirements, with its suspect flag. */
  public linksFrom(from: TraceFrom, ref: string): TraceLink[] {
    const ids = (
      this.db
        .prepare(
          `SELECT DISTINCT json_extract(payload, '$.requirementId') AS r FROM events
             WHERE type IN ('trace/linked', 'trace/confirmed')
               AND json_extract(payload, '$.from') = ? AND json_extract(payload, '$.ref') = ?
             ORDER BY r`,
        )
        .all(from, ref) as { r: string }[]
    ).map((row) => row.r);
    return ids.flatMap((id) => this.links(id).filter((l) => l.from === from && l.ref === ref));
  }
}

function structuralFields(input: RequirementRevision): Record<string, unknown> {
  return {
    ...(input.sliceId !== undefined ? { sliceId: input.sliceId } : {}),
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
    ...(input.kano !== undefined ? { kano: input.kano } : {}),
    ...(input.mustHave !== undefined ? { mustHave: input.mustHave } : {}),
    ...(input.criteria !== undefined ? { criterionIds: input.criteria.map((c) => c.id) } : {}),
  };
}

function privateFields(input: RequirementRevision): Record<string, unknown> {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.criteria !== undefined
      ? { criteria: Object.fromEntries(input.criteria.map((c) => [c.id, c.text])) }
      : {}),
  };
}

/** Fold one `requirement/created` or `requirement/revised` into the requirement. */
function applyRequirementEvent(r: Requirement, e: EventRecord): void {
  const p = e.payload as Record<string, unknown>;
  const priv = e.private ?? {};
  r.version = Number(p.version);
  if (typeof p.projectId === "string") r.projectId = p.projectId;
  if (typeof p.sliceId === "string") r.sliceId = p.sliceId;
  if (Array.isArray(p.dependsOn)) r.dependsOn = p.dependsOn.map(String);
  if (typeof p.kano === "string") r.kano = p.kano as KanoClass;
  if (typeof p.mustHave === "boolean") r.mustHave = p.mustHave;
  if (typeof priv.title === "string") r.title = priv.title;
  if (Array.isArray(p.criterionIds)) {
    const texts = priv.criteria;
    r.criteria = p.criterionIds.map((id) => ({
      id: String(id),
      text:
        texts !== null && typeof texts === "object"
          ? String((texts as Record<string, unknown>)[String(id)] ?? "")
          : ERASED_MARKER,
    }));
  }
}
