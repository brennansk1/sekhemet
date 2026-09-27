import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import type { ExternalRef } from "./types.js";

/**
 * Inherited issues reconciled against the code (integrations
 * NEW-integrations-4: INT-42, INT-43, INT-44; design-stage DS-TO-13).
 *
 * A take-over proposes, for each open tracker issue, exactly one verdict —
 * *done*, *duplicate*, *stale* or *valid* — each with its evidence (a test id
 * and its run, a commit, a file:line, or the other issue), as one proposal
 * (`reconcile/proposed`, `REC-<n>`). A *valid* issue is a candidate card
 * unless a card already carries its `externalRef` (reconciled against that
 * card) or an earlier proposal still standing proposed it. Nothing on the
 * tracker changes until a person applies the proposal
 * (`reconcile/applied`, with the person's principal); the writes go through
 * the one sync adapter, which reads `isApplied` first. Each verdict's
 * reasoning is private.
 */
export type IssueVerdict = "done" | "duplicate" | "stale" | "valid";

export const ISSUE_VERDICTS: readonly IssueVerdict[] = ["done", "duplicate", "stale", "valid"];

export type IssueEvidenceKind = "test" | "commit" | "file_line" | "issue";

export interface IssueEvidence {
  kind: IssueEvidenceKind;
  /** The test id, commit, `path:line`, or the other issue's id. */
  ref: string;
  /** For a test: the run that executed it (a baseline seq or a gate run id). */
  run?: string;
}

/** A tracker issue: its system and id (`owner/repo#12`, `ABC-12`). */
export type IssueRef = Pick<ExternalRef, "system" | "id">;

export interface IssueVerdictInput {
  issue: IssueRef;
  verdict: IssueVerdict;
  evidence: IssueEvidence[];
  /** Why: private. */
  why?: string;
}

export interface ReconciledIssue {
  issue: IssueRef;
  verdict: IssueVerdict;
  evidence: IssueEvidence[];
  /** The existing card that carries this issue's `externalRef`. */
  cardId?: string;
  /** A valid issue proposed as a new card in the take-over backlog. */
  newCard: boolean;
  why?: string;
}

export interface ReconciliationProposal {
  id: string;
  issues: ReconciledIssue[];
  state: "open" | "applied" | "dismissed";
  /** The person who applied or dismissed it. */
  principal?: string;
}

const issueKey = (i: IssueRef) => `${i.system}:${i.id}`;

interface Row {
  type: string;
  payload: string;
  principal: string | null;
}

