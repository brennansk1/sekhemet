import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "@sekhemet/gates";
import type { CardRecord, CardStore, EventLog, ExternalRef } from "@sekhemet/kernel";
import {
  type AgentStatus,
  type AgentStatusResult,
  type CheckRunInfo,
  type ExternalItem,
  type FetchLike,
  ForgejoIssuesAdapter,
  type GitHubClient,
  GitHubIssuesAdapter,
  PullRequestLifecycle,
  type PullRequestOrigin,
  type PullRequestRef,
  type SharedFields,
  type SyncAdapter,
  type SyncCard,
  isDependencyBotPullRequest,
  issueNumberOf,
  mergeThreeWay,
  postCheckRun,
  reconcileExternalEdit,
  uploadSarif,
} from "@sekhemet/sync";
import { readCodeowners } from "./codeowners.js";
import { effectiveConfig } from "./config_apply.js";
import { evidenceSummary } from "./evidence_summary.js";
import { egressRecorder, githubTransport, ownerRepo as ownerRepoOf } from "./github_transport.js";
import { latestLedgerEvidence } from "./ledger_evidence.js";

/**
 * The GitHub App and tracker paths (Y10-Y12, Y14-Y16, Y20), used when the
 * App (or Forgejo) is configured in the environment; the `gh` CLI path in
 * execute.ts and integrations.ts stays the fallback.
 *
 *   SEKHEMET_GITHUB_APP_ID, SEKHEMET_GITHUB_INSTALLATION_ID,
 *   SEKHEMET_GITHUB_APP_KEYCHAIN (or _KEY_PATH), SEKHEMET_GITHUB_HOST (GHES),
 *   SEKHEMET_GITHUB_REPO=owner/repo, SEKHEMET_GITHUB_AUTOMERGE=1
 *   SEKHEMET_FORGEJO_URL, SEKHEMET_FORGEJO_TOKEN, SEKHEMET_FORGEJO_REPO=owner/repo
 */
export const PR_EVENT = "github/pr_opened";

export { ownerRepo } from "./github_transport.js";

interface Evidence {
  passed?: boolean;
  rungResults?: { gate: string; passed: boolean; skipped?: boolean; durationMs?: number }[];
  filesTouched?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  screenshots?: string[];
  failures?: { gate?: string; rung?: string; errorExcerpt?: string }[];
  diff?: string;
}

function readEvidence(repoPath: string, cardId: string): Evidence | undefined {
  try {
    return JSON.parse(
      readFileSync(join(repoPath, ".sekhemet", "evidence", `latest-${cardId}.json`), "utf8"),
    ) as Evidence;
  } catch {
    return undefined;
  }
}

/** The evidence summary a draft PR carries (review-git §2.5.7, RG-S5-18). */
export function prBody(
  card: CardRecord,
  ev: Evidence | undefined,
  abandoned: readonly { attempt: number; stopReason: string }[] = [],
  /** The person who accepted the card (INT-39): named here, never the assignee. */
  accepter?: string,
): string {
  return `${evidenceSummary(card, ev ?? {}, abandoned)}\n\n_Implemented by the Sekhemet Agent. Issue \`${card.id}\`._${accepter ? `\n\nAccepted by ${accepter}` : ""}`;
}

/**
 * Open the card's PR through the App (Y12, Y16): a draft with the
 * evidence summary, a check run per gate with line annotations (Y14), a
 * SARIF upload when the security gates wrote one (Y15). The PR is recorded
 * so the queue can advance it (ready, reviewers, auto-merge).
 */
export async function openPullRequestViaApp(
  client: GitHubClient,
  repoPath: string,
  repo: { owner: string; repo: string },
  card: CardRecord,
  branch: string,
  headSha: string,
  log?: EventLog,
  options: {
    /** The project's integration branch (INT-12); `main` only when none is given. */
    base?: string;
    /** The evidence summary, when the caller holds the reviewed evidence (INT-12a). */
    body?: string;
    /**
     * Post check runs and SARIF: the App only — a person's `gh` token cannot
     * create check runs.
     */
    checks?: boolean;
  } = {},
): Promise<PullRequestRef> {
  const ev = readEvidence(repoPath, card.id);
  const life = new PullRequestLifecycle(client, repo);
  const pr = await life.openDraft({
    head: branch,
    base: options.base ?? "main",
    title: card.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, ""),
    body: options.body ?? prBody(card, ev),
  });
  if (options.checks === false) {
    await log?.append({
      actor: "harness",
      type: PR_EVENT,
      cardId: card.id,
      payload: { ...pr, repo },
    });
    return pr;
  }
  for (const r of ev?.rungResults ?? []) {
    // A skipped rung (nothing declared, nothing to scan) ran nothing: it is in
    // the evidence, never posted as a failing check.
    if ((r as { skipped?: boolean }).skipped) continue;
    await postCheckRun(client, repo, {
      name: `sekhemet/${r.gate}`,
      headSha,
      passed: r.passed,
      summary: `${r.gate} ${r.passed ? "passed" : "failed"} in Sekhemet.`,
      failures: (ev?.failures ?? [])
        .filter((f) => (f.gate ?? f.rung) === r.gate)
        .map((f) => ({
          rung: String(f.gate ?? f.rung),
          errorExcerpt: String(f.errorExcerpt ?? ""),
        })),
    });
  }
  const sarif = join(repoPath, ".sekhemet", "evidence", `${card.id}.sarif`);
  if (existsSync(sarif)) {
    await uploadSarif(client, repo, {
      commitSha: headSha,
      ref: `refs/heads/${branch}`,
      sarif: readFileSync(sarif, "utf8"),
      toolName: "sekhemet",
    });
  }
  await log?.append({
    actor: "harness",
    type: PR_EVENT,
    cardId: card.id,
    payload: { ...pr, repo },
  });
  return pr;
}

