import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { approvalView } from "@sekhemet/planner";
import {
  type AcceptContext,
  accepterVerdict,
  codeOwnerVerdict,
  filesShownSinceEvidence,
  implementationFiles,
  ledgerBundle,
  reviewEntriesSinceEvidence,
} from "./accept.js";

/**
 * What Review needs to say, before Accept is pressed, what Accept will
 * refuse (dashboard NEW-dashboard-5; review-git §2.4.1–3):
 * `GET /api/cards/:id/review`. Read-only; every answer comes from the same
 * functions Accept itself runs (`accepterVerdict`, `implementationFiles`,
 * `filesShownSinceEvidence`), so the page and the refusal cannot disagree.
 */
export interface ReviewDesk {
  /** Every Reviewer entry of the card's dossier, oldest first (DB-N5-2, DB-N5-3). */
  findings: {
    id: string;
    verdict?: string;
    text: string;
    filesRead?: string[];
    modelId?: string;
  }[];
  /** The files Accept requires shown: what the card changed, less its tests. */
  implementationFiles: string[];
  /** The files recorded as shown since the latest evidence, by anyone. */
  filesShown: string[];
  /** Whether the viewer may accept this card, and who may instead (DB-N5-9). */
  accept:
    | { may: true }
    | { may: false; code: "not_permitted"; who: Person[] }
    /** RG-N5-4: a code owner must accept, and the viewer owns none of the files. */
    | { may: false; code: "not_code_owner"; who: Person[] }
    | { may: false; code: "not_independent"; because: "built" | "delegated"; who: Person[] };
  /** A person built the work under review (DB-N5-4); absent when the Worker did. */
  builtBy?: { kind: "person"; id: string; name?: string };
  /**
   * Each staged test the depth profile requires a person to approve (DB-N5-8):
   * `approvedSha256` without `approved` is an approval voided by a change.
   */
  testApprovals: {
    path: string;
    approved: boolean;
    approvedSha256?: string;
    what?: "file" | "examples";
    by?: string;
  }[];
}

interface Person {
  principal: string;
  name?: string;
}

export async function reviewDesk(
  ctx: AcceptContext & { eventLog: EventLog },
  card: CardRecord,
  viewer: string,
  opts: {
    /** The project's Accept rule, when recorded (teams item 7). */
    acceptHolders?: readonly string[] | undefined;
    nameOf: (principal: string | undefined) => string | undefined;
  },
): Promise<ReviewDesk> {
  const store: CardStore = ctx.cardStore;
  const person = (principal: string): Person => {
    const name = opts.nameOf(principal);
    return name ? { principal, name } : { principal };
  };

  // RG-P8-9, -12: the AI review of the change under review, with its model.
  const findings = (await reviewEntriesSinceEvidence(store, card.id)).map((e) => ({
    id: e.entryId,
    ...(e.verdict ? { verdict: e.verdict } : {}),
    text: e.text,
    ...(e.sources?.length ? { filesRead: [...e.sources] } : {}),
    ...(e.modelId ? { modelId: e.modelId } : {}),
  }));

  const ev = await ledgerBundle(ctx, card.id);
  const verdict = await accepterVerdict(store, card.id, viewer, opts.acceptHolders);
  // The code-owner rule is Accept's too (RG-N5-4): checked after who may.
  const owner = verdict.may && ev ? codeOwnerVerdict(ctx, card, ev, viewer) : { ok: true as const };
  const accept: ReviewDesk["accept"] = !owner.ok
    ? { may: false, code: "not_code_owner", who: [...owner.owners, ...owner.unmapped].map(person) }
    : verdict.may
      ? { may: true }
      : verdict.code === "not_permitted"
        ? { may: false, code: "not_permitted", who: verdict.who.map(person) }
        : {
            may: false,
            code: "not_independent",
            because: verdict.because,
            who: verdict.who.map(person),
          };

  // The latest attempt's builder decides (DB-N5-4): a Worker-built attempt
  // stays the Worker's even when the card is delegated to a person later.
  // Only a card with no attempt recorded yet goes by its person delegate.
  const attempt = store.runs.listAttempts(card.id).at(-1);
  const builder = attempt
    ? attempt.builtBy?.kind === "person" && attempt.builtBy.id
      ? attempt.builtBy.id
      : undefined
    : card.delegate?.kind === "person"
      ? card.delegate.id
      : undefined;

  // The approvals the depth profile asks for, with the voided ones kept visible.
  const required = (await approvalView({ store, log: ctx.eventLog }, card.id)).tests;
  const recorded = store.stagedTests.testApprovals(card.id);
  const testApprovals = required.map((t) => {
    const r = recorded.find((a) => a.path === t.path);
    const by = r?.principal ? (opts.nameOf(r.principal) ?? r.principal) : undefined;
    return {
      path: t.path,
      approved: t.approved,
      ...(r?.approvedSha256 ? { approvedSha256: r.approvedSha256 } : {}),
      ...(r?.what ? { what: r.what } : {}),
      ...(by ? { by } : {}),
    };
  });

  return {
    findings,
    implementationFiles: ev ? implementationFiles(ev) : [],
    filesShown: await filesShownSinceEvidence(store, card.id),
    accept,
    ...(builder ? { builtBy: builtBy(builder, opts.nameOf(builder)) } : {}),
    testApprovals,
  };
}

function builtBy(id: string, name: string | undefined): NonNullable<ReviewDesk["builtBy"]> {
  return name ? { kind: "person", id, name } : { kind: "person", id };
}
