import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createSourceIndex, factsOfText } from "@sekhemet/gates";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import {
  type ApiSurface,
  type Ecosystem,
  type InstalledDependency,
  declaredDependencies,
  dependencyApi,
  dependencyDeclarations,
  dependencyFile,
  dependencyFiles,
  goAlias,
  goImports,
  pythonImports,
  resolveDependency,
} from "@sekhemet/loop";
import {
  type LiveNote,
  type LocalMember,
  type NoteFold,
  type NoteSubject,
  type PacketAnswer,
  type ResearchNote,
  admitLocalNote,
  admitResearchNote,
  readNotes,
  recordNoteFed,
  retireStale,
  reuseNote,
} from "./notes.js";
import { researchCopy } from "./research_copy.js";
import type { DeepAnswer } from "./reuse.js";

/**
 * The research packet (design-stage DS-N9-15, -16, -20, -22): when a plan
 * creates cards, the members and packages a card names that the installed
 * dependencies do not have are flagged without a model, answered locally
 * first (the installed package's own declarations, or a research note
 * re-checked against its source), and only then put to the Researcher in
 * the plan's one Researcher load, with a question holding the symbol and
 * `pkg@ver` alone. Each answer reaches the card as one cited `card/research`
 * dossier entry; the Worker stays offline.
 */

export type { PacketAnswer } from "./notes.js";

export const PACKET_EVENT = "research/packet";

/** Flags per card at most (DS-N9-15). */
export const PACKET_MAX_FLAGS = 4;
/**
 * Researcher questions per plan at most (DS-N9-16): each is a quick-effort
 * answer with web egress inside the one planning swap, so a large plan does
 * not turn that swap into a long session. The rest are answered locally.
 */
export const PACKET_MAX_QUESTIONS = 8;
/** Near members per answer at most (DS-N9-16). */
const NEAR_MAX = 3;
/** A dossier entry's characters at most (DS-N9-22; the runner's line). */
const ENTRY_CHARS = 400;

export interface PacketFlag extends NoteSubject {
  cardId: string;
  /** `member`: a qualified reference; `package`: a backticked package name. */
  kind: "member" | "package";
  /** As the card wrote it (`zod.email`, `email-validator`). */
  written: string;
}

/** A Researcher's answer for one packet question, or why it failed. */
export type PacketOutcome = PacketAnswer | { failed: string };

/**
 * One Researcher load for the plan (DS-P7-10, DS-N9-16): the brief's deep
 * question, when there is one, and the packet's questions, answered in order
 * before the model is released.
 */
export type PlanResearcherBatch = (q: {
  deep?: string;
  packet: readonly string[];
}) => Promise<{
  deep?: DeepAnswer | { failed: string };
  packet: PacketOutcome[];
  /** The Researcher's model id, for the notes it answers. */
  model?: string;
}>;

// ------------------------------------------------------------- references

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** `a.b`, `a.b(`, `a::b`, `a.b.c`, not inside a path, a URL or a longer chain. */
const QUALIFIED = /(?<![\w$.:)\]/@\\-])([A-Za-z_$][\w$]*)((?:(?:\.|::)[A-Za-z_$][\w$]*)+)/g;
/** File extensions: `schema.ts` is a file, not a member. */
const FILE_EXT = new Set(
  "ts tsx js jsx mjs cjs mts cts d json md mdx txt toml yaml yml lock py pyi rs go mod sum html css scss sql sh env cfg ini xml csv log png svg".split(
    " ",
  ),
);
const PACKAGE_WORD =
  /\b(?:package|packages|library|libraries|crate|crates|dependency|dependencies)\b/i;

interface Mention {
  at: number;
  kind: "member" | "package";
  written: string;
  head?: string;
  rest?: string[];
}

