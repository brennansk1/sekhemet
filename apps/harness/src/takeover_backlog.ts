import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import { redactSecrets } from "@sekhemet/gates";
import type {
  CardRecord,
  CardStore,
  EventLog,
  ExternalRef,
  FoundClaim,
  IssueEvidence,
  IssueVerdictInput,
  ProposedTakeoverCard,
  ReconciledIssue,
} from "@sekhemet/kernel";
import { DESIGN_COPY } from "@sekhemet/planner";
import { type ExternalItem, type SyncAdapter, openIssues } from "@sekhemet/sync";
import { type CardDraft, type PipelineDeps, createThroughPipeline } from "./pm/pipeline.js";
import type { TakeoverFinding, TakeoverRun } from "./takeover.js";
import {
  type BaselineView,
  baselineAt,
  declaredTests,
  fileAt,
  findingSubject,
  isTestFile,
  stems,
  writeBriefAsFound,
} from "./takeover_brief.js";
import { reconGit } from "./takeover_recon.js";

/**
 * Take over a project, B4.4's half after the inventory (design-stage §2.10
 * steps 4–6; DS-TO-11 to DS-TO-14; integrations INT-42 to INT-44), without a
 * model, each step a kernel record (`TakeoverLedger`,
 * `IssueReconciliationLedger`):
 *
 * - **the brief as found** (`takeover_brief.ts`, DS-TO-9);
 * - **the inherited issues** of the connected tracker, read through its one
 *   adapter and each proposed as done (a commit closes it), duplicate (an
 *   earlier open issue has its title), stale (every file it names was
 *   deleted) or valid, with its evidence — changed on the tracker only when a
 *   person applies the proposal (`applyIssueReconciliation`);
 * - **one batch of questions**: for each file with unfinished work, finish it
 *   now or leave it for later — at most five, the files with the most
 *   unfinished pieces first, each a pending decision whose default (finish
 *   now) cites the finding;
 * - **the evidenced backlog**: stabilise first (a fix card for each *could
 *   not build*, for failing tests, for a focused test; a person's task to
 *   rotate each committed secret), then finish (each unfinished file, after a
 *   `characterize` card when no test reaches it; each valid issue not on a
 *   card), then defer (what the person left for later);
 * - **the person's approval** (`approveTakeoverPlan`), which applies the
 *   open defaults, seeds the requirement graph and creates the cards.
 */

/** The tracker a take-over reads, and a person's applied reconciliation writes through. */
export type IssueTracker = Pick<SyncAdapter, "system" | "pull"> &
  Partial<Pick<SyncAdapter, "update" | "comment">>;

/** Finding kinds that are unfinished work to finish or defer. */
const FINISHABLE = new Set([
  "stub",
  "no_handler",
  "missing_import",
  "no_migration",
  "skipped_test",
  "todo_test",
]);

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|cs|php)$/;
const FORBIDDEN = /requirements|phase|let me gather/i;
const MAX_QUESTIONS = 5;

type InventoryFinding = Pick<TakeoverFinding, "id" | "kind" | "path" | "line" | "commit">;

/** One take-over question: finish a file's unfinished work now, or leave it for later. */
export interface TakeoverQuestion {
  path: string;
  findingIds: string[];
  question: string;
  context: string;
  options: [string, string];
  /** The finding the default (finish it now) cites. */
  defaultCites: string;
}

/**
 * The questions of the batch (DS-TO-11), ranked by how much of the plan each
 * answer moves: one per file with unfinished work, the files with the most
 * pieces first, at most five. Each answer moves that file's cards between
 * finish and defer, so no two answers give the same plan. Deterministic in
 * the inventory, so the approval maps each answer back to its file.
 */
export function planQuestions(findings: readonly InventoryFinding[]): TakeoverQuestion[] {
  const byPath = new Map<string, InventoryFinding[]>();
  for (const f of findings) {
    if (!FINISHABLE.has(f.kind) || !f.path || FORBIDDEN.test(f.path)) continue;
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  }
  return [...byPath]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUESTIONS)
    .map(([path, fs]) => ({
      path,
      findingIds: fs.map((f) => f.id),
      question: `Finish ${path} now, or leave it for later?`,
      context: `${fs.length} unfinished piece${fs.length === 1 ? "" : "s"} found there (${fs
        .map((f) => `${f.id}${f.line ? ` at line ${f.line}` : ""}`)
        .join(", ")}). If you do not answer, the plan finishes it now.`,
      options: ["Finish it now", "Leave it for later"],
      defaultCites: fs[0]?.id as string,
    }));
}

