import { createHash } from "node:crypto";
import { ERASED_MARKER, type EventLog } from "@sekhemet/kernel";
import { type Ecosystem, dependencyFile, resolveDependency } from "@sekhemet/loop";
import { pageChunks } from "./docs.js";
import { documentsVersion } from "./pinned_docs.js";
import { ResearchCache } from "./polite.js";
import { codeNames, confirmMember, researcherCode } from "./probe.js";
import { researchCopy } from "./research_copy.js";
import { htmlToText } from "./web.js";

/**
 * Durable research notes (design-stage DS-N9-19 to -22, DEC-59): what the
 * research packet learned about one symbol of one package at one version,
 * kept as ledger events — `research/note_admitted`, `research/note_retired`,
 * `research/note_fed` — beside the fetched-bytes cache, and no other store
 * (DEC-59 a; context rule 23). A note is admitted only by a model-free check
 * and reaches a card as cited research data, never as a rule (DEC-59 b).
 * The fold is evaluated lazily: the packet reads it, retires what no longer
 * holds (a lockfile change, a fed card that failed on it, a changed source)
 * and records each retirement, so a replay shows why a note stopped.
 */

export const NOTE_EVENTS = {
  admitted: "research/note_admitted",
  retired: "research/note_retired",
  fed: "research/note_fed",
} as const;

/** What a note is about: eco, package, version and the symbol a card named. */
export interface NoteKey {
  eco: Ecosystem;
  pkg: string;
  version: string;
  /** The symbol relative to the package (`email`, `ZodString.emale`). */
  symbol: string;
}

/** A flag's key, with the identifier the installed API lacks (its last missing part). */
export interface NoteSubject extends NoteKey {
  missing: string;
}

export type NoteCitation =
  | { kind: "local"; ref: string; file: string; line: number; fileSha256: string }
  | {
      kind: "web";
      ref: string;
      url: string;
      cacheKey: string;
      sha256: string;
      pageSha256: string;
      fetchedAt: string;
    }
  | { kind: "probe"; ref: string; sha256: string };

export type NoteCheck =
  | { kind: "citation"; detail: "symbol present in excerpt; hash matches source" }
  | { kind: "probe"; codeSha256: string; language: "node" | "python"; exitCode: 0 };

export interface ResearchNote {
  noteId: string;
  symbol: string;
  missing: string;
  ecosystem: Ecosystem;
  package: string;
  version: string;
  citation: NoteCitation;
  check: NoteCheck;
  at: string;
  answeredBy: "local" | "researcher";
  model?: string;
  /** Templated from the symbol and `pkg@ver` (private part). */
  question: string;
  /** At most 600 characters, untrusted (private part). */
  excerpt: string;
}

export interface LiveNote extends ResearchNote {
  seq: number;
  /** The private part was erased: a gap, never fed. */
  erased: boolean;
  fed: { cardId: string; seq: number }[];
}

export interface NoteFold {
  live: Map<string, LiveNote>;
}

export type RetireReason = "lockfile" | "card_failed" | "source_changed" | "erased" | "person";

export interface RetiredNote {
  noteId: string;
  reason: RetireReason;
  detail: string;
  cardId?: string;
}

