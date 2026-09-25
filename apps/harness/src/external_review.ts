import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeterministicGateRunner, type GateResult, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { annotationsFromFailures } from "@sekhemet/sync";
import { recordReview } from "./execute.js";
import { reviewCard } from "./learning/review.js";
import { ownerRepo } from "./wave2_github.js";
import { githubAppFromEnv } from "./wave2_server.js";

/**
 * External review cards (X15, design "External review cards"): a review
 * card targets a pull request the harness did not create. It checks the
 * PR head out in a throwaway worktree, runs the gates and Seshat's review
 * there, writes an evidence bundle, and never edits: anything a gate wrote
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
  store: Pick<CardStore, "recordDossierEntry" | "recordEvent" | "updateCardStatus">;
  /** The gates in a checkout; default: the repository's gates.toml rungs. */
  runGates?: (cwd: string) => Promise<GateResult>;
  /** Seshat's model, loaded only when there is something to review against. */
  reviewer?: () => Promise<LocalInferenceAdapter>;
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

function resolveHead(repo: string, target: ReviewTarget): string | undefined {
  const known = (sha: string) => {
    try {
      git(repo, "cat-file", "-e", `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  if (target.headSha && known(target.headSha)) return git(repo, "rev-parse", target.headSha);
  try {
    git(repo, "fetch", "-q", "origin", `pull/${target.pr}/head:refs/sekhemet/review/${target.pr}`);
    return git(repo, "rev-parse", `refs/sekhemet/review/${target.pr}`);
  } catch {
    return undefined;
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
  const head = target.pr ? resolveHead(repo, target) : undefined;
  if (!head) {
    result.error = `could not fetch PR #${target.pr} (no origin, or the head is gone)`;
    await options.store.updateCardStatus(card.id, "parked", result.error, "harness");
    return result;
  }
  result.headSha = head;
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
    if (options.reviewer && (preferences.length || rules.length)) {
      const model = await options.reviewer();
      const notes = await reviewCard(model, { card, diff, preferences, rules }).catch(() => []);
      await recordReview(options.store, card.id, notes, "reviewer");
      for (const n of notes) result.findings.push({ source: "reviewer", ...n });
    }
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(
      join(repo, evidenceRel),
      JSON.stringify(
        {
          kind: "external-review",
          cardId: card.id,
          pr: target.pr,
          url: target.url,
          headSha: head,
          base: mergeBase,
          files,
          gatesPassed: gates.passed,
          rungResults: gates.rungResults ?? [],
          failures: gates.failures,
          findings: result.findings,
          discardedEdits: result.discardedEdits,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
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
    await options.store.updateCardStatus(
      card.id,
      "review",
      `external review of PR #${target.pr}: ${gates.passed ? "gates pass" : "gates fail"}, ${result.findings.length} finding(s)`,
      "harness",
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await options.store.updateCardStatus(card.id, "parked", result.error, "harness");
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
    `Sekhemet review of \`${r.headSha.slice(0, 12)}\`: gates ${r.gatesPassed ? "pass" : "fail"}.`,
    lines.join("\n") || "No findings.",
    r.discardedEdits ? "_A gate wrote into the checkout; those writes were discarded._" : "",
    `_Evidence: \`${r.evidencePath}\` (card \`${r.cardId}\`). This review never edits the branch._`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
    learning?: {
      profile: () => Promise<{ status: string; category: string; statement: string }[]>;
      rules: () => Promise<{ status: string; role: string; text: string }[]>;
    };
    reviewer?: () => Promise<LocalInferenceAdapter>;
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
      preferences,
      rules,
      ...(deps.reviewer ? { reviewer: deps.reviewer } : {}),
      ...(deps.github ? { github: deps.github } : {}),
    });
    deps.say?.(
      r.error
        ? `External review ${card.id}: parked (${r.error})`
        : `External review ${card.id} (PR #${r.pr}): gates ${r.gatesPassed ? "pass" : "fail"}, ${r.findings.length} finding(s)${r.posted ? ", posted" : ""}; evidence ${r.evidencePath}`,
    );
  }
  return ready.filter((c) => !isExternalReview(c));
}

/** The App and repository to post reviews to, when both are configured. */
export function reviewPosterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExternalReviewOptions["github"] | undefined {
  const client = githubAppFromEnv(env);
  const repo = ownerRepo(env.SEKHEMET_GITHUB_REPO);
  return client && repo ? { client, repo } : undefined;
}