/**
 * Advance every open Sekhemet PR one lifecycle step (Y16): ready with
 * CODEOWNERS reviewers once all checks pass, auto-merge when enabled.
 */
/** The Sekhemet pull requests not yet marked ready (or set to auto-merge). */
async function pendingPullRequests(log: EventLog) {
  const opened = await log.getEventsByTypes([PR_EVENT, "github/pr_advanced"]);
  const done = new Set(
    opened
      .filter(
        (e) =>
          e.type === "github/pr_advanced" &&
          ["ready", "auto_merge"].includes((e.payload as { state: string }).state),
      )
      .map((e) => (e.payload as { number: number }).number),
  );
  return opened.filter(
    (e) => e.type === PR_EVENT && !done.has((e.payload as { number: number }).number),
  );
}

export async function advancePullRequests(
  client: GitHubClient,
  repoPath: string,
  log: EventLog,
  options: {
    autoMerge: boolean;
    /** A card's changed files, from its evidence on the ledger (else the evidence file's diff). */
    filesOf?: (cardId: string) => Promise<readonly string[] | undefined>;
    /** The ledger the PR's other checks are recorded on, as external results (INT-37). */
    store?: CardStore;
    /** Checks that must pass at the PR's current head first (`[review] blocking_checks`, M4). */
    blockingChecks?: readonly string[];
  },
): Promise<{ number: number; state: string }[]> {
  // CODEOWNERS as the integration branch holds it (review-git §2.4.2).
  const codeowners = readCodeowners(repoPath);
  const out: { number: number; state: string }[] = [];
  for (const e of await pendingPullRequests(log)) {
    const p = e.payload as PullRequestRef & { repo: { owner: string; repo: string } };
    const ev = readEvidence(repoPath, e.cardId ?? "");
    const fromDiff = [...new Set((ev?.diff ?? "").match(/^\+\+\+ b\/(.+)$/gm) ?? [])].map((l) =>
      l.slice(6),
    );
    const files = [...((await options.filesOf?.(e.cardId ?? "")) ?? fromDiff)];
    const store = options.store;
    const state = await new PullRequestLifecycle(client, p.repo).advance(p, {
      autoMerge: options.autoMerge,
      ...(options.blockingChecks?.length ? { blockingChecks: options.blockingChecks } : {}),
      ...(codeowners ? { codeowners } : {}),
      changedFiles: files,
      ...(store && e.cardId
        ? {
            onChecks: async (runs: CheckRunInfo[]) => {
              await recordExternalChecks(store, e.cardId as string, runs);
            },
          }
        : {}),
    });
    out.push({ number: p.number, state });
    if (state === "ready" || state === "auto_merge") {
      await log.append({
        actor: "harness",
        type: "github/pr_advanced",
        cardId: e.cardId ?? "board",
        payload: { number: p.number, state },
      });
    }
  }
  return out;
}

/**
 * INT-12b on either transport: advance the open Sekhemet pull requests —
 * ready once every check passes, the code owners of the card's changed files
 * asked to review, auto-merge by policy — through the App or the user's own
 * `gh` login. Nothing is resolved, and `gh` is not run, when none is open.
 */
export async function advanceOpenPullRequests(
  repoPath: string,
  cardStore: CardStore,
  log: EventLog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ number: number; state: string }[]> {
  if ((await pendingPullRequests(log)).length === 0) return [];
  const t = await githubTransport(repoPath, egressRecorder(log), env);
  return advancePullRequests(t.client, repoPath, log, {
    autoMerge: env.SEKHEMET_GITHUB_AUTOMERGE === "1",
    filesOf: async (cardId) => (await latestLedgerEvidence(cardStore, cardId))?.filesTouched,
    store: cardStore,
    // M4: a declared external check gates ready and auto-merge at the PR's current head.
    blockingChecks: effectiveConfig(repoPath).config.review.blockingChecks,
  });
}

/** Our own check runs, posted per gate (Y14): never someone else's result. */
const OWN_CHECK = /^sekhemet\//;

