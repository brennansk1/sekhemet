import ts from "typescript";
import { OBSERVATION_CHAR_LIMIT } from "./observation.js";
import { splitLines } from "./text.js";

/**
 * The evidence-gated commit (worker-loop rule 29a, NEW-worker-loop-9; ECLoop,
 * arXiv:2607.28815), behind `SEKHEMET_EVIDENCE_GATE=off|on`. With it on, a
 * write or a finish waits until the evidence it depends on has been observed
 * in the attempt's step records — never taken from the model's text. The
 * precondition set is `missingEvidence`, one pure function of those records
 * (WL-N9-4), beside `phaseOf`; the session supplies the repository facts it
 * needs (which scope files the acceptance tests import, which exported
 * signatures a write changes and who imports them).
 */
export type EvidenceGateSwitch = "off" | "on";

/** One fact the harness observed in a step: never the model's claim. */
export type EvidenceRecord =
  /** Lines `from`–`to` of a `lines`-line file reached the Worker (a read, or the prompt showing it). */
  | { kind: "read"; path: string; from: number; to: number; lines: number }
  | { kind: "write"; path: string }
  /** `find_references` ran for `symbol` as declared in `file`. */
  | { kind: "references"; symbol: string; file: string }
  /** The card's gates, its tests among them, ran on the tree as it then stood. */
  | { kind: "tests" };

export type EvidenceRequest =
  | {
      kind: "write";
      path: string;
      /** Scope files the staged acceptance tests import (WL-N9-1). */
      importedScopeFiles: readonly string[];
      /** Exported declarations of `path` whose signature the write changes, with their importers (WL-N9-2). */
      signatureChanges: readonly { symbol: string; importers: readonly string[] }[];
    }
  | { kind: "finish" };

export type MissingEvidence =
  | { kind: "unread"; files: string[] }
  | { kind: "importers"; symbol: string; file: string; importers: string[] }
  | { kind: "tests" };

function lastIndex(records: readonly EvidenceRecord[], test: (r: EvidenceRecord) => boolean) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && test(r)) return i;
  }
  return -1;
}

/** Whether the reads of `path` together cover every line of it (an outline is not a read). */
function readInFull(records: readonly EvidenceRecord[], path: string): boolean {
  const reads = records.filter(
    (r): r is Extract<EvidenceRecord, { kind: "read" }> => r.kind === "read" && r.path === path,
  );
  const latest = reads.at(-1);
  if (!latest) return false;
  const lines = latest.lines;
  const ranges = reads.filter((r) => r.lines === lines).sort((a, b) => a.from - b.from);
  let covered = 0;
  for (const r of ranges) {
    if (r.from > covered + 1) break;
    covered = Math.max(covered, r.to);
  }
  return covered >= lines;
}

/**
 * What a write or a finish still waits for, from the attempt's step records
 * alone; undefined when nothing does (rule 29a).
 */
export function missingEvidence(
  records: readonly EvidenceRecord[],
  request: EvidenceRequest,
): MissingEvidence | undefined {
  if (request.kind === "finish") {
    const lastWrite = lastIndex(records, (r) => r.kind === "write");
    const lastTests = lastIndex(records, (r) => r.kind === "tests");
    return lastTests > lastWrite ? undefined : { kind: "tests" };
  }
  if (!records.some((r) => r.kind === "write")) {
    const unread = request.importedScopeFiles.filter((f) => !readInFull(records, f));
    if (unread.length > 0) return { kind: "unread", files: [...unread] };
  }
  const since = lastIndex(records, (r) => r.kind === "write" && r.path === request.path);
  const after = records.slice(since + 1);
  for (const change of request.signatureChanges) {
    if (change.importers.length === 0) continue;
    const searched = after.some(
      (r) => r.kind === "references" && r.symbol === change.symbol && r.file === request.path,
    );
    const read = change.importers.every((f) =>
      after.some((r) => r.kind === "read" && r.path === f),
    );
    if (!searched && !read) {
      return {
        kind: "importers",
        symbol: change.symbol,
        file: request.path,
        importers: [...change.importers],
      };
    }
  }
  return undefined;
}

