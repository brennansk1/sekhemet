import { createHash } from "node:crypto";
import {
  type CardStore,
  type DocumentDifference,
  ERASED_MARKER,
  type EventLog,
  type ProjectDocumentKind,
  type Requirement,
  type RequirementCriterion,
  type RequirementRevision,
  generatedHeader,
  readGeneratedHeader,
} from "@sekhemet/kernel";
import {
  DecisionStore,
  type PlannerDecision,
  type PlannerLedger,
  type RequirementView,
  briefBaseline,
  defaultRequirementProject,
  latestMainCheck,
  storyMap,
} from "@sekhemet/planner";
import {
  NodeGitSyncAdapter,
  commitFilesOnBranch,
  keepAChangelogSection,
  lastCommitTouching,
  listBranchFiles,
  prependChangelogSection,
  readBranchFile,
} from "@sekhemet/sync";
import type { SekhemetConfig } from "./config.js";
import { effectiveConfig } from "./config_apply.js";
import { PmStore } from "./pm/store.js";

/**
 * Project documents in the repository, generated from the ledger
 * (design-stage §2.3, NEW-design-stage-3: DS-N3-1..8; DEC-30).
 *
 * The ledger is canonical for the brief, the requirements and the decision
 * records; this module writes them as Markdown where a professional team
 * expects them — `docs/product/brief.md`, `docs/product/requirements.md`,
 * MADR 4.0 records in `docs/decisions/` or the repository's own ADR folder,
 * `CHANGELOG.md` (Keep a Changelog) and `docs/product/releases/<version>.md`
 * — and commits them onto the integration branch by plumbing, only on a
 * person's accept (a card's, a brief's, a revision's, a release's): the
 * person's checkout is never touched. Each file starts with the generated
 * header naming the ledger seq. A merged edit to a generated document is
 * parsed, diffed against the ledger and recorded as proposals; nothing in
 * the ledger changes until a person applies one. A file without the header
 * is never overwritten, `README.md` and `CONTRIBUTING.md` are only offered
 * changes, and `noNames` writes role labels instead of names.
 */

export interface DocsContext {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
}

export interface DocsLayout {
  /** Where the brief, the requirements and the release notes go. */
  product: string;
  /** Where the decision records go. */
  decisions: string;
}

const ADR_FOLDERS = ["docs/adr", "doc/architecture/decisions"];

/** `[docs]` as the config module read it (refused values named there, not applied). */
function configuredDocs(repoPath: string): SekhemetConfig["docs"] {
  return effectiveConfig(repoPath).config.docs;
}

/**
 * Where the documents go (DS-N3-4, -6): the folders `[docs] product` and
 * `[docs] decisions` of `.sekhemet/config.toml` name, else `docs/product`
 * and, for decisions, the repository's existing ADR folder (`docs/adr/`,
 * `doc/architecture/decisions/`) when `tree` has one, else MADR's default
 * `docs/decisions`. `[docs] no_names = true` makes role labels the default (DS-N3-3).
 */
export function docsLayout(repoPath: string, tree: readonly string[]): DocsLayout {
  const configured = configuredDocs(repoPath);
  const adr = ADR_FOLDERS.find((dir) => tree.some((p) => p.startsWith(`${dir}/`)));
  return {
    product: configured.product ?? "docs/product",
    decisions: configured.decisions ?? adr ?? "docs/decisions",
  };
}

export interface ExportOptions {
  /** The person whose accept this export follows; the install's person when omitted. */
  principal?: string;
  /** Role labels instead of people's names (DS-N3-3). */
  noNames?: boolean;
  /** The card, slice or `brief` the commit is for (its `Card` trailer). */
  card?: string;
  /** A release being tagged: its CHANGELOG.md section and notes are written too (DS-N3-8). */
  release?: { sliceId: string; version: string };
  /** The integration branch's head the export must build on; it refuses a moved branch. */
  expectedHead?: string;
  /** The release date; today when omitted. */
  date?: string;
}