const EXCERPT_CHARS = 600;
const CITED = "symbol present in excerpt; hash matches source" as const;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `rn_` and the first 16 hex of SHA-256(eco|pkg|ver|symbol) (DS-N9-19). */
export function noteId(eco: Ecosystem, pkg: string, version: string, symbol: string): string {
  return `rn_${sha256(`${eco}|${pkg}|${version}|${symbol}`).slice(0, 16)}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name` as a whole identifier in `text`. */
export function namesIdentifier(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(text);
}

/** The question a note answers: the packet's, from the symbol and `pkg@ver` only. */
export function noteQuestion(key: NoteKey): string {
  return researchCopy.packetQuestion(key.symbol, key.pkg, key.version, key.eco);
}

/** Every note, as the ledger holds it: admitted, retired and fed, in order. */
export async function readNotes(log: EventLog): Promise<NoteFold> {
  const events = await log.getEventsByTypes(Object.values(NOTE_EVENTS));
  const live = new Map<string, LiveNote>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const id = String(p.noteId ?? "");
    if (e.type === NOTE_EVENTS.admitted) {
      const priv = (e.private ?? {}) as Record<string, unknown>;
      const excerpt = typeof priv.excerpt === "string" ? priv.excerpt : ERASED_MARKER;
      const question = typeof priv.question === "string" ? priv.question : ERASED_MARKER;
      live.set(id, {
        noteId: id,
        symbol: String(p.symbol),
        missing: String(p.missing),
        ecosystem: p.ecosystem as Ecosystem,
        package: String(p.package),
        version: String(p.version),
        citation: p.citation as NoteCitation,
        check: p.check as NoteCheck,
        at: String(p.at),
        answeredBy: p.answeredBy === "researcher" ? "researcher" : "local",
        ...(typeof p.model === "string" ? { model: p.model } : {}),
        question,
        excerpt,
        seq: e.seq,
        erased: excerpt === ERASED_MARKER,
        fed: [],
      });
    } else if (e.type === NOTE_EVENTS.retired) {
      live.delete(id);
    } else if (e.type === NOTE_EVENTS.fed) {
      live.get(id)?.fed.push({ cardId: String(p.cardId), seq: e.seq });
    }
  }
  return { live };
}

/** Record a note's retirement, and drop it from the fold (DS-N9-21). */
export async function retireNote(
  log: EventLog,
  fold: NoteFold | undefined,
  r: RetiredNote,
): Promise<void> {
  await log.append({
    actor: "harness",
    type: NOTE_EVENTS.retired,
    ...(r.cardId ? { cardId: r.cardId } : {}),
    payload: { noteId: r.noteId, reason: r.reason, ...(r.cardId ? { cardId: r.cardId } : {}) },
    private: { detail: r.detail.slice(0, 500) },
  });
  fold?.live.delete(r.noteId);
}

/** A note reached a card's dossier (DS-N9-22). */
export async function recordNoteFed(log: EventLog, id: string, cardId: string): Promise<void> {
  await log.append({
    actor: "harness",
    type: NOTE_EVENTS.fed,
    cardId,
    payload: { noteId: id, cardId },
  });
}

/**
 * The compiler and runtime errors that name a missing member or import:
 * TypeScript TS2339/TS2305/TS2724, Python AttributeError/ImportError/
 * ModuleNotFoundError, Go `undefined:` and Rust E0425/E0599/E0432 (design
 * call 3). A line counts only when it also names the note's identifier.
 */
const MISSING_API_ERROR =
  /\bTS(?:2339|2305|2724)\b|\b(?:AttributeError|ImportError|ModuleNotFoundError)\b|\bundefined:|\bE0(?:425|599|432)\b/;

/** Whether a gate's output names `missing` on the line of a missing-API error. */
export function failureNames(text: string, missing: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => MISSING_API_ERROR.test(line) && namesIdentifier(line, missing));
}

/** The text a recorded gate failure carries, whatever its shape. */
function failureText(failure: unknown): string {
  if (typeof failure === "string") return failure;
  if (!failure || typeof failure !== "object") return "";
  const f = failure as Record<string, unknown>;
  const parts = ["errorExcerpt", "actual", "message", "detail"]
    .map((k) => f[k])
    .filter((v): v is string => typeof v === "string");
  return parts.length ? parts.join("\n") : JSON.stringify(failure);
}

/**
 * Retire what no longer holds, recording each (DS-N9-21): a note whose
 * `pkg@ver` is neither installed nor pinned any more, and a note a card it
 * fed has since failed on, by a gate excerpt naming its identifier. Returns
 * what it retired; the fold is updated in place.
 */
export async function retireStale(
  repo: string,
  log: EventLog,
  fold: NoteFold,
): Promise<RetiredNote[]> {
  const out: RetiredNote[] = [];
  for (const note of [...fold.live.values()]) {
    const dep = resolveDependency(repo, `${note.ecosystem}:${note.package}`);
    const held = new Set(
      [dep?.installedVersion, ...(dep?.pinnedVersion?.split(", ") ?? [])].filter((v): v is string =>
        Boolean(v),
      ),
    );
    if (!held.has(note.version)) {
      const r: RetiredNote = {
        noteId: note.noteId,
        reason: "lockfile",
        detail: `${note.package}@${note.version} is neither installed nor pinned now (${held.size ? [...held].join(", ") : "absent"})`,
      };
      await retireNote(log, fold, r);
      out.push(r);
      continue;
    }
    const failed = await failedOn(log, note);
    if (failed) {
      await retireNote(log, fold, failed);
      out.push(failed);
    }
  }
  return out;
}

