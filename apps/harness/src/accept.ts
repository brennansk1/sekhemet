import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BoardServiceImpl } from "@sekhemet/board";
import { type CardRecord, type CardStore, ERASED_MARKER } from "@sekhemet/kernel";
import { MergeConflictError, NodeGitSyncAdapter, groupByIntent } from "@sekhemet/sync";
import { ownersOf } from "./codeowners.js";
import { effectiveConfig } from "./config_apply.js";
import { localPersonDetails } from "./ledger_cmds.js";
import { latestLedgerEvidence } from "./ledger_evidence.js";

/**
 * Accept, safely (review-git §2.5, S5, NEW-review-git-5).
 *
 * Every precondition is checked before anything moves; the merge is git
 * plumbing on the integration branch's ref, never the person's checkout; the
 * move to Done and `card/accepted` commit in one ledger transaction, and a
 * refused move puts the ref back. What merges is what was reviewed.
 */

/** What Accept needs of the harness: the repository, its ledger and its board. */
export interface AcceptContext {
  repoPath: string;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  /** Where a failure after the accept is reported; `console.error` without one. */
  report?: (line: string) => void;
}

export interface AcceptOptions {
  /** The person accepting (rule 19); the install's person on a solo setup. */
  principal?: string;
  /** Reviewer findings (`unmet` or `unclear`) the person acknowledged, by dossier entry id (§2.4.3). */
  acknowledgedFindings?: readonly string[];
  /** Auto-accept: the run whose `review/auto_accept_enabled` names the person (§2.5.6). */
  autoRun?: string;
  /**
   * The people the card's project's Accept rule names (teams item 7), when a
   * rule is recorded; without one, the ledger's Accept-holders (the Solo person).
   */
  acceptHolders?: readonly string[];
}

/** A refused accept: nothing moved. `code` says which precondition failed. */
export class AcceptRefusedError extends Error {
  constructor(
    public readonly code:
      | "not_in_review"
      | "no_evidence"
      | "evidence_failed"
      | "ledger_invalid"
      | "changed_after_review"
      | "not_permitted"
      | "not_independent"
      | "unacknowledged"
      | "no_enabling_person"
      | "conflict"
      | "no_branch"
      | "not_code_owner"
      | "pr_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AcceptRefusedError";
  }
}

/** The integration branch cards are cut from and accepted into (RG-S5-14). */
export function integrationBranch(repoPath: string): string {
  return effectiveConfig(repoPath).config.review.integrationBranch;
}

/**
 * Accept moves the integration branch by plumbing, so a checkout on that
 * branch keeps its old files while its branch moves under it (RG-S5-2). One
 * line per such checkout naming the command that fast-forwards its files —
 * a two-tree `read-tree`, which keeps unsaved edits and refuses on a clash.
 * Undefined when no checkout is on the branch.
 */
export function checkoutNotice(repoPath: string, branch: string, sha: string): string | undefined {
  let listing: string;
  let parent: string;
  try {
    listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8",
    });
    parent = execFileSync("git", ["rev-parse", `${sha}^1`], {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
  const on: string[] = [];
  for (const block of listing.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && lines.includes(`branch refs/heads/${branch}`) && !lines.includes("bare")) {
      on.push(path);
    }
  }
  if (on.length === 0) return undefined;
  const q = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`);
  return on
    .map(
      (path) =>
        `Your checkout ${path} is on ${branch}, which moved to ${sha.slice(0, 10)}; to bring its files up to date (unsaved edits kept): \`git -C ${q(path)} read-tree -m -u ${parent} ${branch}\``,
    )
    .join("\n");
}

/** The bundle fields Accept reads (gates rule 35). */
export interface AcceptedEvidence {
  id?: string;
  passed?: boolean;
  rungResults?: { gate: string; passed: boolean; skipped?: boolean; durationMs?: number }[];
  filesTouched?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
  settings?: { modelId?: string };
  /** `<head>:<tree>` of the card's worktree when the evidence was taken (RG-S5-6). */
  repoState?: string;
  screenshots?: string[];
}