/** A numbered line as `read_file` renders it: `   12│text`. */
const NUMBERED = /^\s*(\d+)│/;
/** The line `clampObservation` puts where it cut the middle out. */
const OMITTED = /^\.\.\. \[\d+ chars of .* omitted; \d+ total\] \.\.\.$/;

/**
 * The line ranges a `read_file` reply actually shows (review blocker 2): its
 * numbered lines, not its summary, because a long reply is clamped in the
 * middle and the lines on either side of the cut are partial. A requested
 * single line longer than the clamp is counted as shown: no read can show it
 * whole.
 */
export function shownLineRanges(
  content: string,
  requested: { from: number; to: number },
): [number, number][] {
  const lines = content.split("\n");
  const cut = lines.findIndex((l) => OMITTED.test(l));
  if (cut >= 0 && requested.from === requested.to) return [[requested.from, requested.to]];
  const shown: number[] = [];
  for (const [k, line] of lines.entries()) {
    if (cut >= 0 && (k === cut - 1 || k === cut + 1)) continue;
    const m = NUMBERED.exec(line);
    if (m) shown.push(Number(m[1]));
  }
  const ranges: [number, number][] = [];
  for (const n of shown) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/**
 * Line ranges of a file that `read_file` returns whole, each under the clamp
 * (review blocker 2): the reads to suggest for a file too long for one.
 */
export function readRanges(
  source: string,
  path: string,
  limit: number = OBSERVATION_CHAR_LIMIT,
): [number, number][] {
  const lines = splitLines(source).lines;
  const total = lines.length;
  const header = (from: number, to: number) =>
    `${path} (lines ${from}-${to} of ${total}):\n`.length;
  const width = (n: number) => String(n).padStart(5).length + 1;
  const ranges: [number, number][] = [];
  let from = 1;
  while (from <= total) {
    let to = from;
    let size = width(from) + (lines[from - 1] ?? "").length;
    while (to < total) {
      const next = size + 1 + width(to + 1) + (lines[to] ?? "").length;
      if (header(from, to + 1) + next > limit) break;
      size = next;
      to++;
    }
    ranges.push([from, to]);
    from = to + 1;
  }
  return ranges;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

function exported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isPrivate(member: ts.ClassElement): boolean {
  if (member.name && ts.isPrivateIdentifier(member.name)) return true;
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

/** A declaration's text up to its body: what callers depend on. */
function head(source: string, node: ts.Node, body: ts.Node | undefined): string {
  return source.slice(node.getStart(), body ? body.getStart() : node.end);
}

function classSignature(source: string, node: ts.ClassDeclaration): string {
  const parts = [source.slice(node.getStart(), node.members.pos)];
  for (const member of node.members) {
    if (isPrivate(member)) continue;
    if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      parts.push(head(source, member, member.body));
    } else if (ts.isPropertyDeclaration(member)) {
      parts.push(head(source, member, member.initializer));
    } else {
      parts.push(member.getText());
    }
  }
  return parts.join(" ");
}

/**
 * Each exported top-level declaration's signature: a function's or method's
 * text without its body, a type's whole text, a variable's declared type (or
 * a function value's parameters and return type). A body or a value is not
 * part of it.
 */
export function exportedSignatures(fileName: string, source: string): Map<string, string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const add = (name: string, text: string) =>
    out.set(name, out.has(name) ? `${out.get(name)} ${squash(text)}` : squash(text));
  for (const st of file.statements) {
    if (!exported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name) {
      add(st.name.text, head(source, st, st.body));
    } else if (ts.isClassDeclaration(st) && st.name) {
      add(st.name.text, classSignature(source, st));
    } else if (
      (ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      add(st.name.text, st.getText());
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fn =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
            ? head(source, init, init.body)
            : "";
        add(d.name.text, `${d.type ? d.type.getText() : ""} ${fn}`);
      }
    }
  }
  return out;
}

/** Exported declarations whose signature differs, or that are gone, after a change. */
export function changedExportedSignatures(
  fileName: string,
  before: string,
  after: string,
): string[] {
  const old = exportedSignatures(fileName, before);
  const now = exportedSignatures(fileName, after);
  return [...old.keys()].filter((name) => now.get(name) !== old.get(name));
}