/** The finding ids the person chose to leave for later, from the batch posted for the inventory. */
async function deferredFindings(store: CardStore): Promise<Set<string>> {
  const inv = store.takeover.inventory();
  const out = new Set<string>();
  if (!inv) return out;
  const batch = (await store.eventsOfType(["takeover/questions_posted"])).find(
    (e) => (e.payload as { inventorySeq?: number }).inventorySeq === inv.seq,
  );
  const posted = (batch?.payload as { questions?: { decisionId: string; rank: number }[] })
    ?.questions;
  const questions = planQuestions(inv.findings);
  for (const q of posted ?? []) {
    const d = store.runs.getDecision(q.decisionId);
    const asked = questions[q.rank - 1];
    if (asked && d?.status === "answered" && d.selectedOptionIndex === 1) {
      for (const id of asked.findingIds) out.add(id);
    }
  }
  return out;
}

/**
 * Post the batch (DS-TO-11): each question a pending decision request under
 * `safe_default`, then the batch record. A batch of an earlier inventory
 * still pending is expired: that inventory is superseded.
 */
async function postQuestions(store: CardStore, questions: TakeoverQuestion[]): Promise<string[]> {
  const inv = store.takeover.inventory();
  for (const e of await store.eventsOfType(["takeover/questions_posted"])) {
    const p = e.payload as { inventorySeq: number; questions: { decisionId: string }[] };
    if (p.inventorySeq === inv?.seq) continue;
    for (const q of p.questions) {
      if (store.runs.getDecision(q.decisionId)?.status === "pending") {
        await store.runs.expireDecision(q.decisionId);
      }
    }
  }
  if (questions.length === 0) return [];
  const ids: string[] = [];
  for (const q of questions) {
    const d = await store.runs.requestDecision({
      kind: "takeover_scope",
      question: q.question,
      context: q.context,
      options: q.options,
      recommendationIndex: 0,
    });
    ids.push(d.id);
  }
  await store.takeover.postQuestions({
    questions: questions.map((q, i) => ({
      decisionId: ids[i] as string,
      defaultCites: q.defaultCites,
    })),
  });
  return ids;
}

/** Whether no test file reaches a source file: none imports its module by path. */
function untested(root: string, path: string, testFiles: readonly string[]): boolean {
  if (!CODE_EXT.test(path) || isTestFile(path)) return false;
  const stem = basename(path, extname(path)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const js = new RegExp(`["'\`][^"'\`]*/${stem}(\\.[cm]?[jt]sx?)?["'\`]`);
  const py = new RegExp(`\\b(from|import)\\s+[\\w.]*\\b${stem}\\b`);
  for (const t of testFiles) {
    let text = "";
    try {
      text = readFileSync(join(root, t), "utf8");
    } catch {
      continue;
    }
    if (js.test(text) || py.test(text)) return false;
  }
  return true;
}

const BUCKET_RANK = { stabilise: 0, finish: 1, defer: 2 } as const;

/** Stabilise, then finish, then defer, each keeping its order (a characterize card before its card). */
function ordered(cards: ProposedTakeoverCard[]): ProposedTakeoverCard[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => BUCKET_RANK[a.c.bucket] - BUCKET_RANK[b.c.bucket] || a.i - b.i)
    .map((x) => x.c);
}

/** What the backlog is built from. */
export interface BacklogInput {
  root: string;
  findings: readonly TakeoverFinding[];
  baseline: BaselineView | undefined;
  files: readonly string[];
  deferred: ReadonlySet<string>;
  /** Valid issues proposed as new cards, with their tracker items. */
  issues: readonly { reconciled: ReconciledIssue; item?: ExternalItem }[];
}

