import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CardStore, EventLog, EventRecord } from "@sekhemet/kernel";
import { sliceCards } from "@sekhemet/planner";
import {
  type KeepAChangelogCategory,
  compareVersions,
  gitEnvFor,
  keepAChangelog,
  keepAChangelogSection,
  nextVersion,
  parseVersion,
  releaseBump,
  releaseCommitsAt,
} from "@sekhemet/sync";
import { integrationBranch } from "./accept.js";
import { contextForCard } from "./card_root.js";
import { effectiveConfig } from "./config_apply.js";
import { plainTitle } from "./pm/standup.js";
import {
  PUSH_SETTING,
  type PushResult,
  failedPushes,
  pushSettingOn,
  pushToRemote,
} from "./remote_push.js";

/**
 * Maintenance releases and the open *Next release* (planner-pm §2.15 item
 * 8a, NEW-planner-pm-12; DEC-53 c8; FINDINGS_C1 PRC-07). A product lives on
 * after its last slice: every issue accepted on this server since the
 * project's last tag that traces to no requirement of an open release (a
 * slice no person has accepted yet) collects in Next release, shown on
 * Status. *Propose release* computes the version from those issues' own
 * squashes (review-git §2.6 item 7; fix-only work is a patch), the changelog
 * in Keep a Changelog's categories and the notes from the issues' titles,
 * and records `release/proposed` with no slice and the issues it holds. Only
 * a person's Tag writes the tag — on the integration branch, at the sha the
 * proposal was computed at — records `release/tagged`, pushes it when the
 * project's push setting is on (review-git §2.6 item 8), and so opens a new,
 * empty Next release. v1 has no maintenance branches.
 */

export interface NextReleaseContext {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
}

export interface NextReleaseIssue {
  id: string;
  title: string;
  /** The squash's Keep a Changelog category; housekeeping is *Changed* in the notes. */
  category: KeepAChangelogCategory;
  sha: string;
  acceptedAt: string;
}

export interface NextRelease {
  project: string;
  /** The project's last tag Sekhemet wrote, or none. */
  lastTag: { tag: string; sha: string; at: string } | null;
  issues: NextReleaseIssue[];
  /** The release a person proposed and no one has tagged yet. */
  proposed: {
    version: string;
    tag: string;
    issues: string[];
    notes: string;
    changelog: string;
    sha: string;
    at: string;
  } | null;
  /** Push to remote after Accept and on release: on or off, the remote, and failed pushes. */
  push: { on: boolean; remote: string; failed: (PushResult & { at: string })[] };
}

/** A refused propose or tag: nothing was recorded. */
export class ReleaseRefusal extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export const NOTHING_TO_RELEASE =
  "Nothing was accepted since the last tag, so there is no release to propose.";

/** The project's own repository (runtime item 2a, DEC-57): its root, else the server's. */
function repoOf(ctx: NextReleaseContext, project: string): string {
  return contextForCard(
    { repoPath: ctx.repoPath, cardStore: ctx.cardStore },
    { projectId: project },
  ).repoPath;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: gitEnvFor(repo),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function isAncestor(repo: string, sha: string, of: string): boolean | undefined {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, of], {
      cwd: repo,
      env: gitEnvFor(repo),
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    // Exit 1 is "not an ancestor"; anything else (an unknown sha) is undecided.
    return (err as { status?: number }).status === 1 ? false : undefined;
  }
}

const releaseEvents = async (ctx: NextReleaseContext, project: string) =>
  (await ctx.log.getEventsByTypes(["release/proposed", "release/tagged"])).filter(
    (e) => (e.payload as { projectId?: string }).projectId === project,
  );

/** The latest maintenance proposal no `release/tagged` has followed, or undefined. */
function pendingProposal(events: readonly EventRecord[]): EventRecord | undefined {
  let pending: EventRecord | undefined;
  for (const e of events) {
    const slice = (e.payload as { sliceId?: string }).sliceId;
    if (e.type === "release/proposed" && slice === undefined) pending = e;
    else if (e.type === "release/tagged" && slice === undefined) pending = undefined;
  }
  return pending;
}

/** Each issue's category in Keep a Changelog's terms; housekeeping reads as *Changed*. */
function categoryOf(commit: Parameters<typeof keepAChangelog>[0][number]): KeepAChangelogCategory {
  const groups = keepAChangelog([commit]);
  return (Object.keys(groups)[0] as KeepAChangelogCategory | undefined) ?? "Changed";
}