/** The card's latest evidence as the ledger names it, checked against its hash (K-S7-7). */
export async function ledgerBundle(
  ctx: AcceptContext,
  cardId: string,
): Promise<AcceptedEvidence | undefined> {
  const record = await latestLedgerEvidence(ctx.cardStore, cardId);
  if (!record) return undefined;
  try {
    const body = readFileSync(
      isAbsolute(record.path) ? record.path : join(ctx.repoPath, record.path),
      "utf8",
    );
    if (createHash("sha256").update(body).digest("hex") !== record.sha256) return undefined;
    return JSON.parse(body) as AcceptedEvidence;
  } catch {
    return undefined;
  }
}

/** `GateStatus` from the evidence, never hard-coded (RG-S5-7). */
export function gateStatusOf(ev: AcceptedEvidence): "pass" | "fail" | "partial" {
  const rungs = ev.rungResults ?? [];
  if (ev.passed !== true || rungs.some((r) => r.passed === false && r.skipped !== true))
    return "fail";
  return rungs.some((r) => r.skipped === true) ? "partial" : "pass";
}

/** Implementation files: what the card changed, less its tests (§2.4.3). */
export function implementationFiles(ev: AcceptedEvidence): string[] {
  const g = groupByIntent(ev.filesTouched ?? []);
  return [...g.source, ...g.config, ...g.docs].sort();
}

/**
 * Who may accept, and whether this accept is independent (§2.4.1, O11):
 * one Accept-holder is solo — they may accept what they built or delegated;
 * two or more is a team, where neither the builder nor the delegator (the
 * principal of the latest `card/delegated` to the Worker, whoever owns the
 * card now) may accept. Counted now, at the attempt.
 */
export async function accepterCheck(
  store: CardStore,
  cardId: string,
  principal: string,
  /** The project's Accept rule, when recorded (teams item 7). */
  rule?: readonly string[],
): Promise<{ independent: boolean }> {
  const holders = rule ? [...new Set(rule)] : store.acceptHolders();
  if (rule ? !holders.includes(principal) : !store.mayAccept(principal)) {
    throw new AcceptRefusedError(
      "not_permitted",
      `${principal} does not hold the Accept permission for this project. Who may accept: ${holders.join(", ") || "no one yet — name an Accept-holder"}`,
    );
  }
  if (holders.length < 2) return { independent: false };
  const builders = await store.buildersOf(cardId);
  const delegator = store.delegatorOf(cardId);
  const excluded = new Set([...builders, ...(delegator ? [delegator] : [])]);
  if (excluded.has(principal)) {
    const may = holders.filter((h) => !excluded.has(h));
    throw new AcceptRefusedError(
      "not_independent",
      `${principal} ${builders.includes(principal) ? "built" : "delegated"} ${cardId}; on a team another Accept-holder accepts it. Who may accept: ${may.join(", ") || "no other Accept-holder yet"}`,
    );
  }
  return { independent: true };
}

/**
 * RG-N5-4: on a project that requires a code owner's accept, the accepting
 * principal must own at least one of the card's files (CODEOWNERS, the last
 * matching pattern for each file; owners mapped through linked GitHub
 * logins). Any owner suffices; a refusal names the owners who may.
 */
function codeOwnerCheck(
  ctx: AcceptContext,
  card: CardRecord,
  ev: AcceptedEvidence,
  principal: string,
): void {
  if (!effectiveConfig(ctx.repoPath).config.review.requireCodeOwnerAccept) return;
  const files = ev.filesTouched?.length ? ev.filesTouched : (card.scopeFiles ?? []);
  const owners = ownersOf(ctx.repoPath, ctx.cardStore, files);
  if (owners.principals.includes(principal)) return;
  const who = [...owners.principals, ...owners.unmapped];
  throw new AcceptRefusedError(
    "not_code_owner",
    `${principal} owns none of ${card.id}'s files, and this project requires a code owner's accept. Who may accept: ${who.join(", ") || "no code owner is named in CODEOWNERS for these files"}`,
  );
}

/**
 * The light Accept friction (§2.4.3, O13; RG-N5-5): every `unmet` or
 * `unclear` Reviewer finding acknowledged, and every Implementation file
 * shown once — by a `review/opened` of this card after its latest evidence.
 * Returns what remains, empty when Accept may proceed.
 */