/** The qualified references and backticked package names of one text, in order. */
export function mentionsIn(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(QUALIFIED)) {
    const rest = (m[2] as string).split(/::|\./).filter(Boolean);
    if (rest.length === 1 && FILE_EXT.has((rest[0] as string).toLowerCase())) continue;
    out.push({ at: m.index ?? 0, kind: "member", written: m[0], head: m[1] as string, rest });
  }
  for (const m of text.matchAll(/`([^`\n]{1,120})`/g)) {
    const name = (m[1] as string).trim();
    const at = m.index ?? 0;
    const scoped = /^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(name);
    const goPath = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[\w.~/-]+$/.test(name);
    const plain =
      /^[A-Za-z0-9][\w.-]*$/.test(name) &&
      !/^\d[\d.]*$/.test(name) &&
      !(name.includes(".") && FILE_EXT.has(name.split(".").at(-1)?.toLowerCase() ?? "")) &&
      PACKAGE_WORD.test(text.slice(Math.max(0, at - 60), at + name.length + 62));
    if (scoped || goPath || plain) out.push({ at, kind: "package", written: name });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------- heads

interface Head {
  /** `eco:name`, as `resolveDependency` reads it. */
  spec: string;
  /** `package`/`namespace`: the head is the module; `named`: an imported name of it. */
  kind: "package" | "namespace" | "named";
  imported?: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".sekhemet",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go)$/;
const MAX_SOURCE_FILES = 400;

function sourceFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_SOURCE_FILES || depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_SOURCE_FILES) return;
      if (SKIP_DIRS.has(n) || n.startsWith(".")) continue;
      const full = join(dir, n);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (SOURCE.test(n) && !n.endsWith(".d.ts") && st.size <= 256 * 1024) out.push(full);
    }
  };
  walk(repo, 0);
  return out;
}

/** An import specifier's package: `@scope/name`, or its first element; undefined when relative. */
function npmPackageOf(specifier: string): string | undefined {
  if (/^(?:\.|\/|node:|#)/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The names a card may use for an installed dependency: its own names and
 * aliases (a Python distribution's import names, a crate's `_` form, a Go
 * module's last element), and the aliases this repository's imports bind.
 */
export function headsOf(repo: string): Map<string, Head> {
  const heads = new Map<string, Head>();
  const add = (name: string, head: Head) => {
    if (IDENT.test(name) && !heads.has(name)) heads.set(name, head);
  };
  const declared = declaredDependencies(repo);
  for (const d of declared) {
    const spec = `${d.eco}:${d.name}`;
    for (const n of [d.name, ...d.aliases]) add(n, { spec, kind: "package" });
    if (d.eco === "python")
      for (const n of resolveDependency(repo, spec)?.entries ?? [])
        add(n, { spec, kind: "package" });
  }
  const goModules = declared.filter((d) => d.eco === "go").map((d) => d.name);
  for (const file of sourceFiles(repo)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      for (const imp of factsOfText(relative(repo, file), text).imports) {
        const pkg = npmPackageOf(imp.specifier);
        if (!pkg) continue;
        const spec = `npm:${pkg}`;
        if (imp.namespace) add(imp.namespace.local, { spec, kind: "namespace" });
        for (const b of imp.bindings)
          if (b.imported !== "default" && b.imported !== "*")
            add(b.local, { spec, kind: "named", imported: b.imported });
      }
    } else if (file.endsWith(".py")) {
      for (const b of pythonImports(text)) {
        const spec = `python:${b.module.split(".")[0]}`;
        if (b.module.startsWith(".")) continue;
        if (b.kind === "module" && b.aliased) add(b.local, { spec, kind: "namespace" });
        else if (b.kind === "from")
          add(b.local, { spec, kind: "named", imported: b.imported as string });
      }
    } else if (file.endsWith(".rs")) {
      for (const m of text.matchAll(/^\s*(?:pub\s+)?use\s+(\w+)\s+as\s+(\w+)\s*;/gm))
        add(m[2] as string, { spec: `rust:${m[1]}`, kind: "namespace" });
      for (const m of text.matchAll(/^\s*(?:pub\s+)?use\s+(\w+)::(\w+)(?:\s+as\s+(\w+))?\s*;/gm))
        add((m[3] ?? m[2]) as string, {
          spec: `rust:${m[1]}`,
          kind: "named",
          imported: m[2] as string,
        });
    } else if (file.endsWith(".go")) {
      for (const imp of goImports(text)) {
        if (!goModules.includes(imp.path)) continue;
        add(imp.alias ?? goAlias(imp.path), { spec: `go:${imp.path}`, kind: "namespace" });
      }
    }
  }
  return heads;
}

// ------------------------------------------------------------- the context

/** Per-plan caches: one walk of the repository, one surface per symbol, one name index per package. */
export class PacketContext {
  private headsCache?: Map<string, Head>;
  private own?: Set<string>;
  private surfaces = new Map<string, Promise<ApiSurface | undefined>>();
  private indexes = new Map<string, NameEntry[]>();
  private hashes = new Map<string, string | undefined>();
  constructor(readonly repo: string) {}

  heads(): Map<string, Head> {
    this.headsCache ??= headsOf(this.repo);
    return this.headsCache;
  }

  /**
   * The names the repository declares itself (DS-N9-15's repo-map guard):
   * its workspace packages and the top-level declarations of its own TS/JS
   * source, from the source index. A backticked one is never a missing package.
   */
  ownNames(): Set<string> {
    if (this.own) return this.own;
    const own = new Set<string>();
    try {
      const index = createSourceIndex(this.repo);
      for (const p of index.workspace()?.packages ?? []) own.add(p.name);
      for (const file of index.files().slice(0, MAX_SOURCE_FILES))
        for (const d of index.facts(file)?.declarations ?? []) if (d.topLevel) own.add(d.name);
    } catch {
      // No index: only the root-path check guards.
    }
    this.own = own;
    return own;
  }

  surface(spec: string, symbol: string): Promise<ApiSurface | undefined> {
    const key = `${spec}\0${symbol}`;
    let s = this.surfaces.get(key);
    if (!s) {
      s = dependencyApi(this.repo, spec, symbol).catch(() => undefined);
      this.surfaces.set(key, s);
    }
    return s;
  }

  index(dep: InstalledDependency): NameEntry[] {
    const key = `${dep.eco}:${dep.name}@${dep.version}`;
    let idx = this.indexes.get(key);
    if (!idx) {
      idx = nameIndex(dep);
      this.indexes.set(key, idx);
    }
    return idx;
  }

  fileSha(dep: InstalledDependency, file: string): string | undefined {
    const key = `${dep.eco}:${dep.name}@${dep.version}/${file}`;
    if (!this.hashes.has(key)) {
      const read = dependencyFile(dep, file, 50_000_000);
      this.hashes.set(
        key,
        read.ok && !read.truncated
          ? createHash("sha256").update(read.text).digest("hex")
          : undefined,
      );
    }
    return this.hashes.get(key);
  }
}

// ------------------------------------------------------------- flagging

function installed(repo: string, spec: string): InstalledDependency | undefined {
  const dep = resolveDependency(repo, spec);
  return dep?.installed ? dep : undefined;
}

/** A Python submodule (`pkg.adapters`) is part of the package, though its exports may omit it. */
function pythonSubmodule(dep: InstalledDependency, name: string): boolean {
  return dependencyFiles(dep, 2000).some((f) =>
    new RegExp(`(^|/)${name}(\\.pyi?|/__init__\\.pyi?)$`).test(f),
  );
}

async function flagMember(
  ctx: PacketContext,
  cardId: string,
  m: Mention,
): Promise<PacketFlag | undefined> {
  const head = ctx.heads().get(m.head as string);
  if (!head) return undefined;
  const dep = installed(ctx.repo, head.spec);
  if (!dep) return undefined;
  const rest = m.rest as string[];
  const base = {
    cardId,
    kind: "member" as const,
    written: m.written,
    eco: dep.eco,
    pkg: dep.name,
    version: dep.version,
  };
  const spec = `${dep.eco}:${dep.name}`;
  const [first, second] = rest as [string, string | undefined];
  if (head.kind === "named") {
    // A named import: its members, only when the surface lists them.
    const symbol = `${head.imported}.${first}`;
    const s = await ctx.surface(spec, symbol);
    if (!s || s.members.length === 0 || s.members.includes(first)) return undefined;
    return { ...base, symbol, missing: first };
  }
  const top = await ctx.surface(spec, first);
  if (!top || top.exports.length === 0) return undefined;
  if (!top.exports.includes(first)) {
    // A chain through a name the exports omit may be a module: left alone.
    if (second !== undefined) return undefined;
    if (dep.eco === "python" && pythonSubmodule(dep, first)) return undefined;
    // Precision: a name declared at the top level of any of its files may be
    // exported by a chain the surface's list does not follow.
    if (ctx.index(dep).some((e) => e.name === first && !e.container)) return undefined;
    return { ...base, symbol: first, missing: first };
  }
  if (second === undefined) return undefined;
  const symbol = `${first}.${second}`;
  const s = await ctx.surface(spec, symbol);
  if (!s || s.members.length === 0 || s.members.includes(second)) return undefined;
  return { ...base, symbol, missing: second };
}

function flagPackage(ctx: PacketContext, cardId: string, m: Mention): PacketFlag | undefined {
  const name = m.written;
  if (installed(ctx.repo, name)) return undefined;
  if (existsSync(join(ctx.repo, name)) || ctx.ownNames().has(name)) return undefined;
  const pinned = resolveDependency(ctx.repo, name);
  return {
    cardId,
    kind: "package",
    written: name,
    eco: pinned?.eco ?? "npm",
    pkg: name,
    version: pinned?.version ?? "",
    symbol: name,
    missing: name,
  };
}

/**
 * The flags of one card (DS-N9-15): its spec, then each criterion, in the
 * order they are written; at most four. No model is used.
 */
export async function flagCard(
  repo: string,
  card: Pick<CardRecord, "id" | "spec" | "acceptanceCriteria">,
  ctx = new PacketContext(repo),
): Promise<PacketFlag[]> {
  const out: PacketFlag[] = [];
  const seen = new Set<string>();
  for (const text of [card.spec ?? "", ...(card.acceptanceCriteria ?? [])]) {
    for (const m of mentionsIn(text)) {
      if (out.length >= PACKET_MAX_FLAGS) return out;
      if (seen.has(m.written)) continue;
      seen.add(m.written);
      const flag =
        m.kind === "member" ? await flagMember(ctx, card.id, m) : flagPackage(ctx, card.id, m);
      if (
        flag &&
        !out.some((f) => f.eco === flag.eco && f.pkg === flag.pkg && f.symbol === flag.symbol)
      )
        out.push(flag);
    }
  }
  return out;
}

// ------------------------------------------------------------- local answers

interface NameEntry {
  name: string;
  container?: string;
  signature: string;
  file: string;
  line: number;
}

/**
 * Declared names of an installed package, with their type and line: the
 * ecosystem adapter's own static declarations (DS-N9-1, -15), so the packet
 * and `apiSurface` read a package the same way (npm's through the source
 * index, gates GT-T2-3).
 */
function nameIndex(dep: InstalledDependency): NameEntry[] {
  return dependencyDeclarations(dep).map((d) => ({
    name: d.name,
    ...(d.container ? { container: d.container } : {}),
    signature: d.signature.trim().slice(0, 200),
    file: d.file,
    line: d.line,
  }));
}

/** Edit distance with adjacent transpositions (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      row[j] = Math.min(
        ((d[i - 1] as number[])[j] as number) + 1,
        (row[j - 1] as number) + 1,
        ((d[i - 1] as number[])[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
    }
  return (d[a.length] as number[])[b.length] as number;
}

/** How far a near name may be: 2 for five letters or more, 1 for three or four. */
const nearLimit = (name: string) => (name.length >= 5 ? 2 : name.length >= 3 ? 1 : 0);

export interface LocalAnswer {
  /** Declarations of the same name elsewhere, then the nearest; at most three. */
  members: LocalMember[];
  /** For a package the project lacks: its pin, when a lockfile has one. */
  pinned?: string;
  /** For a package the project lacks: installed packages with near names. */
  near: string[];
}

/**
 * The local answer to a flag (DS-N9-16): the identifier declared elsewhere
 * in the installed package, then the nearest declared names by edit
 * distance, each with its signature, its citation and its file's hash. For
 * a package the project lacks: its pin and the installed packages with near
 * names. No model, no network.
 */
export async function answerLocally(
  repo: string,
  flag: PacketFlag,
  ctx = new PacketContext(repo),
): Promise<LocalAnswer> {
  if (flag.kind === "package") {
    const pinned = resolveDependency(repo, flag.pkg);
    const limit = nearLimit(flag.pkg);
    const near = [
      ...new Set(
        declaredDependencies(repo)
          .filter((d) => installed(repo, `${d.eco}:${d.name}`))
          .map((d) => d.name)
          .filter((n) => editDistance(n.toLowerCase(), flag.pkg.toLowerCase()) <= limit),
      ),
    ].slice(0, NEAR_MAX);
    return { members: [], ...(pinned ? { pinned: `${pinned.name}@${pinned.version}` } : {}), near };
  }
  const dep = installed(repo, `${flag.eco}:${flag.pkg}`);
  if (!dep || dep.version !== flag.version) return { members: [], near: [] };
  const owner = flag.symbol.includes(".") ? flag.symbol.split(".")[0] : undefined;
  const entries = ctx.index(dep);
  const limit = nearLimit(flag.missing);
  const scored = entries
    .map((e) => ({ e, d: e.name === flag.missing ? 0 : editDistance(e.name, flag.missing) }))
    .filter((x) => x.d <= limit && !(x.d === 0 && owner !== undefined && x.e.container === owner))
    .sort(
      (a, b) =>
        a.d - b.d ||
        Number(a.e.container !== owner) - Number(b.e.container !== owner) ||
        a.e.name.localeCompare(b.e.name) ||
        a.e.line - b.e.line,
    );
  const members: LocalMember[] = [];
  const seen = new Set<string>();
  for (const { e } of scored) {
    if (members.length >= NEAR_MAX) break;
    const key = `${e.container ?? ""}.${e.name}`;
    if (seen.has(key)) continue;
    const fileSha256 = ctx.fileSha(dep, e.file);
    if (!fileSha256) continue;
    seen.add(key);
    members.push({
      name: e.name,
      ...(e.container ? { container: e.container } : {}),
      signature: e.signature,
      file: e.file,
      line: e.line,
      ref: `deps:${dep.eco}:${dep.name}@${dep.version}/${e.file}:${e.line}`,
      fileSha256,
    });
  }
  return { members, near: [] };
}

/** An identifier or package name: no space, no phrase, at most 120 characters (DS-N9-23). */
const IDENTIFIER_FORM = /^[@\w$.:/-]{1,120}$/;

/**
 * Whether a flag may be put to the Researcher (DS-N9-23): its identifier
 * (or package name) and package are in identifier form, so the question
 * carries that word and nothing else of the spec.
 */
export function askable(flag: PacketFlag): boolean {
  const word = flag.kind === "package" ? flag.pkg : flag.symbol;
  return IDENTIFIER_FORM.test(word) && IDENTIFIER_FORM.test(flag.pkg);
}

/** The question the Researcher is asked for a flag: the symbol and `pkg@ver` alone (DS-N9-16). */
export function packetQuestion(flag: PacketFlag): string {
  return flag.kind === "package"
    ? researchCopy.packetPackageQuestion(flag.pkg)
    : researchCopy.packetQuestion(flag.symbol, flag.pkg, flag.version, flag.eco);
}

// ------------------------------------------------------------- the packet

type Resolution =
  | { via: "note"; note: LiveNote }
  | { via: "local"; local: LocalAnswer }
  | { via: "researcher"; question: number; local: LocalAnswer };

export interface PacketQuestion {
  /** eco|pkg|ver|symbol: one question for every card that flags it. */
  key: string;
  flag: PacketFlag;
  question: string;
}

export interface PreparedPacket {
  cards: { cardId: string; flags: { flag: PacketFlag; resolution: Resolution }[] }[];
  questions: PacketQuestion[];
  /** Flags past the plan's question cap, answered locally (DS-N9-16). */
  unasked: number;
  fold: NoteFold;
}

interface PacketDeps {
  repoPath: string;
  log: EventLog;
  cardStore: Pick<CardStore, "getCard" | "recordDossierEntry">;
}

const flagKey = (f: PacketFlag) => `${f.eco}|${f.pkg}|${f.version}|${f.symbol}`;

/**
 * The model-free half of the packet, run when a plan has created its cards
 * (DS-N9-15, -16, -20, -21): the notes' fold is read and what no longer
 * holds retired; each card's flags are answered by a re-checked note, else
 * by the installed package; what neither answers becomes one question for
 * the Researcher, shared by every card that flags it.
 */
export async function preparePacket(
  k: PacketDeps,
  cardIds: readonly string[],
): Promise<PreparedPacket> {
  const fold = await readNotes(k.log);
  await retireStale(k.repoPath, k.log, fold);
  const ctx = new PacketContext(k.repoPath);
  const questions: PacketQuestion[] = [];
  let unasked = 0;
  const cards: PreparedPacket["cards"] = [];
  for (const cardId of cardIds) {
    const card = await k.cardStore.getCard(cardId);
    if (!card) continue;
    const flags: PreparedPacket["cards"][number]["flags"] = [];
    for (const flag of await flagCard(k.repoPath, card, ctx)) {
      const note =
        flag.kind === "member"
          ? await reuseNote(k.repoPath, k.log, fold, {
              eco: flag.eco,
              pkg: flag.pkg,
              version: flag.version,
              symbol: flag.symbol,
            })
          : undefined;
      if (note) {
        flags.push({ flag, resolution: { via: "note", note } });
        continue;
      }
      const local = await answerLocally(k.repoPath, flag, ctx);
      if (local.members.length > 0 || local.pinned || local.near.length > 0) {
        flags.push({ flag, resolution: { via: "local", local } });
        continue;
      }
      const key = flagKey(flag);
      let question = questions.findIndex((q) => q.key === key);
      if (!askable(flag)) {
        flags.push({ flag, resolution: { via: "local", local } });
        continue;
      }
      if (question < 0 && questions.length >= PACKET_MAX_QUESTIONS) {
        unasked++;
        flags.push({ flag, resolution: { via: "local", local } });
        continue;
      }
      if (question < 0) {
        questions.push({ key, flag, question: packetQuestion(flag) });
        question = questions.length - 1;
      }
      flags.push({ flag, resolution: { via: "researcher", question, local } });
    }
    if (flags.length) cards.push({ cardId, flags });
  }
  return { cards, questions, unasked, fold };
}

const clip = (text: string) =>
  text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS - 1)}…` : text;

