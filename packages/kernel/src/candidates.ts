import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import {
  KANO_CLASSES,
  type KanoClass,
  type RequirementCriterion,
  type RequirementLedger,
  type RequirementRevision,
} from "./requirements.js";
import type { EventRecord } from "./types.js";

/**
 * Candidate requirements and the story map's walkthroughs (design-stage
 * §2.8, P14: DS-P14-5, -6, -7, -10; DS-TO-14).
 *
 * A requirement a model proposed, a feature the comparables share, or a
 * take-over claim nothing has proven is a *candidate*
 * (`requirement/proposed`), never a requirement: it enters the requirement
 * graph only when a person accepts it (`requirement/created` naming the
 * candidate), with a stable id and version 1 that is never reused; or a
 * person rejects it (`requirement/candidate_rejected`). A walkthrough of the
 * story map is recorded once per named user role (`walkthrough/recorded`),
 * and each step no requirement supports becomes a candidate. Titles,
 * criteria text, sources, role names and step text are private.
 */
export type CandidateSource = "model-proposal" | "comparable" | "takeover";

export const CANDIDATE_SOURCES: readonly CandidateSource[] = [
  "model-proposal",
  "comparable",
  "takeover",
];

/** A comparable project or product a candidate was found in (DS-P14-5). */
export interface CandidateSourceRef {
  label: string;
  url?: string;
}

export interface CandidateInput {
  projectId?: string;
  sliceId?: string;
  source: CandidateSource;
  title: string;
  criteria?: RequirementCriterion[];
  /** For a comparable: set from `comparables` when omitted, and refused when it disagrees. */
  kano?: KanoClass;
  mustHave?: boolean;
  /** Required for a comparable, at least one (DS-P14-5). */
  sources?: CandidateSourceRef[];
  /** For a comparable: how many of the comparables have the feature (DS-P14-5). */
  comparables?: { foundIn: number; of: number };
  /** The walkthrough step it came from (DS-P14-7). */
  walkthrough?: { walkthroughId: string; stepId: string };
  /** The take-over claim it came from (DS-TO-14). */
  claimId?: string;
}

export interface Candidate {
  id: string;
  source: CandidateSource;
  projectId?: string;
  sliceId?: string;
  kano?: KanoClass;
  mustHave?: boolean;
  criteria: RequirementCriterion[];
  /** Private; `[erased]` after an erasure. */
  title?: string;
  sources: CandidateSourceRef[];
  comparables?: { foundIn: number; of: number };
  walkthrough?: { walkthroughId: string; stepId: string };
  claimId?: string;
  state: "open" | "accepted" | "rejected";
  /** The requirement a person accepted it as. */
  requirementId?: string;
}

export interface WalkthroughStep {
  id: string;
  /** What the user does at this step: private. */
  text: string;
  /** The requirements that support the step; none makes the step a candidate. */
  requirementIds: string[];
}

export interface Walkthrough {
  walkthroughId: string;
  projectId: string;
  /** The named user role: private. */
  role?: string;
  steps: WalkthroughStep[];
}

const CANDIDATE_EVENTS = [
  "requirement/proposed",
  "requirement/candidate_rejected",
  "requirement/created",
];

const normalRole = (role: string) => role.trim().toLowerCase().replace(/\s+/g, " ");