/** The issues of the open Next release (PM-N12-1), oldest accept first. */
async function openIssues(
  ctx: NextReleaseContext,
  project: string,
  repo: string,
  lastTag: { sha: string; seq: number } | undefined,
): Promise<NextReleaseIssue[]> {
  // An issue that traces to a requirement of an open release belongs to that release.
  const inOpenSlice = new Set<string>();
  const ledger = { store: ctx.cardStore, log: ctx.log };
  for (const s of await ctx.cardStore.slices.list(project)) {
    if (s.accepted) continue;
    for (const c of await sliceCards(ledger, s.id)) inOpenSlice.add(c.id);
  }
  const accepted = new Map<string, EventRecord>();
  for (const e of await ctx.log.getEventsByTypes(["card/accepted"])) {
    const p = e.payload as { id?: string; sha?: string };
    if (p.id && p.sha) accepted.set(p.id, e);
  }
  const out: NextReleaseIssue[] = [];
  for (const [id, e] of accepted) {
    const card = await ctx.cardStore.getCard(id);
    if (!card || card.projectId !== project || card.status !== "done" || inOpenSlice.has(id)) {
      continue;
    }
    const sha = String((e.payload as { sha: string }).sha);
    if (lastTag) {
      const before = isAncestor(repo, sha, lastTag.sha);
      if (before ?? e.seq < lastTag.seq) continue;
    }
    let commit: ReturnType<typeof releaseCommitsAt>[number] | undefined;
    try {
      [commit] = releaseCommitsAt(repo, [sha]);
    } catch {
      continue;
    }
    if (!commit) continue;
    out.push({
      id,
      title: plainTitle(card),
      category: categoryOf(commit),
      sha,
      acceptedAt: e.createdAt,
    });
  }
  return out.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
}

/** Next release as Status shows it (PM-N12-1). */
export async function nextRelease(ctx: NextReleaseContext, project: string): Promise<NextRelease> {
  const repo = repoOf(ctx, project);
  const events = await releaseEvents(ctx, project);
  const tagged = events.filter((e) => e.type === "release/tagged").at(-1);
  const lastTag = tagged
    ? {
        tag: String((tagged.payload as { tag: string }).tag),
        sha: String((tagged.payload as { sha: string }).sha),
        at: tagged.createdAt,
      }
    : null;
  const pending = pendingProposal(events);
  const proposed = pending
    ? (() => {
        const p = pending.payload as { version: string; issues?: string[]; sha?: string };
        const priv = (pending.private ?? {}) as { notes?: unknown; changelog?: unknown };
        return {
          version: p.version,
          tag: `v${p.version}`,
          issues: p.issues ?? [],
          notes: typeof priv.notes === "string" ? priv.notes : "",
          changelog: keepAChangelogSection(
            p.version,
            pending.createdAt.slice(0, 10),
            (priv.changelog ?? {}) as Partial<Record<KeepAChangelogCategory, string[]>>,
          ),
          sha: p.sha ?? "",
          at: pending.createdAt,
        };
      })()
    : null;
  const issues = await openIssues(
    ctx,
    project,
    repo,
    tagged ? { sha: lastTag?.sha as string, seq: tagged.seq } : undefined,
  );
  return {
    project,
    lastTag,
    issues,
    proposed,
    push: {
      on: await pushSettingOn(ctx.cardStore, project),
      remote: effectiveConfig(repo).config.review.remote || "origin",
      failed: await failedPushes(ctx.cardStore, project),
    },
  };
}

/** The version a set of releases and tags was last at, without the `v`. */
function latestVersion(versions: readonly string[]): string | undefined {
  return [...versions]
    .filter((v) => parseVersion(v))
    .sort(compareVersions)
    .at(-1);
}