export interface ExportResult {
  /** The ledger seq the documents were generated from. */
  seq: number;
  /** The documents' commit on the integration branch, when one was written. */
  sha?: string;
  branch: string;
  written: string[];
  /** Files without the generated header, left as they are (DS-N3-5). */
  left: string[];
  /** Generated files with open proposals from a merged edit, not overwritten (DS-N3-2). */
  held: string[];
  /** Proposals this export recorded from merged edits (DS-N3-2, -5). */
  proposals: string[];
  /** The person's files a change was offered for, never written (DS-N3-7). */
  offers: string[];
  /** Why nothing was exported. */
  skipped?: string;
  /** For each checkout on the integration branch, how to bring its files up to date (RG-S5-2). */
  notice?: string;
}

interface Doc {
  path: string;
  kind: ProjectDocumentKind;
  text: string;
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
/** A document without its first (header) line. */
const bodyOf = (t: string) => t.slice(t.indexOf("\n") + 1);
const today = () => new Date().toISOString().slice(0, 10);

function ledgerSeq(store: CardStore): number {
  return Number((store.ledgerHead() ?? "0").split(":")[0]) || 0;
}

// --- People: names, or role labels (DS-N3-3) --------------------------------------------

const LEVEL_LABEL: Record<string, string> = {
  admin: "Admin",
  member: "Member",
  stakeholder: "Stakeholder",
  viewer: "Viewer",
};

async function personLabel(
  ctx: DocsContext,
  principal: string | undefined,
  noNames: boolean,
): Promise<string> {
  if (!principal) return "Unknown";
  if (noNames) {
    let level: string | undefined;
    for (const e of await ctx.cardStore.eventsOfType(["member/joined", "member/level_changed"])) {
      const p = e.payload as { principal?: string; level?: string };
      if (p.principal === principal && p.level) level = p.level;
    }
    if (level) return LEVEL_LABEL[level] ?? "Member";
    return principal === ctx.cardStore.localPrincipal() ? "Owner" : "Member";
  }
  if (principal === ctx.cardStore.localPrincipal()) {
    try {
      const name = new NodeGitSyncAdapter(ctx.repoPath).gitConfig("user.name");
      if (name) return name;
    } catch {
      // No git name: the person record's below.
    }
  }
  const created = (await ctx.cardStore.eventsOfType(["person/created"])).find(
    (e) => (e.payload as { principal?: string }).principal === principal,
  );
  const name = (created?.private as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name && name !== ERASED_MARKER ? name : principal;
}

// --- Rendering ------------------------------------------------------------------------------

const STATUS_WORDS: Record<RequirementView["state"], string> = {
  cut: "cut",
  suspect: "suspect",
  unplanned: "unplanned",
  planned: "planned",
  failing: "failing",
  passing_strength_unmet: "passing with strength unmet",
  proven: "proven",
};

function metaLine(r: Requirement, status: string): string {
  return [
    `version: ${r.version}`,
    `kano: ${r.kano ?? "unclassified"}`,
    `must: ${r.mustHave ? "yes" : "no"}`,
    `slice: ${r.sliceId ?? "none"}`,
    `status: ${status}`,
    `dependsOn: ${r.dependsOn.length ? r.dependsOn.join(", ") : "none"}`,
  ].join(" · ");
}

async function projectData(ctx: DocsContext) {
  const ledger: PlannerLedger = { store: ctx.cardStore, log: ctx.log };
  const projectId = await defaultRequirementProject(ledger);
  if (!projectId) return undefined;
  const requirements = await ctx.cardStore.requirements.list({ projectId });
  const briefEvent = (await ctx.log.getEventsByTypes(["brief/accepted"]))
    .filter((e) => (e.payload as { projectId?: string }).projectId === projectId)
    .at(-1);
  if (requirements.length === 0 && !briefEvent) return undefined;
  // Judged as of the latest check on main, so a later commit (these
  // documents' own among them) does not turn every status to "planned".
  const check = await latestMainCheck(ledger);
  const map = await storyMap(ledger, { projectId, mainSha: check?.sha });
  const views = new Map(map.slices.flatMap((s) => s.requirements).map((v) => [v.id, v]));
  return {
    projectId,
    projectName: ctx.cardStore.getProject(projectId)?.name ?? projectId,
    requirements,
    views,
    map,
    check,
    briefEvent,
    baseline: await briefBaseline(ledger, projectId),
    slices: await ctx.cardStore.slices.list(projectId),
  };
}

type ProjectData = NonNullable<Awaited<ReturnType<typeof projectData>>>;

async function renderBrief(
  ctx: DocsContext,
  data: ProjectData,
  seq: number,
  noNames: boolean,
): Promise<string> {
  const profile = ctx.cardStore.depthProfiles.of(data.projectId);
  const titles = new Map(data.requirements.map((r) => [r.id, r]));
  const lines = [
    generatedHeader(seq),
    `# Product brief: ${data.projectName}`,
    "",
    "## What people have today",
    "",
    data.baseline ?? "Not stated.",
    "",
    "## Depth profile",
    "",
    profile.recorded
      ? `${profile.profile}, chosen by ${await personLabel(ctx, profile.principal, noNames)}.`
      : `${profile.profile} (no profile chosen yet; this one applies).`,
    "",
    "## Slices",
  ];
  for (const s of data.slices) {
    const appetite = [
      s.appetite.cards !== undefined ? `${s.appetite.cards} cards` : "",
      s.appetite.hours !== undefined ? `${s.appetite.hours} hours` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push("", `### ${s.id} — ${s.title ?? "(untitled)"}`, "");
    lines.push(`Appetite: ${appetite || "none"} · accepted: ${s.accepted ? "yes" : "no"}`, "");
    for (const id of s.requirementIds) {
      const r = titles.get(id);
      lines.push(`- ${id} — ${r?.title ?? ""}${r && !r.mustHave ? " (nice-to-have)" : ""}`);
    }
  }
  if (data.briefEvent) {
    lines.push(
      "",
      `Accepted by ${await personLabel(ctx, data.briefEvent.principal, noNames)} on ${data.briefEvent.createdAt.slice(0, 10)}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderRequirements(data: ProjectData, seq: number): string {
  const lines = [
    generatedHeader(seq),
    `# Requirements: ${data.projectName}`,
    "",
    // No sha or date here: the line would change on every check of main.
    data.check
      ? `Status as of the latest check of main, against the ${data.check.profile} profile.`
      : "Main has not been checked yet.",
  ];
  for (const r of data.requirements) {
    const view = data.views.get(r.id);
    const status = r.cut ? "cut" : view ? STATUS_WORDS[view.state] : "unplanned";
    lines.push("", `### ${r.id} — ${r.title ?? ""}`, "", metaLine(r, status), "");
    for (const c of r.criteria) lines.push(`- \`${c.id}\` ${c.text}`);
    if (r.invariant) lines.push(`- invariant: ${r.invariant}`);
    if (r.criteria.length || r.invariant) lines.push("");
    const tests = view?.tests.map((t) => `\`${t.ref}\``) ?? [];
    lines.push(`Tests: ${tests.length ? tests.join(", ") : "none yet"}`);
  }
  return `${lines.join("\n")}\n`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "decision"
  );
}

const DECISION_MARK = /^sekhemet-decision: (\S+)$/m;

async function renderDecision(
  ctx: DocsContext,
  d: PlannerDecision,
  seq: number,
  noNames: boolean,
  answeredBy: string | undefined,
): Promise<string> {
  const req = d.request;
  const chosen = d.record.selectedOptionIndex ?? 0;
  const option = req.options[chosen];
  const recommended = req.options[req.recommendation.optionIndex];
  const makers =
    d.state === "default_applied"
      ? "Safe default (no answer by the deadline)"
      : await personLabel(ctx, answeredBy, noNames);
  const because =
    d.state === "default_applied"
      ? "no answer came by the deadline and it was the safe default."
      : chosen === req.recommendation.optionIndex
        ? `${req.recommendation.rationale.replace(/\.$/, "")}.`
        : `the decision-makers chose it over the recommendation (${recommended?.label ?? "none"}: ${req.recommendation.rationale.replace(/\.$/, "")}).`;
  return `${[
    generatedHeader(seq),
    "---",
    "status: accepted",
    `date: ${(d.record.answeredAt ?? d.record.createdAt).slice(0, 10)}`,
    `decision-makers: ${makers}`,
    `sekhemet-decision: ${d.id}`,
    "---",
    "",
    `# ${req.question}`,
    "",
    "## Context and Problem Statement",
    "",
    `${req.question} Asked while planning ${req.cardId} (${req.category.replace(/_/g, " ")}).`,
    "",
    "## Decision Drivers",
    "",
    `* Recommended: ${recommended?.label ?? "none"}, because ${req.recommendation.rationale.replace(/\.$/, "")}.`,
    `* ${req.policy === "safe_default" ? "Without an answer by the deadline, the safe default applies" : "Without an answer, the card stays parked"}.`,
    "",
    "## Considered Options",
    "",
    ...req.options.map((o) => `* ${o.label}`),
    "",
    "## Decision Outcome",
    "",
    `Chosen option: "${option?.label ?? ""}", because ${because}`,
    "",
    "### Consequences",
    "",
    ...req.options.map((o, i) =>
      i === chosen ? `* ${o.consequence}` : `* Not taken: ${o.label} (${o.consequence}).`,
    ),
    "",
    "### Confirmation",
    "",
    `The cards planned under this decision prove it through their gates, starting with ${req.cardId}.`,
  ].join("\n")}\n`;
}

function renderReleaseNotes(
  seq: number,
  release: { version: string; notes?: string; requirementIds: string[] },
  slice: { id: string; title?: string | undefined },
  date: string,
): string {
  return `${[
    generatedHeader(seq),
    `# Release ${release.version}`,
    "",
    `${slice.id}${slice.title ? ` — ${slice.title}` : ""}, released on ${date}.`,
    "",
    release.notes?.trim() || "No notes were proposed for this release.",
    "",
    `Requirements proven: ${release.requirementIds.join(", ") || "none"}.`,
  ].join("\n")}\n`;
}

// --- Parsing a document back (DS-N3-2) --------------------------------------------------------

interface ParsedRequirement {
  id?: string;
  title: string;
  kano?: string;
  must?: boolean;
  dependsOn?: string[];
  criteria: { id?: string; text: string }[];
}

const REQ_HEADING = /^### (?:(REQ-\d+) — )?(.*)$/;

export function parseRequirements(text: string): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  let cur: ParsedRequirement | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const h = REQ_HEADING.exec(line);
    if (h) {
      cur = { ...(h[1] ? { id: h[1] } : {}), title: (h[2] ?? "").trim(), criteria: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^version: /.test(line)) {
      for (const part of line.split(" · ")) {
        const [key, ...rest] = part.split(": ");
        const value = rest.join(": ").trim();
        if (key === "kano") cur.kano = value;
        if (key === "must") cur.must = value === "yes";
        if (key === "dependsOn")
          cur.dependsOn =
            value === "none" || !value
              ? []
              : value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean);
      }
      continue;
    }
    const withId = /^- `([^`]+)` (.*)$/.exec(line);
    if (withId && withId[1] !== undefined) {
      cur.criteria.push({ id: withId[1], text: (withId[2] ?? "").trim() });
      continue;
    }
    const bare = /^- (?!invariant: )(.+)$/.exec(line);
    if (bare) cur.criteria.push({ text: (bare[1] ?? "").trim() });
  }
  return out;
}

const sameCriteria = (a: { id?: string; text: string }[], b: RequirementCriterion[]) =>
  a.length === b.length && a.every((c, i) => c.id === b[i]?.id && c.text === b[i]?.text);

/** The differences between a requirements document and the ledger, one per field (DS-N3-2). */
export function diffRequirements(text: string, ledger: Requirement[]): DocumentDifference[] {
  const parsed = parseRequirements(text);
  const out: DocumentDifference[] = [];
  const byId = new Map(ledger.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const p of parsed) {
    const r = p.id ? byId.get(p.id) : undefined;
    if (!r) {
      out.push({
        kind: "added",
        target: "requirement",
        proposed: JSON.stringify({ title: p.title, criteria: p.criteria.map((c) => c.text) }),
      });
      continue;
    }
    seen.add(r.id);
    const change = (field: string, proposed: string) =>
      out.push({ kind: "changed", target: "requirement", targetId: r.id, field, proposed });
    if (p.title !== (r.title ?? "")) change("title", p.title);
    if (!sameCriteria(p.criteria, r.criteria)) change("criteria", JSON.stringify(p.criteria));
    if (p.kano !== undefined && p.kano !== (r.kano ?? "unclassified")) change("kano", p.kano);
    if (p.must !== undefined && p.must !== r.mustHave) change("must_have", p.must ? "yes" : "no");
    if (p.dependsOn !== undefined && p.dependsOn.join(",") !== r.dependsOn.join(",")) {
      change("depends_on", p.dependsOn.join(", "));
    }
  }
  for (const r of ledger) {
    if (!r.cut && !seen.has(r.id))
      out.push({ kind: "removed", target: "requirement", targetId: r.id });
  }
  return out;
}

function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(l)) break;
    body.push(l);
  }
  return body.join("\n").trim();
}