const targetOf = (f: PacketFlag) => (f.version ? `${f.pkg}@${f.version}` : f.pkg);

function noteEntry(flag: PacketFlag, note: ResearchNote): { text: string; sources: string[] } {
  return {
    text: clip(
      researchCopy.packet.note(
        flag.written,
        targetOf(flag),
        researchCopy.packet.checkedBy(note.check.kind),
        note.excerpt.replace(/\s+/g, " ").trim(),
      ),
    ),
    sources: [note.citation.ref],
  };
}

function localEntry(flag: PacketFlag, local: LocalAnswer): { text: string; sources: string[] } {
  if (flag.kind === "package")
    return {
      text: clip(researchCopy.packet.package(flag.pkg, local.pinned, local.near)),
      sources: [],
    };
  if (local.members.length === 0)
    return { text: clip(researchCopy.packet.absent(flag.written, targetOf(flag))), sources: [] };
  const near = local.members.map((m) =>
    researchCopy.packet.member(m.signature, m.container, m.ref),
  );
  // Fewer members rather than a cut citation: the entry stays whole.
  while (
    near.length > 1 &&
    researchCopy.packet.local(flag.written, targetOf(flag), near).length > ENTRY_CHARS
  )
    near.pop();
  return {
    text: clip(researchCopy.packet.local(flag.written, targetOf(flag), near)),
    sources: local.members.slice(0, near.length).map((m) => m.ref),
  };
}