/** The evidenced backlog (DS-TO-12), in the order its cards should run. */
export function buildBacklog(input: BacklogInput): ProposedTakeoverCard[] {
  const cards: ProposedTakeoverCard[] = [];
  const ref = () => `c${cards.length + 1}`;
  const at = (f: InventoryFinding) => (f.path && f.line ? [`${f.path}:${f.line}`] : []);
  // Stabilise: a build that fails is fixed first, its red check the build failing on the base.
  for (const f of input.findings.filter((x) => x.kind === "could_not_build")) {
    cards.push({
      ref: ref(),
      bucket: "stabilise",
      title: `Make ${f.command ? `\`${f.command}\`` : "the build"} pass`,
      links: [f.id],
      change: "fix",
      assignee: "worker",
      forFinding: f.id,
      redCheck: "build_fails_on_base",
    });
  }
  // Failing tests the baseline names, by file.
  const failing = (input.baseline?.entries ?? []).filter((e) => e.rung === "test");
  for (const file of [...new Set(failing.map((e) => e.file))].sort()) {
    cards.push({
      ref: ref(),
      bucket: "stabilise",
      title: `Make the failing tests in ${file} pass`,
      links: failing.filter((e) => e.file === file).map((e) => `${e.file} > ${e.rule}`),
      change: "fix",
      assignee: "worker",
    });
  }
  // A suite that failed without naming a test.
  const unnamed = (input.baseline?.runs ?? []).some(
    (r) => r.rung === "test" && !r.unavailable && r.exitCode !== 0 && r.failing.length === 0,
  );
  const testFiles = input.files.filter(isTestFile);
  if (unnamed && testFiles.length > 0) {
    cards.push({
      ref: ref(),
      bucket: "stabilise",
      title: "Find and fix what makes the test suite fail",
      links: testFiles.map((t) => `${t}:1`),
      change: "fix",
      assignee: "worker",
    });
  }
  for (const f of input.findings.filter((x) => x.kind === "focused_test")) {
    cards.push({
      ref: ref(),
      bucket: "stabilise",
      title: `Remove the focused test in ${f.path ?? "the suite"} so every test runs`,
      links: [f.id, ...at(f)],
      change: "fix",
      assignee: "worker",
    });
  }
  // Each committed secret: a person rotates it, never the Worker.
  const secrets = new Set<string>();
  for (const f of input.findings.filter((x) => x.kind === "secret" && x.commit && x.path)) {
    const key = `${f.commit}\0${f.path}`;
    if (secrets.has(key)) continue;
    secrets.add(key);
    cards.push({
      ref: ref(),
      bucket: "stabilise",
      title: `Rotate the credential committed in ${f.path} (${(f.commit as string).slice(0, 12)})`,
      links: [f.id, f.commit as string],
      assignee: "person",
      secret: { commit: f.commit as string, path: f.path as string },
    });
  }
  // Finish (or defer) each file's unfinished work, characterized first when no test reaches it.
  const byPath = new Map<string, TakeoverFinding[]>();
  for (const f of input.findings.filter((x) => FINISHABLE.has(x.kind) && x.path)) {
    byPath.set(f.path as string, [...(byPath.get(f.path as string) ?? []), f]);
  }
  for (const [path, fs] of byPath) {
    const bucket = fs.some((f) => input.deferred.has(f.id)) ? "defer" : "finish";
    const needsCharacterize = untested(input.root, path, testFiles);
    const own = `c${cards.length + (needsCharacterize ? 2 : 1)}`;
    if (needsCharacterize) {
      cards.push({
        ref: ref(),
        bucket,
        title: `Pin down with tests what ${path} does today`,
        links: [`${path}:1`],
        change: "characterize",
        assignee: "worker",
        characterizes: [own],
      });
    }
    cards.push({
      ref: ref(),
      bucket,
      title: `Finish ${path}`,
      links: [...fs.map((f) => f.id), ...fs.flatMap(at)],
      change: "feature",
      assignee: "worker",
      ...(needsCharacterize ? { needsCharacterize: true } : {}),
    });
  }
  // Each valid inherited issue no card carries yet (INT-42).
  for (const { reconciled, item } of input.issues) {
    if (reconciled.verdict !== "valid" || !reconciled.newCard) continue;
    cards.push({
      ref: ref(),
      bucket: "finish",
      title: redactSecrets(item?.title ?? `Issue ${reconciled.issue.id}`),
      links: [
        reconciled.issue.id,
        ...(item?.ref.url ? [item.ref.url] : []),
        ...reconciled.evidence.map((e) => e.ref),
      ],
      change: "feature",
      assignee: "worker",
    });
  }
  return ordered(cards);
}

/** The issue number an id ends with: `owner/repo#12` and `12` are 12. */
const issueNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);

const normalTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const PATH_IN_TEXT =
  /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|cs|php|sql|prisma|json|ya?ml|toml|md))\b/g;