export class RequirementCandidateLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    private readonly requirements: RequirementLedger,
  ) {}

  /** The next `CAND-<n>`, one more than the highest ever used. */
  private nextId(): string {
    const row = this.db
      .prepare(
        `SELECT MAX(CAST(SUBSTR(json_extract(payload, '$.candidateId'), 6) AS INTEGER)) AS n
           FROM events WHERE type = 'requirement/proposed'
            AND json_extract(payload, '$.candidateId') LIKE 'CAND-%'`,
      )
      .get() as { n: number | null } | undefined;
    return `CAND-${(row?.n ?? 0) + 1}`;
  }

  /**
   * Propose a candidate (DS-P14-5, -6, -7). A comparable cites at least one
   * source, and a feature found in at least half the comparables is must-be.
   */
  public async propose(input: CandidateInput, actor = "planner"): Promise<string> {
    if (!CANDIDATE_SOURCES.includes(input.source)) {
      throw new Error(
        `A candidate's source is one of ${CANDIDATE_SOURCES.join(", ")}, got ${String(input.source)}`,
      );
    }
    if (!input.title.trim()) throw new Error("A candidate needs a title");
    if (input.kano !== undefined && !KANO_CLASSES.includes(input.kano)) {
      throw new Error(`A candidate's Kano class is one of ${KANO_CLASSES.join(", ")}`);
    }
    let kano = input.kano;
    if (input.source === "comparable") {
      if ((input.sources?.length ?? 0) === 0) {
        throw new Error("A comparable candidate cites at least one source (DS-P14-5)");
      }
      const c = input.comparables;
      if (
        !c ||
        !Number.isInteger(c.foundIn) ||
        !Number.isInteger(c.of) ||
        c.of < 1 ||
        c.foundIn < 1 ||
        c.foundIn > c.of
      ) {
        throw new Error(
          "A comparable candidate says in how many of how many comparables it was found",
        );
      }
      const common = c.foundIn * 2 >= c.of;
      if (common && kano !== undefined && kano !== "must-be") {
        throw new Error(
          `A feature in ${c.foundIn} of ${c.of} comparables is proposed as must-be, not ${kano} (DS-P14-5)`,
        );
      }
      kano ??= common ? "must-be" : "performance";
    }
    if (input.source === "takeover" && !input.claimId) {
      throw new Error("A take-over candidate names the claim it came from (DS-TO-14)");
    }
    if (
      input.projectId !== undefined &&
      !this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)
    ) {
      throw new Error(`No project ${input.projectId}`);
    }
    const candidateId = this.nextId();
    await this.log.append({
      actor,
      type: "requirement/proposed",
      payload: {
        candidateId,
        source: input.source,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.sliceId !== undefined ? { sliceId: input.sliceId } : {}),
        ...(kano !== undefined ? { kano } : {}),
        ...(input.mustHave !== undefined ? { mustHave: input.mustHave } : {}),
        ...(input.criteria !== undefined ? { criterionIds: input.criteria.map((c) => c.id) } : {}),
        ...(input.comparables !== undefined
          ? { foundIn: input.comparables.foundIn, comparableCount: input.comparables.of }
          : {}),
        ...(input.walkthrough !== undefined
          ? { walkthroughId: input.walkthrough.walkthroughId, stepId: input.walkthrough.stepId }
          : {}),
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
      },
      private: {
        title: input.title,
        ...(input.criteria !== undefined
          ? { criteria: Object.fromEntries(input.criteria.map((c) => [c.id, c.text])) }
          : {}),
        ...(input.sources !== undefined ? { sources: input.sources } : {}),
      },
    });
    return candidateId;
  }

  /** Every candidate, in the order proposed, with where it stands. */
  public async list(
    filter: { projectId?: string; state?: Candidate["state"] } = {},
  ): Promise<Candidate[]> {
    const byId = new Map<string, Candidate>();
    for (const e of await this.log.getEventsByTypes(CANDIDATE_EVENTS)) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "requirement/proposed") {
        byId.set(String(p.candidateId), candidateFrom(e));
        continue;
      }
      const c = byId.get(String(p.candidateId));
      if (!c || c.state !== "open") continue;
      if (e.type === "requirement/created") {
        c.state = "accepted";
        c.requirementId = String(p.id);
      } else c.state = "rejected";
    }
    return [...byId.values()].filter(
      (c) =>
        (filter.projectId === undefined || c.projectId === filter.projectId) &&
        (filter.state === undefined || c.state === filter.state),
    );
  }

  public async get(id: string): Promise<Candidate | undefined> {
    return (await this.list()).find((c) => c.id === id);
  }

  private async mustOpen(id: string): Promise<Candidate> {
    const c = await this.get(id);
    if (!c) throw new Error(`No candidate ${id}`);
    if (c.state !== "open") throw new Error(`Candidate ${id} was already ${c.state}`);
    return c;
  }

  /**
   * A person accepts a candidate (DS-P14-6, -10): it enters the requirement
   * graph with a stable id at version 1, as proposed or with the person's edits.
   */
  public async accept(
    id: string,
    principal: string,
    edits: RequirementRevision = {},
  ): Promise<{ id: string; version: number }> {
    if (!principal) throw new Error("A candidate is accepted by a person; no principal was given");
    const c = await this.mustOpen(id);
    return this.requirements.create(
      {
        title: edits.title ?? c.title ?? "",
        ...(c.projectId !== undefined ? { projectId: c.projectId } : {}),
        ...((edits.sliceId ?? c.sliceId) !== undefined
          ? { sliceId: edits.sliceId ?? c.sliceId }
          : {}),
        ...(edits.dependsOn !== undefined ? { dependsOn: edits.dependsOn } : {}),
        ...((edits.kano ?? c.kano) !== undefined ? { kano: edits.kano ?? c.kano } : {}),
        ...((edits.mustHave ?? c.mustHave) !== undefined
          ? { mustHave: edits.mustHave ?? c.mustHave }
          : {}),
        ...((edits.criteria ?? c.criteria).length > 0
          ? { criteria: edits.criteria ?? c.criteria }
          : {}),
        ...(edits.invariant !== undefined ? { invariant: edits.invariant } : {}),
        source: c.source,
        candidateId: c.id,
        ...(c.claimId !== undefined ? { claimId: c.claimId } : {}),
      },
      principal,
    );
  }

  /** A person rejects it; the reason is private. */
  public async reject(id: string, principal: string, reason?: string): Promise<void> {
    if (!principal) throw new Error("A candidate is rejected by a person; no principal was given");
    await this.mustOpen(id);
    await this.log.append({
      actor: "human",
      type: "requirement/candidate_rejected",
      payload: { candidateId: id },
      principal,
      ...(reason !== undefined ? { private: { reason } } : {}),
    });
  }

  /**
   * Record one walk of the story map from a named user role's point of view
   * (DS-P14-7) — once per role per project — and propose each step that no
   * requirement supports as a candidate.
   */
  public async recordWalkthrough(
    input: { projectId: string; role: string; steps: WalkthroughStep[] },
    actor = "planner",
  ): Promise<{ walkthroughId: string; candidateIds: string[] }> {
    if (!input.role.trim()) throw new Error("A walkthrough names the user role it walks as");
    if (!this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)) {
      throw new Error(`No project ${input.projectId}`);
    }
    const role = normalRole(input.role);
    if (
      (await this.walkthroughs(input.projectId)).some(
        (w) => w.role !== undefined && normalRole(w.role) === role,
      )
    ) {
      throw new Error(
        `The story map was already walked as ${input.role.trim()}: once per named user role (DS-P14-7)`,
      );
    }
    const ids = input.steps.map((s) => s.id);
    if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((i) => !i)) {
      throw new Error("A walkthrough has at least one step, each with its own id");
    }
    const known = new Set((await this.requirements.list()).filter((r) => !r.cut).map((r) => r.id));
    for (const s of input.steps) {
      const unknown = s.requirementIds.filter((r) => !known.has(r));
      if (unknown.length > 0) {
        throw new Error(`Walkthrough step ${s.id}: no requirement ${unknown.join(", ")}`);
      }
    }
    const walkthroughId = `walk_${randomUUID().slice(0, 8)}`;
    await this.log.append({
      actor,
      type: "walkthrough/recorded",
      payload: {
        walkthroughId,
        projectId: input.projectId,
        steps: input.steps.map((s) => ({ id: s.id, requirementIds: s.requirementIds })),
      },
      private: {
        role: input.role.trim(),
        stepTexts: Object.fromEntries(input.steps.map((s) => [s.id, s.text])),
      },
    });
    const candidateIds: string[] = [];
    for (const s of input.steps) {
      if (s.requirementIds.length > 0) continue;
      candidateIds.push(
        await this.propose(
          {
            projectId: input.projectId,
            source: "model-proposal",
            title: s.text,
            walkthrough: { walkthroughId, stepId: s.id },
          },
          actor,
        ),
      );
    }
    return { walkthroughId, candidateIds };
  }

  /** The walkthroughs recorded, optionally for one project, in order. */
  public async walkthroughs(projectId?: string): Promise<Walkthrough[]> {
    return (await this.log.getEventsByTypes(["walkthrough/recorded"]))
      .map((e) => {
        const p = e.payload as {
          walkthroughId: string;
          projectId: string;
          steps: { id: string; requirementIds: string[] }[];
        };
        const priv = (e.private ?? {}) as { role?: unknown; stepTexts?: Record<string, unknown> };
        return {
          walkthroughId: p.walkthroughId,
          projectId: p.projectId,
          ...(typeof priv.role === "string" ? { role: priv.role } : {}),
          steps: p.steps.map((s) => ({
            id: s.id,
            text: String(priv.stepTexts?.[s.id] ?? ""),
            requirementIds: s.requirementIds,
          })),
        };
      })
      .filter((w) => projectId === undefined || w.projectId === projectId);
  }
}

