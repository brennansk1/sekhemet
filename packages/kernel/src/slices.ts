import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import type { RequirementLedger } from "./requirements.js";

/**
 * Release slices, their appetite and their releases (planner-pm §2.15.4,
 * .7, .8; PM-P13-9, PM-P13-13), read from the ledger: `slice/created`,
 * `slice/appetite_reached`, `slice/extended`, `requirement/cut`,
 * `slice/accepted` (written by `CardStore.recordSliceAccepted`, K-N5-5) and
 * `release/proposed`. These are records only: when to stop scheduling,
 * what to offer and whether a slice is proven is the planner's.
 */

/** A slice's appetite: a card budget, a time budget, or both. */
export interface SliceAppetite {
  cards?: number;
  hours?: number;
}

export interface Slice {
  id: string;
  projectId: string;
  /** The private title; `[erased]` after an erasure. */
  title?: string;
  appetite: SliceAppetite;
  /** Reached, and not extended since (PM-P13-9). */
  appetiteReached: boolean;
  extensions: number;
  /** A person recorded `slice/accepted` for it. */
  accepted: boolean;
  /** Its requirements, in creation order. */
  requirementIds: string[];
  /** Those a person cut. */
  cutRequirementIds: string[];
}

/** Keep a Changelog's categories (planner-pm §2.15.8). */
export type ChangelogCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export interface ReleaseProposal {
  sliceId: string;
  projectId: string;
  /** A semantic version, `1.2.3`. */
  version: string;
  /** The slice's proven requirements the notes are written from. */
  requirementIds: string[];
  changelog?: Partial<Record<ChangelogCategory, string[]>>;
  notes?: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const SLICE_EVENTS = [
  "slice/created",
  "slice/appetite_reached",
  "slice/extended",
  "slice/accepted",
];

export class SliceLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    private readonly requirements: RequirementLedger,
  ) {}

  /**
   * Create a slice with its appetite, set before planning (PM-P13-9): its id
   * is `SLICE-<n>`, never reused, or the one given.
   */
  public async create(
    input: { id?: string; projectId: string; title: string; appetite: SliceAppetite },
    principal: string,
  ): Promise<string> {
    const used = (
      this.db
        .prepare(
          "SELECT json_extract(payload, '$.sliceId') AS s FROM events WHERE type = 'slice/created'",
        )
        .all() as { s: string }[]
    ).map((r) => r.s);
    let id = input.id;
    if (id !== undefined && used.includes(id)) {
      throw new Error(`Slice id ${id} was used before; a slice id is never reused`);
    }
    if (id === undefined) {
      const highest = used.reduce((n, u) => {
        const m = /^SLICE-(\d+)$/.exec(u);
        return m ? Math.max(n, Number(m[1])) : n;
      }, 0);
      id = `SLICE-${highest + 1}`;
    }
    if (!this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)) {
      throw new Error(`Slice ${id}: no project ${input.projectId}`);
    }
    if (input.appetite.cards === undefined && input.appetite.hours === undefined) {
      throw new Error(`Slice ${id}: an appetite is a card budget, a time budget or both`);
    }
    await this.log.append({
      actor: "human",
      type: "slice/created",
      payload: { sliceId: id, projectId: input.projectId, ...appetitePayload(input.appetite) },
      principal,
      private: { title: input.title },
    });
    return id;
  }

  /** Every slice, in creation order, optionally of one project. */
  public async list(projectId?: string): Promise<Slice[]> {
    const slices = new Map<string, Slice & { reachedAt: number; extendedAt: number }>();
    for (const e of await this.log.getEventsByTypes(SLICE_EVENTS)) {
      const p = e.payload as Record<string, unknown>;
      const id = String(p.sliceId);
      if (e.type === "slice/created") {
        slices.set(id, {
          id,
          projectId: String(p.projectId),
          ...(typeof e.private?.title === "string" ? { title: e.private.title } : {}),
          appetite: appetiteOf(p),
          appetiteReached: false,
          extensions: 0,
          accepted: false,
          requirementIds: [],
          cutRequirementIds: [],
          reachedAt: 0,
          extendedAt: 0,
        });
        continue;
      }
      const s = slices.get(id);
      if (!s) continue;
      if (e.type === "slice/appetite_reached") s.reachedAt = e.seq;
      if (e.type === "slice/extended") {
        s.appetite = { ...s.appetite, ...appetiteOf(p) };
        s.extensions += 1;
        s.extendedAt = e.seq;
      }
      if (e.type === "slice/accepted" && e.actor === "human") s.accepted = true;
    }
    for (const r of await this.requirements.list()) {
      const s = r.sliceId === undefined ? undefined : slices.get(r.sliceId);
      if (!s) continue;
      s.requirementIds.push(r.id);
      if (r.cut) s.cutRequirementIds.push(r.id);
    }
    return [...slices.values()]
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .map(({ reachedAt, extendedAt, ...s }) => ({
        ...s,
        appetiteReached: reachedAt > extendedAt,
      }));
  }

  public async get(id: string): Promise<Slice | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  private async mustGet(id: string): Promise<Slice> {
    const slice = await this.get(id);
    if (!slice) throw new Error(`No slice ${id}`);
    return slice;
  }

  /** The machine records that a slice's cards or hours reached its appetite (PM-P13-9). */
  public async recordAppetiteReached(
    input: { sliceId: string; cards: number; hours: number },
    actor = "planner",
  ): Promise<void> {
    const slice = await this.mustGet(input.sliceId);
    await this.log.append({
      actor,
      type: "slice/appetite_reached",
      payload: {
        sliceId: slice.id,
        projectId: slice.projectId,
        cards: input.cards,
        hours: input.hours,
      },
    });
  }

  /** A person extends a slice's appetite: each budget given is raised (PM-P13-9). */
  public async extend(
    input: { sliceId: string; appetite: SliceAppetite },
    principal: string,
  ): Promise<void> {
    if (!principal) throw new Error("A slice is extended by a person; no principal was given");
    const slice = await this.mustGet(input.sliceId);
    const given = appetitePayload(input.appetite);
    if (Object.keys(given).length === 0) {
      throw new Error(`Slice ${slice.id}: cannot extend without a new card or time budget`);
    }
    for (const key of ["cards", "hours"] as const) {
      const next = input.appetite[key];
      const now = slice.appetite[key];
      if (next !== undefined && now !== undefined && next <= now) {
        throw new Error(
          `Slice ${slice.id}: cannot extend ${key} to ${next}; an extension raises it above ${now}`,
        );
      }
    }
    await this.log.append({
      actor: "human",
      type: "slice/extended",
      payload: { sliceId: slice.id, projectId: slice.projectId, ...given },
      principal,
    });
  }

  /** A person cuts a nice-to-have from its slice (PM-P13-9); a must-have is never cut. */
  public async cut(
    input: { requirementId: string; reason?: string },
    principal: string,
  ): Promise<void> {
    if (!principal) throw new Error("A requirement is cut by a person; no principal was given");
    const r = await this.requirements.get(input.requirementId);
    if (!r) throw new Error(`No requirement ${input.requirementId}`);
    if (r.sliceId === undefined) {
      throw new Error(`Requirement ${r.id} is in no slice, so there is nothing to cut it from`);
    }
    if (r.mustHave) {
      throw new Error(
        `Requirement ${r.id} is a must-have: it is never cut (revise it to a nice-to-have first)`,
      );
    }
    if (r.cut) throw new Error(`Requirement ${r.id} was already cut`);
    await this.log.append({
      actor: "human",
      type: "requirement/cut",
      payload: { id: r.id, sliceId: r.sliceId },
      principal,
      ...(input.reason !== undefined ? { private: { reason: input.reason } } : {}),
    });
  }

  /**
   * Propose a release for a slice a person accepted (PM-P13-13): its version
   * and the proven requirements (which ones are proven is the planner's to
   * compute); the changelog and notes are private text. Tagging is a
   * person's confirmation, later.
   */
  public async proposeRelease(
    input: Omit<ReleaseProposal, "projectId">,
    actor = "planner",
  ): Promise<void> {
    const slice = await this.mustGet(input.sliceId);
    if (!slice.accepted) {
      throw new Error(
        `Slice ${slice.id} has not been accepted by a person; no release is proposed`,
      );
    }
    if (!SEMVER.test(input.version)) {
      throw new Error(`A release version is a semantic version (1.2.3), got ${input.version}`);
    }
    for (const id of input.requirementIds) {
      if (!slice.requirementIds.includes(id) || slice.cutRequirementIds.includes(id)) {
        throw new Error(`${id} is not a requirement of slice ${slice.id} that was kept`);
      }
    }
    const priv = {
      ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    await this.log.append({
      actor,
      type: "release/proposed",
      payload: {
        sliceId: slice.id,
        projectId: slice.projectId,
        version: input.version,
        requirementIds: input.requirementIds,
      },
      ...(Object.keys(priv).length > 0 ? { private: priv } : {}),
    });
  }

  /** The releases proposed for a slice, oldest first, with their private text. */
  public async releases(sliceId: string): Promise<ReleaseProposal[]> {
    return (await this.log.getEventsByTypes(["release/proposed"]))
      .filter((e) => (e.payload as { sliceId?: string }).sliceId === sliceId)
      .map((e) => {
        const p = e.payload as Omit<ReleaseProposal, "changelog" | "notes">;
        const priv = e.private ?? {};
        return {
          sliceId: p.sliceId,
          projectId: p.projectId,
          version: p.version,
          requirementIds: p.requirementIds,
          ...(priv.changelog !== undefined
            ? { changelog: priv.changelog as Partial<Record<ChangelogCategory, string[]>> }
            : {}),
          ...(typeof priv.notes === "string" ? { notes: priv.notes } : {}),
        };
      });
  }
}

function appetitePayload(a: SliceAppetite): { appetiteCards?: number; appetiteHours?: number } {
  return {
    ...(a.cards !== undefined ? { appetiteCards: a.cards } : {}),
    ...(a.hours !== undefined ? { appetiteHours: a.hours } : {}),
  };
}

function appetiteOf(p: Record<string, unknown>): SliceAppetite {
  return {
    ...(typeof p.appetiteCards === "number" ? { cards: p.appetiteCards } : {}),
    ...(typeof p.appetiteHours === "number" ? { hours: p.appetiteHours } : {}),
  };
}