/**
 * One verdict per open inherited issue (DS-TO-13, INT-42, INT-44), each with
 * its evidence, read from the repository's own history: *done* only when a
 * commit says it closes the issue (never the issue's own word), *duplicate*
 * when an earlier open issue has the same title, *stale* when every file it
 * names is gone (citing the commit that deleted it), *valid* otherwise
 * (citing the files it names, the unfinished work it is about, or the
 * commit it was checked at).
 */
export function reconcileIssues(
  root: string,
  items: readonly ExternalItem[],
  findings: readonly TakeoverFinding[],
): IssueVerdictInput[] {
  const open = items
    .filter((i) => i.state === "open")
    .sort((a, b) => issueNumber(a.ref.id) - issueNumber(b.ref.id));
  const head = reconGit(root, ["rev-parse", "HEAD"]).trim();
  const commits = reconGit(root, ["log", "--format=%H%x1f%B%x1e"])
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha = "", message = ""] = c.split("\x1f");
      return { sha: sha.trim(), message };
    });
  const unfinished = findings.filter((f) => FINISHABLE.has(f.kind) && f.path);
  const out: IssueVerdictInput[] = [];
  open.forEach((issue, index) => {
    const n = issueNumber(issue.ref.id);
    const key = { system: issue.ref.system, id: issue.ref.id };
    const closing = Number.isFinite(n)
      ? commits.find((c) =>
          new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#${n}\\b`, "i").test(
            c.message,
          ),
        )
      : undefined;
    if (closing) {
      out.push({
        issue: key,
        verdict: "done",
        evidence: [{ kind: "commit", ref: closing.sha }],
        why: "a commit says it closes this issue",
      });
      return;
    }
    const same = open
      .slice(0, index)
      .find((o) => normalTitle(o.title) === normalTitle(issue.title) && normalTitle(issue.title));
    if (same) {
      out.push({
        issue: key,
        verdict: "duplicate",
        evidence: [{ kind: "issue", ref: same.ref.id }],
        why: "an earlier open issue has the same title",
      });
      return;
    }
    const text = `${issue.title}\n${issue.body}`;
    const paths = [...new Set([...text.matchAll(PATH_IN_TEXT)].map((m) => m[1] as string))];
    const present = paths.filter((p) => fileAt(root, p));
    if (paths.length > 0 && present.length === 0) {
      const evidence: IssueEvidence[] = [];
      for (const p of paths) {
        const sha = reconGit(root, [
          "log",
          "--diff-filter=D",
          "-n",
          "1",
          "--format=%H",
          "--",
          p,
        ]).trim();
        evidence.push({ kind: "commit", ref: sha || head });
      }
      out.push({
        issue: key,
        verdict: "stale",
        evidence: evidence.filter((e, i) => evidence.findIndex((x) => x.ref === e.ref) === i),
        why: "every file it names is gone",
      });
      return;
    }
    const words = stems(issue.title);
    const about = unfinished.filter((f) => [...findingSubject(root, f)].some((s) => words.has(s)));
    const evidence: IssueEvidence[] = [
      ...present.map((p) => ({ kind: "file_line" as const, ref: `${p}:1` })),
      ...about.map((f) => ({ kind: "file_line" as const, ref: `${f.path}:${f.line ?? 1}` })),
    ];
    out.push({
      issue: key,
      verdict: "valid",
      evidence: evidence.length > 0 ? evidence : [{ kind: "commit", ref: head }],
      why: "nothing in the history closes it and the code it names is still there",
    });
  });
  return out;
}

/** What steps 4–6 recorded. */
export interface TakeoverPlan {
  claims: FoundClaim[];
  /** The decision requests of the batch, ranked. */
  questions: string[];
  /** The backlog proposal, when there was anything to propose. */
  proposalId?: string;
  reconciliation?: { id: string; issues: ReconciledIssue[] };
}