/**
 * Results from someone else's CI (integrations item 15a, INT-37, INT-38):
 * each completed check run on the card's pull request that Sekhemet did not
 * post is recorded on the card's latest attempt as `source: "external"`
 * with the check's name, its run URL and the head SHA it ran on — once per
 * run and outcome. Whether it counts is the Review entry condition's
 * (kernel rule 37, K-N8-4): advisory unless `[review] blocking_checks`
 * declares it, and never evidence at a head other than the card branch's.
 */
export async function recordExternalChecks(
  store: CardStore,
  cardId: string,
  runs: readonly CheckRunInfo[],
): Promise<number> {
  const evidence = await latestLedgerEvidence(store, cardId);
  if (!evidence) return 0;
  const have = store.runs
    .listGateResults(evidence.attemptId)
    .filter((r) => r.source === "external" && r.externalRef);
  let recorded = 0;
  for (const run of runs) {
    const name = run.name ?? "";
    const runUrl = run.html_url ?? run.details_url ?? "";
    if (!name || OWN_CHECK.test(name) || run.status !== "completed" || !run.conclusion) continue;
    if (!runUrl || !run.head_sha) continue; // K-N8-3: an external result names its run and head.
    const passed = ["success", "neutral", "skipped"].includes(run.conclusion);
    const seen = have.some(
      (h) =>
        h.gate === name &&
        h.passed === passed &&
        h.externalRef?.runUrl === runUrl &&
        h.externalRef.headSha === run.head_sha,
    );
    if (seen) continue;
    const took =
      run.started_at && run.completed_at
        ? Math.max(0, Date.parse(run.completed_at) - Date.parse(run.started_at))
        : 0;
    await store.runs.recordGateResult({
      attemptId: evidence.attemptId,
      cardId,
      gate: name,
      layer: "functional",
      passed,
      exitCode: passed ? 0 : 1,
      durationMs: Number.isFinite(took) ? took : 0,
      failures: [],
      source: "external",
      externalRef: { system: "github", checkName: name, runUrl, headSha: run.head_sha },
    });
    recorded++;
  }
  return recorded;
}

// ------------------------------------------------ INT-20b: agent status on the issue

/**
 * A card's state as GitHub's agent-session status (integrations item 16a):
 * queued (Ready), working (Planning, In Progress, Verify), waiting for
 * review (Review), completed (Done); nothing for Backlog, Parked or Rejected.
 */
export function agentStatusOf(status: string): AgentStatus | undefined {
  if (status === "ready") return "queued";
  if (status === "planning" || status === "in_progress" || status === "verify") return "working";
  if (status === "review") return "waiting_for_review";
  if (status === "done") return "completed";
  return undefined;
}

/** Linked GitHub cards whose status differs from the last one shown on the issue. */
async function agentStatusesDue(
  store: CardStore,
): Promise<{ card: CardRecord; ref: ExternalRef; status: AgentStatus }[]> {
  const due: { card: CardRecord; ref: ExternalRef; status: AgentStatus }[] = [];
  for (const card of await store.listCards()) {
    const ref = card.externalRef;
    if (ref?.system !== "github" || !ref.id.includes("#")) continue;
    const status = agentStatusOf(card.status);
    if (!status) continue;
    const last = (await store.cardEvents(card.id, ["github/agent_status"])).at(-1);
    if ((last?.payload as { status?: string } | undefined)?.status === status) continue;
    due.push({ card, ref, status });
  }
  return due;
}

/**
 * INT-20b: show each linked card's state on its issue's Projects status —
 * queued, working, waiting for review, completed — and record it
 * (`github/agent_status`), so a state is set once. The issue's assignee is
 * never written: it stays the person. Nothing is asked of GitHub when no
 * card's state changed.
 */
