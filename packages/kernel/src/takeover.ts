import type { DatabaseSync } from "node:sqlite";
import type { RequirementCandidateLedger } from "./candidates.js";
import type { CardChange } from "./card_class.js";
import type { EventLog } from "./log.js";
import type { RunLedger } from "./records.js";
import type { RequirementLedger } from "./requirements.js";

/**
 * A take-over's records after the inventory (design-stage §2.10 steps 4–6,
 * NEW-design-stage-6: DS-TO-9, -11, -12, -14), each bound to the latest
 * `takeover/inventory` by its `seq`:
 *
 * - `takeover/brief_as_found` — each claim's label and citations; a *proven*
 *   claim cites an executed result of the onboarding baseline, checked here,
 *   and its link to the claim stays *proposed* until a person confirms it.
 * - `takeover/questions_posted` — the one batch of questions (at most five,
 *   ranked, each a pending decision request whose default cites a finding).
 * - `takeover/backlog_proposed` — the evidenced backlog (stabilise, finish,
 *   defer), `TOP-<n>`.
 * - `takeover/plan_approved` — the person's approval, which applies every
 *   batch question's default still unanswered (`decision/default_applied`)
 *   and seeds the requirement graph: each proven claim a requirement whose
 *   baseline tests are proposed links, each claimed-unproven claim a
 *   candidate. Nothing is seeded, and no default applied, before it.
 *
 * Claim text and card titles are private. Creating the approved cards is the
 * caller's (the planner's plan persistence), and only after `isPlanApproved`.
 */
export type ClaimLabel = "proven" | "claimed_unproven" | "contradicted";

export const CLAIM_LABELS: readonly ClaimLabel[] = ["proven", "claimed_unproven", "contradicted"];

/** An executed result of the onboarding baseline a claim cites (DS-TO-9). */
export interface ExecutedResult {
  /** A test that passed in both baseline runs, or the build that succeeded. */
  kind: "test" | "build";
  /** The test id (`<file> > <name>`), or the build step. */
  ref: string;
  /** The `project/baseline` event's `seq`. */
  baselineSeq: number;
}

export interface FoundClaim {
  id: string;
  label: ClaimLabel;
  /** At least one file:line, test id, commit or finding id. */
  citations: string[];
  results?: ExecutedResult[];
  /** What the repository claims: private. */
  text: string;
}

export interface BriefAsFound {
  seq: number;
  inventorySeq: number;
  claims: (Omit<FoundClaim, "text"> & {
    text?: string;
    /** A proven claim's link to its results: proposed until a person confirms it. */
    linkState?: "proposed";
  })[];
}

export type BacklogBucket = "stabilise" | "finish" | "defer";

export const BACKLOG_BUCKETS: readonly BacklogBucket[] = ["stabilise", "finish", "defer"];

/** One card of the take-over backlog (DS-TO-12). */
export interface ProposedTakeoverCard {
  /** The card's id within the proposal. */
  ref: string;
  bucket: BacklogBucket;
  /** Private. */
  title: string;
  /** At least one finding id, test id, file:line or commit. */
  links: string[];
  change?: CardChange;
  /** A secret to rotate is a person's task, never the Worker's. */
  assignee: "worker" | "person";
  /** The finding this card answers — a *could not build* finding's `fix` card names it. */
  forFinding?: string;
  /** A `could not build` fix card's red check: the build command failing on the base (gates rule 6b). */
  redCheck?: "build_fails_on_base";
  /** The secret finding this person's task rotates. */
  secret?: { commit: string; path: string };
  /** For a `characterize` card: the cards it pins down before they run. */
  characterizes?: string[];
  /** Its scope files are executed by no test on the base: a `characterize` card comes first. */
  needsCharacterize?: boolean;
}

export interface TakeoverBacklog {
  proposalId: string;
  inventorySeq: number;
  cards: ProposedTakeoverCard[];
}

interface Inventory {
  seq: number;
  baselineSeq: number;
  findings: { id: string; kind: string; path?: string; line?: number; commit?: string }[];
}

/** Words a take-over question never contains (DS-TO-11, DS-N1-7). */
const FORBIDDEN_WORDS = /\b(requirements|phase|let me gather)\b/i;

const MAX_QUESTIONS = 5;

