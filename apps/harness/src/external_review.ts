import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TransitionRefusedError } from "@sekhemet/board";
import { DeterministicGateRunner, type GateResult, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStatus, CardStore, EventLog } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { annotationsFromFailures } from "@sekhemet/sync";
import { REVIEW_DESK_COPY } from "@sekhemet/ui";
import {
  appClientFromEnv,
  decideEgress,
  egressRecorder,
  githubEndpoints,
  integrationFetch,
  ownerRepo,
  remoteDestination,
} from "./github_transport.js";
import { reviewCard } from "./learning/review.js";
import { recordLedgerRun } from "./ledger_evidence.js";
import type { ResearchBoard } from "./research/cards.js";
import { type ReviewerRole, recordNotReviewed, recordReview } from "./review_flow.js";

/**
 * External review cards (X15, design "External review cards"): a review
 * card targets a pull request the harness did not create. It checks the
 * PR head out in a throwaway worktree, runs the gates and the AI review
 * there (the run's Review model, RG-P8-10), writes an evidence bundle, and never edits: anything a gate wrote
 * into the checkout is discarded and noted. With the GitHub App configured
 * the findings post as one review with line comments.
 */
export const EXTERNAL_REVIEW_LABEL = "external-review";

export interface ReviewTarget {
  pr: number;
  headSha: string;
  url: string;
}

export function isExternalReview(card: Pick<CardRecord, "labels">): boolean {
  return (card.labels ?? []).includes(EXTERNAL_REVIEW_LABEL);
}

/** The PR a review card points at (from its external ref and spec). */
export function reviewTargetOf(card: CardRecord): ReviewTarget | undefined {
  const ref = card.externalRef;
  const fromRef = ref && /^pr\/(\d+)$/.exec(ref.id)?.[1];
  const fromSpec = /PR #(\d+)/.exec(card.spec ?? "")?.[1];
  const pr = Number(fromRef ?? fromSpec);
  if (!pr) return undefined;
  return {
    pr,
    headSha: /\bat ([0-9a-f]{7,40})\b/.exec(card.spec ?? "")?.[1] ?? "",
    url: ref?.url ?? "",
  };
}

export interface ExternalFinding {
  source: "gate" | "reviewer";
  severity: "failure" | "likely_send_back" | "consider";
  note: string;
  path?: string;
  line?: number;
}

export interface ExternalReviewResult {
  cardId: string;
  pr: number;
  headSha: string;
  gatesPassed: boolean;
  findings: ExternalFinding[];
  evidencePath: string;
  discardedEdits: boolean;
  posted: boolean;
  error?: string;
}

