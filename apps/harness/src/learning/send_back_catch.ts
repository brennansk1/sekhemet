import { clopperPearson } from "@sekhemet/eval";
import type { CardStore, DossierEntry } from "@sekhemet/kernel";

/**
 * How often the AI review had already found what a person sent an issue back
 * for (review-git RG-P8-14; RESEARCH_REGISTER R8, AutoDev's reviewer against
 * the lead's preferences): the share of send-back reasons a finding caught
 * before the person saw the issue, against R8's adoption threshold of one in
 * five.
 *
 * Read from the ledger alone, per issue and per send-back:
 * - a **reason** is one `send_back` dossier entry a person wrote — the note
 *   itself and each line comment, each its own reason;
 * - the **findings before the person saw it** are the AI review's `unmet` or
 *   `unclear` entries the model wrote and cited — a checked `(file:line)`
 *   closes the entry — recorded after the issue's previous send-back and
 *   before this one, and before the first `review/opened` of the issue in
 *   that window (a review the person could not have read first is not
 *   counted). The harness's own entries are not the model's findings and
 *   never count: a skipped criterion's uncited `unclear`, and the fail-only
 *   `no test:` check (as RG-P8-13's scorer excludes them);
 * - a reason is **caught** when one of those findings names what it names: a
 *   finding cited in the file the reason names (within
 *   {@link LINE_TOLERANCE} lines when the reason names a line), or the
 *   finding's own note or location holding a symbol the reason names in
 *   backticks or as an identifier — never the criterion it restates, which
 *   the person wrote;
 * - the reasons a `preference:` finding caught are counted apart
 *   (`caughtByPreference`), the part RG-P8-14 and R8 name; the verdict is on
 *   every cited model finding.
 * A reason that names no file and no symbol cannot be matched without a
 * judge and is counted as not caught, and reported apart, so the share is
 * never raised by guessing.
 */

/** R8's adoption threshold: at least one send-back reason in five caught. */
export const R8_THRESHOLD = 0.2;
/** Below this many reasons the share is shown but no verdict is given. */
export const MIN_REASONS = 5;
/** How far a finding's cited line may be from a line the reason names. */
export const LINE_TOLERANCE = 3;

export interface ReasonAnchors {
  files: { path: string; line?: number }[];
  symbols: string[];
}

const FILE =
  /((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:[cm]?[jt]sx?|json|md|py|rs|go|java|kt|rb|php|cs|c|h|cpp|hpp|swift|css|scss|html|vue|svelte|sql|sh|toml|ya?ml))(?::(\d+))?\b/g;