interface Row {
  seq: number;
  payload: string;
}

export class TakeoverLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    private readonly runs: RunLedger,
    private readonly requirements: RequirementLedger,
    private readonly candidates: RequirementCandidateLedger,
  ) {}

  private latest(type: string): { seq: number; payload: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare("SELECT seq, payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1")
      .get(type) as Row | undefined;
    return row ? { seq: row.seq, payload: JSON.parse(row.payload) } : undefined;
  }

  private all(type: string): { seq: number; payload: Record<string, unknown> }[] {
    return (
      this.db
        .prepare("SELECT seq, payload FROM events WHERE type = ? ORDER BY seq")
        .all(type) as unknown as Row[]
    ).map((r) => ({ seq: r.seq, payload: JSON.parse(r.payload) }));
  }

  /** The latest as-built inventory (DS-TO-5, -8), or undefined when the take-over has not reached it. */
  public inventory(): Inventory | undefined {
    const e = this.latest("takeover/inventory");
    if (!e) return undefined;
    return {
      seq: e.seq,
      baselineSeq: Number(e.payload.baselineSeq),
      findings: (e.payload.findings as Inventory["findings"]) ?? [],
    };
  }

  /** The inventory recorded at `seq` (the one an approved proposal was bound to). */
  private inventoryAt(seq: number): Inventory {
    const e = this.all("takeover/inventory").find((x) => x.seq === seq);
    if (!e) throw new Error(`No take-over inventory at seq ${seq}`);
    return {
      seq: e.seq,
      baselineSeq: Number(e.payload.baselineSeq),
      findings: (e.payload.findings as Inventory["findings"]) ?? [],
    };
  }

  private mustInventory(): Inventory {
    const inv = this.inventory();
    if (!inv)
      throw new Error("The take-over has no inventory yet: recon and the inventory come first");
    return inv;
  }

  /** The onboarding baseline event at a `seq`, or undefined. */
  private baseline(seq: number): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE seq = ? AND type = 'project/baseline'")
      .get(seq) as { payload: string } | undefined;
    const p = row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
    return p && p.kind === "recorded" ? p : undefined;
  }

  /** Why an executed result does not show what a proven claim needs, or undefined when it does (DS-TO-9). */
  private resultFailure(r: ExecutedResult): string | undefined {
    const base = this.baseline(r.baselineSeq);
    if (!base) return `no onboarding baseline was recorded at seq ${r.baselineSeq}`;
    if (r.kind === "build") {
      const inv = this.all("takeover/inventory").find(
        (i) => Number(i.payload.baselineSeq) === r.baselineSeq,
      );
      const findings = (inv?.payload.findings as { kind: string }[] | undefined) ?? [];
      if (!inv) return `no take-over inventory records the build of baseline ${r.baselineSeq}`;
      if (findings.some((f) => f.kind === "could_not_build")) {
        return `the build of baseline ${r.baselineSeq} failed (a could-not-build finding)`;
      }
      return undefined;
    }
    if (r.kind !== "test") return `an executed result is a test or a build, got ${String(r.kind)}`;
    const runs =
      (base.runs as
        | {
            rung: string;
            run: number;
            unavailable?: string;
            exitCode?: number;
            failing?: unknown[];
          }[]
        | undefined) ?? [];
    const suite = runs.filter((x) => x.rung === "test" && !x.unavailable);
    const testRuns = new Set(suite.map((x) => x.run));
    if (!testRuns.has(1) || !testRuns.has(2)) {
      return `the suite of baseline ${r.baselineSeq} did not run twice`;
    }
    // A run that failed naming none of its failures (a crashed suite) shows
    // nothing about any one test.
    if (suite.some((x) => x.exitCode !== 0 && (x.failing?.length ?? 0) === 0)) {
      return `a run of the suite of baseline ${r.baselineSeq} exited ${String(suite.find((x) => x.exitCode !== 0)?.exitCode)} naming no failure`;
    }
    type Entry = { rung: string; file: string; rule: string };
    const bad = [
      ...((base.entries as Entry[] | undefined) ?? []),
      ...((base.flaky as Entry[] | undefined) ?? []),
    ].filter((e) => e.rung === "test");
    if (bad.some((e) => r.ref === `${e.file} > ${e.rule}` || r.ref === e.rule)) {
      return `${r.ref} failed in a run of baseline ${r.baselineSeq}`;
    }
    return undefined;
  }

  /**
   * Record the brief as found (DS-TO-9). Every claim cites at least one
   * file:line, test id, commit or finding; a proven claim cites at least one
   * executed result — a test that passed in both baseline runs, or the build
   * that succeeded — and a claimed-unproven one none.
   */
  public async recordBriefAsFound(
    input: { claims: FoundClaim[] },
    actor = "planner",
  ): Promise<void> {
    const inv = this.mustInventory();
    const ids = input.claims.map((c) => c.id);
    if (new Set(ids).size !== ids.length || ids.some((i) => !i)) {
      throw new Error("Each claim of the brief as found has its own id");
    }
    for (const c of input.claims) {
      if (!CLAIM_LABELS.includes(c.label)) {
        throw new Error(`Claim ${c.id}: the label is one of ${CLAIM_LABELS.join(", ")}`);
      }
      if (c.citations.length === 0) {
        throw new Error(
          `Claim ${c.id}: every claim cites at least one file:line, test id or commit (DS-TO-9)`,
        );
      }
      const results = c.results ?? [];
      if (c.label === "proven") {
        if (results.length === 0) {
          throw new Error(
            `Claim ${c.id} is labelled proven but cites no executed result (DS-TO-9)`,
          );
        }
        for (const r of results) {
          const why = this.resultFailure(r);
          if (why) throw new Error(`Claim ${c.id} cannot be proven: ${why} (DS-TO-9)`);
        }
      } else if (c.label === "claimed_unproven" && results.length > 0) {
        throw new Error(
          `Claim ${c.id} cites an executed result: it is proven or contradicted, not unproven`,
        );
      }
    }
    await this.log.append({
      actor,
      type: "takeover/brief_as_found",
      payload: {
        inventorySeq: inv.seq,
        claims: input.claims.map((c) => ({
          id: c.id,
          label: c.label,
          citations: c.citations,
          ...(c.results && c.results.length > 0
            ? {
                results: c.results.map((r) => ({
                  kind: r.kind,
                  ref: r.ref,
                  baselineSeq: r.baselineSeq,
                })),
              }
            : {}),
        })),
      },
      private: { claimTexts: input.claims.map((c) => ({ id: c.id, text: c.text })) },
    });
  }

  /** The latest brief as found, with its claims' text. */
  public async briefAsFound(): Promise<BriefAsFound | undefined> {
    const events = await this.log.getEventsByTypes(["takeover/brief_as_found"]);
    const e = events[events.length - 1];
    if (!e) return undefined;
    const p = e.payload as { inventorySeq?: number; claims: Omit<FoundClaim, "text">[] };
    const texts = new Map(
      ((e.private?.claimTexts as { id: string; text: string }[] | undefined) ?? []).map((t) => [
        t.id,
        t.text,
      ]),
    );
    return {
      seq: e.seq,
      inventorySeq: Number(p.inventorySeq ?? 0),
      claims: p.claims.map((c) => ({
        ...c,
        ...(texts.has(c.id) ? { text: texts.get(c.id) as string } : {}),
        ...(c.label === "proven" ? { linkState: "proposed" as const } : {}),
      })),
    };
  }

  /** The latest inventory's brief as found, when there is one. */
  private async briefFor(inv: Inventory): Promise<BriefAsFound | undefined> {
    const brief = await this.briefAsFound();
    return brief && brief.inventorySeq === inv.seq ? brief : undefined;
  }

  /** The batch posted for an inventory, if any. */
  private batchFor(
    inv: Inventory,
  ): { decisionId: string; rank: number; defaultCites: string }[] | undefined {
    const e = this.all("takeover/questions_posted").find(
      (b) => Number(b.payload.inventorySeq) === inv.seq,
    );
    return e
      ? (e.payload.questions as { decisionId: string; rank: number; defaultCites: string }[])
      : undefined;
  }

  /**
   * Post the take-over's questions as one batch (DS-TO-11): at most five
   * pending decision requests, ranked in the order given, each under the
   * `safe_default` policy with a default citing a finding or claim id; at
   * most one when the inventory holds at most one failing test or half-done
   * finding and the brief no contradicted claim. One batch per inventory.
   */
  public async postQuestions(
    input: { questions: { decisionId: string; defaultCites: string }[] },
    actor = "planner",
  ): Promise<void> {
    const inv = this.mustInventory();
    if (this.batchFor(inv)) {
      throw new Error(
        "The take-over's questions were already posted: they go as one batch (DS-TO-11)",
      );
    }
    const qs = input.questions;
    if (qs.length === 0) throw new Error("A batch of questions has at least one question");
    if (qs.length > MAX_QUESTIONS) {
      throw new Error(`A take-over asks at most five questions, got ${qs.length} (DS-TO-11)`);
    }
    if (new Set(qs.map((q) => q.decisionId)).size !== qs.length) {
      throw new Error("A question appears once in the batch");
    }
    const brief = await this.briefFor(inv);
    const base = this.baseline(inv.baselineSeq);
    const failingTests = ((base?.entries as { rung: string }[] | undefined) ?? []).filter(
      (e) => e.rung === "test",
    ).length;
    const contradicted = brief?.claims.some((c) => c.label === "contradicted") ?? false;
    if (inv.findings.length + failingTests <= 1 && !contradicted && qs.length > 1) {
      throw new Error(
        "The inventory holds at most one failing test or half-done finding and no contradicted claim: ask at most one question (DS-TO-11)",
      );
    }
    const citable = new Set([
      ...inv.findings.map((f) => f.id),
      ...(brief?.claims.map((c) => c.id) ?? []),
    ]);
    for (const q of qs) {
      const d = this.runs.getDecision(q.decisionId);
      if (!d) throw new Error(`Decision not found: ${q.decisionId}`);
      if (d.status !== "pending")
        throw new Error(`Decision ${q.decisionId} is already ${d.status}`);
      const word = FORBIDDEN_WORDS.exec(d.question);
      if (word) {
        throw new Error(
          `Decision ${q.decisionId}: a take-over question never says "${word[1]}" (DS-TO-11)`,
        );
      }
      if (!citable.has(q.defaultCites)) {
        throw new Error(
          `Decision ${q.decisionId}: its default cites ${q.defaultCites}, which is no finding or claim of the take-over (DS-TO-11)`,
        );
      }
    }
    await this.log.append({
      actor,
      type: "takeover/questions_posted",
      payload: {
        inventorySeq: inv.seq,
        questions: qs.map((q, i) => ({
          decisionId: q.decisionId,
          rank: i + 1,
          defaultCites: q.defaultCites,
          policy: "safe_default",
        })),
      },
    });
  }

  /**
   * Propose the take-over backlog (DS-TO-12): every card links a finding,
   * test id, file:line or commit; every *could not build* finding has a
   * *stabilise* `fix` card whose red check is the build failing on the base;
   * every secret found is a person's task, never the Worker's; a card whose
   * scope no test executes follows a `characterize` card for it.
   */
  public async proposeBacklog(
    input: { cards: ProposedTakeoverCard[] },
    actor = "planner",
  ): Promise<string> {
    const inv = this.mustInventory();
    const cards = input.cards;
    if (cards.length === 0) throw new Error("A take-over backlog proposes at least one card");
    const refs = cards.map((c) => c.ref);
    if (new Set(refs).size !== refs.length || refs.some((r) => !r)) {
      throw new Error("Each card of the take-over backlog has its own ref");
    }
    for (const c of cards) {
      if (c.links.length === 0) {
        throw new Error(`Card ${c.ref} links no finding, test id, file:line or commit (DS-TO-12)`);
      }
      if (!BACKLOG_BUCKETS.includes(c.bucket)) {
        throw new Error(`Card ${c.ref}: the bucket is one of ${BACKLOG_BUCKETS.join(", ")}`);
      }
      if (c.assignee !== "worker" && c.assignee !== "person") {
        throw new Error(`Card ${c.ref}: a card is the Worker's or a person's`);
      }
      if (!c.title.trim()) throw new Error(`Card ${c.ref} needs a title`);
      if (c.secret && c.assignee !== "person") {
        throw new Error(
          `Card ${c.ref}: a secret to rotate is a person's task, never the Worker's (DS-TO-12)`,
        );
      }
    }
    for (const f of inv.findings.filter((x) => x.kind === "could_not_build")) {
      const ok = cards.some(
        (c) =>
          c.forFinding === f.id &&
          c.bucket === "stabilise" &&
          c.change === "fix" &&
          c.assignee === "worker" &&
          c.redCheck === "build_fails_on_base",
      );
      if (!ok) {
        throw new Error(
          `Could-not-build finding ${f.id} needs a stabilise fix card whose red check is the build failing on the base (DS-TO-12)`,
        );
      }
    }
    const scan = this.latest("takeover/secrets_scanned");
    for (const s of (scan?.payload.findings as { commit: string; path: string }[] | undefined) ??
      []) {
      const ok = cards.some(
        (c) => c.assignee === "person" && c.secret?.commit === s.commit && c.secret.path === s.path,
      );
      if (!ok) {
        throw new Error(
          `The secret found at ${s.path} in ${s.commit.slice(0, 12)} needs a person's task to rotate it (DS-TO-12)`,
        );
      }
    }
    cards.forEach((c, i) => {
      if (!c.needsCharacterize) return;
      const before = cards
        .slice(0, i)
        .some((b) => b.change === "characterize" && (b.characterizes ?? []).includes(c.ref));
      if (!before) {
        throw new Error(
          `Card ${c.ref}: no test executes its scope on the base, so a characterize card for it comes first (DS-TO-12)`,
        );
      }
    });
    const n = this.all("takeover/backlog_proposed").length + 1;
    const proposalId = `TOP-${n}`;
    await this.log.append({
      actor,
      type: "takeover/backlog_proposed",
      payload: {
        proposalId,
        inventorySeq: inv.seq,
        cards: cards.map(({ title: _title, links: _links, ...rest }) => rest),
      },
      // A card's title and links are the repository's text — a failing test's
      // name (`file > rule`), an issue's URL, a path: private, never in the
      // hashed public payload.
      private: {
        titles: Object.fromEntries(cards.map((c) => [c.ref, c.title])),
        links: Object.fromEntries(cards.map((c) => [c.ref, c.links])),
      },
    });
    return proposalId;
  }

  /**
   * A proposed backlog with its cards' titles and links, or undefined. Once
   * the private part is erased, a card has no title and no links.
   */
  public async backlog(proposalId: string): Promise<TakeoverBacklog | undefined> {
    const e = (await this.log.getEventsByTypes(["takeover/backlog_proposed"])).find(
      (x) => (x.payload as { proposalId?: unknown }).proposalId === proposalId,
    );
    if (!e) return undefined;
    const p = e.payload as {
      inventorySeq: number;
      cards: Omit<ProposedTakeoverCard, "title" | "links">[];
    };
    const titles = (e.private?.titles ?? {}) as Record<string, unknown>;
    const links = (e.private?.links ?? {}) as Record<string, unknown>;
    const linksOf = (ref: string): string[] => {
      const l = links[ref];
      return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
    };
    return {
      proposalId,
      inventorySeq: p.inventorySeq,
      cards: p.cards.map((c) => ({
        ...c,
        title: String(titles[c.ref] ?? ""),
        links: linksOf(c.ref),
      })),
    };
  }

  /** Whether a person approved this proposal (DS-TO-14): no card is created before. */
  public isPlanApproved(proposalId: string): boolean {
    return this.all("takeover/plan_approved").some((e) => e.payload.proposalId === proposalId);
  }

  /**
   * A person approves the take-over plan (DS-TO-11, DS-TO-14): every batch
   * question still unanswered takes its default (`decision/default_applied`),
   * each proven claim becomes a requirement whose baseline tests are proposed
   * links, and each claimed-unproven claim a candidate for the person to
   * accept or cut. Returns the cards the caller now creates.
   *
   * The proposal must be the latest and bound to the latest inventory. The
   * approval is appended first, so nothing is seeded and no default applied
   * without it on the ledger; if a step after it fails, calling this again
   * finishes what the approval began (each step skips what is done) and
   * returns the cards, and once all is done it refuses as already approved.
   */
  public async approvePlan(
    input: { proposalId: string; projectId?: string },
    principal: string,
  ): Promise<{
    defaultsApplied: string[];
    requirementIds: string[];
    candidateIds: string[];
    cards: ProposedTakeoverCard[];
  }> {
    if (!principal)
      throw new Error("A take-over plan is approved by a person; no principal was given");
    const proposal = await this.backlog(input.proposalId);
    if (!proposal) throw new Error(`No take-over proposal ${input.proposalId}`);
    const approved = this.isPlanApproved(input.proposalId);
    const inv = approved ? this.inventoryAt(proposal.inventorySeq) : this.mustInventory();
    if (!approved) {
      const latest = this.latest("takeover/backlog_proposed");
      if (latest?.payload.proposalId !== input.proposalId) {
        throw new Error(
          `Take-over proposal ${input.proposalId} was superseded by ${String(latest?.payload.proposalId)}`,
        );
      }
      if (proposal.inventorySeq !== inv.seq) {
        throw new Error(
          `Take-over proposal ${input.proposalId} was made from an earlier inventory (seq ${proposal.inventorySeq}, now ${inv.seq}): propose the backlog again`,
        );
      }
    }
    if (
      input.projectId !== undefined &&
      !this.db.prepare("SELECT 1 AS x FROM projects WHERE id = ?").get(input.projectId)
    ) {
      throw new Error(`No project ${input.projectId}`);
    }
    const brief = await this.briefFor(inv);
    const requirements = await this.requirements.list();
    const seededClaims = new Set([
      ...requirements.map((r) => r.claimId),
      ...(await this.candidates.list()).map((c) => c.claimId),
    ]);
    const batch = this.batchFor(inv) ?? [];
    const pending = batch.filter((q) => this.runs.getDecision(q.decisionId)?.status === "pending");
    const unlinked = (c: NonNullable<typeof brief>["claims"][number]) => {
      const r = requirements.find((x) => x.claimId === c.id);
      const linked = new Set(r ? this.requirements.links(r.id).map((l) => l.ref) : []);
      return (c.results ?? []).some((x) => x.kind === "test" && !linked.has(x.ref));
    };
    const toSeed = (brief?.claims ?? []).filter(
      (c) =>
        (c.label === "proven" || c.label === "claimed_unproven") &&
        (!seededClaims.has(c.id) || (c.label === "proven" && unlinked(c))),
    );
    if (approved && pending.length === 0 && toSeed.length === 0) {
      throw new Error(`Take-over proposal ${input.proposalId} was already approved`);
    }
    if (!approved) {
      await this.log.append({
        actor: "human",
        type: "takeover/plan_approved",
        payload: { proposalId: input.proposalId, inventorySeq: proposal.inventorySeq },
        principal,
      });
    }
    const defaultsApplied: string[] = [];
    for (const q of pending) {
      const d = this.runs.getDecision(q.decisionId);
      if (d?.status !== "pending") continue;
      await this.log.append({
        actor: "system",
        type: "decision/default_applied",
        ...(d.cardId ? { cardId: d.cardId } : {}),
        payload: { id: d.id, optionIndex: d.recommendationIndex },
      });
      await this.runs.answerDecision(d.id, d.recommendationIndex, "safe_default");
      defaultsApplied.push(d.id);
    }
    const requirementIds: string[] = [];
    const candidateIds: string[] = [];
    for (const c of toSeed) {
      const project = input.projectId !== undefined ? { projectId: input.projectId } : {};
      if (c.label === "proven") {
        const existing = requirements.find((x) => x.claimId === c.id);
        const r =
          existing ??
          (await this.requirements.create(
            {
              title: c.text ?? c.id,
              ...project,
              mustHave: true,
              source: "takeover",
              claimId: c.id,
            },
            principal,
          ));
        const linked = new Set(this.requirements.links(r.id).map((l) => l.ref));
        for (const t of (c.results ?? []).filter((x) => x.kind === "test")) {
          if (linked.has(t.ref)) continue;
          await this.requirements.link({
            requirementId: r.id,
            from: "test",
            ref: t.ref,
            proposed: true,
          });
        }
        requirementIds.push(r.id);
      } else {
        candidateIds.push(
          await this.candidates.propose({
            ...project,
            source: "takeover",
            title: c.text ?? c.id,
            claimId: c.id,
          }),
        );
      }
    }
    return { defaultsApplied, requirementIds, candidateIds, cards: proposal.cards };
  }
}
