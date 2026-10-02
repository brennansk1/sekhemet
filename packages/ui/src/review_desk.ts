/**
 * Review for a team, and review that forces a look (dashboard §2.5.3–9,
 * NEW-dashboard-5). What the Review surface decides, as a pure model: the
 * Reviewer's findings and its coverage (DB-N5-2), the order of the
 * Implementation files by risk (DB-N5-1), what keeps Accept disabled and who
 * may accept instead (DB-N5-3, DB-N5-9), who built the card (DB-N5-4), and
 * the Acceptance tests group's supersessions and approvals (DB-N5-7, -8).
 * Every word the page shows for these is here.
 *
 * Accept's own checks stay on the server (`accept.ts`: `acceptFriction`,
 * `accepterCheck`); this mirrors them so the page says what remains before
 * the button is pressed.
 *
 * The browser loads the compiled module as `/app/lib/review_desk.js`.
 */

/** A Reviewer finding as the card's dossier holds it (`card/review`, review-git §2.3). */
export interface FindingEntry {
  /** The dossier entry id: what Accept's `acknowledgedFindings` names. */
  id: string;
  verdict?: string;
  text: string;
  /** The files the Reviewer read, when it recorded them (the entry's `sources`). */
  filesRead?: string[];
  /** The Review model that wrote the finding (review-git RG-P8-12). */
  modelId?: string;
}

export type FindingVerdict = "unmet" | "unclear" | "met";

export interface Citation {
  file: string;
  from: number;
  to: number;
}

export interface FindingRow {
  id: string;
  verdict: FindingVerdict;
  /** What kind of finding it is, for the ones not about a criterion (FINDINGS_C1 R-38). */
  chip?: string;
  text: string;
  citations: Citation[];
  /** Unmet or unclear: Accept waits for its acknowledgement. */
  needsAck: boolean;
  acknowledged: boolean;
}

/** Every word of the Review surface's team and forcing parts. */
export const REVIEW_DESK_COPY = {
  heading: "AI review",
  /** RG-P8-10: the Review role is unfilled, recorded on the issue in place of findings. */
  noReviewer: "No AI review: no Review model outside the Coding model's family is configured.",
  /** Models rule 23: the review could not run; the issue reaches Review unreviewed and says so. */
  reviewFailed: (why: string) =>
    `AI review could not run (${why}). The checks passed; the change reaches you unreviewed.`,
  why: "The review model checked the diff against the issue's criteria. It's advice, not a check: Accept is yours.",
  verdict: { unmet: "Unmet", unclear: "Unclear", met: "Met" } as Record<FindingVerdict, string>,
  acknowledge: "Acknowledge",
  acknowledged: "Acknowledged",
  acknowledgeKey: "x acknowledges the focused finding",
  metMore: (n: number) => `${n} met`,
  coverageRead: (read: number, total: number, uncited: number, changed: number) =>
    `AI review read ${read} of ${total} ${total === 1 ? "file" : "files"}; ${uncited} of ${changed} changed ${changed === 1 ? "line is" : "lines are"} cited by no finding.`,
  coverageUnrecorded: (uncited: number, changed: number) =>
    `AI review did not record which files it read; ${uncited} of ${changed} changed ${changed === 1 ? "line is" : "lines are"} cited by no finding.`,
  notReadHeading: "Files AI review did not read",
  uncitedHeading: "Changed lines cited by no finding",
  seen: "Seen",
  findingsLeft: (n: number) => `${n} ${n === 1 ? "finding" : "findings"} to acknowledge`,
  filesLeft: (n: number, names: string) =>
    `${n} ${n === 1 ? "file" : "files"} not yet shown: ${names}`,
  andMore: (n: number) => ` and ${n} more`,
  whoMay: (names: string[]) =>
    `Who may accept: ${names.length ? names.join(", ") : "no one else on the Accept rule yet"}.`,
  notIndependent: (because: "built" | "delegated") =>
    `You ${because === "built" ? "built this issue" : "delegated this issue to the Agent"}; on a team, another person on the Accept rule accepts it.`,
  notPermitted: "You do not hold the Accept permission on this project.",
  notCodeOwner: "This project needs a code owner's accept, and you own none of this issue's files.",
  noCodeOwner: "no code owner is named in CODEOWNERS for these files",
  builtBy: (name: string) => `Built by ${name} (person)`,
  builtByFact: (name: string) => `${name} (person)`,
  builtByLabel: "Built by",
  worker: "Agent",
  supersededHeading: "Superseded base tests",
  supersededOld: "Base test",
  supersededNew: "New version",
  supersededNotNeeded:
    "Declared; the base test did not fail, so the regression check did not need it",
  approvalsHeading: "Test approvals",
  approved: (by: string, what?: "file" | "examples") =>
    `Approved by ${by}${what === "examples" ? " · example table" : ""}`,
  needsApproval: "Needs approval",
  needsApprovalAgain: "Needs approval again",
} as const;