/** The brief's differences: its baseline, the part a person wrote (DS-N3-2). */
export function diffBrief(text: string, baseline: string | undefined): DocumentDifference[] {
  const now = sectionOf(text, "## What people have today");
  if (now === undefined || now === (baseline ?? "Not stated.")) return [];
  return [{ kind: "changed", target: "brief", field: "baseline", proposed: now }];
}

/** A decision record's differences: its chosen option (DS-N3-2). */
export function diffDecision(
  text: string,
  decision: PlannerDecision | undefined,
): DocumentDifference[] {
  const chosen = /^Chosen option: "(.*)",/m.exec(text)?.[1];
  if (!decision || chosen === undefined) return [];
  const label = decision.request.options[decision.record.selectedOptionIndex ?? 0]?.label;
  if (chosen === label) return [];
  return [
    {
      kind: "changed",
      target: "decision",
      targetId: decision.id,
      field: "outcome",
      proposed: chosen,
    },
  ];
}

// --- The export ---------------------------------------------------------------------------------

function integrationBranchOf(repoPath: string): string {
  return effectiveConfig(repoPath).config.review.integrationBranch;
}

function revParse(repoPath: string, ref: string): string | undefined {
  try {
    return new NodeGitSyncAdapter(repoPath).revParse(ref);
  } catch {
    return undefined;
  }
}

