import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./canonical_json.js";
import type { EventLog } from "./log.js";

/**
 * Seshat's suggestions on an issue (teams item 20, TEAM-18, TEAM-19;
 * planner-pm PM-N9-1), read from the ledger: `suggestion/proposed` (the
 * reason private), `suggestion/applied`, `suggestion/dismissed`. Recording
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

interface Row {
  type: string;
  payload: string;
}

export class SuggestionLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
  ) {}

  /** Each suggestion's proposal and its end (applied or dismissed), structural only. */
  private states(): Map<string, { s: Omit<Suggestion, "why">; end?: "applied" | "dismissed" }> {
    const out = new Map<string, { s: Omit<Suggestion, "why">; end?: "applied" | "dismissed" }>();
    const rows = this.db
      .prepare(
        `SELECT type, payload FROM events
           WHERE type IN ('suggestion/proposed', 'suggestion/applied', 'suggestion/dismissed')
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
      if (state && !state.end) {
        state.end = r.type === "suggestion/applied" ? "applied" : "dismissed";
      }
    }
    return out;
  }

  /** A person dismissed this change on this issue before (TEAM-19). */
  public wasDismissed(cardId: string, kind: SuggestionKind, value: SuggestionValue): boolean {
    const same = canonicalJson(value);
    return [...this.states().values()].some(
      (st) =>
        st.end === "dismissed" &&
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
   * rule, the Admin as principal (TEAM-41). The assignee is never auto-applied (TEAM-18).
   */
  public async apply(
    id: string,
    principal: string,
    options: { auto?: boolean } = {},
  ): Promise<void> {
    if (!principal)
      throw new Error("A suggestion is applied under a person's principal; none was given");
    const s = this.mustOpen(id);
    const auto = options.auto === true;
    if (auto && !AUTO_APPLICABLE_KINDS.includes(s.kind)) {
      throw new Error(`An ${s.kind} suggestion is never applied automatically (TEAM-18)`);
    }
    await this.log.append({
      actor: auto ? "system" : "human",
      type: "suggestion/applied",
      cardId: s.cardId,
      payload: { id, auto },
      principal,
    });
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
  public async get(
    id: string,
  ): Promise<(Suggestion & { state: "open" | "applied" | "dismissed" }) | undefined> {
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
    };
  }

  /** Open suggestions (neither applied nor dismissed), optionally on one issue, with their reasons. */
  public async open(cardId?: string): Promise<Suggestion[]> {
    const why = new Map<string, string>();
    for (const e of await this.log.getEventsByTypes(["suggestion/proposed"])) {
      const w = e.private?.why;
      if (typeof w === "string") why.set(String((e.payload as { id: string }).id), w);
    }
    return [...this.states().values()]
      .filter((st) => !st.end && (cardId === undefined || st.s.cardId === cardId))
      .map((st) => ({ ...st.s, ...(why.has(st.s.id) ? { why: why.get(st.s.id) as string } : {}) }));
  }
}