export interface PacketSummary {
  cards: number;
  flagged: number;
  answeredLocally: number;
  askedResearcher: number;
  reused: number;
}

/**
 * The packet's second half (DS-N9-16, -19, -22): the Researcher's answers,
 * when it was asked, admitted as notes where a model-free check grounds
 * them; then one `card/research` entry per flag, `research/note_fed` for
 * each note fed, and `research/packet` per card. `notAsked` says why the
 * Researcher was not asked; the local answers are recorded whatever it says.
 */
export async function finishPacket(
  k: PacketDeps,
  prepared: PreparedPacket,
  outcome: { answers?: readonly (PacketOutcome | undefined)[]; model?: string; notAsked?: string },
): Promise<PacketSummary> {
  const summary: PacketSummary = {
    cards: prepared.cards.length,
    flagged: 0,
    answeredLocally: 0,
    askedResearcher: 0,
    reused: 0,
  };
  const admitted = new Map<number, ResearchNote | undefined>();
  for (const { cardId, flags } of prepared.cards) {
    const counts = { flagged: flags.length, answeredLocally: 0, askedResearcher: 0, reused: 0 };
    for (const { flag, resolution } of flags) {
      let entry: { text: string; sources: string[] };
      let fed: ResearchNote | undefined;
      if (resolution.via === "note") {
        counts.reused++;
        fed = resolution.note;
        entry = noteEntry(flag, fed);
      } else if (resolution.via === "local") {
        counts.answeredLocally++;
        entry = localEntry(flag, resolution.local);
        if (flag.kind === "member")
          for (const member of resolution.local.members.filter((m) => m.name === flag.missing)) {
            fed = await admitLocalNote(k.repoPath, k.log, { flag, member }).catch(() => undefined);
            if (fed) break;
          }
      } else {
        const answer = outcome.answers?.[resolution.question];
        if (answer && !("failed" in answer)) {
          counts.askedResearcher++;
          if (!admitted.has(resolution.question))
            admitted.set(
              resolution.question,
              flag.kind === "member"
                ? await admitResearchNote(k.repoPath, k.log, {
                    flag,
                    answer,
                    ...(outcome.model ? { model: outcome.model } : {}),
                  }).catch(() => undefined)
                : undefined,
            );
          fed = admitted.get(resolution.question);
          entry = fed
            ? noteEntry(flag, fed)
            : {
                text: clip(
                  researchCopy.packet.research(
                    flag.written,
                    targetOf(flag),
                    answer.answer.replace(/\s+/g, " ").trim(),
                  ),
                ),
                sources: answer.sources.slice(0, 5),
              };
        } else {
          entry = localEntry(flag, resolution.local);
        }
      }
      await k.cardStore
        .recordDossierEntry({
          cardId,
          kind: "research",
          text: entry.text,
          ...(entry.sources.length ? { sources: entry.sources } : {}),
        })
        .catch(() => undefined);
      if (fed) await recordNoteFed(k.log, fed.noteId, cardId);
    }
    await k.log.append({
      actor: "harness",
      type: PACKET_EVENT,
      cardId,
      payload: { card: cardId, ...counts },
      private: {
        symbols: flags.map((f) => f.flag.written),
        ...(outcome.notAsked ? { notAsked: outcome.notAsked.slice(0, 500) } : {}),
      },
    });
    summary.flagged += counts.flagged;
    summary.answeredLocally += counts.answeredLocally;
    summary.askedResearcher += counts.askedResearcher;
    summary.reused += counts.reused;
  }
  return summary;
}