export class IssueReconciliationLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
  ) {}

  private states(): Map<
    string,
    { issues: ReconciledIssue[]; end?: "applied" | "dismissed"; principal?: string }
  > {
    const out = new Map<
      string,
      { issues: ReconciledIssue[]; end?: "applied" | "dismissed"; principal?: string }
    >();
    const rows = this.db
      .prepare(
        `SELECT type, payload, principal FROM events
           WHERE type IN ('reconcile/proposed', 'reconcile/applied', 'reconcile/dismissed')
           ORDER BY seq`,
      )
      .all() as unknown as Row[];
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { id: string; issues?: ReconciledIssue[] };
      if (r.type === "reconcile/proposed") {
        out.set(p.id, { issues: p.issues ?? [] });
        continue;
      }
      const st = out.get(p.id);
      if (st && !st.end) {
        st.end = r.type === "reconcile/applied" ? "applied" : "dismissed";
        if (r.principal) st.principal = r.principal;
      }
    }
    return out;
  }

  /** The card that carries this issue's `externalRef`, if one does. */
  private cardFor(issue: IssueRef): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM cards WHERE json_extract(external_ref, '$.system') = ?
           AND json_extract(external_ref, '$.id') = ? ORDER BY rowid LIMIT 1`,
      )
      .get(issue.system, issue.id) as { id: string } | undefined;
    return row?.id;
  }

  /**
   * Propose one verdict per issue (INT-42, INT-44). Refused, with nothing
   * appended, when an issue appears twice, a verdict has no evidence, a
   * duplicate names no other issue, or *done* rests on no executed test run
   * or commit.
   */
  public async propose(
    input: { issues: IssueVerdictInput[] },
    actor = "planner",
  ): Promise<{ id: string; issues: ReconciledIssue[] }> {
    if (input.issues.length === 0)
      throw new Error("A reconciliation proposes a verdict for at least one issue");
    const seen = new Set<string>();
    for (const i of input.issues) {
      const key = issueKey(i.issue);
      if (seen.has(key)) {
        throw new Error(`Issue ${key} appears twice: each issue gets exactly one verdict (INT-42)`);
      }
      seen.add(key);
      if (!ISSUE_VERDICTS.includes(i.verdict)) {
        throw new Error(
          `Issue ${key}: the verdict is done, duplicate, stale or valid, got ${String(i.verdict)}`,
        );
      }
      if (i.evidence.length === 0) {
        throw new Error(`Issue ${key}: a verdict cites its evidence (INT-42)`);
      }
      if (
        i.verdict === "duplicate" &&
        !i.evidence.some((e) => e.kind === "issue" && e.ref !== i.issue.id)
      ) {
        throw new Error(`Issue ${key}: a duplicate cites the other issue (INT-42)`);
      }
      if (i.verdict === "done") {
        const shown = i.evidence.some((e) => e.kind === "commit" || e.kind === "test");
        if (!shown) {
          throw new Error(
            `Issue ${key}: already done needs an executed test or a commit showing the behaviour, not the issue's word (INT-44)`,
          );
        }
        const unrun = i.evidence.find((e) => e.kind === "test" && !e.run);
        if (unrun && !i.evidence.some((e) => e.kind === "commit")) {
          throw new Error(
            `Issue ${key}: the test ${unrun.ref} names no run that executed it (INT-44)`,
          );
        }
      }
    }
    const states = this.states();
    // Proposed as a new card by a proposal still standing (open or applied): never again (INT-42).
    const proposedBefore = new Set(
      [...states.values()]
        .filter((st) => st.end !== "dismissed")
        .flatMap((st) => st.issues.filter((i) => i.newCard).map((i) => issueKey(i.issue))),
    );
    const issues: ReconciledIssue[] = input.issues.map((i) => {
      const cardId = this.cardFor(i.issue);
      return {
        issue: { system: i.issue.system, id: i.issue.id },
        verdict: i.verdict,
        evidence: i.evidence.map((e) => ({
          kind: e.kind,
          ref: e.ref,
          ...(e.run !== undefined ? { run: e.run } : {}),
        })),
        ...(cardId !== undefined ? { cardId } : {}),
        newCard:
          i.verdict === "valid" && cardId === undefined && !proposedBefore.has(issueKey(i.issue)),
      };
    });
    const id = `REC-${states.size + 1}`;
    const why = Object.fromEntries(
      input.issues
        .filter((i) => i.why !== undefined)
        .map((i) => [issueKey(i.issue), i.why as string]),
    );
    await this.log.append({
      actor,
      type: "reconcile/proposed",
      payload: { id, issues },
      ...(Object.keys(why).length > 0 ? { private: { why } } : {}),
    });
    return { id, issues };
  }

  private mustOpen(id: string): { issues: ReconciledIssue[] } {
    const st = this.states().get(id);
    if (!st) throw new Error(`No reconciliation ${id}`);
    if (st.end) throw new Error(`Reconciliation ${id} was already ${st.end}`);
    return st;
  }

  /** Whether a person applied it: until then no tracker issue is closed, labelled or commented on (INT-43). */
  public isApplied(id: string): boolean {
    return this.states().get(id)?.end === "applied";
  }

  /** A person applies it (INT-43); the sync adapter then writes each verdict. */
  public async apply(id: string, principal: string): Promise<ReconciliationProposal> {
    if (!principal)
      throw new Error("A reconciliation is applied by a person; no principal was given");
    this.mustOpen(id);
    await this.log.append({
      actor: "human",
      type: "reconcile/applied",
      payload: { id },
      principal,
    });
    return (await this.get(id)) as ReconciliationProposal;
  }

  /** A person dismisses it: nothing is written, and its issues may be proposed again. */
  public async dismiss(id: string, principal: string): Promise<void> {
    if (!principal)
      throw new Error("A reconciliation is dismissed by a person; no principal was given");
    this.mustOpen(id);
    await this.log.append({
      actor: "human",
      type: "reconcile/dismissed",
      payload: { id },
      principal,
    });
  }

  /** One proposal, with each verdict's private reasoning. */
  public async get(id: string): Promise<ReconciliationProposal | undefined> {
    const st = this.states().get(id);
    if (!st) return undefined;
    const proposed = (await this.log.getEventsByTypes(["reconcile/proposed"])).find(
      (e) => (e.payload as { id?: unknown }).id === id,
    );
    const why = (proposed?.private?.why ?? {}) as Record<string, unknown>;
    return {
      id,
      issues: st.issues.map((i) => {
        const w = why[issueKey(i.issue)];
        return typeof w === "string" ? { ...i, why: w } : i;
      }),
      state: st.end ?? "open",
      ...(st.principal ? { principal: st.principal } : {}),
    };
  }

  /** Proposals no person has applied or dismissed. */
  public async open(): Promise<ReconciliationProposal[]> {
    const out: ReconciliationProposal[] = [];
    for (const [id, st] of this.states()) {
      if (!st.end) out.push((await this.get(id)) as ReconciliationProposal);
    }
    return out;
  }
}