export async function mirrorAgentStatuses(
  repoPath: string,
  store: CardStore,
  log: EventLog,
  options: {
    env?: NodeJS.ProcessEnv;
    /** The tracker to set it on; default the project's GitHub transport. */
    adapter?: Pick<SyncAdapter, "setAgentStatus">;
    repo?: { owner: string; repo: string };
  } = {},
): Promise<{ set: number; skipped: number; errors: string[] }> {
  const out = { set: 0, skipped: 0, errors: [] as string[] };
  let due = await agentStatusesDue(store);
  if (due.length === 0) return out;
  let adapter = options.adapter;
  let repo = options.repo;
  if (!adapter) {
    const t = await githubTransport(repoPath, egressRecorder(log), options.env ?? process.env);
    adapter = new GitHubIssuesAdapter(t.repo, t.client);
    repo = t.repo;
  }
  // Only this repository's issues: another's ref is not this transport's to write.
  if (repo) {
    const prefix = `${repo.owner}/${repo.repo}#`.toLowerCase();
    due = due.filter((d) => d.ref.id.toLowerCase().startsWith(prefix));
  }
  for (const { card, ref, status } of due) {
    try {
      const r: AgentStatusResult = (await adapter.setAgentStatus?.(ref, status)) ?? {
        set: [],
        skipped: "the tracker has no agent status",
      };
      await store.recordEvent({
        type: "github/agent_status",
        cardId: card.id,
        actor: "github",
        payload: {
          id: card.id,
          ref: ref.id,
          status,
          projects: r.set.map((x) => x.project),
          ...(r.skipped ? { skipped: r.skipped } : {}),
        },
      });
      if (r.set.length) out.set++;
      else out.skipped++;
    } catch (err) {
      out.errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ---------------------------------------------- INT-20c: the tracker's Done

/**
 * INT-20c: a tracker closed a linked card the board has not accepted — not
 * Done, not accepted, not awaiting its merge. The board keeps the card where
 * it is and records a `sync/conflict` once per closure (keyed by when it closed).
 */
export async function recordDoneBeforeAccept(
  store: CardStore,
  card: CardRecord,
  closedAt: string,
  actor: string,
): Promise<boolean> {
  if (card.status === "done" || card.status === "rejected") return false;
  if (card.accepter || card.hold?.kind === "awaitingMerge") return false;
  const recorded = (await store.cardEvents(card.id, ["sync/conflict"])).some((e) => {
    const p = e.payload as { field?: string; at?: string };
    return p.field === "state" && p.at === closedAt;
  });
  if (recorded) return false;
  await store.recordEvent({
    type: "sync/conflict",
    cardId: card.id,
    actor,
    payload: { field: "state", reason: "done_before_accept", at: closedAt },
  });
  return true;
}

// ------------------------------------- INT-16a, INT-16: dependency-bot pull requests

/** The label a dependency bot's verification card carries (item 12). */
export const DEPENDENCY_LABEL = "dependency-update";

export const isDependencyVerification = (card: Pick<CardRecord, "labels">): boolean =>
  (card.labels ?? []).includes(DEPENDENCY_LABEL);

/**
 * The queue's hook for a dependency bot's pull requests (INT-16a, INT-16):
 * each verification card runs the project's full gates on the pull
 * request's head in a throwaway checkout — never an edit, never the Worker
 * (the external review's procedure) — and then, when every gate passed and
 * the project's policy allows it (`[review] auto_merge_dependencies`),
 * auto-merge is enabled, provided the pull request's head is still the one
 * the gates ran on; otherwise it waits in Review for a person. Returns the
 * cards left for the Worker.
 */
export async function runDependencyVerifications(
  repoPath: string,
  ready: CardRecord[],
  deps: {
    store: CardStore;
    board: import("./research/cards.js").ResearchBoard;
    /** The gates in a checkout; default the repository's full gates.toml rungs. */
    runGates?: (cwd: string) => Promise<GateResult>;
    env?: NodeJS.ProcessEnv;
    say?: (line: string) => void;
  },
): Promise<CardRecord[]> {
  const cards = ready.filter(isDependencyVerification);
  if (cards.length === 0) return ready;
  const { runExternalReview } = await import("./external_review.js");
  const allowed = effectiveConfig(repoPath).config.review.autoMergeDependencies;
  for (const card of cards) {
    const r = await runExternalReview(repoPath, card, {
      store: deps.store,
      board: deps.board,
      ...(deps.runGates ? { runGates: deps.runGates } : {}),
    });
    if (r.error) {
      deps.say?.(`Dependency PR #${r.pr} (${card.id}): not verified (${r.error})`);
      continue;
    }
    let autoMerge:
      | "enabled"
      | "not_allowed"
      | "gates_failed"
      | "head_moved"
      | "not_dependency_bot"
      | "refused" = "not_allowed";
    if (!r.gatesPassed) autoMerge = "gates_failed";
    else if (allowed) {
      try {
        const t = await githubTransport(
          repoPath,
          egressRecorder(deps.store),
          deps.env ?? process.env,
        );
        const pr = await t.client.rest<
          {
            number: number;
            node_id: string;
            html_url: string;
            head: { sha: string };
          } & PullRequestOrigin
        >("GET", `/repos/${t.repo.owner}/${t.repo.repo}/pulls/${r.pr}`);
        // M1: GitHub's answer now, not the card's label: the bot's own branch here.
        if (!isDependencyBotPullRequest(pr)) autoMerge = "not_dependency_bot";
        else if (pr.head.sha !== r.headSha) autoMerge = "head_moved";
        else {
          await new PullRequestLifecycle(t.client, t.repo).enableAutoMerge({
            number: pr.number,
            nodeId: pr.node_id,
            url: pr.html_url,
            headSha: pr.head.sha,
          });
          autoMerge = "enabled";
        }
      } catch (err) {
        autoMerge = "refused";
        deps.say?.(
          `Dependency PR #${r.pr}: auto-merge not enabled (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    await deps.store.recordEvent({
      type: "github/dependency_verified",
      cardId: card.id,
      actor: "harness",
      payload: { id: card.id, pr: r.pr, headSha: r.headSha, passed: r.gatesPassed, autoMerge },
    });
    deps.say?.(
      `Dependency PR #${r.pr}: ${r.gatesPassed ? "all checks passed" : "checks failed"}; ${
        autoMerge === "enabled"
          ? "auto-merge enabled"
          : autoMerge === "not_allowed"
            ? "left for a person (the project does not allow auto-merge)"
            : autoMerge === "head_moved"
              ? "not merged: its head moved since the checks ran"
              : autoMerge === "not_dependency_bot"
                ? "not merged: GitHub does not show it as the bot's own branch in this repository"
                : autoMerge === "refused"
                  ? "auto-merge refused by GitHub"
                  : "not merged"
      }`,
    );
  }
  return ready.filter((c) => !isDependencyVerification(c));
}

/**
 * Forgejo from the environment, when configured (Y11), over the caller's
 * network policy (`integrationFetch` with purpose `integration:forgejo`);
 * GitHub is `githubTransport`'s.
 */
export function forgejoFromEnv(
  fetchFor: (apiUrl: string) => FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): SyncAdapter | undefined {
  const fj = ownerRepoOf(env.SEKHEMET_FORGEJO_REPO);
  if (env.SEKHEMET_FORGEJO_URL && env.SEKHEMET_FORGEJO_TOKEN && fj) {
    return new ForgejoIssuesAdapter(
      env.SEKHEMET_FORGEJO_URL,
      fj,
      env.SEKHEMET_FORGEJO_TOKEN,
      fetchFor(env.SEKHEMET_FORGEJO_URL),
    );
  }
  return undefined;
}

/**
 * The card linked to an external item (integrations item 9, INT-1): by its
 * one identity; a GitHub card linked before the one ID (a bare issue number
 * with the same URL) is found too and moved to `owner/repo#n`.
 */
export async function findLinkedCard(
  store: CardStore,
  ref: ExternalRef,
  cards?: readonly CardRecord[],
): Promise<CardRecord | undefined> {
  const all = cards ?? (await store.listCards());
  const exact = all.find(
    (c) => c.externalRef?.system === ref.system && c.externalRef.id === ref.id,
  );
  if (exact) return exact;
  if (ref.system !== "github" || !ref.id.includes("#")) return undefined;
  const n = String(issueNumberOf(ref.id));
  const legacy = all.find(
    (c) =>
      c.externalRef?.system === "github" &&
      c.externalRef.id === n &&
      (!c.externalRef.url || c.externalRef.url === ref.url),
  );
  if (!legacy) return undefined;
  return store.updateCard(legacy.id, { externalRef: ref }, "github");
}

/** What the last sync agreed for one item (integrations item 4): the merge's base. */
interface Snapshot {
  item: ExternalItem;
  agreed: SharedFields;
  /** The card's owner when agreed: a board change of owner is a change of assignee. */
  boardOwner: string | null;
  /** Whether the card was delegated to the Worker when agreed. */
  worker: boolean;
}

/** The label the board writes for a webhook issue's sub-issues (item 12). */
export const SUB_ISSUES_PREFIX = "sub-issues:";
export const subIssuesLabel = (numbers: readonly number[]) =>
  `${SUB_ISSUES_PREFIX}${numbers.join(",")}`;
/** A label the board keeps for itself: never synced, never replaced by the tracker's (M2). */
const boardOnly = (label: string) => label.startsWith(SUB_ISSUES_PREFIX);

const snapKey = (ref: ExternalRef) => `${ref.system}:${ref.id}`;
const sharedOf = (item: ExternalItem): SharedFields => ({
  title: item.title,
  body: item.body,
  labels: [...item.labels],
  ...(item.assignee ? { assignee: item.assignee } : {}),
});
const sameShared = (a: SharedFields, b: SharedFields) =>
  a.title === b.title &&
  a.body === b.body &&
  JSON.stringify([...a.labels].sort()) === JSON.stringify([...b.labels].sort()) &&
  (a.assignee ?? null) === (b.assignee ?? null);

/** Canonical (key-sorted) JSON, so equal values hash equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/**
 * Each item's latest snapshot. Its item and agreed fields — logins and the
 * issue's text — are the event's private part (kernel rule 33, B4.9 review
 * B2): an erased snapshot is no base, so the next sync merges as on a first
 * link. A snapshot written before they were private is read from its payload.
 */
async function snapshots(log: EventLog): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  for (const e of await log.getEventsByTypes(["sync/snapshot"])) {
    const p = e.payload as {
      ref?: ExternalRef;
      item?: ExternalItem;
      agreed?: SharedFields;
      boardOwner?: string | null;
      worker?: boolean;
    };
    const priv = (e.private ?? {}) as { item?: unknown; agreed?: unknown };
    const item = isObject(priv.item) ? (priv.item as unknown as ExternalItem) : p.item;
    const ref = p.ref ?? p.item?.ref;
    if (!ref) continue;
    if (!isObject(item)) {
      out.delete(snapKey(ref));
      continue;
    }
    out.set(snapKey(ref), {
      item,
      agreed: isObject(priv.agreed)
        ? (priv.agreed as unknown as SharedFields)
        : (p.agreed ?? sharedOf(item)),
      boardOwner: p.boardOwner ?? null,
      worker: p.worker ?? false,
    });
  }
  return out;
}

/**
 * Record what both sides agree for a linked card after a sync (the next
 * merge's base): its ref, the tracker's `updatedAt` and the hashes public,
 * the item and the agreed fields private and erasable (B4.9 review B2).
 */
export async function recordSnapshot(
  store: CardStore,
  card: CardRecord | null | undefined,
  item: ExternalItem,
  agreed: SharedFields = sharedOf(item),
): Promise<void> {
  if (!card) return;
  await store.recordEvent({
    type: "sync/snapshot",
    cardId: card.id,
    actor: item.ref.system === "github" ? "github" : "sync",
    payload: {
      ref: { system: item.ref.system, id: item.ref.id, url: item.ref.url },
      updatedAt: item.updatedAt,
      itemHash: hashOf(item),
      agreedHash: hashOf(agreed),
      boardOwner: card.owner ?? null,
      worker: card.delegate?.kind === "worker",
    },
    private: { item, agreed },
  });
}

/** Which way a sync goes (M6): take the tracker's changes, send the board's, or both. */
export type SyncDirection = "pull" | "push" | "both";

/**
 * Two-way sync through a tracker adapter (integrations items 4–9, P9 and
 * NEW-integrations-2). Pull: a new item becomes a Backlog card; a linked
 * card merges its shared fields three ways against the last snapshot — a
 * tracker-only change comes to the board (deferred while the card runs,
 * INT-7), a board-only change goes to the tracker (INT-5), and only a field
 * both changed is a conflict (INT-6). The tracker's assignee becomes the
 * card's owner through the person's linked login (INT-40); a login linked to
 * no one leaves the owner and is recorded once (INT-41). An item whose
 * `updatedAt` the snapshot already holds, on a card unchanged since, is
 * skipped (INT-11d). Push: unlinked cards open issues with the owner's login
 * as assignee and the Worker as a label (INT-36); Done closes the issue.
 *
 * `direction` (M6): `pull` takes the tracker's changes and sends nothing —
 * no update, no new issue; `push` sends the board's changes and changes
 * nothing on the board — no new card, no field, no owner. A change a
 * direction does not carry keeps the old base in the snapshot, so the next
 * sync that carries it still sees it (the same rule as INT-7).
 *
 * A scope or acceptance-criteria edit to a running card (INT-11a) is
 * recorded on the card as `sync/scope_changed`; the Worker is not paused,
 * and at the card's end the runner moves it to Planning, not Review.
 */
export async function syncViaAdapter(
  adapter: SyncAdapter,
  cardStore: CardStore,
  log: EventLog,
  since: string,
  direction: SyncDirection = "both",
): Promise<{
  /** Cards created from new items. */
  created: number;
  /** Cards the tracker's changes updated. */
  updated: number;
  /** Running cards whose scope or criteria the tracker changed (INT-11a). */
  scopeChanged: number;
  /** Items the board's changes updated. */
  pushed: number;
  /** New items opened for unlinked cards. */
  linked: number;
  /** Cards nested deeper than the tracker's `maxDepth`: not written, linked to an ancestor (INT-11e). */
  clamped: { id: string; ancestor: string }[];
  errors: string[];
}> {
  const out = {
    created: 0,
    updated: 0,
    scopeChanged: 0,
    pushed: 0,
    linked: 0,
    clamped: [] as { id: string; ancestor: string }[],
    errors: [] as string[],
  };
  const takes = direction !== "push";
  const sends = direction !== "pull";
  const actor = adapter.system === "github" ? "github" : "sync";
  const system = adapter.system === "forgejo" ? "forgejo" : "github";
  const snaps = await snapshots(log);
  const handleOf = (principal: string | undefined) =>
    principal ? cardStore.handleOf(principal, system) : undefined;
  let items: ExternalItem[] = [];
  try {
    items = await adapter.pull(since);
  } catch (err) {
    out.errors.push(`pull: ${err instanceof Error ? err.message : String(err)}`);
  }
  let cards = await cardStore.listCards();
  const reconcile = async (item: ExternalItem): Promise<void> => {
    try {
      const card = await findLinkedCard(cardStore, item.ref, cards);
      if (!card) {
        if (item.state === "closed" || !takes) return;
        const created = await cardStore.createCard(
          {
            tier: "task",
            title: item.title.slice(0, 300),
            status: "backlog",
            ...(item.body.trim() ? { spec: item.body.trim() } : {}),
            labels: item.labels,
            externalRef: item.ref,
          },
          actor,
        );
        const owner = item.assignee
          ? cardStore.principalForHandle(system, item.assignee)
          : undefined;
        if (owner) await cardStore.changeOwner(created.id, owner, undefined, actor);
        await recordSnapshot(cardStore, await cardStore.getCard(created.id), item);
        cards = await cardStore.listCards();
        out.created++;
        return;
      }
      // INT-20c: the tracker's Done never moves the board; closed early, it is recorded.
      if (takes && item.state === "closed") {
        await recordDoneBeforeAccept(cardStore, card, item.closedAt ?? item.updatedAt, actor);
      }
      const snap = snaps.get(snapKey(item.ref));
      const worker = card.delegate?.kind === "worker";
      const boardAssignee =
        snap && (card.owner ?? null) === snap.boardOwner
          ? snap.agreed.assignee
          : handleOf(card.owner);
      // The board's own labels (the sub-issues note) are never synced (M2).
      const kept = (card.labels ?? []).filter(boardOnly);
      const board: SharedFields = {
        title: card.title,
        body: card.spec ?? "",
        labels: (card.labels ?? []).filter((l) => !boardOnly(l)),
        ...(boardAssignee ? { assignee: boardAssignee } : {}),
      };
      const closeIt = sends && card.status === "done" && item.state !== "closed";
      const delegateDiffers = worker !== (item.delegatedToWorker ?? false);
      if (
        snap &&
        snap.item.updatedAt === item.updatedAt &&
        sameShared(board, snap.agreed) &&
        // A tracker edit deferred while the card ran is still pending (INT-7).
        sameShared(sharedOf(item), snap.agreed) &&
        snap.worker === worker &&
        !closeIt
      ) {
        return; // INT-11d: seen, and nothing changed on either side since.
      }
      const running = ["in_progress", "verify"].includes(card.status);
      if (running && takes && snap && snap.item.updatedAt !== item.updatedAt) {
        // INT-11a: recorded on the card, never a pause; the runner reads it at the card's end.
        const rec = reconcileExternalEdit(card, snap.item, item);
        if (rec.action === "replan_on_completion") {
          await cardStore.recordEvent({
            type: "sync/scope_changed",
            cardId: card.id,
            actor,
            payload: { id: card.id, fields: rec.fields, change: rec.change },
          });
          out.scopeChanged++;
        }
      }
      const m = mergeThreeWay(
        snap?.agreed,
        { ...board, updatedAt: card.updatedAt },
        { ...sharedOf(item), updatedAt: item.updatedAt },
      );
      const agreed: SharedFields = { ...m.merged };
      const setAgreed = (f: keyof SharedFields, v: unknown) => {
        (agreed as unknown as Record<string, unknown>)[f] = v;
      };
      // INT-7 and M6: a change this sync does not carry keeps the old base,
      // so the next sync that carries it still sees it — the tracker's edit
      // to a running card, the tracker's side on a push, the board's on a pull.
      const toBoard = running || !takes ? {} : m.toBoard;
      for (const f of Object.keys(m.toBoard) as (keyof SharedFields)[]) {
        if (f in toBoard) continue;
        setAgreed(f, snap ? snap.agreed[f] : board[f]);
      }
      const toTracker = sends ? m.toTracker : {};
      for (const f of Object.keys(m.toTracker) as (keyof SharedFields)[]) {
        if (f in toTracker) continue;
        setAgreed(f, snap ? snap.agreed[f] : sharedOf(item)[f]);
      }
      const fields = {
        ...(toBoard.title !== undefined ? { title: toBoard.title.slice(0, 300) } : {}),
        ...(toBoard.body !== undefined ? { spec: toBoard.body } : {}),
        ...(toBoard.labels !== undefined ? { labels: [...toBoard.labels, ...kept] } : {}),
      };
      if (Object.keys(fields).length > 0) {
        await cardStore.updateCard(card.id, fields, actor);
        out.updated++;
      }
      if ("assignee" in toBoard) {
        const login = toBoard.assignee;
        const owner = login ? cardStore.principalForHandle(system, login) : undefined;
        if (login && !owner) {
          // INT-41: a login linked to no one never becomes the owner.
          await cardStore.recordEvent({
            type: "sync/conflict",
            cardId: card.id,
            actor,
            payload: { field: "assignee", reason: "unmapped" },
            private: { assignee: login },
          });
        } else if ((owner ?? null) !== (card.owner ?? null)) {
          await cardStore.changeOwner(card.id, owner ?? null, undefined, actor);
          out.updated++;
        }
      }
      // A conflict is recorded when this sync resolves it; one it does not
      // carry is seen again, and recorded, by the sync that does.
      const resolved = m.history.filter((h) =>
        h.winner === "tracker" ? h.field in toBoard : sends,
      );
      if (resolved.length) {
        await cardStore.recordEvent({
          type: "sync/conflict",
          cardId: card.id,
          actor,
          payload: {
            fields: resolved.map((h) => ({ field: h.field, winner: h.winner, at: h.at })),
          },
          private: {
            values: resolved.map((h) => ({ field: h.field, kept: h.kept, lost: h.lost })),
          },
        });
      }
      const patch: Partial<SyncCard> = { id: card.id };
      if (toTracker.title !== undefined) patch.title = toTracker.title;
      if (toTracker.body !== undefined) patch.spec = toTracker.body;
      if (sends && (toTracker.labels !== undefined || delegateDiffers)) {
        // M1: the merged labels — a label the tracker added is kept.
        patch.labels = [...m.merged.labels];
        if (worker) patch.delegate = "worker";
      }
      if ("assignee" in toTracker) patch.owner = toTracker.assignee;
      if (closeIt) patch.status = "done";
      let after = item;
      if (Object.keys(patch).length > 1) {
        await adapter.update(item.ref, patch);
        out.pushed++;
        // What the tracker holds now, so the next sync does not take the
        // board's own push for a tracker edit.
        const { assignee: _was, ...rest } = item;
        const assignee = "owner" in patch ? patch.owner : item.assignee;
        after = {
          ...rest,
          ...(assignee ? { assignee } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.spec !== undefined ? { body: patch.spec } : {}),
          ...(patch.labels !== undefined
            ? { labels: patch.labels, delegatedToWorker: worker }
            : {}),
          ...(patch.status === "done" ? { state: "closed" as const } : {}),
        };
      }
      await recordSnapshot(cardStore, await cardStore.getCard(card.id), after, agreed);
    } catch (err) {
      out.errors.push(`${item.ref.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const item of items) await reconcile(item);
  // A linked item the pull did not return has not changed since `since`: its
  // snapshot is the tracker's state, so a board-only change is still pushed
  // (INT-5) and an edit deferred while the card ran still lands (INT-7).
  const pulled = new Set(items.map((i) => snapKey(i.ref)));
  for (const card of await cardStore.listCards()) {
    const ref = card.externalRef;
    if (ref?.system !== adapter.system || pulled.has(snapKey(ref))) continue;
    const snap = snaps.get(snapKey(ref));
    if (snap) await reconcile(snap.item);
  }
  if (!sends) return out;
  const all = await cardStore.listCards();
  const byId = new Map(all.map((c) => [c.id, c]));
  const writable = (c: CardRecord | undefined) => c !== undefined && c.tier !== "epic";
  // A card's written ancestors, nearest first (epics are never written).
  const ancestorsOf = (c: CardRecord): CardRecord[] => {
    const chain: CardRecord[] = [];
    const seen = new Set([c.id]);
    for (let p = byId.get(c.parentId ?? ""); p && !seen.has(p.id); p = byId.get(p.parentId ?? "")) {
      seen.add(p.id);
      if (writable(p)) chain.push(p);
    }
    return chain;
  };
  const maxDepth = Math.max(1, adapter.capabilities.maxDepth);
  // Parents first, so a card's ancestor is linked before the card is decided.
  const depthOf = (c: CardRecord) => ancestorsOf(c).length + 1;
  const pending = all
    .filter((c) => writable(c) && !c.externalRef)
    .filter((c) => c.status !== "done" && c.status !== "rejected")
    .sort((a, b) => depthOf(a) - depthOf(b));
  for (const card of pending) {
    if (depthOf(card) > maxDepth) {
      // INT-11e: never deeper than the tracker nests. The card is linked to
      // its nearest ancestor at the deepest written level, once.
      const ancestor = ancestorsOf(card)[depthOf(card) - maxDepth - 1] as CardRecord;
      out.clamped.push({ id: card.id, ancestor: ancestor.id });
      const ref = (await cardStore.getCard(ancestor.id))?.externalRef;
      const linked = (await cardStore.cardEvents(card.id, ["sync/clamped"])).some(
        (e) => (e.payload as { ancestor?: string }).ancestor === ancestor.id,
      );
      if (ref && !linked) {
        await cardStore.recordEvent({
          type: "sync/clamped",
          cardId: card.id,
          actor,
          payload: { id: card.id, ancestor: ancestor.id, ref: ref.id, maxDepth },
        });
      }
      continue;
    }
    try {
      const owner = handleOf(card.owner);
      const worker = card.delegate?.kind === "worker";
      const labels = (card.labels ?? []).filter((l) => !boardOnly(l));
      const ref = await adapter.push({
        id: card.id,
        title: card.title,
        ...(card.spec ? { spec: card.spec } : {}),
        labels,
        ...(owner ? { owner } : {}),
        ...(worker ? { delegate: "worker" as const } : {}),
        status: card.status,
        updatedAt: card.updatedAt,
      });
      const linked = await cardStore.updateCard(card.id, { externalRef: ref }, actor);
      await recordSnapshot(cardStore, linked, {
        ref,
        title: card.title,
        body: card.spec ?? "",
        labels,
        ...(owner ? { assignee: owner } : {}),
        delegatedToWorker: worker,
        state: "open",
        updatedAt: "",
      });
      out.linked++;
    } catch (err) {
      out.errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