/**
 * Review threads and the *Comment* verdict (teams item 25, NEW-teams-8;
 * GitHub's pull-request review): every word the triage bar, the Comment
 * form and the Changes tab's threads show.
 */
export const THREAD_COPY = {
  comment: "Comment",
  commentKey: "C",
  heading: "Review threads",
  none: "No review threads. Comment leaves a review with no verdict: its comments open threads here.",
  formLabel: "Comment on this change",
  formHint:
    "A review with no verdict. It opens a thread on the whole change, and one for each line comment you add in Changes.",
  placeholder: "Leave a comment for the people reviewing this issue.",
  carried: (n: number) =>
    `${n === 1 ? "1 line comment opens its own thread" : `${n} line comments open their own threads`}.`,
  send: "Comment",
  sent: (n: number) => `Comment posted. ${n === 1 ? "1 thread" : `${n} threads`} opened.`,
  empty: "Add a comment, or line comments in Changes.",
  wholeChange: "the whole change",
  reply: "Reply",
  replyLabel: (place: string) => `Reply on ${place}`,
  resolve: "Resolve conversation",
  reopen: "Unresolve conversation",
  resolved: (name: string | undefined) => (name ? `Resolved by ${name}` : "Resolved"),
  open: "Open",
  resolveNeeds: "A Member can resolve conversations.",
  count: (open: number, total: number) =>
    total === 0 ? "" : open === 0 ? `${total} resolved` : `${open} open of ${total}`,
  /** TEAM-25: Accept's reason while a thread is open, naming it. */
  openThread: (place: string, name: string | undefined, quote: string, more: number) =>
    `This project needs every review thread resolved before Accept. Open thread on ${place}${name ? ` from ${name}` : ""}: “${quote}”${more > 0 ? ` (and ${more} more open)` : ""}.`,
  /** TEAM-24: the triage bar's note after new commits dismissed an accept. */
  dismissed: "Accept dismissed: new commits since it was accepted",
  dismissedDetail: (who: string | undefined, pr: number | undefined) =>
    `${who ? `${who}'s accept` : "The accept"}${pr ? ` of pull request #${pr}` : ""} no longer holds. Review the new commits, then accept again.`,
} as const;

/** A review thread as `GET /api/cards/:id/threads` returns it. */
export interface ReviewThreadLike {
  id: string;
  file?: string;
  line?: number;
  name?: string;
  resolved: boolean;
  comments: readonly { text: string }[];
}

/** Where a thread is: `src/a.ts:12`, a file, or the whole change. */
export function threadPlace(t: { file?: string; line?: number }): string {
  if (!t.file) return THREAD_COPY.wholeChange;
  return t.line !== undefined ? `${t.file}:${t.line}` : t.file;
}

/**
 * TEAM-25: why Accept waits while a thread is open — the first open one
 * named by place, who opened it and its first words — or "" when none is
 * open or the project does not require it. The server's refusal says the same.
 */
export function openThreadText(threads: readonly ReviewThreadLike[], required: boolean): string {
  if (!required) return "";
  const open = threads.filter((t) => !t.resolved);
  const first = open[0];
  if (!first) return "";
  const words = (first.comments[0]?.text ?? "").replace(/\s+/g, " ").trim();
  const quote = words.length > 60 ? `${words.slice(0, 59)}…` : words;
  return THREAD_COPY.openThread(threadPlace(first), first.name, quote, open.length - 1);
}

/** What the review desk (`GET /api/cards/:id/review`) says about threads and a dismissed accept. */
export interface ThreadDesk {
  threads?: readonly (ReviewThreadLike & {
    principal?: string;
    resolvedByName?: string;
    comments: readonly { text: string; name?: string; principal?: string }[];
  })[];
  requireResolvedThreads?: boolean;
  /** The server's own wording of the open thread Accept waits on. */
  openThread?: string;
  acceptDismissed?: { pr?: number; accepterName?: string };
}