export async function acceptFriction(
  store: CardStore,
  cardId: string,
  ev: AcceptedEvidence,
  acknowledged: readonly string[],
): Promise<{ findings: string[]; files: string[] }> {
  const dossier = await store.getDossier(cardId);
  const open = dossier.entries.filter(
    (e) => e.kind === "review" && (e.verdict === "unmet" || e.verdict === "unclear"),
  );
  const ack = new Set(acknowledged);
  const findings = open.filter((e) => !ack.has(e.entryId)).map((e) => e.entryId);
  const since = (await store.cardEvents(cardId, ["evidence/recorded"])).at(-1)?.seq ?? 0;
  const shown = new Set<string>();
  for (const e of await store.cardEvents(cardId, ["review/opened"])) {
    if (e.seq < since) continue;
    for (const f of (e.payload as { filesShown?: string[] }).filesShown ?? []) shown.add(f);
  }
  const files = implementationFiles(ev).filter((f) => !shown.has(f));
  return { findings, files };
}

/**
 * The accepter's display name for a pull request's body, which leaves the
 * machine (INT-39): the install's person's git `user.name`, or the name
 * their person record holds — never their email; else the opaque principal.
 */
async function accepterName(
  repoPath: string,
  store: CardStore,
  principal: string,
): Promise<string> {
  if (principal === store.localPrincipal()) {
    try {
      const name = new NodeGitSyncAdapter(repoPath).gitConfig("user.name");
      if (name) return name;
    } catch {
      // No git name: the person record's below.
    }
  }
  const created = (await store.eventsOfType(["person/created"])).find(
    (e) => (e.payload as { principal?: string }).principal === principal,
  );
  const name = (created?.private as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name && name !== ERASED_MARKER ? name : principal;
}

/** `Name <email>` for the install's person, else the opaque principal (§2.5.4): local trailers only. */
function acceptedBy(repoPath: string, store: CardStore, principal: string): string {
  if (principal !== store.localPrincipal()) return principal;
  const d = localPersonDetails(repoPath);
  let name = "";
  try {
    name = new NodeGitSyncAdapter(repoPath).gitConfig("user.name");
  } catch {
    name = "";
  }
  if (d.email) return `${name || d.email.split("@")[0]} <${d.email}>`;
  return d.name ?? principal;
}

/** The person whose standing decision this auto-accept run is (§2.5.6, RG-S5-8). */
export async function autoAcceptPrincipal(
  store: CardStore,
  run: string | undefined,
): Promise<string> {
  const enabled = run
    ? (await store.eventsOfType(["review/auto_accept_enabled"]))
        .filter((e) => (e.payload as { run?: string }).run === run)
        .at(-1)
    : undefined;
  const principal = (enabled?.payload as { principal?: string } | undefined)?.principal;
  if (!principal) {
    throw new AcceptRefusedError(
      "no_enabling_person",
      "Auto-accept is a person's standing decision: no review/auto_accept_enabled names who enabled it for this run, so nothing is accepted",
    );
  }
  return principal;
}

/**
 * Record a person's standing decision to auto-accept this run (§2.5.6):
 * `review/auto_accept_enabled { principal, run }`. Returns the run id.
 */
export async function enableAutoAccept(store: CardStore, principal?: string): Promise<string> {
  const who = principal ?? store.localPrincipal();
  const run = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await store.recordLedgerEvent({
    type: "review/auto_accept_enabled",
    actor: "human",
    principal: who,
    payload: { principal: who, run },
  });
  return run;
}

/** The branch's `<head>:<tree>`, as the runner fingerprints a clean worktree (RG-S5-6). */
function branchState(adapter: NodeGitSyncAdapter, branch: string): string {
  return `${adapter.revParse(`refs/heads/${branch}`)}:${adapter.revParse(`refs/heads/${branch}^{tree}`)}`;
}

/**
 * Check everything Accept needs before anything moves (§2.5.1). Returns the
 * facts the merge uses.
 */
export async function acceptPreconditions(
  ctx: AcceptContext,
  cardId: string,
  actor: string,
  options: AcceptOptions,
): Promise<{
  card: CardRecord;
  ev: AcceptedEvidence;
  principal: string;
  independent: boolean;
  auto: boolean;
}> {
  const card = await ctx.cardStore.getCard(cardId);
  if (!card || card.status !== "review") {
    throw new AcceptRefusedError(
      "not_in_review",
      `Card ${cardId} is in '${card?.status ?? "nowhere"}'. Only a card in Review can be accepted.`,
    );
  }
  if (card.hold?.kind === "awaitingMerge") {
    throw new AcceptRefusedError(
      "not_in_review",
      `${cardId} was accepted and awaits pull request #${card.hold.pr}`,
    );
  }
  const ev = await ledgerBundle(ctx, cardId);
  if (!ev) {
    throw new AcceptRefusedError(
      "no_evidence",
      `${cardId} has no evidence bundle on the ledger; nothing to accept`,
    );
  }
  if (ev.passed !== true || (ev.rungResults ?? []).length === 0) {
    throw new AcceptRefusedError(
      "evidence_failed",
      `${cardId}'s latest evidence ${(ev.rungResults ?? []).length === 0 ? "ran no gates" : "did not pass every blocking gate"}`,
    );
  }
  const ledger = ctx.cardStore.verifyLedger();
  if (!ledger.valid) {
    throw new AcceptRefusedError(
      "ledger_invalid",
      `The ledger does not verify (${ledger.reason ?? "hash chain broken"}); nothing is accepted until it does`,
    );
  }
  let principal: string;
  let independent = false;
  const auto = actor === "harness";
  if (auto) {
    principal = await autoAcceptPrincipal(ctx.cardStore, options.autoRun);
  } else {
    principal = options.principal ?? ctx.cardStore.localPrincipal();
    independent = (await accepterCheck(ctx.cardStore, cardId, principal, options.acceptHolders))
      .independent;
    codeOwnerCheck(ctx, card, ev, principal);
    const remaining = await acceptFriction(
      ctx.cardStore,
      cardId,
      ev,
      options.acknowledgedFindings ?? [],
    );
    if (remaining.findings.length > 0 || remaining.files.length > 0) {
      const parts = [
        remaining.findings.length
          ? `acknowledge the Reviewer's finding(s) ${remaining.findings.join(", ")}`
          : "",
        remaining.files.length ? `look at ${remaining.files.join(", ")}` : "",
      ].filter(Boolean);
      throw new AcceptRefusedError(
        "unacknowledged",
        `Before accepting ${cardId}, ${parts.join(" and ")} (sekhemet review ${cardId} shows them)`,
      );
    }
  }
  const adapter = new NodeGitSyncAdapter(ctx.repoPath);
  const branch = adapter.cardBranch(cardId);
  if (!branch) {
    throw new AcceptRefusedError("no_branch", `${cardId} has no branch to merge`);
  }
  if (!ev.repoState || branchState(adapter, branch) !== ev.repoState) {
    throw new AcceptRefusedError(
      "changed_after_review",
      `${cardId} changed after it was reviewed: its branch head is not the state its evidence records. Verify it again before accepting.`,
    );
  }
  return { card, ev, principal, independent, auto };
}

/**
 * Accept a reviewed card (review-git §2.5): the preconditions, then — under
 * the project's accept lock — a plumbing squash onto the integration branch
 * by compare-and-set, then the move to Done and `card/accepted` in one
 * ledger transaction. A refused move restores the ref; nothing is half-done.
 * With pull-request-on-accept, the card stays in Review awaiting the merge.
 */
export async function acceptCard(
  ctx: AcceptContext & { restrictedMode?: boolean },
  card: CardRecord,
  actor = "human",
  options: AcceptOptions = {},
): Promise<string> {
  const execute = await import("./execute.js");
  const facts = await acceptPreconditions(ctx, card.id, actor, options);
  const { ev, principal, independent, auto } = facts;
  const stored = facts.card;
  const adapter = new NodeGitSyncAdapter(ctx.repoPath);
  const target = integrationBranch(ctx.repoPath);
  const gateStatus = gateStatusOf(ev);
  const execCtx = { restrictedMode: false, ...ctx };

  // §2.5.7: with pull-request-on-accept, a person's Accept opens a pull
  // request and the card waits in Review under `awaitingMerge` (rule 24).
  const { readSettings } = await import("./integrations.js");
  if (!auto && readSettings(ctx.repoPath).githubPrOnAccept) {
    const branch = adapter.cardBranch(stored.id) as string;
    let opened: Awaited<ReturnType<typeof execute.openPullRequest>>;
    try {
      opened = await execute.openPullRequest(execCtx, stored, branch, {
        base: target,
        remote: effectiveConfig(ctx.repoPath).config.review.remote,
        accepter: await accepterName(ctx.repoPath, ctx.cardStore, principal),
        evidence: ev,
      });
    } catch (err) {
      // INT-15: nothing moved — the card stays in Review, the reason said.
      throw new AcceptRefusedError(
        "pr_unavailable",
        `${stored.id} stays in Review: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The pull request's hold and `card/accepted` in one transaction (kernel S7).
    await ctx.boardService.acceptWithPullRequest(stored.id, opened, principal, "harness", [
      {
        type: "card/accepted",
        actor,
        principal,
        payload: { id: stored.id, pr: opened.url, principal, independent, gateStatus },
      },
    ]);
    await recordDecision(ctx, stored, principal, "accept", options.acknowledgedFindings ?? []);
    await adapter.removeWorktree(stored.id);
    await execute.releaseHeldCards(execCtx).catch(() => []);
    return opened.url;
  }

  // RG-S5-5: the head this accept was decided against, read before the lock,
  // so an accept that lands while this one waits refuses it ("moved since
  // the preview") rather than squashing onto a head nobody reviewed against.
  const old = adapter.revParse(`refs/heads/${target}^{commit}`);
  const sha = await adapter.withAcceptLock(async () => {
    const person = acceptedBy(ctx.repoPath, ctx.cardStore, principal);
    const trailers: Record<string, string> = {
      "Agent-Model": ev.settings?.modelId ?? stored.modelRoute?.executor ?? "local",
      "Agent-Harness": "sekhemet",
      "Agent-Role": "implementer",
      GateStatus: gateStatus,
      "Accepted-by": auto ? `sekhemet --auto-accept (for ${person})` : person,
      "Ledger-Head": ctx.cardStore.ledgerHead() ?? "0:genesis",
    };
    let merged: string;
    try {
      merged = await adapter.squashAndMerge(
        stored.id,
        target,
        `feat(${stored.id}): ${stored.title}`,
        trailers,
        stored.title,
        { expectedOld: old, body: execute.evidenceSummary(stored, ev, []) },
      );
    } catch (err) {
      if (err instanceof MergeConflictError) {
        throw new AcceptRefusedError("conflict", err.message);
      }
      throw err;
    }
    try {
      // §2.5.3, kernel S7: the move and `card/accepted` in one transaction.
      await ctx.boardService.transitionCard({
        cardId: stored.id,
        fromStatus: "review",
        toStatus: "done",
        actor,
        principal,
        reason: auto ? "auto-accepted under a person's standing decision" : "accepted",
        with: [
          {
            type: "card/accepted",
            actor,
            principal,
            payload: {
              id: stored.id,
              sha: merged,
              principal,
              independent,
              gateStatus,
              integration: target,
              ...(auto ? { auto: true } : {}),
            },
          },
        ],
      });
    } catch (err) {
      // RG-S5-3: the board refused after the ref moved — put it back.
      await adapter.restoreRef(target, old, merged);
      throw err;
    }
    return merged;
  });
  if (!auto) {
    await recordDecision(ctx, stored, principal, "accept", options.acknowledgedFindings ?? []);
  }
  await adapter.removeWorktree(stored.id);
  // §2.5.5: stacked children rebase onto the integration branch and re-run
  // their gates (NEW-review-git-2); a child that conflicts is reported.
  // The accept stands; a restack that fails is said, not swallowed.
  await execute.restackAfterAccept(execCtx, stored, target).catch((err: unknown) => {
    (ctx.report ?? console.error)(
      `Restacking the cards stacked on ${stored.id} failed after it was accepted: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  await execute.releaseHeldCards(execCtx).catch(() => []);
  if (stored.parentId) await execute.rollupParent(execCtx, stored.parentId).catch(() => undefined);
  return sha;
}

/**
 * A person's decision on a card in Review, recorded for ReviewWIP (S6,
 * RG-S6-6): `review/decided { principal, decision, linesReviewed, minutes,
 * acknowledgedFindings }`. Minutes run from the person's latest
 * `review/opened` of the card, else from its entering Review.
 */
export async function recordDecision(
  ctx: Pick<AcceptContext, "cardStore">,
  card: CardRecord,
  principal: string,
  decision: "accept" | "send_back" | "park" | "reject",
  acknowledgedFindings: readonly string[],
  lines?: number,
): Promise<void> {
  const opened = (await ctx.cardStore.cardEvents(card.id, ["review/opened"]))
    .filter((e) => e.principal === principal)
    .at(-1);
  const entered = (await ctx.cardStore.cardEvents(card.id, ["card/status_changed"]))
    .filter((e) => (e.payload as { toStatus?: string }).toStatus === "review")
    .at(-1);
  const from = opened ?? entered;
  const minutes = from ? Math.max(0, (Date.now() - Date.parse(from.createdAt)) / 60_000) : 0;
  const last = ctx.cardStore.runs.listEvidence(card.id).at(-1);
  const linesReviewed = lines ?? (last ? last.linesAdded + last.linesRemoved : 0);
  await ctx.cardStore.recordEvent({
    type: "review/decided",
    cardId: card.id,
    actor: "human",
    principal,
    payload: {
      id: card.id,
      principal,
      decision,
      linesReviewed: Math.max(0, Math.round(linesReviewed)),
      minutes: Math.round(minutes * 100) / 100,
      acknowledgedFindings: [...acknowledgedFindings],
      ...(card.projectId ? { project: card.projectId } : {}),
    },
  });
}

/**
 * The files a person was shown in Review (RG-S6-6, §2.4.3):
 * `review/opened { principal, evidence, filesShown }`.
 */
export async function recordReviewOpened(
  ctx: AcceptContext,
  card: CardRecord,
  filesShown: readonly string[],
  principal = ctx.cardStore.localPrincipal(),
): Promise<void> {
  const ev = await ledgerBundle(ctx, card.id);
  await ctx.cardStore.recordEvent({
    type: "review/opened",
    cardId: card.id,
    actor: "human",
    principal,
    payload: {
      id: card.id,
      principal,
      ...(ev?.id ? { evidence: ev.id } : {}),
      filesShown: [...new Set(filesShown)].sort(),
    },
  });
}

/**
 * Revert an accepted card (§2.4, RG-S5-10): a revert commit of its squash on
 * the integration branch (plumbing, compare-and-set), then Done → Ready,
 * recorded as `card/reverted { sha, revertSha }` in the move's transaction.
 */
export async function revertAccept(
  ctx: AcceptContext,
  card: CardRecord,
  reason = "",
  principal = ctx.cardStore.localPrincipal(),
  /** The project's Accept rule, when recorded (teams item 7). */
  rule?: readonly string[],
): Promise<string> {
  const stored = await ctx.cardStore.getCard(card.id);
  if (stored?.status !== "done") {
    throw new Error(
      `${card.id} is not done (it is ${stored?.status ?? "missing"}); only an accepted card is reverted`,
    );
  }
  const accepted = (await ctx.cardStore.cardEvents(card.id, ["card/accepted"])).at(-1);
  const p = accepted?.payload as { sha?: string; integration?: string } | undefined;
  if (!p?.sha) throw new Error(`${card.id} has no accepted squash on the ledger to revert`);
  if (rule ? !rule.includes(principal) : !ctx.cardStore.mayAccept(principal)) {
    throw new AcceptRefusedError(
      "not_permitted",
      `${principal} does not hold the Accept permission; reverting an accept is an Accept-holder's decision`,
    );
  }
  const target = p.integration ?? integrationBranch(ctx.repoPath);
  const adapter = new NodeGitSyncAdapter(ctx.repoPath);
  return adapter.withAcceptLock(async () => {
    const head = adapter.revParse(`refs/heads/${target}^{commit}`);
    const revert = await adapter.revertSquash(target, p.sha as string, {
      Card: card.id,
      "Agent-Model": "none",
      "Agent-Harness": "sekhemet",
      "Agent-Role": "reviewer",
      "Reverted-by": acceptedBy(ctx.repoPath, ctx.cardStore, principal),
      "Co-authored-by": "sekhemet <harness@sekhemet.local>",
    });
    try {
      await ctx.boardService.transitionCard({
        cardId: card.id,
        fromStatus: "done",
        toStatus: "ready",
        actor: "human",
        principal,
        reason: `reverted${reason.trim() ? `: ${reason.trim()}` : ""}`,
        with: [
          {
            type: "card/reverted",
            actor: "human",
            principal,
            payload: { id: card.id, sha: p.sha, revertSha: revert, principal },
            ...(reason.trim() ? { private: { reason: reason.trim().slice(0, 2000) } } : {}),
          },
        ],
      });
    } catch (err) {
      await adapter.restoreRef(target, head, revert);
      throw err;
    }
    return revert;
  });
}