/** Seshat says it once: a line already in the thread is not repeated. */
async function tellOnce(ctx: DocsContext, text: string): Promise<void> {
  const pm = new PmStore(ctx.log);
  if ((await pm.thread()).some((m) => m.text === text)) return;
  await pm.appendReply({ replyTo: [], text, model: "ledger" });
}

async function answeredDecisions(ctx: DocsContext): Promise<PlannerDecision[]> {
  const ledger: PlannerLedger = { store: ctx.cardStore, log: ctx.log };
  return (await new DecisionStore(ledger).all())
    .filter((d) => d.state === "answered" || d.state === "default_applied")
    .sort((a, b) => (a.record.answeredAt ?? "").localeCompare(b.record.answeredAt ?? ""));
}

async function answerPrincipals(ctx: DocsContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await ctx.cardStore.eventsOfType(["decision/answered"])) {
    const id = (e.payload as { id?: string }).id;
    if (id && e.principal) out.set(id, e.principal);
  }
  return out;
}

/**
 * Generate the project's documents from the ledger and commit what changed
 * onto the integration branch (DS-N3-1..8). First, every generated document
 * a merged commit changed since its export is parsed and diffed against the
 * ledger, each difference recorded as a proposal (DS-N3-2); such a file is
 * not overwritten while a proposal on it is open. Then each document is
 * rendered: a missing one is written, one whose body changed is rewritten,
 * one without the generated header is left as it is (DS-N3-5); CHANGELOG.md
 * is only ever extended (DS-N3-8). `README.md` gets an offered link, never a
 * write (DS-N3-7). The commit carries the attribution trailers and the
 * person's name (or role label, DS-N3-3); the export is recorded
 * (`docs/exported`) with each file's SHA-256 as committed.
 */