/** Read the tracker's open issues (DS-TO-13): the items, and what recon says about them. */
export async function readInheritedIssues(
  tracker: IssueTracker | undefined,
  notConnected = "no tracker connected",
): Promise<{ items: ExternalItem[]; note: string }> {
  if (!tracker) return { items: [], note: `not read: ${notConnected}` };
  try {
    const items = await openIssues(tracker);
    return { items, note: `${items.length} open issue(s) read from ${tracker.system}` };
  } catch (err) {
    return {
      items: [],
      note: `not read: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
}

/**
 * Steps 4–6 after a trusted take-over's inventory (DS-TO-9, DS-TO-11 to
 * DS-TO-13): the brief as found, the inherited issues' reconciliation, the
 * batch of questions and the backlog proposal. Creates no card and applies
 * no default: that waits for the person's approval.
 */
export async function planTakeover(
  root: string,
  ctx: {
    store: CardStore;
    findings: readonly TakeoverFinding[];
    runs: readonly TakeoverRun[];
    baselineSeq: number;
    docs: readonly string[];
    files: readonly string[];
    issues: readonly ExternalItem[];
  },
): Promise<TakeoverPlan> {
  const { store } = ctx;
  const claims = await writeBriefAsFound(store, root, ctx);
  let reconciliation: TakeoverPlan["reconciliation"];
  const verdicts = reconcileIssues(root, ctx.issues, ctx.findings);
  if (verdicts.length > 0)
    reconciliation = await store.reconciliation.propose({ issues: verdicts });
  const inv = store.takeover.inventory();
  const questions = await postQuestions(store, planQuestions(inv?.findings ?? []));
  const items = new Map(ctx.issues.map((i) => [i.ref.id, i]));
  const cards = buildBacklog({
    root,
    findings: ctx.findings,
    baseline: await baselineAt(store, ctx.baselineSeq),
    files: ctx.files,
    deferred: await deferredFindings(store),
    issues: (reconciliation?.issues ?? []).map((r) => {
      const item = items.get(r.issue.id);
      return item ? { reconciled: r, item } : { reconciled: r };
    }),
  });
  // Work an earlier approved plan already made cards for is not proposed again.
  const fresh = await withoutPlanned(store, cards);
  const proposalId =
    fresh.length > 0 ? await store.takeover.proposeBacklog({ cards: fresh }) : undefined;
  return {
    claims,
    questions,
    ...(proposalId ? { proposalId } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

/** The proposal's cards with each unfinished file's bucket as the answers now say. */
async function rebucketed(
  store: CardStore,
  cards: readonly ProposedTakeoverCard[],
): Promise<ProposedTakeoverCard[]> {
  const deferred = await deferredFindings(store);
  const governed = new Set(
    planQuestions(store.takeover.inventory()?.findings ?? []).flatMap((q) => q.findingIds),
  );
  const next = cards.map((c) => {
    const ids = c.links.filter((l) => governed.has(l));
    if (ids.length === 0 || c.bucket === "stabilise") return { ...c };
    return {
      ...c,
      bucket: ids.some((id) => deferred.has(id)) ? "defer" : "finish",
    } as ProposedTakeoverCard;
  });
  // A characterize card goes where the card it pins down goes.
  const byRef = new Map(next.map((c) => [c.ref, c]));
  for (const c of next) {
    const target = c.characterizes?.[0] ? byRef.get(c.characterizes[0]) : undefined;
    if (target) c.bucket = target.bucket;
  }
  return ordered(next);
}

const FILE_LINK = /^((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?$/;

/** A finding id is its own inventory's: never evidence across take-overs. */
const FINDING_ID = /^f\d+$/;

/** The label naming the proposal card a created card plans (`TOP-1/c3`). */
const planLabel = (proposalId: string, ref: string) => `${proposalId}/${ref}`;

/**
 * What identifies a proposed card's work across take-overs (B4.4 lead
 * ruling): its bucket and change with each file it cites, else each stable
 * evidence ref (a test, a commit, an issue), else its bucket and title.
 */
export function evidenceKeys(
  c: Pick<ProposedTakeoverCard, "bucket" | "change" | "links" | "title">,
): string[] {
  const keys = new Set<string>();
  for (const l of c.links) {
    if (FINDING_ID.test(l)) continue;
    const path = /^https?:\/\//.test(l) ? undefined : FILE_LINK.exec(l)?.[1];
    keys.add(path ? `${c.bucket}:${c.change ?? ""}:${path}` : `ref:${l}`);
  }
  if (keys.size === 0) keys.add(`${c.bucket}:${c.title}`);
  return [...keys];
}

/** The keys of the work an earlier approved take-over plan already made cards for. */
async function plannedKeys(store: CardStore): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of await store.eventsOfType(["takeover/backlog_proposed"])) {
    const { proposalId, cards } = e.payload as {
      proposalId: string;
      cards: ProposedTakeoverCard[];
    };
    if (!store.takeover.isPlanApproved(proposalId)) continue;
    const proposal = await store.takeover.backlog(proposalId);
    for (const c of proposal?.cards ?? cards ?? []) for (const k of evidenceKeys(c)) out.add(k);
  }
  return out;
}

/** The proposal's cards less those an earlier approved plan already created. */
export async function withoutPlanned(
  store: CardStore,
  cards: readonly ProposedTakeoverCard[],
): Promise<ProposedTakeoverCard[]> {
  const planned = await plannedKeys(store);
  const kept = cards.filter((c) => !evidenceKeys(c).some((k) => planned.has(k)));
  const refs = new Set(kept.map((c) => c.ref));
  // A characterize card goes with the card it pins down.
  return kept.filter((c) => (c.characterizes ?? []).every((r) => refs.has(r)));
}

/** The files a proposed card cites, less tests (its tests are protected). */
function scopeOf(c: ProposedTakeoverCard): string[] {
  return [
    ...new Set(
      c.links
        .filter((l) => !/^https?:\/\//.test(l) && !l.includes(" > "))
        .map((l) => FILE_LINK.exec(l)?.[1])
        .filter((p): p is string => p !== undefined && !isTestFile(p)),
    ),
  ];
}

const T = DESIGN_COPY.takeover;

/**
 * A proposed card as the planning pipeline takes it (PM-P1-1): its evidence
 * — each finding with its kind and place, each cited file, test, commit or
 * issue, and each claim of the brief as found that cites it — is its spec,
 * and its criteria say what that evidence shows done.
 */
function draftOf(
  c: ProposedTakeoverCard,
  ctx: {
    findings: ReadonlyMap<string, InventoryFinding>;
    claims: readonly { id: string; label: string; citations: string[] }[];
    epicId: string;
    projectId?: string | undefined;
  },
): CardDraft {
  const evidence: string[] = [];
  for (const l of c.links) {
    const f = ctx.findings.get(l);
    evidence.push(
      f
        ? T.finding(f.id, f.kind, f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : undefined)
        : T.link(l),
    );
  }
  for (const claim of ctx.claims) {
    if (claim.citations.some((x) => c.links.includes(x)))
      evidence.push(T.claim(claim.id, claim.label));
  }
  const files = c.links.filter((l) => FILE_LINK.test(l)).map((l) => l.replace(/:\d+$/, ""));
  const path = scopeOf(c)[0] ?? files[0];
  const command = /`([^`]+)`/.exec(c.title)?.[1];
  const issue = c.links.find((l) => /#\d+$/.test(l));
  const pieces = c.links.filter((l) => FINDING_ID.test(l)).length || 1;
  let criterion: string;
  if (c.secret) criterion = T.criteria.rotate(c.secret.path, c.secret.commit.slice(0, 12));
  else if (c.redCheck === "build_fails_on_base" || c.forFinding)
    criterion = T.criteria.build(command ?? "the build");
  else if (issue) criterion = T.criteria.issue(issue);
  else if (c.links.some((l) => l.includes(" > ")))
    criterion = T.criteria.failingTests(c.links[0]?.split(" > ")[0] ?? "");
  else if (c.links.some((l) => ctx.findings.get(l)?.kind === "focused_test") && path)
    criterion = T.criteria.focused(path);
  else if (c.bucket === "stabilise" && files.length > 0 && files.every(isTestFile))
    criterion = T.criteria.suite;
  else if (path) criterion = T.criteria.finish(path, pieces);
  else criterion = T.criteria.issue(c.ref);
  return {
    title: c.title,
    spec: [c.title, T.evidence, ...evidence].join("\n"),
    acceptanceCriteria: [criterion],
    epicId: ctx.epicId,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
  };
}

/** What approving a take-over plan needs: the repository, its ledger and its board. */
export interface TakeoverApprovalContext {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
  boardService?: Pick<BoardService, "transitionCard">;
}

/**
 * The person approves the take-over plan (DS-TO-11, DS-TO-14). Refused when
 * an answer given since the proposal changes it: the plan is proposed again
 * and that new proposal is the one to approve. Otherwise the kernel applies
 * each open default and seeds the requirement graph; then — only once the
 * ledger holds the approval — each card is planned through the one planning
 * pipeline (PM-P1-1, the B4.4 lead ruling), its evidence as its spec, so it
 * has criteria with ids and, where the pipeline can stage one, a test; never
 * a title-only card. A characterize card is the pipeline's own, made for an
 * untested scope (PM-N6). Stabilise and finish wait in Planning for the
 * person's approval of their criteria, deferred ones in the Backlog; a
 * person's task is delegated to the approving person; each finish card after
 * the stabilise work and after its characterize card. Approving again creates
 * only what is missing.
 */
export async function approveTakeoverPlan(
  ctx: TakeoverApprovalContext,
  input: { proposalId: string; projectId?: string },
  principal: string,
): Promise<{
  defaultsApplied: string[];
  requirementIds: string[];
  candidateIds: string[];
  cards: CardRecord[];
}> {
  const store = ctx.cardStore;
  const proposal = await store.takeover.backlog(input.proposalId);
  if (!proposal) throw new Error(`No take-over proposal ${input.proposalId}`);
  let seeded = {
    defaultsApplied: [] as string[],
    requirementIds: [] as string[],
    candidateIds: [] as string[],
  };
  let cards = proposal.cards;
  if (!store.takeover.isPlanApproved(input.proposalId)) {
    const now = await rebucketed(store, proposal.cards);
    const same = (a: readonly ProposedTakeoverCard[], b: readonly ProposedTakeoverCard[]) =>
      JSON.stringify(a.map((c) => [c.ref, c.bucket])) ===
      JSON.stringify(b.map((c) => [c.ref, c.bucket]));
    if (!same(now, proposal.cards)) {
      const next = await store.takeover.proposeBacklog({ cards: now });
      throw new Error(
        `Your answers changed the plan since ${input.proposalId}: review ${next} and approve that one`,
      );
    }
    const r = await store.takeover.approvePlan(input, principal);
    seeded = {
      defaultsApplied: r.defaultsApplied,
      requirementIds: r.requirementIds,
      candidateIds: r.candidateIds,
    };
    cards = r.cards;
  }
  // No card exists before a person's approval is on the ledger.
  if (!store.takeover.isPlanApproved(input.proposalId)) {
    throw new Error(`${input.proposalId} is not approved: no card is created`);
  }
  // The inherited issues any reconciliation proposed, for a card's `externalRef`.
  const reconciled = new Map<string, ReconciledIssue["issue"]>();
  for (const e of await store.eventsOfType(["reconcile/proposed"])) {
    for (const i of (e.payload as { issues: ReconciledIssue[] }).issues) {
      reconciled.set(i.issue.id, i.issue);
    }
  }
  const findings = new Map((store.takeover.inventory()?.findings ?? []).map((f) => [f.id, f]));
  const claims = (await store.takeover.briefAsFound())?.claims ?? [];
  const epicId = `epic_${input.proposalId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  if (!(await store.getCard(epicId))) {
    await store.createCard(
      {
        id: epicId,
        tier: "epic",
        title: T.epic(input.proposalId),
        status: "in_progress",
        labels: ["take-over"],
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      "planner",
    );
  }
  const deps: PipelineDeps = {
    repoPath: ctx.repoPath,
    cardStore: store,
    log: ctx.log,
    principal,
    ...(ctx.boardService ? { boardService: ctx.boardService } : {}),
  };
  const board = ctx.boardService ?? new BoardServiceImpl(store, { entryConditions: true });
  // The cards each proposal ref already has (approving again creates only what is missing).
  const made = new Map<string, CardRecord[]>();
  for (const card of await store.listCards()) {
    for (const l of card.labels ?? []) {
      if (!l.startsWith(`${input.proposalId}/`)) continue;
      made.set(l, [...(made.get(l) ?? []), card]);
    }
  }
  const mainOf = new Map<string, string>();
  const created: CardRecord[] = [];
  // A characterize card is planned with the card it pins down.
  const pinned = new Map<string, string>();
  for (const c of cards) for (const r of c.characterizes ?? []) pinned.set(r, c.ref);
  for (const c of cards) {
    if (c.change === "characterize" && (c.characterizes ?? []).length > 0) continue;
    const label = planLabel(input.proposalId, c.ref);
    const already = made.get(label);
    if (already && already.length > 0) {
      const main = already.find((x) => x.change !== "characterize") ?? already[0];
      if (main) mainOf.set(c.ref, main.id);
      created.push(...already);
      continue;
    }
    const outcome = (
      await createThroughPipeline(deps, [
        draftOf(c, { findings, claims, epicId, projectId: input.projectId }),
      ])
    )[0];
    const planned = outcome?.cards ?? [];
    const issueLink = c.links.find((l) => reconciled.has(l));
    const issue = issueLink ? reconciled.get(issueLink) : undefined;
    const url = c.links.find((l) => /^https?:\/\//.test(l));
    const externalRef: ExternalRef | undefined = issue
      ? { system: issue.system, id: issue.id, url: url ?? "" }
      : undefined;
    const charRef = pinned.get(c.ref);
    for (const card of planned) {
      const isChar = card.change === "characterize";
      const labels = [
        ...new Set([
          ...(card.labels ?? []),
          "take-over",
          c.bucket,
          label,
          ...(isChar && charRef ? [planLabel(input.proposalId, charRef)] : []),
        ]),
      ];
      const scope = isChar ? [] : scopeOf(c);
      await store.updateCard(
        card.id,
        {
          labels,
          ...(scope.length > 0 ? { scopeFiles: scope } : {}),
          ...(!isChar && c.change && card.change !== c.change ? { change: c.change } : {}),
          ...(externalRef && !isChar ? { externalRef } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
        "planner",
        { principal },
      );
      if (c.assignee === "person" && !isChar) {
        await store.delegateCard(card.id, { kind: "person", id: principal }, principal, "planner");
      }
      if (!isChar) mainOf.set(c.ref, card.id);
    }
    created.push(...planned);
  }
  // Order: each worker card that does not stabilise waits on the stabilise
  // work and on the card that characterizes it; a deferred card waits in the Backlog.
  const stabilising = cards
    .filter((c) => c.bucket === "stabilise" && c.assignee === "worker")
    .map((c) => mainOf.get(c.ref))
    .filter((id): id is string => id !== undefined);
  const out: CardRecord[] = [];
  for (const stale of created) {
    const card = (await store.getCard(stale.id)) ?? stale;
    const ref = (card.labels ?? [])
      .find((l) => l.startsWith(`${input.proposalId}/`))
      ?.slice(input.proposalId.length + 1);
    const c = cards.find((x) => x.ref === ref);
    const isChar = card.change === "characterize";
    if (c && !isChar && c.assignee === "worker" && c.bucket !== "stabilise") {
      const charIds: string[] = [];
      for (const x of created) {
        const now = await store.getCard(x.id);
        if (
          now?.change === "characterize" &&
          now.id !== card.id &&
          (now.labels ?? []).includes(planLabel(input.proposalId, c.ref))
        ) {
          charIds.push(now.id);
        }
      }
      for (const dep of [...charIds, ...stabilising]) {
        const now = await store.getCard(card.id);
        if (dep !== card.id && !(now?.dependsOn ?? []).includes(dep)) {
          await store.addDependency(card.id, dep, "declared", "planner");
        }
      }
    }
    const now = (await store.getCard(card.id)) ?? card;
    if (c?.bucket === "defer" && now.status === "planning") {
      await board.transitionCard({
        cardId: now.id,
        fromStatus: "planning",
        toStatus: "backlog",
        actor: "planner",
        reason: T.epic(input.proposalId),
      });
    }
    out.push((await store.getCard(card.id)) ?? now);
  }
  return { ...seeded, cards: out };
}