/** TEAM-25: the open thread Accept waits on, as the server said it (or as the page works it out). */
export function threadBlocker(desk: ThreadDesk | null | undefined): string {
  if (!desk) return "";
  return (
    desk.openThread ?? openThreadText(desk.threads ?? [], desk.requireResolvedThreads === true)
  );
}

/** TEAM-24: the triage bar's note while a dismissed accept has not been given again. */
export function dismissalNote(
  desk: ThreadDesk | null | undefined,
): { text: string; detail: string } | undefined {
  const d = desk?.acceptDismissed;
  if (!d) return undefined;
  return { text: THREAD_COPY.dismissed, detail: THREAD_COPY.dismissedDetail(d.accepterName, d.pr) };
}

/**
 * The Changes tab's review threads (teams item 25): open ones first, each
 * with its place, who opened it, its comments by name ("You" for the
 * reader), and what the reader may do — reply (every level) and resolve or
 * reopen (`canResolve`: a Member or above).
 */
export function threadRows(
  desk: ThreadDesk | null | undefined,
  reader: string | undefined,
  canResolve: boolean,
): {
  heading: string;
  count: string;
  rows: {
    id: string;
    place: string;
    resolved: boolean;
    state: string;
    comments: { who: string; text: string }[];
    /** `disabled`: the reader's level may not, and the reason names the level that may (DB-N9-17). */
    action: { verb: "resolve" | "reopen"; label: string; disabled?: string };
  }[];
} {
  const threads = desk?.threads ?? [];
  const who = (c: { text: string; name?: string; principal?: string }) =>
    reader && c.principal === reader ? "You" : c.name || "A person";
  const ordered = [...threads.filter((t) => !t.resolved), ...threads.filter((t) => t.resolved)];
  return {
    heading: THREAD_COPY.heading,
    count: THREAD_COPY.count(threads.filter((t) => !t.resolved).length, threads.length),
    rows: ordered.map((t) => ({
      id: t.id,
      place: threadPlace(t),
      resolved: t.resolved,
      state: t.resolved ? THREAD_COPY.resolved(t.resolvedByName) : THREAD_COPY.open,
      comments: t.comments.map((c) => ({ who: who(c), text: c.text })),
      action: {
        ...(t.resolved
          ? { verb: "reopen" as const, label: THREAD_COPY.reopen }
          : { verb: "resolve" as const, label: THREAD_COPY.resolve }),
        ...(canResolve ? {} : { disabled: THREAD_COPY.resolveNeeds }),
      },
    })),
  };
}

const VERDICTS: readonly FindingVerdict[] = ["unmet", "unclear", "met"];

function verdictOf(v: string | undefined): FindingVerdict | undefined {
  return (VERDICTS as readonly string[]).includes(v ?? "") ? (v as FindingVerdict) : undefined;
}

/** `path/to/file.ts:12` and `file.ts:10-14` in a finding's text: what it cites. */
export function citationsOf(text: string): Citation[] {
  const out: Citation[] = [];
  const re = /((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)(?:[-–](\d+))?/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    out.push({ file: m[1] as string, from, to: Math.max(from, to) });
  }
  return out;
}

/**
 * The stored finding's machine prefix (`no test: …`, `outside: <file>`, which
 * the Agent's dossier keeps) as a chip a person reads, and its text without
 * the prefix or the trailing `(file:line)` its citation chip already shows
 * (FINDINGS_C1 R-38, WRD-24).
 */
const FINDING_CHIPS: readonly [RegExp, string][] = [
  [/^no test:\s*/i, "No test checks this"],
  [/^outside:\s*/i, "Outside the criteria"],
];

function findingWords(text: string, cited: boolean): { chip?: string; text: string } {
  let t = String(text ?? "").trim();
  let chip: string | undefined;
  for (const [re, label] of FINDING_CHIPS) {
    if (re.test(t)) {
      chip = label;
      t = t.replace(re, "");
      break;
    }
  }
  if (cited) t = t.replace(/\s*\((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]+:\d+(?:[-–]\d+)?\)$/, "");
  return { ...(chip ? { chip } : {}), text: t };
}

/**
 * The Reviewer's findings as Review lists them (§2.5.3 4a): unmet first, then
 * unclear, then met; entries without one of those verdicts (Seshat's
 * preference notes) are not Reviewer findings and are left out. `open` is
 * what Accept still waits for: the unacknowledged unmet and unclear ids.
 */