export async function exportProjectDocuments(
  ctx: DocsContext,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const branch = integrationBranchOf(ctx.repoPath);
  const noNames = options.noNames ?? configuredDocs(ctx.repoPath).noNames;
  const principal = options.principal ?? ctx.cardStore.localPrincipal();
  const result: ExportResult = {
    seq: ledgerSeq(ctx.cardStore),
    branch,
    written: [],
    left: [],
    held: [],
    proposals: [],
    offers: [],
  };
  const head = revParse(ctx.repoPath, `refs/heads/${branch}^{commit}`);
  if (!head) return { ...result, skipped: `${branch} has no commit` };
  if (options.expectedHead && options.expectedHead !== head) {
    throw new Error(
      `${branch} moved to ${head.slice(0, 7)} since ${options.expectedHead.slice(0, 7)}; the project documents were not written`,
    );
  }
  const tree = listBranchFiles(ctx.repoPath, head);
  const layout = docsLayout(ctx.repoPath, tree);
  const data = await projectData(ctx);
  const decisions = await answeredDecisions(ctx);

  // 1. Merged edits to generated documents become proposals (DS-N3-2).
  const docs = ctx.cardStore.documents;
  const diffed = new Set(
    (await ctx.log.getEventsByTypes(["docs/import_diffed"])).map((e) => {
      const p = e.payload as { path: string; sha256: string };
      return `${p.path}\u0000${p.sha256}`;
    }),
  );
  const lastByPath = new Map<string, ProjectDocumentKind>();
  for (const e of docs.exports()) for (const f of e.files) lastByPath.set(f.path, f.kind);
  const byMark = new Map(decisions.map((d) => [d.id, d]));
  for (const [path, kind] of lastByPath) {
    if (kind === "changelog" || kind === "release") continue;
    const text = readBranchFile(ctx.repoPath, head, path);
    const last = docs.lastExport(path);
    if (text === undefined || !last || sha256(text) === last.sha256) continue;
    if (diffed.has(`${path}\u0000${sha256(text)}`)) continue;
    const differences =
      kind === "requirements"
        ? diffRequirements(text, data?.requirements ?? [])
        : kind === "brief"
          ? diffBrief(text, data?.baseline)
          : diffDecision(text, byMark.get(DECISION_MARK.exec(text)?.[1] ?? ""));
    const commit = lastCommitTouching(ctx.repoPath, head, path) ?? head;
    result.proposals.push(...(await docs.recordImportDiff({ path, commit, text, differences })));
  }
  const openPaths = new Set((await docs.openProposals()).map((p) => p.path));

  // 2. The documents, rendered from the ledger at this seq.
  const seq = ledgerSeq(ctx.cardStore);
  result.seq = seq;
  const out: Doc[] = [];
  if (data) {
    out.push({
      path: `${layout.product}/brief.md`,
      kind: "brief",
      text: await renderBrief(ctx, data, seq, noNames),
    });
    out.push({
      path: `${layout.product}/requirements.md`,
      kind: "requirements",
      text: renderRequirements(data, seq),
    });
  }
  const principals = await answerPrincipals(ctx);
  const numbered = new Map<string, string>();
  let highest = 0;
  for (const path of tree.filter((p) => p.startsWith(`${layout.decisions}/`))) {
    const n = /^(\d{4})-/.exec(path.slice(layout.decisions.length + 1))?.[1];
    if (n) highest = Math.max(highest, Number(n));
    const mark = DECISION_MARK.exec(readBranchFile(ctx.repoPath, head, path) ?? "")?.[1];
    if (mark) numbered.set(mark, path);
  }
  for (const d of decisions) {
    let path = numbered.get(d.id);
    if (!path) {
      highest += 1;
      path = `${layout.decisions}/${String(highest).padStart(4, "0")}-${slug(d.request.question)}.md`;
    }
    out.push({
      path,
      kind: "decision",
      text: await renderDecision(ctx, d, seq, noNames, principals.get(d.id)),
    });
  }
  if (options.release) {
    const release = (await ctx.cardStore.slices.releases(options.release.sliceId))
      .filter((r) => r.version === options.release?.version)
      .at(-1);
    if (!release) {
      throw new Error(
        `No release ${options.release.version} is proposed for ${options.release.sliceId}`,
      );
    }
    const slice = await ctx.cardStore.slices.get(options.release.sliceId);
    const date = options.date ?? today();
    const section = keepAChangelogSection(release.version, date, release.changelog ?? {});
    const existing = readBranchFile(ctx.repoPath, head, "CHANGELOG.md");
    let changelog = prependChangelogSection(existing, section, release.version);
    if (existing === undefined) changelog = `${generatedHeader(seq)}\n${changelog}`;
    else if (readGeneratedHeader(existing) !== undefined && changelog !== existing) {
      changelog = `${generatedHeader(seq)}\n${bodyOf(changelog)}`;
    }
    out.push({ path: "CHANGELOG.md", kind: "changelog", text: changelog });
    out.push({
      path: `${layout.product}/releases/${release.version}.md`,
      kind: "release",
      text: renderReleaseNotes(
        seq,
        release,
        { id: options.release.sliceId, title: slice?.title },
        date,
      ),
    });
  }

  // 3. What to write, what to leave (DS-N3-2, -5).
  const writes: Doc[] = [];
  const kept: Doc[] = [];
  for (const doc of out) {
    const existing = readBranchFile(ctx.repoPath, head, doc.path);
    if (doc.kind === "changelog") {
      if (existing === doc.text) kept.push({ ...doc, text: existing });
      else writes.push(doc);
      continue;
    }
    if (existing === undefined) {
      writes.push(doc);
      continue;
    }
    if (readGeneratedHeader(existing) === undefined) {
      result.left.push(doc.path);
      if (!docs.lastExport(doc.path)) {
        await tellOnce(
          ctx,
          `${doc.path} has no generated header, so it is yours: it was left as it is. The ${doc.kind} generated from the ledger is shown with \`sekhemet release docs\`; copy what you want from it, or remove your file to let Sekhemet keep it.`,
        );
      }
      continue;
    }
    if (openPaths.has(doc.path)) {
      result.held.push(doc.path);
      continue;
    }
    if (
      bodyOf(existing) === bodyOf(doc.text) &&
      docs.lastExport(doc.path)?.sha256 === sha256(existing)
    ) {
      kept.push({ ...doc, text: existing });
      continue;
    }
    writes.push(doc);
  }

  // 4. README.md is the person's: a link to the documents is offered, never written (DS-N3-7).
  const readme = tree.find((p) => p.toLowerCase() === "readme.md");
  if (data && readme) {
    const text = readBranchFile(ctx.repoPath, head, readme) ?? "";
    if (!text.includes(`${layout.product}/`)) {
      result.offers.push(readme);
      await tellOnce(
        ctx,
        `Suggested: add to ${readme} a line linking the project's documents — "The brief and the requirements: [${layout.product}/brief.md](${layout.product}/brief.md), [${layout.product}/requirements.md](${layout.product}/requirements.md)." Why: people reading ${readme} find the product's documents from it. Sekhemet does not edit ${readme}; it is yours.`,
      );
    }
  }

  if (writes.length === 0) return result;
  const accepter = await personLabel(ctx, principal, noNames);
  const sha = await new NodeGitSyncAdapter(ctx.repoPath).withAcceptLock(async () =>
    commitFilesOnBranch(ctx.repoPath, {
      branch,
      expectedOld: head,
      files: writes.map((d) => ({ path: d.path, text: d.text })),
      subject: `docs(product): ${options.release ? `release ${options.release.version} notes and changelog; ` : ""}project documents from ledger seq ${seq}`,
      body: `Generated from the ledger: ${writes.map((d) => d.path).join(", ")}.`,
      trailers: {
        Card: options.card ?? options.release?.sliceId ?? "docs",
        "Agent-Model": "none",
        "Agent-Harness": "sekhemet",
        "Agent-Role": "documenter",
        "Accepted-by": accepter,
        "Ledger-Seq": String(seq),
        "Co-authored-by": "sekhemet <harness@sekhemet.local>",
      },
    }),
  );
  await docs.recordExport({
    seq,
    noNames,
    files: [...writes, ...kept].map((d) => ({
      path: d.path,
      sha256: sha256(d.text),
      kind: d.kind,
    })),
  });
  // The branch moved by plumbing: a checkout on it is told how to catch up (RG-S5-2).
  const { checkoutNotice } = await import("./accept.js");
  const notice = checkoutNotice(ctx.repoPath, branch, sha);
  return { ...result, sha, written: writes.map((d) => d.path), ...(notice ? { notice } : {}) };
}

