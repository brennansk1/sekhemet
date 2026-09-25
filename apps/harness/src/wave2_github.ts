import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { DecisionStore } from "@sekhemet/planner";
import {
  type ExternalItem,
  ForgejoIssuesAdapter,
  type GitHubClient,
  GitHubIssuesAdapter,
  PullRequestLifecycle,
  type PullRequestRef,
  type SyncAdapter,
  mergeLastWriterWins,
  postCheckRun,
  reconcileExternalEdit,
  staticToken,
  uploadSarif,
} from "@sekhemet/sync";

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

export function ownerRepo(spec: string | undefined): { owner: string; repo: string } | undefined {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(spec ?? "");
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined;
}

interface Evidence {
  passed?: boolean;
  rungResults?: { gate: string; passed: boolean; durationMs?: number }[];
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

/** The evidence summary a draft PR carries (design "Pull request lifecycle"). */
export function prBody(card: CardRecord, ev: Evidence | undefined): string {
  const gates = (ev?.rungResults ?? [])
    .map(
      (r) =>
        `- ${r.passed ? "pass" : "FAIL"} ${r.gate}${r.durationMs ? ` (${r.durationMs} ms)` : ""}`,
    )
    .join("\n");
  const files = [...new Set((ev?.diff ?? "").match(/^\+\+\+ b\/(.+)$/gm) ?? [])].map((l) =>
    l.slice(6),
  );
  return [
    card.spec ?? "",
    card.acceptanceCriteria?.length
      ? `### Done when\n${card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    `### Gates\n${gates || "_No evidence file was found for this card._"}`,
    files.length ? `### Files\n${files.map((f) => `- ${f}`).join("\n")}` : "",
    `_Implemented by the Sekhemet Worker. Card \`${card.id}\`._`,
  ]
    .filter(Boolean)
    .join("\n\n");
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
): Promise<PullRequestRef> {
  const ev = readEvidence(repoPath, card.id);
  const life = new PullRequestLifecycle(client, repo);
  const pr = await life.openDraft({
    head: branch,
    base: "main",
    title: card.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, ""),
    body: prBody(card, ev),
  });
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
export async function advancePullRequests(
  client: GitHubClient,
  repoPath: string,
  log: EventLog,
  options: { autoMerge: boolean },
): Promise<{ number: number; state: string }[]> {
  const codeownersPath = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
    .map((p) => join(repoPath, p))
    .find((p) => existsSync(p));
  const codeowners = codeownersPath ? readFileSync(codeownersPath, "utf8") : undefined;
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
  const out: { number: number; state: string }[] = [];
  for (const e of opened.filter((x) => x.type === PR_EVENT)) {
    const p = e.payload as PullRequestRef & { repo: { owner: string; repo: string } };
    if (done.has(p.number)) continue;
    const ev = readEvidence(repoPath, e.cardId ?? "");
    const files = [...new Set((ev?.diff ?? "").match(/^\+\+\+ b\/(.+)$/gm) ?? [])].map((l) =>
      l.slice(6),
    );
    const state = await new PullRequestLifecycle(client, p.repo).advance(p, {
      autoMerge: options.autoMerge,
      ...(codeowners ? { codeowners } : {}),
      changedFiles: files,
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

/** A tracker adapter from the environment: the GitHub App or Forgejo (Y10, Y11). */
export function trackerFromEnv(
  client: GitHubClient | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SyncAdapter | undefined {
  const gh = ownerRepo(env.SEKHEMET_GITHUB_REPO);
  if (client && gh) return new GitHubIssuesAdapter(gh, staticToken(""), undefined, client);
  const fj = ownerRepo(env.SEKHEMET_FORGEJO_REPO);
  if (env.SEKHEMET_FORGEJO_URL && env.SEKHEMET_FORGEJO_TOKEN && fj) {
    return new ForgejoIssuesAdapter(env.SEKHEMET_FORGEJO_URL, fj, env.SEKHEMET_FORGEJO_TOKEN);
  }
  return undefined;
}

/**
 * Two-way sync through a tracker adapter (Y10, Y11, Y20). Pull: new items
 * become Backlog cards; linked cards merge shared fields last-writer-wins
 * with the losing value kept on the ledger; an issue whose scope changed
 * while its card runs pauses the card behind a decision request. Push:
 * unlinked cards open issues; done cards close theirs.
 */
export async function syncViaAdapter(
  adapter: SyncAdapter,
  cardStore: CardStore,
  log: EventLog,
  since: string,
): Promise<{ created: number; updated: number; paused: number; pushed: number; errors: string[] }> {
  const out = { created: 0, updated: 0, paused: 0, pushed: 0, errors: [] as string[] };
  // The ledger's actor for this tracker ("github", or "sync" for Forgejo).
  const actor = adapter.system === "github" ? "github" : "sync";
  const snapshots = new Map<string, ExternalItem>();
  for (const e of await log.getEventsByTypes(["sync/snapshot"])) {
    const item = (e.payload as { item: ExternalItem }).item;
    snapshots.set(`${item.ref.system}:${item.ref.id}`, item);
  }
  let items: ExternalItem[] = [];
  try {
    items = await adapter.pull(since);
  } catch (err) {
    out.errors.push(`pull: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cards = await cardStore.listCards();
  for (const item of items) {
    const key = `${item.ref.system}:${item.ref.id}`;
    const card = cards.find(
      (c) => c.externalRef?.system === item.ref.system && c.externalRef.id === item.ref.id,
    );
    if (!card) {
      if (item.state === "closed") continue;
      await cardStore.createCard(
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
      out.created++;
    } else {
      const before = snapshots.get(key);
      const rec = before ? reconcileExternalEdit(card, before, item) : { action: "none" as const };
      if (rec.action === "pause_and_ask") {
        await new DecisionStore({ store: cardStore, log }).request({
          id: `sync_${key}_${item.updatedAt}`,
          cardId: card.id,
          question: rec.question,
          options: [
            {
              label: "Continue with the old version",
              consequence: "the running work stands",
              effortDelta: "0",
              riskNote: "May not match the issue now.",
            },
            {
              label: "Restart with the new version",
              consequence: "the card re-plans from the issue",
              effortDelta: "a new attempt",
              riskNote: "Discards the running attempt.",
            },
          ],
          previewSketches: [],
          recommendation: {
            optionIndex: 1,
            rationale: "The issue is the source of truth for scope.",
          },
          policy: "default_deny",
          defaultIfNoAnswer: { deadline: new Date(Date.now() + 12 * 3_600_000).toISOString() },
          category: "scope_boundary",
          createdAt: new Date().toISOString(),
        });
        out.paused++;
      } else if (rec.action !== "none" || !before) {
        const merged = mergeLastWriterWins(
          {
            id: card.id,
            title: card.title,
            ...(card.spec ? { spec: card.spec } : {}),
            labels: card.labels ?? [],
            status: card.status,
            updatedAt: card.updatedAt,
          },
          item,
        );
        if (
          merged.history.some((h) => h.winner === "tracker") &&
          !["in_progress", "verify"].includes(card.status)
        ) {
          await cardStore.updateCard(
            card.id,
            {
              title: merged.card.title,
              ...(merged.card.spec ? { spec: merged.card.spec } : {}),
              labels: merged.card.labels ?? [],
            },
            actor,
          );
          out.updated++;
        }
        if (merged.history.length) {
          await cardStore.recordEvent({
            type: "sync/conflict",
            cardId: card.id,
            actor,
            payload: merged.history,
          });
        }
      }
    }
    await log.append({ actor, type: "sync/snapshot", payload: { item } });
  }
  for (const card of await cardStore.listCards()) {
    if (card.tier === "epic") continue;
    try {
      if (!card.externalRef && card.status !== "done" && card.status !== "rejected") {
        const ref = await adapter.push({
          id: card.id,
          title: card.title,
          ...(card.spec ? { spec: card.spec } : {}),
          status: card.status,
          updatedAt: card.updatedAt,
        });
        await cardStore.updateCard(card.id, { externalRef: ref }, actor);
        out.pushed++;
      } else if (card.externalRef?.system === adapter.system && card.status === "done") {
        const remote = items.find((i) => i.ref.id === card.externalRef?.id);
        if (remote && remote.state !== "closed") {
          await adapter.update(card.externalRef, { status: "done" });
          out.pushed++;
        }
      }
    } catch (err) {
      out.errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
