import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./canonical_json.js";
import type { EventLog } from "./log.js";

/**
 * Seshat's suggestions on an issue (teams item 20, TEAM-18, TEAM-19;
 * planner-pm PM-N9-1), read from the ledger: `suggestion/proposed` (the
 * reason private), `suggestion/applied`, `suggestion/dismissed`, and
 * `suggestion/undone` for one an Admin's rule applied (TEAM-41). Recording
 * an application does not make the change: the caller applies it through
 * the card store under the person's principal. Who may apply, and the
 * auto-apply setting, are the Team setup's.
 */

/**
 * What a suggestion changes (TEAM-18); never a project's health. `hold`
 * (its value the reason the card waits in Planning) and `remove` (its value
 * the re-plan's reason for Rejected) are the planner's own changes to an
 * issue someone else owns (planner-pm §2.18.6, PM-N9-9).
 */
export type SuggestionKind =
  | "assignee"
  | "label"
  | "priority"
  | "duplicate"
  | "split"
  | "hold"
  | "remove";

export const SUGGESTION_KINDS: readonly SuggestionKind[] = [
  "assignee",
  "label",
  "priority",
  "duplicate",
  "split",
  "hold",
  "remove",
];

/** The kinds an Admin's auto-apply rule may cover (TEAM-18): never the assignee, a hold or a removal. */
export const AUTO_APPLICABLE_KINDS: readonly SuggestionKind[] = [
  "label",
  "priority",
  "duplicate",
  "split",
];

export type SuggestionValue = string | number | string[];

export interface Suggestion {
  id: string;
  cardId: string;
  kind: SuggestionKind;
  value: SuggestionValue;
  /** Why, as the issue shows it; `[erased]` after an erasure. */
  why?: string;
}

/**
 * The issue as it was before an Admin's rule applied a suggestion, so one
 * action undoes it (TEAM-41): its status, labels and priority, the parts a
 * split made, and (private, as free text) its parked reason.
 */
export interface SuggestionBefore {
  status?: string;
  labels?: string[];
  priority?: number;
  /** The issues a split made. */
  made?: string[];
  blockedReason?: string;
}

/** A suggestion an Admin's rule applied and no one has undone (TEAM-41). */
export interface RuleApplied extends Suggestion {
  /** The Admin whose rule applied it: the principal of the application. */
  by: string;
  before: SuggestionBefore;
  appliedAt: string;
}

export type SuggestionState = "open" | "applied" | "dismissed" | "undone";

type End = Exclude<SuggestionState, "open">;

interface Row {
  type: string;
  payload: string;
  principal: string | null;
  created_at: string;
}

interface St {
  s: Omit<Suggestion, "why">;
  end?: End;
  /** Applied by an Admin's rule: that Admin, the issue as it was, and when. */
  rule?: { by: string; before: SuggestionBefore; at: string };
}