function candidateFrom(e: EventRecord): Candidate {
  const p = e.payload as Record<string, unknown>;
  const priv = (e.private ?? {}) as Record<string, unknown>;
  const texts = priv.criteria as Record<string, unknown> | undefined;
  return {
    id: String(p.candidateId),
    source: p.source as CandidateSource,
    ...(typeof p.projectId === "string" ? { projectId: p.projectId } : {}),
    ...(typeof p.sliceId === "string" ? { sliceId: p.sliceId } : {}),
    ...(typeof p.kano === "string" ? { kano: p.kano as KanoClass } : {}),
    ...(typeof p.mustHave === "boolean" ? { mustHave: p.mustHave } : {}),
    criteria: Array.isArray(p.criterionIds)
      ? p.criterionIds.map((id) => ({ id: String(id), text: String(texts?.[String(id)] ?? "") }))
      : [],
    ...(typeof priv.title === "string" ? { title: priv.title } : {}),
    sources: Array.isArray(priv.sources) ? (priv.sources as CandidateSourceRef[]) : [],
    ...(typeof p.foundIn === "number" && typeof p.comparableCount === "number"
      ? { comparables: { foundIn: p.foundIn, of: p.comparableCount } }
      : {}),
    ...(typeof p.walkthroughId === "string" && typeof p.stepId === "string"
      ? { walkthrough: { walkthroughId: p.walkthroughId, stepId: p.stepId } }
      : {}),
    ...(typeof p.claimId === "string" ? { claimId: p.claimId } : {}),
    state: "open",
  };
}