async function failedOn(log: EventLog, note: LiveNote): Promise<RetiredNote | undefined> {
  for (const fed of note.fed) {
    const results = await log.getEventsByCardAndTypes(fed.cardId, ["gate/result"]);
    for (const e of results) {
      if (e.seq <= fed.seq) continue;
      const p = e.payload as { passed?: boolean; failures?: unknown[] };
      if (p.passed !== false) continue;
      const excerpt = (p.failures ?? [])
        .map(failureText)
        .find((t) => failureNames(t, note.missing));
      if (excerpt)
        return {
          noteId: note.noteId,
          reason: "card_failed",
          cardId: fed.cardId,
          detail: excerpt.slice(0, 400),
        };
    }
  }
  return undefined;
}

/** The whole text of a file inside an installed dependency, or undefined. */
function dependencyText(repo: string, key: NoteKey, file: string): string | undefined {
  const dep = resolveDependency(repo, `${key.eco}:${key.pkg}`);
  if (!dep?.installed || dep.version !== key.version) return undefined;
  const read = dependencyFile(dep, file, 50_000_000);
  return read.ok && !read.truncated ? read.text : undefined;
}

/** A cached page's raw bytes and the text its chunks are cut from. */
function cachedPage(
  cache: ResearchCache,
  key: string,
): { body: string; text: string; at: number } | undefined {
  const e = cache.entry(key);
  if (!e || e.status >= 400) return undefined;
  const html = /html/i.test(e.type) || /^\s*</.test(e.body);
  return { body: e.body, text: html ? htmlToText(e.body) : e.body, at: e.at };
}

/**
 * Whether a note's source still holds what it was admitted on (DS-N9-20):
 * the local file's hash, or the cached page's and its chunk's. A probe's
 * program is in the ledger itself. Undefined: the source cannot be read
 * now (the cache was cleared), so the note is left alone and not fed.
 */
function sourceHolds(repo: string, note: ResearchNote, cache: ResearchCache): boolean | undefined {
  const c = note.citation;
  if (c.kind === "probe") return true;
  if (c.kind === "local") {
    const text = dependencyText(
      repo,
      { eco: note.ecosystem, pkg: note.package, version: note.version, symbol: note.symbol },
      c.file,
    );
    if (text === undefined) return undefined;
    return sha256(text) === c.fileSha256;
  }
  const page = cachedPage(cache, c.cacheKey);
  if (!page) return undefined;
  return (
    sha256(page.body) === c.pageSha256 &&
    pageChunks(page.text).some((k) => sha256(k.text) === c.sha256)
  );
}

/**
 * The live note for a key, its source re-checked first (DS-N9-20); a
 * mismatch retires it as `source_changed`. Undefined when there is none, it
 * was erased, or its source cannot be read now.
 */
export async function reuseNote(
  repo: string,
  log: EventLog,
  fold: NoteFold,
  key: NoteKey,
  cache = new ResearchCache(),
): Promise<LiveNote | undefined> {
  const note = fold.live.get(noteId(key.eco, key.pkg, key.version, key.symbol));
  if (!note) return undefined;
  if (note.erased) {
    // DS-N9-20: a gap on replay, never fed; the flag is answered afresh.
    await retireNote(log, fold, {
      noteId: note.noteId,
      reason: "erased",
      detail: `the question and excerpt of ${note.noteId} were erased (ledger/erased)`,
    });
    return undefined;
  }
  const holds = sourceHolds(repo, note, cache);
  if (holds === undefined) return undefined;
  if (!holds) {
    await retireNote(log, fold, {
      noteId: note.noteId,
      reason: "source_changed",
      detail: `the source of ${note.citation.ref} changed since the note was admitted`,
    });
    return undefined;
  }
  return note;
}