export class SuggestionLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
  ) {}

  /**
   * Each suggestion's proposal and its end (applied, dismissed, or undone
   * after a rule applied it), structural only.
   */
  private states(): Map<string, St> {
    const out = new Map<string, St>();
    const rows = this.db
      .prepare(
        `SELECT type, payload, principal, created_at FROM events
           WHERE type IN ('suggestion/proposed', 'suggestion/applied', 'suggestion/dismissed',
                          'suggestion/undone')
           ORDER BY seq`,
      )
      .all() as unknown as Row[];
    for (const r of rows) {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      const id = String(p.id);
      if (r.type === "suggestion/proposed") {
        out.set(id, {
          s: {
            id,
            cardId: String(p.cardId),
            kind: p.kind as SuggestionKind,
            value: p.value as SuggestionValue,
          },
        });
        continue;
      }
      const state = out.get(id);
      if (!state) continue;
      if (r.type === "suggestion/undone") {
        if (state.end === "applied" && state.rule) state.end = "undone";
        continue;
      }
      if (state.end) continue;
      if (r.type === "suggestion/dismissed") {
        state.end = "dismissed";
        continue;
      }
      state.end = "applied";
      if (p.auto === true) {
        const before = (p.before ?? {}) as SuggestionBefore;
        state.rule = { by: r.principal ?? "", before, at: r.created_at };
      }
    }
    return out;
  }

  /**
   * A person dismissed this change on this issue before (TEAM-19), or undid
   * it after an Admin's rule applied it (TEAM-41): either way it is not raised again.
   */
  public wasDismissed(cardId: string, kind: SuggestionKind, value: SuggestionValue): boolean {
    const same = canonicalJson(value);
    return [...this.states().values()].some(
      (st) =>
        (st.end === "dismissed" || st.end === "undone") &&
        st.s.cardId === cardId &&
        st.s.kind === kind &&
        canonicalJson(st.s.value) === same,
    );
  }

  /**
   * Propose a change on an issue, with its reason (PM-N9-1). Returns the
   * suggestion's id, the open one's id when the same change is already
   * open, or null when a person dismissed the same change on this issue (TEAM-19).
   */
  public async propose(
    input: { cardId: string; kind: SuggestionKind; value: SuggestionValue; why: string },
    actor = "planner",
  ): Promise<string | null> {
    if (!SUGGESTION_KINDS.includes(input.kind)) {
      throw new Error(
        `A suggestion's kind is one of ${SUGGESTION_KINDS.join(", ")}, got ${String(input.kind)} (TEAM-18)`,
      );
    }
    if (!this.db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").get(input.cardId)) {
      throw new Error(`Card not found: ${input.cardId}`);
    }
    if (this.wasDismissed(input.cardId, input.kind, input.value)) return null;
    const same = canonicalJson(input.value);
    const open = [...this.states().values()].find(
      (st) =>
        !st.end &&
        st.s.cardId === input.cardId &&
        st.s.kind === input.kind &&
        canonicalJson(st.s.value) === same,
    );
    if (open) return open.s.id;
    const id = `sug_${randomUUID().slice(0, 8)}`;
    await this.log.append({
      actor,
      type: "suggestion/proposed",
      cardId: input.cardId,
      payload: { id, cardId: input.cardId, kind: input.kind, value: input.value },
      private: { why: input.why },
    });
    return id;
  }

  private mustOpen(id: string): Omit<Suggestion, "why"> {
    const state = this.states().get(id);
    if (!state) throw new Error(`No suggestion ${id}`);
    if (state.end) throw new Error(`Suggestion ${id} was already ${state.end}`);
    return state.s;
  }

  /**
   * Record that a person applied it — or, with `auto`, an Admin's auto-apply
   * rule, the Admin as principal, with the issue as it was so one action
   * undoes it (TEAM-41). The assignee, a hold and a removal are never
   * auto-applied (TEAM-18).
   */
  public async apply(
    id: string,
    principal: string,
    options: { auto?: boolean; before?: SuggestionBefore } = {},
  ): Promise<void> {
    if (!principal)
      throw new Error("A suggestion is applied under a person's principal; none was given");
    const s = this.mustOpen(id);
    const auto = options.auto === true;
    if (auto && !AUTO_APPLICABLE_KINDS.includes(s.kind)) {
      throw new Error(`An ${s.kind} suggestion is never applied automatically (TEAM-18)`);
    }
    const { blockedReason, ...before } = options.before ?? {};
    await this.log.append({
      actor: auto ? "system" : "human",
      type: "suggestion/applied",
      cardId: s.cardId,
      payload: { id, auto, kind: s.kind, ...(auto ? { before } : {}) },
      ...(auto && blockedReason !== undefined ? { private: { blockedReason } } : {}),
      principal,
    });
  }

  /**
   * Record that a person undid what an Admin's rule applied (TEAM-41). The
   * caller restores the issue first; the same change is not raised again.
   */
  public async undo(id: string, principal: string): Promise<void> {
    if (!principal) throw new Error("A suggestion is undone by a person; no principal was given");
    const state = this.states().get(id);
    if (!state) throw new Error(`No suggestion ${id}`);
    if (state.end !== "applied" || !state.rule) {
      throw new Error(
        state.end === "undone"
          ? `Suggestion ${id} was already undone`
          : `Only a suggestion an Admin's rule applied is undone; ${id} is ${state.end ?? "open"}`,
      );
    }
    await this.log.append({
      actor: "human",
      type: "suggestion/undone",
      cardId: state.s.cardId,
      payload: { id, kind: state.s.kind },
      principal,
    });
  }

  /**
   * The suggestions an Admin's rule applied that no one has undone,
   * optionally on one issue, with their reasons and the issue as it was (TEAM-41).
   */
  public async appliedByRule(cardId?: string): Promise<RuleApplied[]> {
    const why = await this.reasons();
    const blocked = new Map<string, string>();
    for (const e of await this.log.getEventsByTypes(["suggestion/applied"])) {
      const b = e.private?.blockedReason;
      if (typeof b === "string") blocked.set(String((e.payload as { id: string }).id), b);
    }
    const out: RuleApplied[] = [];
    for (const st of this.states().values()) {
      if (st.end !== "applied" || !st.rule) continue;
      if (cardId !== undefined && st.s.cardId !== cardId) continue;
      const b = blocked.get(st.s.id);
      out.push({
        ...st.s,
        ...(why.has(st.s.id) ? { why: why.get(st.s.id) as string } : {}),
        by: st.rule.by,
        before: { ...st.rule.before, ...(b !== undefined ? { blockedReason: b } : {}) },
        appliedAt: st.rule.at,
      });
    }
    return out;
  }

  private async reasons(): Promise<Map<string, string>> {
    const why = new Map<string, string>();
    for (const e of await this.log.getEventsByTypes(["suggestion/proposed"])) {
      const w = e.private?.why;
      if (typeof w === "string") why.set(String((e.payload as { id: string }).id), w);
    }
    return why;
  }

  /** A person dismissed it; the same change is not proposed again on the issue (TEAM-19). */
  public async dismiss(id: string, principal: string): Promise<void> {
    if (!principal)
      throw new Error("A suggestion is dismissed by a person; no principal was given");
    const s = this.mustOpen(id);
    await this.log.append({
      actor: "human",
      type: "suggestion/dismissed",
      cardId: s.cardId,
      payload: { id },
      principal,
    });
  }

  /** One suggestion with its reason and where it stands; undefined when there is none. */
  public async get(id: string): Promise<
    | (Suggestion & {
        state: SuggestionState;
        /** Set when an Admin's rule applied it (TEAM-41): that Admin. */
        rule?: string;
      })
    | undefined
  > {
    const state = this.states().get(id);
    if (!state) return undefined;
    const proposed = (await this.log.getEventsByTypes(["suggestion/proposed"])).find(
      (e) => (e.payload as { id?: unknown }).id === id,
    );
    const why = proposed?.private?.why;
    return {
      ...state.s,
      ...(typeof why === "string" ? { why } : {}),
      state: state.end ?? "open",
      ...(state.rule ? { rule: state.rule.by } : {}),
    };
  }

  /** Open suggestions (neither applied nor dismissed), optionally on one issue, with their reasons. */
  public async open(cardId?: string): Promise<Suggestion[]> {
    const why = await this.reasons();
    return [...this.states().values()]
      .filter((st) => !st.end && (cardId === undefined || st.s.cardId === cardId))
      .map((st) => ({ ...st.s, ...(why.has(st.s.id) ? { why: why.get(st.s.id) as string } : {}) }));
  }
}