export function reviewerFindings(
  entries: readonly FindingEntry[],
  acknowledged: ReadonlySet<string>,
): { title: string; rows: FindingRow[]; open: string[]; met: number } {
  const rows: FindingRow[] = [];
  for (const verdict of VERDICTS) {
    for (const e of entries) {
      if (verdictOf(e.verdict) !== verdict) continue;
      const needsAck = verdict !== "met";
      const citations = citationsOf(e.text);
      rows.push({
        id: e.id,
        verdict,
        ...findingWords(e.text, citations.length > 0),
        citations,
        needsAck,
        acknowledged: acknowledged.has(e.id),
      });
    }
  }
  const count = (v: FindingVerdict) => rows.filter((r) => r.verdict === v).length;
  const parts = (["unmet", "unclear"] as const)
    .filter((v) => count(v) > 0)
    .map((v) => `${count(v)} ${v}`);
  // RG-P8-12: attributed to AI review and the model that wrote the latest finding.
  const model = [...entries].reverse().find((e) => verdictOf(e.verdict) && e.modelId)?.modelId;
  const title = `${REVIEW_DESK_COPY.heading}${model ? ` · ${model}` : ""} · ${parts.length ? parts.join(", ") : `${count("met")} met`}`;
  return {
    title,
    rows,
    open: rows.filter((r) => r.needsAck && !r.acknowledged).map((r) => r.id),
    met: count("met"),
  };
}

/**
 * RG-P8-10 and models rule 23: why no AI review ran on this change — the
 * `not_reviewed` note recorded in place of findings — or undefined when
 * findings exist or nothing was recorded.
 */
export function reviewerAbsence(entries: readonly FindingEntry[]): string | undefined {
  if (entries.some((e) => verdictOf(e.verdict))) return undefined;
  return [...entries].reverse().find((e) => e.verdict === "not_reviewed")?.text;
}

/**
 * DB-N5-1: the Implementation files in the order a reviewer should read them —
 * files with failures (more first), then files an unmet or unclear finding
 * cites, then by changed lines — never alphabetically; ties keep the diff's order.
 */
export function orderImplementationFiles(
  files: readonly { path: string; added: number; removed: number }[],
  risk: {
    failures?: readonly { location?: { file?: string } }[];
    findings?: readonly FindingEntry[];
  },
): string[] {
  const fails = new Map<string, number>();
  for (const f of risk.failures ?? []) {
    const file = f.location?.file;
    if (file) fails.set(file, (fails.get(file) ?? 0) + 1);
  }
  const flagged = new Set<string>();
  for (const e of risk.findings ?? []) {
    const v = verdictOf(e.verdict);
    if (v === "unmet" || v === "unclear") for (const c of citationsOf(e.text)) flagged.add(c.file);
  }
  const tier = (p: string) => ((fails.get(p) ?? 0) > 0 ? 0 : flagged.has(p) ? 1 : 2);
  return files
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        tier(a.f.path) - tier(b.f.path) ||
        (fails.get(b.f.path) ?? 0) - (fails.get(a.f.path) ?? 0) ||
        b.f.added + b.f.removed - (a.f.added + a.f.removed) ||
        a.i - b.i,
    )
    .map(({ f }) => f.path);
}