/** The notes from the issues' titles, grouped by category (PM-N12-2). */
export function maintenanceNotes(
  issues: readonly Pick<NextReleaseIssue, "title" | "category">[],
): string {
  const order: KeepAChangelogCategory[] = [
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
  ];
  return order
    .map((cat) => {
      const titles = issues.filter((i) => i.category === cat).map((i) => `- ${i.title}`);
      return titles.length ? `${cat}\n${titles.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Propose the Next release (PM-N12-2): refused, recording nothing, when it
 * holds no issue (PM-N12-4). Writes no tag.
 */
export async function proposeNextRelease(
  ctx: NextReleaseContext,
  project: string,
  principal: string,
): Promise<NonNullable<NextRelease["proposed"]>> {
  const repo = repoOf(ctx, project);
  const open = await nextRelease(ctx, project);
  if (open.issues.length === 0) throw new ReleaseRefusal(NOTHING_TO_RELEASE);
  const commits = releaseCommitsAt(
    repo,
    open.issues.map((i) => i.sha),
  );
  const bump = releaseBump(commits);
  const branch = integrationBranch(repo);
  const head = git(repo, ["rev-parse", `refs/heads/${branch}^{commit}`]);
  let described: string | undefined;
  try {
    described = git(repo, ["describe", "--tags", "--abbrev=0", head]);
  } catch {
    described = undefined;
  }
  // Never below a version this project already proposed or tagged.
  const events = await releaseEvents(ctx, project);
  const known = [
    ...(described ? [described] : []),
    ...events.map((e) =>
      e.type === "release/tagged"
        ? String((e.payload as { tag: string }).tag)
        : String((e.payload as { version: string }).version),
    ),
  ];
  const previous = latestVersion(known);
  const version = nextVersion(previous, bump === "none" ? "patch" : bump).replace(/^v/, "");
  const categories = keepAChangelog(commits);
  const notes = maintenanceNotes(open.issues);
  await ctx.log.append({
    actor: "human",
    type: "release/proposed",
    principal,
    payload: {
      projectId: project,
      version,
      requirementIds: [],
      issues: open.issues.map((i) => i.id),
      sha: head,
    },
    private: { changelog: categories, notes },
  });
  const proposed = (await nextRelease(ctx, project)).proposed;
  if (!proposed) throw new Error("The proposal was not recorded");
  return proposed;
}

/**
 * Tag the proposed maintenance release on a person's confirmation (PM-N12-3):
 * its CHANGELOG.md section and `docs/product/releases/<version>.md` are
 * committed first (PM-N12-2, as DS-N3-8 does for a slice's release) — on the
 * proposed sha, whose documents commit the tag then names, or, when the
 * integration branch moved since the proposal, onto its head after the tag
 * names the proposed sha; `release/tagged` with the person as principal,
 * the tagged commit and the proposed sha; then the tag pushed when the
 * project's setting is on.
 */
export async function tagNextRelease(
  ctx: NextReleaseContext,
  project: string,
  principal: string,
): Promise<{ tag: string; sha: string; push?: PushResult[]; notice: string }> {
  const repo = repoOf(ctx, project);
  const pending = (await nextRelease(ctx, project)).proposed;
  if (!pending?.sha) {
    throw new ReleaseRefusal("No release is proposed: propose the Next release first.");
  }
  const tag = pending.tag;
  try {
    git(repo, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    throw new ReleaseRefusal(`${tag} was not tagged: the tag already exists`);
  } catch (err) {
    if (err instanceof ReleaseRefusal) throw err;
  }
  // PM-N12-2, DS-N3-8: the changelog section and the release notes.
  const proposal = pendingProposal(await releaseEvents(ctx, project));
  const categories = ((proposal?.private ?? {}) as { changelog?: unknown }).changelog ?? {};
  const head = git(repo, ["rev-parse", `refs/heads/${integrationBranch(repo)}^{commit}`]);
  const onProposed = head === pending.sha;
  const notices: string[] = [];
  let tagged = pending.sha;
  let committed: string | undefined;
  try {
    const { exportProjectDocuments } = await import("./project_docs.js");
    const docs = await exportProjectDocuments(
      { repoPath: repo, cardStore: ctx.cardStore, log: ctx.log, projectId: project },
      {
        principal,
        card: tag,
        maintenance: {
          version: pending.version,
          changelog: categories as Partial<Record<KeepAChangelogCategory, string[]>>,
          notes: pending.notes,
          issues: pending.issues,
        },
        ...(onProposed ? { expectedHead: pending.sha } : {}),
      },
    );
    committed = docs.sha;
    if (docs.sha && onProposed) {
      const { documentsOnlyCommit } = await import("./project_done.js");
      const recorded =
        ctx.cardStore.documents
          .exports(project)
          .at(-1)
          ?.files.map((f) => f.path) ?? [];
      const check = documentsOnlyCommit(repo, pending.sha, docs.sha, recorded);
      if (check.ok) tagged = docs.sha;
      else
        notices.push(
          `The documents commit ${docs.sha.slice(0, 7)} changed more than the exported documents, so ${tag} names the proposed ${pending.sha.slice(0, 7)} instead.`,
        );
    } else if (docs.sha) {
      notices.push(
        `Main moved since ${tag} was proposed: the tag names the proposed ${pending.sha.slice(0, 7)}, and its changelog section and notes were committed onto main.`,
      );
    }
  } catch (err) {
    notices.push(
      `${tag}'s changelog section and notes were not committed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    execFileSync("git", ["tag", "-a", tag, "-m", `Release ${tag}`, tagged], {
      cwd: repo,
      env: gitEnvFor(repo),
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    throw new ReleaseRefusal(
      `${tag} was not tagged: ${String((err as { stderr?: unknown }).stderr ?? err).trim() || "git refused it"}`,
    );
  }
  await ctx.log.append({
    actor: "human",
    type: "release/tagged",
    principal,
    payload: { projectId: project, tag, sha: tagged, proven: pending.sha },
  });
  // The documents commit moved the integration branch: it goes to the remote
  // with the tag, as an Accept's does (review-git §2.6 item 8).
  const branchPush = committed
    ? await pushToRemote(
        { repoPath: repo, cardStore: ctx.cardStore },
        {
          project,
          ref: `refs/heads/${integrationBranch(repo)}`,
          sha: committed,
          principal,
        },
      )
    : undefined;
  const tagPush = await pushToRemote(
    { repoPath: repo, cardStore: ctx.cardStore },
    { project, ref: `refs/tags/${tag}`, sha: tagged, principal },
  );
  const push = branchPush || tagPush ? [...(branchPush ?? []), ...(tagPush ?? [])] : undefined;
  return {
    tag,
    sha: tagged,
    ...(push ? { push } : {}),
    notice: [...notices, pushNotice(tag, push)].join("\n"),
  };
}

/** What a tag's push did, said with the release (review-git §2.6 item 8). */
export function pushNotice(tag: string, push: readonly PushResult[] | undefined): string {
  if (!push) {
    return `${tag} stays in this server's repository: ${PUSH_SETTING} is off for this project.`;
  }
  const own = push.find((r) => r.ref === `refs/tags/${tag}`);
  if (!own) return `${tag} was not pushed.`;
  return own.result === "pushed"
    ? `${tag} was pushed to ${own.remote}.`
    : `${tag} was not pushed to ${own.remote}: ${own.reason ?? "the remote refused it"}`;
}

// --- REST (PM_CONTRACT §3, "Story map and releases") ------------------------------------

export interface NextReleaseRouteContext extends NextReleaseContext {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  /** The person, by principal; refusals by level are the access table's. */
  principalOf: (req: IncomingMessage) => string;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  /** PM-N9-8: a project the person cannot see reads as no project. */
  canSee?: (req: IncomingMessage, project: string) => boolean;
}

/**
 * `GET /api/projects/:id/releases/next`, `POST …/releases/next/propose` and
 * `POST …/releases/next/tag` (the project's Accept rule, like a slice's
 * acceptance; teams item 6). True when the route was this module's.
 */
export async function handleNextReleaseRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: NextReleaseRouteContext,
): Promise<boolean> {
  const m = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/releases\/next(?:\/(propose|tag))?$/.exec(
    url,
  );
  if (!m) return false;
  const project = m[1] as string;
  if (!ctx.cardStore.getProject(project) || ctx.canSee?.(req, project) === false) {
    ctx.json(res, 404, { error: `No project ${project}` });
    return true;
  }
  const verb = m[2];
  if (!verb) {
    if (req.method !== "GET") return false;
    ctx.json(res, 200, { next: await nextRelease(ctx, project) });
    return true;
  }
  if (req.method !== "POST") return false;
  if (!ctx.isTrustedMutation(req)) {
    ctx.json(res, 403, { error: "A release is proposed and tagged from the dashboard itself." });
    return true;
  }
  try {
    if (verb === "propose") {
      const proposed = await proposeNextRelease(ctx, project, ctx.principalOf(req));
      ctx.json(res, 200, { proposed });
    } else {
      ctx.json(res, 200, await tagNextRelease(ctx, project, ctx.principalOf(req)));
    }
  } catch (err) {
    if (err instanceof ReleaseRefusal) ctx.json(res, err.status, { error: err.message });
    else
      ctx.json(res, 500, {
        error: `Nothing was recorded: ${err instanceof Error ? err.message : String(err)}`,
      });
  }
  return true;
}