const BACKTICK = /`([^`\s][^`]*)`/g;
const IDENTIFIER = /\b(?:[a-z]+[A-Z]\w*|[a-z]+_[a-z0-9_]+|\w+\(\))/g;

/** What a send-back reason names that a finding could match. */
export function reasonAnchors(reason: string): ReasonAnchors {
  const files: ReasonAnchors["files"] = [];
  for (const m of reason.matchAll(FILE)) {
    const path = (m[1] as string).replace(/^[ab]\//, "");
    files.push(m[2] ? { path, line: Number(m[2]) } : { path });
  }
  const symbols = new Set<string>();
  for (const m of reason.matchAll(BACKTICK)) {
    const s = (m[1] as string).trim();
    if (!files.some((f) => s.startsWith(f.path)) && s.length >= 3) symbols.add(s);
  }
  const withoutFiles = reason.replace(FILE, " ");
  for (const m of withoutFiles.matchAll(IDENTIFIER)) {
    const s = m[0].replace(/\(\)$/, "");
    if (s.length >= 3) symbols.add(s);
  }
  return { files, symbols: [...symbols] };
}

/** Where a finding's text cites: the `(file:line)` `findingText` ends with. */
function citedAt(text: string): { path: string; line: number } | undefined {
  const m = /\(((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)\)\s*$/.exec(text);
  return m ? { path: m[1] as string, line: Number(m[2]) } : undefined;
}

/** Whether a review entry is a finding the model wrote and cited (not the harness's own). */
export function isModelFinding(text: string): boolean {
  return citedAt(text) !== undefined && !/^no test:/i.test(text.trim());
}

/**
 * The part of a finding the model wrote: its note and location, after the
 * criterion it restates (`<criterion> — <note> (<file:line>)`). The card's
 * own criteria are stripped exactly; otherwise the text up to the first ` — `.
 */
export function modelPart(finding: string, criteria: readonly string[] = []): string {
  for (const c of criteria)
    if (c && finding.startsWith(`${c} — `)) return finding.slice(c.length + 3);
  const i = finding.indexOf(" — ");
  return i >= 0 ? finding.slice(i + 3) : (/\([^()]*\)\s*$/.exec(finding)?.[0] ?? "");
}

/** Whether one AI review finding names what a send-back reason names. */
export function findingCatches(
  finding: string,
  anchors: ReasonAnchors,
  criteria: readonly string[] = [],
): boolean {
  const at = citedAt(finding);
  for (const f of anchors.files) {
    if (!at) continue;
    const same =
      at.path === f.path || at.path.endsWith(`/${f.path}`) || f.path.endsWith(`/${at.path}`);
    if (same && (f.line === undefined || Math.abs(at.line - f.line) <= LINE_TOLERANCE)) return true;
  }
  const own = modelPart(finding, criteria);
  return anchors.symbols.some((s) => own.includes(s));
}

export interface SendBackReason {
  cardId: string;
  entryId: string;
  text: string;
  anchored: boolean;
  caught: boolean;
  /** The finding entries that caught it. */
  by: string[];
  /** Whether a `preference:` finding was among them. */
  byPreference?: boolean;
}

export interface SendBackCatchReport {
  reasons: SendBackReason[];
  total: number;
  caught: number;
  /** Of `caught`, the reasons a `preference:` finding caught (R8's part). */
  caughtByPreference: number;
  unanchored: number;
  share: number;
  interval: { low: number; high: number };
  verdict: "meets" | "below" | "too_few";
  line: string;
}

const LOOKED_AT = new Set(["unmet", "unclear"]);

/** The share of send-back reasons the AI review caught first (RG-P8-14). */
export async function sendBackCatches(
  cardStore: Pick<CardStore, "listCards" | "getDossier" | "cardEvents">,
): Promise<SendBackCatchReport> {
  const reasons: SendBackReason[] = [];
  for (const card of await cardStore.listCards()) {
    const dossier = await cardStore.getDossier(card.id);
    const entries = [...dossier.entries].sort((a, b) => a.seq - b.seq);
    if (!entries.some((e) => e.kind === "send_back" && e.actor === "human")) continue;
    const opened = (await cardStore.cardEvents(card.id, ["review/opened"])).map((e) => e.seq);
    // One send-back decision writes its note and its line comments together;
    // they share one window: after the previous decision, up to this one.
    let windowStart = 0;
    let lastBack = 0;
    let previous: DossierEntry | undefined;
    for (const back of entries) {
      const isBack = back.kind === "send_back" && back.actor === "human";
      const continues = previous?.kind === "send_back" && previous.actor === "human";
      previous = back;
      if (!isBack) continue;
      if (!continues) windowStart = lastBack;
      lastBack = back.seq;
      const firstOpen = opened.find((s) => s > windowStart && s < back.seq);
      const before = firstOpen ?? back.seq;
      const findings = entries.filter(
        (e) =>
          e.kind === "review" &&
          e.seq > windowStart &&
          e.seq < before &&
          LOOKED_AT.has(e.verdict ?? "") &&
          isModelFinding(e.text),
      );
      const anchors = reasonAnchors(back.text);
      const anchored = anchors.files.length > 0 || anchors.symbols.length > 0;
      const catching = anchored
        ? findings.filter((f) => findingCatches(f.text, anchors, card.acceptanceCriteria ?? []))
        : [];
      reasons.push({
        cardId: card.id,
        entryId: back.entryId,
        text: back.text,
        anchored,
        caught: catching.length > 0,
        by: catching.map((f) => f.entryId),
        byPreference: catching.some((f) => /^preference:/i.test(f.text)),
      });
    }
  }
  return sendBackReport(reasons);
}

/** The share, its interval and the verdict against R8's one in five. */
export function sendBackReport(reasons: SendBackReason[]): SendBackCatchReport {
  const total = reasons.length;
  const caught = reasons.filter((r) => r.caught).length;
  const caughtByPreference = reasons.filter((r) => r.caught && r.byPreference).length;
  const unanchored = reasons.filter((r) => !r.anchored).length;
  const share = total ? caught / total : 0;
  const interval = clopperPearson(caught, total);
  const verdict = total < MIN_REASONS ? "too_few" : share >= R8_THRESHOLD ? "meets" : "below";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const line =
    total === 0
      ? "No send-backs yet: nothing to measure the AI review against."
      : `The AI review had already found ${caught} of ${total} send-back reasons before a person opened the issue (${pct(share)}, 95% interval ${pct(interval.low)}–${pct(interval.high)}; ${caughtByPreference} by a preference finding)${unanchored ? `; ${unanchored} named no file or symbol and could not be matched` : ""}. ${
          verdict === "too_few"
            ? `Fewer than ${MIN_REASONS} reasons: no verdict against R8's one in five yet.`
            : verdict === "meets"
              ? "Meets R8's threshold of one in five."
              : "Below R8's threshold of one in five."
        }`;
  return { reasons, total, caught, caughtByPreference, unanchored, share, interval, verdict, line };
}
