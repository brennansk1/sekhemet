import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./canonical_json.js";
import type { EventLog } from "./log.js";

/**
 * Staged acceptance tests and their approvals (planner-pm §2.1.7, §2.17;
 * PM-P1-17, PM-P1-18, PM-N7-3, PM-N7-4, PM-N7-5), read from the ledger:
 * `test/staged` (gates rule 6a, with each case's criterion id), and
 * `criteria/approved` and `test/approved`, each bound to a SHA-256 of the
 * content so that a change voids it. Which files a depth profile requires a
 * person to approve is the planner's; this records and answers.
 */

export type StagedTestAuthor = "planner" | "test-author" | "pm" | "person" | "repository" | "suite";

/** One test case of a staged file: its title and the card criterion it proves. */
export interface StagedTestCase {
  name: string;
  criterionId: string;
}

export interface StagedTest {
  path: string;
  sha256: string;
  author: StagedTestAuthor;
  cases?: StagedTestCase[];
}

export interface CriteriaApproval {
  /** A person approved the criteria exactly as they are now. */
  approved: boolean;
  /** The SHA-256 of the card's criteria now (`criteriaSha256`). */
  currentSha256: string;
  approvedSha256?: string;
  principal?: string;
}

export interface TestApproval {
  path: string;
  /** The SHA-256 of its latest staging. */
  stagedSha256: string;
  /** A person approved that content. */
  approved: boolean;
  approvedSha256?: string;
  principal?: string;
  /** The whole file (regulated) or its example tables (production). */
  what?: "file" | "examples";
}

/** The SHA-256 of a card's criteria: the canonical JSON of their `{id, text}` list. */
export function criteriaSha256(criteria: readonly { id: string; text: string }[]): string {
  return createHash("sha256")
    .update(canonicalJson(criteria.map((c) => ({ id: c.id, text: c.text }))))
    .digest("hex");
}

interface EventRow {
  payload: string;
  principal: string | null;
}