async function admit(
  log: EventLog,
  repo: string,
  subject: NoteSubject,
  fields: Pick<ResearchNote, "citation" | "check" | "answeredBy" | "excerpt"> & { model?: string },
): Promise<ResearchNote> {
  const id = noteId(subject.eco, subject.pkg, subject.version, subject.symbol);
  const existing = (await readNotes(log)).live.get(id);
  // An erased note is a gap, never handed back: a fresh admission replaces it.
  if (existing && !existing.erased) return existing;
  const note: ResearchNote = {
    noteId: id,
    symbol: subject.symbol,
    missing: subject.missing,
    ecosystem: subject.eco,
    package: subject.pkg,
    version: subject.version,
    citation: fields.citation,
    check: fields.check,
    at: new Date().toISOString(),
    answeredBy: fields.answeredBy,
    ...(fields.model ? { model: fields.model } : {}),
    question: noteQuestion(subject),
    excerpt: fields.excerpt.slice(0, EXCERPT_CHARS),
  };
  const { question, excerpt, ...payload } = note;
  await log.append({
    actor: fields.answeredBy === "researcher" ? "researcher" : "harness",
    type: NOTE_EVENTS.admitted,
    payload,
    private: { question, excerpt, repo },
  });
  return note;
}

/** One declaration the packet found in the installed package (DS-N9-16). */
export interface LocalMember {
  name: string;
  container?: string;
  signature: string;
  /** Relative to the package root. */
  file: string;
  line: number;
  /** `deps:<eco>:<pkg>@<ver>/<file>:<line>`. */
  ref: string;
  fileSha256: string;
}

/**
 * Admit a local answer (DS-N9-19): its cited line holds the identifier the
 * card named, verbatim, and the file's hash still matches what was read.
 */
export async function admitLocalNote(
  repo: string,
  log: EventLog,
  o: { flag: NoteSubject; member: LocalMember },
): Promise<ResearchNote | undefined> {
  const { flag, member } = o;
  const text = dependencyText(repo, flag, member.file);
  if (text === undefined || sha256(text) !== member.fileSha256) return undefined;
  const line = text.split(/\r?\n/)[member.line - 1] ?? "";
  if (!namesIdentifier(line, flag.missing)) return undefined;
  return admit(log, repo, flag, {
    citation: {
      kind: "local",
      ref: member.ref,
      file: member.file,
      line: member.line,
      fileSha256: member.fileSha256,
    },
    check: { kind: "citation", detail: CITED },
    answeredBy: "local",
    excerpt: `${member.container ? `${member.container}: ` : ""}${line.trim()}`,
  });
}

/** A source as the Researcher's answer types it. */
export interface AnswerSource {
  kind: string;
  ref: string;
  excerpt?: string;
}

/** What the packet keeps of a Researcher's answer. */
export interface PacketAnswer {
  answer: string;
  sources: string[];
  grounded: boolean;
  evidence?: AnswerSource[];
  /** The answer's probe claims (DS-N9-13), read through `isReproducedProbe`. */
  probeClaims?: unknown[];
}

/** A probe claim that ran and exited 0, with the program that ran (DS-N9-17, -18). */
export interface ReproducedProbe {
  id: string;
  kind: "executable";
  text: string;
  reproduce: { language: "node" | "python"; code: string };
}

/**
 * The narrow guard over the Researcher's probe claims: only D's claim for a
 * probe that ran and exited 0 carries `reproduce`; a documented Go or Rust
 * claim carries `unreproducible` instead and admits nothing.
 */
export function isReproducedProbe(c: unknown): c is ReproducedProbe {
  if (!c || typeof c !== "object") return false;
  const x = c as Record<string, unknown>;
  const r = x.reproduce as Record<string, unknown> | undefined;
  return (
    typeof x.id === "string" &&
    x.id.startsWith("probe_") &&
    x.kind === "executable" &&
    typeof x.text === "string" &&
    x.unreproducible === undefined &&
    !!r &&
    typeof r === "object" &&
    (r.language === "node" || r.language === "python") &&
    typeof r.code === "string"
  );
}

