/**
 * A one-shot reply, in the format `prompt.md` states for an arm that can only
 * reply in text: every file under a line `### path/to/file` followed by one
 * fenced code block holding the whole file; a later reply lists only what it
 * adds or changes, and a file to delete as `### path` then the line
 * `(deleted)`.
 *
 * The parser is strict and never repairs anything: a section it cannot read
 * (no fenced block, an unclosed fence, a path outside the repository or into
 * `.git`) is counted and logged as unparsed, and its file is not written.
 * Text outside the sections (the model's commentary) is ignored and counted.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HEADING = /^###[ \t]+(.+?)[ \t]*$/;
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^`]*)$/;

/** Why a reply path may not be written, or null when it may. */
export function pathRefusal(path) {
  if (path.length === 0) return "an empty path";
  if (path.length > 300) return "a path longer than 300 characters";
  if (path.includes("\\")) return "a backslash in the path";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "an absolute path";
  if ([...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    return "a control character in the path";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return "an empty, '.' or '..' path segment";
  if (parts[0] === ".git" || parts.includes(".git")) return "a path into .git";
  return null;
}

/** The heading's path: `### path`, with one pair of backticks allowed around it. */
function headingPath(raw) {
  const m = /^`([^`]+)`$/.exec(raw);
  return m ? m[1] : raw;
}

/**
 * The sections of a reply, in order: `{ path, kind: "file", content }`,
 * `{ path, kind: "deleted" }`, or `{ path, kind: "unparsed", why }`. A
 * heading that is not followed (after blank lines) by a fence or `(deleted)`
 * is unparsed; so is one whose fence is never closed.
 */
export function parseReply(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let ignoredLines = 0;
  let i = 0;
  while (i < lines.length) {
    const h = HEADING.exec(lines[i]);
    if (!h) {
      if (lines[i].trim()) ignoredLines += 1;
      i += 1;
      continue;
    }
    const path = headingPath(h[1].trim());
    i += 1;
    while (i < lines.length && lines[i].trim() === "") i += 1;
    if (i < lines.length && lines[i].trim() === "(deleted)") {
      const why = pathRefusal(path);
      sections.push(why ? { path, kind: "unparsed", why } : { path, kind: "deleted" });
      i += 1;
      continue;
    }
    const open = i < lines.length ? FENCE_OPEN.exec(lines[i]) : null;
    if (!open) {
      sections.push({
        path,
        kind: "unparsed",
        why: "no fenced block or (deleted) after the heading",
      });
      continue;
    }
    const fence = open[1];
    const body = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        closed = true;
        i += 1;
        break;
      }
      body.push(line);
      i += 1;
    }
    if (!closed) {
      sections.push({ path, kind: "unparsed", why: "the fenced block is never closed" });
      continue;
    }
    const why = pathRefusal(path);
    sections.push(
      why
        ? { path, kind: "unparsed", why }
        : { path, kind: "file", content: `${body.join("\n")}\n` },
    );
  }
  return { sections, ignoredLines };
}

/**
 * Write a parsed reply into `repo`: files written whole, deletions removed.
 * A path named twice keeps its last section (and the first is counted as
 * replaced). Returns what happened, for the run's log.
 */
export function applyReply(repo, parsed) {
  const written = [];
  const deleted = [];
  const unparsed = [];
  const lastIndex = new Map();
  parsed.sections.forEach((s, i) => {
    if (s.kind !== "unparsed") lastIndex.set(s.path, i);
  });
  let replacedInReply = 0;
  parsed.sections.forEach((s, i) => {
    if (s.kind === "unparsed") {
      unparsed.push({ path: s.path, why: s.why });
      return;
    }
    if (lastIndex.get(s.path) !== i) {
      replacedInReply += 1;
      return;
    }
    const target = join(repo, s.path);
    if (s.kind === "deleted") {
      rmSync(target, { force: true });
      deleted.push(s.path);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, s.content);
    written.push(s.path);
  });
  return {
    written,
    deleted,
    unparsed,
    unparsedCount: unparsed.length,
    replacedInReply,
    ignoredLines: parsed.ignoredLines,
  };
}

const SKIP = new Set([".git", "node_modules", "dist", "data"]);

/** Every file of a tree as sorted POSIX paths, without `.git`, installed packages, build output and data. */
export function treeFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk("");
  return out.sort();
}

/**
 * A tree as text in the reply format, the same rendering the seed uses
 * (`seed.mjs --render`): `### path`, then one fence longer than any backtick
 * run in the file. A file that is not valid UTF-8 is listed as binary with
 * its size, never inlined.
 */
export function renderTree(dir) {
  return treeFiles(dir)
    .map((path) => {
      const buf = readFileSync(join(dir, path));
      const body = buf.toString("utf8");
      if (Buffer.compare(Buffer.from(body, "utf8"), buf) !== 0) {
        return `### ${path}\n\n(binary, ${buf.length} bytes)\n`;
      }
      const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longest + 1);
      return `### ${path}\n\n${fence}\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}\n`;
    })
    .join("\n");
}