/** Consecutive line numbers as `file:a–b` (or `file:a`). */
function ranges(file: string, lines: number[]): string[] {
  const out: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  const flush = () => {
    if (start === undefined || prev === undefined) return;
    out.push(start === prev ? `${file}:${start}` : `${file}:${start}–${prev}`);
  };
  for (const n of [...lines].sort((a, b) => a - b)) {
    if (prev !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    flush();
    start = n;
    prev = n;
  }
  flush();
  return out;
}

/**
 * DB-N5-2: the Reviewer's coverage line — files it read of the changed files,
 * and the changed (added) lines no finding cites — with the files not read
 * and the uncited lines listed. `filesRead` undefined: the Reviewer recorded
 * none, and the line says so instead of claiming it read everything.
 */
export function reviewCoverage(
  files: readonly { path: string; addedLines: readonly number[] }[],
  findings: readonly FindingEntry[],
  filesRead: readonly string[] | undefined,
): { line: string; notRead: string[]; uncited: string[] } {
  const cites = findings.flatMap((e) => citationsOf(e.text));
  const cited = (file: string, line: number) =>
    cites.some((c) => c.file === file && line >= c.from && line <= c.to);
  let changed = 0;
  const uncited: string[] = [];
  for (const f of files) {
    changed += f.addedLines.length;
    const left = f.addedLines.filter((n) => !cited(f.path, n));
    uncited.push(...ranges(f.path, left));
  }
  const uncitedCount = files.reduce(
    (n, f) => n + f.addedLines.filter((l) => !cited(f.path, l)).length,
    0,
  );
  if (!filesRead) {
    return {
      line: REVIEW_DESK_COPY.coverageUnrecorded(uncitedCount, changed),
      notRead: [],
      uncited,
    };
  }
  const read = new Set(filesRead);
  const notRead = files.map((f) => f.path).filter((p) => !read.has(p));
  return {
    line: REVIEW_DESK_COPY.coverageRead(
      files.length - notRead.length,
      files.length,
      uncitedCount,
      changed,
    ),
    notRead,
    uncited,
  };
}

/**
 * DB-N5-3: what keeps Accept disabled — unacknowledged unmet or unclear
 * findings, and Implementation files not yet shown — written beside the
 * button (at most three files named). Empty text: nothing remains.
 */
export function acceptBlockers(input: {
  openFindings: readonly string[];
  implementationFiles: readonly string[];
  shown: ReadonlySet<string>;
}): { findings: number; files: string[]; text: string } {
  const files = input.implementationFiles.filter((f) => !input.shown.has(f));
  const parts: string[] = [];
  if (input.openFindings.length)
    parts.push(REVIEW_DESK_COPY.findingsLeft(input.openFindings.length));
  if (files.length) {
    const names =
      files.slice(0, 3).join(", ") +
      (files.length > 3 ? REVIEW_DESK_COPY.andMore(files.length - 3) : "");
    parts.push(REVIEW_DESK_COPY.filesLeft(files.length, names));
  }
  return { findings: input.openFindings.length, files, text: parts.join(" · ") };
}

/** Who may accept this card, as the server's `accepterVerdict` answers for the viewer. */
export type AcceptVerdict =
  | { may: true }
  | {
      may: false;
      code: "not_permitted" | "not_code_owner";
      who: readonly { principal: string; name?: string }[];
    }
  | {
      may: false;
      code: "not_independent";
      because: "built" | "delegated";
      who: readonly { principal: string; name?: string }[];
    };

/** DB-N5-9: why this viewer may not accept, naming who may; empty when they may. */
/** What Accept's state reads from the page (`store.state`). */
export interface AcceptContext {
  /** False when the server was started without triage. */
  triage?: boolean;
  offline?: boolean;
  /** The ledger's verification (`/api/events`' `verification`); null before the first. */
  ledger?: { valid?: boolean; corruptedSeq?: number } | null;
}

/**
 * Whether Accept is allowed, and the plain reason beside it when it is not
 * (DB-N2-2, DB-P12-3). A ledger that fails verification disables it first,
 * on every surface that offers Accept. `deskReason` is the review desk's own
 * blocker (who may accept, unacknowledged findings, files not yet shown).
 */
export function acceptVerdict(
  ctx: AcceptContext,
  card: { status?: string } | null | undefined,
  evidence: { passed?: boolean } | null | undefined,
  deskReason = "",
): { ok: boolean; reason: string } {
  if (ctx.ledger && ctx.ledger.valid === false) {
    return {
      ok: false,
      reason: `Activity log altered at entry #${ctx.ledger.corruptedSeq ?? "?"}. Inspect before accepting.`,
    };
  }
  if (ctx.triage === false) return { ok: false, reason: "Read-only." };
  if (ctx.offline) return { ok: false, reason: "Offline." };
  if (!evidence) return { ok: false, reason: "Accept needs evidence from a run." };
  if (!evidence.passed) return { ok: false, reason: "Accept needs every check passing." };
  if (!card || card.status !== "review")
    return { ok: false, reason: "Only issues in Review can be accepted." };
  if (deskReason) return { ok: false, reason: deskReason };
  return { ok: true, reason: "" };
}

export function acceptPermissionText(v: AcceptVerdict): string {
  if (v.may) return "";
  const names = v.who.map((w) => w.name || w.principal);
  if (v.code === "not_code_owner") {
    const who = names.length ? names.join(", ") : REVIEW_DESK_COPY.noCodeOwner;
    return `${REVIEW_DESK_COPY.notCodeOwner} Who may accept: ${who}.`;
  }
  const lead =
    v.code === "not_independent"
      ? REVIEW_DESK_COPY.notIndependent(v.because)
      : REVIEW_DESK_COPY.notPermitted;
  return `${lead} ${REVIEW_DESK_COPY.whoMay(names)}`;
}

/** DB-N5-4: a person-built card's outcome line and Facts row; the Worker otherwise. */
export function builtByLabel(builtBy: { kind: string; id: string; name?: string } | undefined): {
  outcome: string;
  fact: string;
} {
  if (builtBy?.kind !== "person") return { outcome: "", fact: REVIEW_DESK_COPY.worker };
  const name = builtBy.name || builtBy.id;
  return { outcome: REVIEW_DESK_COPY.builtBy(name), fact: REVIEW_DESK_COPY.builtByFact(name) };
}

/**
 * DB-N5-7: each base test the card supersedes (`file > name`, gates rule 25a)
 * beside its new version — the staged tests the regression gate named for it
 * in the evidence — in the card's declared order.
 */
export function supersessionRows(
  declared: readonly string[] | undefined,
  accepted: readonly { test: string; staged: readonly string[] }[] | undefined,
): { old: string; new: string }[] {
  const tests = [...(declared ?? [])];
  for (const a of accepted ?? []) if (!tests.includes(a.test)) tests.push(a.test);
  return tests.map((test) => {
    const hit = (accepted ?? []).find((a) => a.test === test);
    return {
      old: test,
      new: hit?.staged.length ? hit.staged.join(", ") : REVIEW_DESK_COPY.supersededNotNeeded,
    };
  });
}

/**
 * DB-N5-8: each test the depth profile requires a person to approve, with its
 * state; an approval voided by a content change reads *Needs approval again*.
 */
export function testApprovalRows(
  approvals: readonly {
    path: string;
    approved: boolean;
    approvedSha256?: string;
    by?: string;
    what?: "file" | "examples";
  }[],
): { path: string; state: "approved" | "needs" | "again"; label: string }[] {
  return approvals.map((a) =>
    a.approved
      ? {
          path: a.path,
          state: "approved" as const,
          label: REVIEW_DESK_COPY.approved(a.by ?? "a person", a.what),
        }
      : a.approvedSha256
        ? { path: a.path, state: "again" as const, label: REVIEW_DESK_COPY.needsApprovalAgain }
        : { path: a.path, state: "needs" as const, label: REVIEW_DESK_COPY.needsApproval },
  );
}

/** What a line of Accept's checklist is about, so a page can link it to where it is met. */
export type ChecklistKind =
  | "findings"
  | "files"
  | "thread"
  | "conversation"
  | "who"
  | "checks"
  | "refused"
  | "other";

export interface ChecklistItem {
  kind: ChecklistKind;
  text: string;
  /** False for a line that informs and keeps nothing disabled (an open conversation). */
  blocking: boolean;
}

/** "1 open conversation": the review threads still open (FINDINGS REV-03). */
export function openConversations(desk: ThreadDesk | null | undefined): string {
  const n = (desk?.threads ?? []).filter((t) => !t.resolved).length;
  return n ? `${n} open ${n === 1 ? "conversation" : "conversations"}` : "";
}

/**
 * Accept's conditions as a checklist above the triage bar — GitHub's merge
 * box (FINDINGS REV-02; dashboard §2.5.9): one line per thing that keeps
 * Accept disabled, each with its kind so a page links it to where it is met
 * (dashboard §8 question 7), then the open conversations, which inform and
 * do not block unless the project requires resolved threads (REV-03). A
 * refusal from the server leads, where it happened (§A Error messages).
 */
export function acceptChecklist(
  reason: string,
  desk?: ThreadDesk | null,
  refused?: string,
): ChecklistItem[] {
  const kindOf = (t: string): ChecklistKind =>
    / to acknowledge$/.test(t)
      ? "findings"
      : / not yet shown/.test(t)
        ? "files"
        : /review thread/.test(t)
          ? "thread"
          : /accept|Accept-holder|code owner/i.test(t) && !/^Accept needs/.test(t)
            ? "who"
            : /check/i.test(t)
              ? "checks"
              : "other";
  const items: ChecklistItem[] = [];
  if (refused) items.push({ kind: "refused", text: refused, blocking: true });
  for (const part of reason ? reason.split(" · ") : []) {
    items.push({ kind: kindOf(part), text: part, blocking: true });
  }
  const open = openConversations(desk);
  if (open && !items.some((i) => i.kind === "thread"))
    items.push({ kind: "conversation", text: open, blocking: false });
  return items;
}