/** Every generated document's text as the ledger would write it now, without committing (`sekhemet release docs show`). */
export async function renderedDocuments(
  ctx: DocsContext,
  options: { noNames?: boolean } = {},
): Promise<{ path: string; text: string }[]> {
  const branch = integrationBranchOf(ctx.repoPath);
  const head = revParse(ctx.repoPath, `refs/heads/${branch}^{commit}`);
  const layout = docsLayout(ctx.repoPath, head ? listBranchFiles(ctx.repoPath, head) : []);
  const data = await projectData(ctx);
  const seq = ledgerSeq(ctx.cardStore);
  if (!data) return [];
  return [
    {
      path: `${layout.product}/brief.md`,
      text: await renderBrief(ctx, data, seq, options.noNames ?? false),
    },
    { path: `${layout.product}/requirements.md`, text: renderRequirements(data, seq) },
  ];
}

// --- Applying a proposal (DS-N3-2) ------------------------------------------------------------

/**
 * A person applies a document proposal: the change is made in the ledger
 * under their principal — a requirement edit through `revise` (a
 * `requirement/revised` with its impact), an added requirement created, a
 * removed one cut — and only then is the proposal recorded as applied. A
 * brief's baseline or a decision's outcome is not changed from a document:
 * such a proposal is refused here and is dismissed or taken to Seshat.
 */