/** A window of `text` around the first whole-identifier `name`, at most 600 characters. */
function around(text: string, name: string): string {
  const m = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).exec(text);
  if (!m) return text.slice(0, EXCERPT_CHARS);
  const start = Math.max(0, m.index - 250);
  return text.slice(start, start + EXCERPT_CHARS);
}

/** The first cached chunk of a cited page that names the identifier. */
function webCitation(
  subject: NoteSubject,
  answer: PacketAnswer,
  cache: ResearchCache,
): { citation: NoteCitation; excerpt: string } | undefined {
  const refs = [
    ...(answer.evidence ?? []).map((e) => e.ref),
    ...answer.sources.map((s) => s.replace(/^\[\d+\]\s*/, "")),
  ];
  for (const ref of [...new Set(refs)]) {
    if (!/^https?:\/\//.test(ref)) continue;
    const url = ref.split("#")[0] as string;
    // DS-N9-24: only a page that documents this exact version by its URL.
    if (!documentsVersion(url, subject.eco, subject.pkg, subject.version)) continue;
    for (const cacheKey of [`crawl:${url}`, url]) {
      const page = cachedPage(cache, cacheKey);
      if (!page) continue;
      const chunk = pageChunks(page.text).find((k) => namesIdentifier(k.text, subject.missing));
      if (!chunk) continue;
      return {
        citation: {
          kind: "web",
          ref: `${url}${chunk.anchor ? `#${chunk.anchor}` : ""}`,
          url,
          cacheKey,
          sha256: sha256(chunk.text),
          pageSha256: sha256(page.body),
          fetchedAt: new Date(page.at).toISOString(),
        },
        excerpt: around(chunk.text, subject.missing),
      };
    }
  }
  return undefined;
}

/**
 * Admit a Researcher's answer (DS-N9-19) when, model-free, a page it read
 * is in the cache with a chunk naming the identifier, or a probe it ran
 * exited 0 at this `pkg@ver` with a program naming it. Otherwise undefined:
 * the answer reaches the dossier as plain research and is never a note.
 */
export async function admitResearchNote(
  repo: string,
  log: EventLog,
  o: { flag: NoteSubject; answer: PacketAnswer; model?: string },
  cache = new ResearchCache(),
): Promise<ResearchNote | undefined> {
  const { flag, answer } = o;
  const target = `${flag.pkg}@${flag.version}`;
  // DS-N9-19, -25: the Researcher's own code (the harness's prelude, its
  // comments and strings left out) names the identifier, and the harness's
  // own existence check of it exits 0 in the packet's sandbox.
  let probe: { claim: ReproducedProbe; code: string } | undefined;
  for (const c of (answer.probeClaims ?? []).filter(isReproducedProbe)) {
    if (!c.text.endsWith(`(reproduced at ${target})`)) continue;
    const code = researcherCode(c.reproduce.language, c.reproduce.code);
    if (code === undefined || !codeNames(c.reproduce.language, code, flag.missing)) continue;
    if (!(await confirmMember(repo, flag.eco, flag.pkg, flag.version, flag.symbol))) break;
    probe = { claim: c, code };
    break;
  }
  const web = webCitation(flag, answer, cache);
  if (!probe && !web) return undefined;
  const fields = {
    answeredBy: "researcher" as const,
    ...(o.model ? { model: o.model } : {}),
  };
  if (probe) {
    const { claim } = probe;
    const codeSha256 = sha256(claim.reproduce.code);
    const lines = probe.code.split(/\r?\n/).filter((l) => namesIdentifier(l, flag.missing));
    return admit(log, repo, flag, {
      ...fields,
      citation: web?.citation ?? { kind: "probe", ref: `probe:${claim.id}`, sha256: codeSha256 },
      check: { kind: "probe", codeSha256, language: claim.reproduce.language, exitCode: 0 },
      excerpt: web?.excerpt ?? `${claim.text}\n${lines.join("\n")}`,
    });
  }
  const w = web as NonNullable<typeof web>;
  return admit(log, repo, flag, {
    ...fields,
    citation: w.citation,
    check: { kind: "citation", detail: CITED },
    excerpt: w.excerpt,
  });
}