export interface ExternalReviewOptions {
  store: CardStore;
  /**
   * The board every move goes through (kernel K-S4-4): the review's run is
   * an attempt on the ledger, so Verify's and Review's entry conditions and
   * back-pressure apply, and a review whose gates failed never enters Review.
   */
  board: ResearchBoard;
  /** The gates in a checkout; default: the repository's gates.toml rungs. */
  runGates?: (cwd: string) => Promise<GateResult>;
  /**
   * The run's Review model (RG-P8-10: never of the Coding model's family),
   * from `externalReviewerFor`; absent, no AI review runs.
   */
  reviewer?: () => Promise<LocalInferenceAdapter>;
  /** Why no AI review runs (the Review role unfilled), recorded on the issue. */
  notReviewed?: string;
  preferences?: string[];
  rules?: string[];
  /** Post the review through the App (a GitHubClient or anything with `rest`). */
  github?: {
    client: { rest: (method: string, path: string, body?: unknown) => Promise<unknown> };
    repo: { owner: string; repo: string };
  };
  base?: string;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

/**
 * The PR's head: the commit when this clone has it, else fetched from
 * `origin` — and the fetch, a request like any other, is decided by the
 * network policy and recorded as `harness/egress` before it runs; refused
 * (offline, or a host the policy denies), nothing is fetched and the refusal
 * names the setting (security item 33; B4.9 part 2, B3).
 */
async function resolveHead(
  repo: string,
  target: ReviewTarget,
  store: CardStore,
): Promise<{ head?: string; error?: string }> {
  const known = (sha: string) => {
    try {
      git(repo, "cat-file", "-e", `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  if (target.headSha && known(target.headSha)) {
    return { head: git(repo, "rev-parse", target.headSha) };
  }
  let remote: string;
  try {
    remote = git(repo, "remote", "get-url", "origin");
  } catch {
    return {};
  }
  const dest = remoteDestination(remote);
  try {
    await decideEgress(repo, egressRecorder(store), githubEndpoints(process.env).apiUrl, {
      url: dest.url,
      host: dest.host,
      detail: `git fetch pull/${target.pr}/head`,
      recordAllowed: true,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    git(repo, "fetch", "-q", "origin", `pull/${target.pr}/head:refs/sekhemet/review/${target.pr}`);
    return { head: git(repo, "rev-parse", `refs/sekhemet/review/${target.pr}`) };
  } catch {
    return {};
  }
}

function defaultGates(repo: string): (cwd: string) => Promise<GateResult> {
  return async (cwd) => {
    const config = loadGatesConfig(repo);
    const rungs = [...new Set(config.gates.map((g) => g.rung))];
    return new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: repo,
      expectedConfigSha256: config.sha256,
    }).runGates(rungs, cwd);
  };
}

export async function runExternalReview(
  repo: string,
  card: CardRecord,
  options: ExternalReviewOptions,
): Promise<ExternalReviewResult> {
  const target = reviewTargetOf(card) ?? { pr: 0, headSha: "", url: "" };
  const evidenceRel = join(".sekhemet", "evidence", `review-${card.id}.json`);
  const result: ExternalReviewResult = {
    cardId: card.id,
    pr: target.pr,
    headSha: target.headSha,
    gatesPassed: false,
    findings: [],
    evidencePath: evidenceRel,
    discardedEdits: false,
    posted: false,
  };
  const move = async (to: CardStatus, reason: string) => {
    const now = await options.store.getCard(card.id);
    await options.board.transitionCard({
      cardId: card.id,
      fromStatus: now?.status ?? card.status,
      toStatus: to,
      actor: "harness",
      reason,
    });
  };
  const resolved = target.pr ? await resolveHead(repo, target, options.store) : {};
  const head = resolved.head;
  if (!head) {
    result.error =
      resolved.error ?? `could not fetch PR #${target.pr} (no origin, or the head is gone)`;
    // An environment failure, not a verdict: the card stays where it is with
    // the reason, and the next pass retries (the stop-reason table's `error`).
    // Parked needs a stop reason that parks, a person's reason or an open
    // decision (kernel rule 27, K-N5-2).
    await options.store.updateCard(card.id, { blockedReason: result.error }, "harness");
    return result;
  }
  result.headSha = head;
  // An external review writes one file, its evidence; that is its scope.
  if (card.scopeFiles.length === 0) {
    await options.store.updateCard(card.id, { scopeFiles: [evidenceRel] }, "harness");
  }
  if (card.status !== "in_progress")
    await move("in_progress", `external review of PR #${target.pr}`);
  const started = Date.now();
  const evidenceId = `ev_review_${card.id}_${started.toString(36)}`;
  const base = options.base ?? "main";
  const checkout = join(repo, ".sekhemet", "review", card.id);
  rmSync(checkout, { recursive: true, force: true });
  try {
    git(repo, "worktree", "prune");
    git(repo, "worktree", "add", "-q", "--detach", checkout, head);
    let mergeBase = base;
    try {
      mergeBase = git(repo, "merge-base", base, head);
    } catch {
      // No common base: review the head against the base tip.
    }
    const diff = git(repo, "diff", "--no-ext-diff", "--no-textconv", `${mergeBase}..${head}`);
    const files = git(repo, "diff", "--name-only", "--no-ext-diff", `${mergeBase}..${head}`)
      .split("\n")
      .filter(Boolean);
    const gates = await (options.runGates ?? defaultGates(repo))(checkout);
    result.gatesPassed = gates.passed;
    // Never edits: whatever a gate or tool wrote is thrown away.
    if (git(checkout, "status", "--porcelain")) {
      result.discardedEdits = true;
      git(checkout, "reset", "-q", "--hard", head);
      git(checkout, "clean", "-qfd");
    }
    const located = annotationsFromFailures(gates.failures);
    for (const f of gates.failures) {
      const at = located.find((a) => f.errorExcerpt.includes(`${a.path}:${a.start_line}`));
      result.findings.push({
        source: "gate",
        severity: "failure",
        note: `${f.gate ?? f.rung}: ${f.errorExcerpt.split("\n")[0]?.slice(0, 300) ?? ""}`,
        ...(at ? { path: at.path, line: at.start_line } : {}),
      });
    }
    const preferences = options.preferences ?? [];
    const rules = options.rules ?? [];
    // The Reviewer reads the pull request against the card's criteria and the
    // preferences, learned or not (review-git §2.3, RG-P8-4); its unmet and
    // unclear findings post with their lines, and all go to the dossier.
    if (options.reviewer) {
      // A Review model that cannot load or answer is not a verdict on the
      // pull request: the reason is on the issue, which goes on (models rule 23).
      const review = await options
        .reviewer()
        .then((model) => reviewCard(model, { card, diff, preferences, rules }))
        .catch(async (err: unknown) => {
          await recordNotReviewed(
            { cardStore: options.store },
            card.id,
            REVIEW_DESK_COPY.reviewFailed(err instanceof Error ? err.message : String(err)),
          ).catch(() => undefined);
          return undefined;
        });
      if (review) {
        await recordReview({ repoPath: repo, cardStore: options.store }, card.id, review);
        review.findings.forEach((f, i) => {
          if (f.verdict === "met") return;
          // Only a location the model gave and the harness checked is a line
          // comment; a skipped criterion's fallback location cites nothing.
          const m = review.cited[i] === true ? /^(.*):(\d+)$/.exec(f.evidence) : null;
          result.findings.push({
            source: "reviewer",
            severity: f.verdict === "unmet" ? "likely_send_back" : "consider",
            note: [f.criterion, f.note].filter(Boolean).join(": "),
            ...(m && Number(m[2]) > 0 ? { path: m[1] as string, line: Number(m[2]) } : {}),
          });
        });
      }
    } else if (options.notReviewed) {
      await recordNotReviewed({ cardStore: options.store }, card.id, options.notReviewed);
    }
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    const body = JSON.stringify(
      {
        id: evidenceId,
        kind: "external-review",
        cardId: card.id,
        pr: target.pr,
        url: target.url,
        headSha: head,
        base: mergeBase,
        files,
        passed: gates.passed,
        gatesPassed: gates.passed,
        rungResults: gates.rungResults ?? [],
        failures: gates.failures,
        findings: result.findings,
        discardedEdits: result.discardedEdits,
        at: new Date().toISOString(),
      },
      null,
      2,
    );
    writeFileSync(join(repo, evidenceRel), body);
    // The review's run on the ledger (K-S4-6, K-S7-7). It never edits, so
    // there is no repair to try: failing gates exhaust its ladder at once.
    await recordLedgerRun(options.store, {
      cardId: card.id,
      modelId: "external-review",
      passed: gates.passed,
      stopReason: gates.passed ? "gate_passed" : "repair_exhausted",
      evidenceId,
      path: evidenceRel,
      body,
      filesTouched: files,
      secondsUsed: Math.round((Date.now() - started) / 1000),
    });
    if (options.github) {
      const { owner, repo: name } = options.github.repo;
      const inline = result.findings.filter((f) => f.path && f.line && files.includes(f.path));
      await options.github.client.rest(
        "POST",
        `/repos/${owner}/${name}/pulls/${target.pr}/reviews`,
        {
          commit_id: head,
          event: "COMMENT",
          body: reviewBody(result),
          comments: inline.map((f) => ({
            path: f.path,
            line: f.line,
            side: "RIGHT",
            body: f.note,
          })),
        },
      );
      result.posted = true;
    }
    await options.store.recordEvent({
      type: "review/external",
      cardId: card.id,
      actor: "reviewer",
      payload: {
        pr: target.pr,
        headSha: head,
        gatesPassed: gates.passed,
        findings: result.findings.length,
        evidence: evidenceRel,
        posted: result.posted,
        discardedEdits: result.discardedEdits,
      },
    });
    const verdict = `external review of PR #${target.pr}: ${gates.passed ? "all checks passed" : "checks failed"}, ${result.findings.length} finding(s)`;
    try {
      await move("verify", verdict);
      // A review whose gates failed never enters Review (K-S4-4): a person
      // reads its findings from Parked.
      if (gates.passed) await move("review", verdict);
      else await move("parked", verdict);
    } catch (err) {
      if (!(err instanceof TransitionRefusedError)) throw err;
      await options.board.holdCard?.(
        card.id,
        `${err.toStatus} refused (${err.message})`,
        "harness",
        err.toStatus,
      );
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await move("parked", result.error).catch(() => undefined);
  } finally {
    try {
      git(repo, "worktree", "remove", "--force", checkout);
    } catch {
      if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true });
    }
  }
  return result;
}

function reviewBody(r: ExternalReviewResult): string {
  const lines = r.findings.map(
    (f) => `- [${f.severity}] ${f.path ? `\`${f.path}:${f.line}\` ` : ""}${f.note}`,
  );
  return [
    `Sekhemet review of \`${r.headSha.slice(0, 12)}\`: ${r.gatesPassed ? "all checks passed" : "checks failed"}.`,
    lines.join("\n") || "No findings.",
    r.discardedEdits ? "_A check wrote into the checkout; those writes were discarded._" : "",
    `_Evidence: \`${r.evidencePath}\` (issue \`${r.cardId}\`). This review never edits the branch._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The external reviews' Review model, from the run's Review role (RG-P8-10):
 * filled, its queue as one queued review request (models rule 20e, C6), held
 * for the batch and released after it; unfilled, no model and the reason
 * each review records.
 */
export function externalReviewerFor(
  role: ReviewerRole,
  access: {
    queuedModel(
      queue: string,
      opts: { review?: boolean },
    ): { model: () => Promise<LocalInferenceAdapter>; release: () => Promise<void> };
  },
): {
  reviewer?: () => Promise<LocalInferenceAdapter>;
  notReviewed?: string;
  release: () => Promise<void>;
} {
  if (role.state === "unfilled") return { notReviewed: role.reason, release: async () => {} };
  const held = access.queuedModel(role.queue, { review: true });
  return { reviewer: held.model, release: held.release };
}

/**
 * The queue's hook: external review cards run here, before the Worker pass,
 * and never reach the Worker. Returns the cards left for the Worker.
 */
export async function runExternalReviews(
  repo: string,
  ready: CardRecord[],
  deps: {
    store: ExternalReviewOptions["store"];
    board: ExternalReviewOptions["board"];
    learning?: {
      profile: () => Promise<{ status: string; category: string; statement: string }[]>;
      rules: () => Promise<{ status: string; role: string; text: string }[]>;
    };
    reviewer?: () => Promise<LocalInferenceAdapter>;
    notReviewed?: string;
    github?: ExternalReviewOptions["github"];
    say?: (line: string) => void;
  },
): Promise<CardRecord[]> {
  const reviews = ready.filter(isExternalReview);
  if (reviews.length === 0) return ready;
  const preferences = deps.learning
    ? (await deps.learning.profile())
        .filter((p) => p.status === "active" && p.category === "code_style")
        .map((p) => p.statement)
    : [];
  const rules = deps.learning
    ? (await deps.learning.rules())
        .filter((r) => r.status === "active" && r.role === "worker")
        .map((r) => r.text)
    : [];
  for (const card of reviews) {
    const r = await runExternalReview(repo, card, {
      store: deps.store,
      board: deps.board,
      preferences,
      rules,
      ...(deps.reviewer ? { reviewer: deps.reviewer } : {}),
      ...(deps.notReviewed ? { notReviewed: deps.notReviewed } : {}),
      ...(deps.github ? { github: deps.github } : {}),
    });
    deps.say?.(
      r.error
        ? `External review ${card.id}: parked (${r.error})`
        : `External review ${card.id} (PR #${r.pr}): ${r.gatesPassed ? "all checks passed" : "checks failed"}, ${r.findings.length} finding(s)${r.posted ? ", posted" : ""}; evidence ${r.evidencePath}`,
    );
  }
  return ready.filter((c) => !isExternalReview(c));
}

/**
 * The App and repository to post reviews to, when both are configured —
 * every request through the network policy and recorded (security item 33).
 */
export function reviewPosterFromEnv(
  repoPath: string,
  ledger: Pick<EventLog, "append"> | Pick<CardStore, "recordLedgerEvent">,
  env: NodeJS.ProcessEnv = process.env,
): ExternalReviewOptions["github"] | undefined {
  const client = appClientFromEnv(
    integrationFetch(repoPath, egressRecorder(ledger), githubEndpoints(env).apiUrl),
    env,
  );
  const repo = ownerRepo(env.SEKHEMET_GITHUB_REPO);
  return client && repo ? { client, repo } : undefined;
}