export async function applyDocumentProposal(
  ctx: DocsContext,
  id: string,
  principal: string,
  revise: (requirementId: string, revision: RequirementRevision) => Promise<unknown>,
): Promise<string> {
  const p = (await ctx.cardStore.documents.proposals()).find((x) => x.id === id);
  if (!p) throw new Error(`No document proposal ${id}`);
  if (p.state !== "open") throw new Error(`Document proposal ${id} was already ${p.state}`);
  if (p.target !== "requirement") {
    throw new Error(
      `${id} changes the ${p.target === "brief" ? "brief's baseline, which a revised brief changes" : "outcome of a decision, which a new decision changes"}; dismiss it, or ask Seshat`,
    );
  }
  const text = p.proposed ?? "";
  let done: string;
  if (p.kind === "added") {
    const parsed = JSON.parse(text) as { title: string; criteria: string[] };
    const ledger: PlannerLedger = { store: ctx.cardStore, log: ctx.log };
    const projectId = await defaultRequirementProject(ledger);
    const made = await ctx.cardStore.requirements.create(
      {
        title: parsed.title,
        ...(projectId ? { projectId } : {}),
        criteria: parsed.criteria.map((c, i) => ({ id: `c${i + 1}`, text: c })),
      },
      principal,
    );
    done = `${made.id} created`;
  } else if (p.kind === "removed") {
    await ctx.cardStore.slices.cut(
      { requirementId: p.targetId as string, reason: `removed from ${p.path}` },
      principal,
    );
    done = `${p.targetId} cut`;
  } else {
    const revision: RequirementRevision =
      p.field === "title"
        ? { title: text }
        : p.field === "criteria"
          ? {
              criteria: (JSON.parse(text) as { id?: string; text: string }[]).map((c, i) => ({
                id: c.id ?? `c${i + 1}`,
                text: c.text,
              })),
            }
          : p.field === "kano"
            ? { kano: text as NonNullable<RequirementRevision["kano"]> }
            : p.field === "must_have"
              ? { mustHave: text === "yes" }
              : {
                  dependsOn: text
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                };
    await revise(p.targetId as string, revision);
    done = `${p.targetId} revised (${p.field?.replace(/_/g, " ")})`;
  }
  await ctx.cardStore.documents.applyProposal(id, principal);
  return done;
}