export class StagedTestLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
  ) {}

  private rows(
    cardId: string,
    type: string,
  ): { payload: Record<string, unknown>; principal?: string }[] {
    return (
      this.db
        .prepare(
          "SELECT payload, principal FROM events WHERE card_id = ? AND type = ? ORDER BY seq",
        )
        .all(cardId, type) as unknown as EventRow[]
    ).map((r) => ({
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      ...(r.principal ? { principal: r.principal } : {}),
    }));
  }

  /** The card's criteria with their ids, or undefined when there is no such card. */
  private criteria(cardId: string): { id: string; text: string }[] | undefined {
    const row = this.db
      .prepare("SELECT acceptance_criteria AS c, criterion_ids AS i FROM cards WHERE id = ?")
      .get(cardId) as { c: string; i: string | null } | undefined;
    if (!row) return undefined;
    const texts = JSON.parse(row.c || "[]") as string[];
    const ids = row.i ? (JSON.parse(row.i) as string[]) : [];
    return ids.map((id, n) => ({ id, text: texts[n] ?? "" }));
  }

  private mustCriteria(cardId: string): { id: string; text: string }[] {
    const criteria = this.criteria(cardId);
    if (criteria === undefined) throw new Error(`Card not found: ${cardId}`);
    return criteria;
  }

  /**
   * Stage a test file for a card (gates rule 6a) with each case's criterion
   * id (PM-P1-17): refused, appending nothing, when it proves no criterion
   * of its card or names a criterion the card does not have.
   */
  public async stage(input: StagedTest & { cardId: string }, actor = "planner"): Promise<void> {
    const ids = this.mustCriteria(input.cardId).map((c) => c.id);
    const cases = input.cases ?? [];
    if (cases.length === 0) {
      throw new Error(
        `The staged test ${input.path} proves no criterion of card ${input.cardId}: each test case names the criterion it proves`,
      );
    }
    for (const c of cases) {
      if (!ids.includes(c.criterionId)) {
        throw new Error(
          `The staged test ${input.path} case "${c.name}" names criterion ${c.criterionId}, which card ${input.cardId} does not have (${ids.join(", ") || "no criterion ids"})`,
        );
      }
    }
    await this.log.append({
      actor,
      type: "test/staged",
      cardId: input.cardId,
      payload: {
        cardId: input.cardId,
        path: input.path,
        sha256: input.sha256,
        author: input.author,
        cases: cases.map((c) => ({ name: c.name, criterionId: c.criterionId })),
      },
    });
  }

  /** The card's staged files, each at its latest staging, in the order first staged. */
  public staged(cardId: string): StagedTest[] {
    const byPath = new Map<string, StagedTest>();
    for (const { payload: p } of this.rows(cardId, "test/staged")) {
      byPath.set(String(p.path), {
        path: String(p.path),
        sha256: String(p.sha256),
        author: p.author as StagedTestAuthor,
        ...(Array.isArray(p.cases) ? { cases: p.cases as StagedTestCase[] } : {}),
      });
    }
    return [...byPath.values()];
  }

  /** The card's criterion ids that no latest staged case proves (PM-P1-18). */
  public uncoveredCriteria(cardId: string): string[] {
    const covered = new Set(
      this.staged(cardId).flatMap((t) => (t.cases ?? []).map((c) => c.criterionId)),
    );
    return this.mustCriteria(cardId)
      .map((c) => c.id)
      .filter((id) => !covered.has(id));
  }

  /** A person approves the card's criteria as they are now (PM-N7-5). */
  public async approveCriteria(cardId: string, principal: string): Promise<void> {
    if (!principal) throw new Error("Criteria are approved by a person; no principal was given");
    const criteria = this.mustCriteria(cardId);
    if (criteria.length === 0) {
      throw new Error(`Card ${cardId} has no criteria with ids to approve`);
    }
    await this.log.append({
      actor: "human",
      type: "criteria/approved",
      cardId,
      payload: { cardId, sha256: criteriaSha256(criteria) },
      principal,
    });
  }

  /** Whether the card's criteria, as they are now, carry a person's approval. */
  public criteriaApproval(cardId: string): CriteriaApproval {
    const currentSha256 = criteriaSha256(this.mustCriteria(cardId));
    const last = this.rows(cardId, "criteria/approved").at(-1);
    if (!last) return { approved: false, currentSha256 };
    const approvedSha256 = String(last.payload.sha256);
    return {
      approved: approvedSha256 === currentSha256,
      currentSha256,
      approvedSha256,
      ...(last.principal ? { principal: last.principal } : {}),
    };
  }

  /**
   * A person approves a staged test file, or its example tables, at the
   * content it was staged with (PM-N7-3); a later staging voids it (PM-N7-4).
   */
  public async approveTest(
    input: { cardId: string; path: string; sha256: string; what: "file" | "examples" },
    principal: string,
  ): Promise<void> {
    if (!principal) throw new Error("A test is approved by a person; no principal was given");
    const staged = this.staged(input.cardId).find((t) => t.path === input.path);
    if (!staged || staged.sha256 !== input.sha256) {
      throw new Error(
        `${input.path} at ${input.sha256.slice(0, 12)} is not the content staged for card ${input.cardId}`,
      );
    }
    await this.log.append({
      actor: "human",
      type: "test/approved",
      cardId: input.cardId,
      payload: { cardId: input.cardId, path: input.path, sha256: input.sha256, what: input.what },
      principal,
    });
  }

  /** Each staged file of the card, with whether its latest content is approved. */
  public testApprovals(cardId: string): TestApproval[] {
    const approvals = new Map<
      string,
      { sha256: string; principal?: string; what: "file" | "examples" }
    >();
    for (const { payload: p, principal } of this.rows(cardId, "test/approved")) {
      approvals.set(String(p.path), {
        sha256: String(p.sha256),
        what: p.what as "file" | "examples",
        ...(principal ? { principal } : {}),
      });
    }
    return this.staged(cardId).map((t) => {
      const a = approvals.get(t.path);
      return {
        path: t.path,
        stagedSha256: t.sha256,
        approved: a?.sha256 === t.sha256,
        ...(a
          ? {
              approvedSha256: a.sha256,
              ...(a.principal ? { principal: a.principal } : {}),
              what: a.what,
            }
          : {}),
      };
    });
  }
}
