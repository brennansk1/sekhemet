import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ToolCall } from "@sekhemet/models";
import { type ExecutionResult, PermissionEngine, ProcessSandbox } from "@sekhemet/sandbox";
import { matchesGlob } from "./glob.js";
import { type ToolObservation, clampObservation, denied, fail, ok } from "./observation.js";
import { PathEscapeError, canonicalizeRoot, resolveInWorktree } from "./paths.js";
import { findSymbol, listSymbolNames } from "./symbols.js";
import { applyEol, detectEol, joinLines, reindentBlock, splitLines, toLf } from "./text.js";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sekhemet", "coverage", ".next"]);
const MAX_GREP_MATCHES = 80;
const MAX_FIND_RESULTS = 300;
const MAX_READ_BYTES = 512 * 1024;

/** Approval hook for the `ask` permission tier. Returning false denies the call. */
export type ApprovalHandler = (request: {
  tool: string;
  reason: string;
  targetPath?: string | undefined;
  command?: string | undefined;
}) => Promise<boolean>;

export interface ToolExecutorOptions {
  worktreePath: string;
  scopeFiles?: string[] | undefined;
  agentRole?: string | undefined;
  allowNetwork?: boolean | undefined;
  commandTimeoutMs?: number | undefined;
  sandbox?: ProcessSandbox | undefined;
  permissionEngine?: PermissionEngine | undefined;
  /** Invoked for `ask`-tier calls. Absent means ask-tier is refused. */
  onApproval?: ApprovalHandler | undefined;
}

/** A file is treated as binary if a NUL appears in its first block. */
function isBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Executes the harness tool catalog against a confined worktree.
 *
 * Every tool returns a {@link ToolObservation} rather than throwing, because the
 * observation is what gets fed back to the model: a failed edit that explains
 * *why* it failed is what lets the agent self-correct on the next turn.
 */
export class ToolExecutor {
  public readonly root: string;
  private sandbox: ProcessSandbox;
  private permissions: PermissionEngine;
  private notes: string[] = [];
  private finishRequested = false;
  private readFiles = new Set<string>();

  constructor(private options: ToolExecutorOptions) {
    this.root = canonicalizeRoot(options.worktreePath);
    this.sandbox = options.sandbox ?? new ProcessSandbox();
    this.permissions = options.permissionEngine ?? new PermissionEngine();
  }

  public wantsFinish(): boolean {
    return this.finishRequested;
  }

  public resetFinish(): void {
    this.finishRequested = false;
  }

  public getNotes(): string[] {
    return [...this.notes];
  }

  /** Files already read this card, so the prompt can discourage re-reading them. */
  public getReadFiles(): string[] {
    return [...this.readFiles].sort();
  }

  // --- Structured accessors -------------------------------------------------
  // The observation-returning tools above are what the model sees. These typed
  // variants expose the same primitives to harness code (CLI, gates, tests)
  // that needs real values rather than prose.

  /** Read a file's exact bytes as text. Throws if missing, binary, or outside the worktree. */
  public readRaw(relPath: string): string {
    const abs = resolveInWorktree(this.root, relPath);
    if (!existsSync(abs)) throw new Error(`File not found: ${relPath}`);
    return this.readText(abs);
  }

  /** Write text to a path inside the worktree, creating parent directories. */
  public writeRaw(relPath: string, content: string): void {
    this.writeText(resolveInWorktree(this.root, relPath), content);
  }

  /** Entry names directly inside `relPath`, excluding build and VCS directories. */
  public listDirNames(relPath = "."): string[] {
    const abs = resolveInWorktree(this.root, relPath);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** Worktree-relative paths matching `pattern`, searched recursively. */
  public findFileList(pattern: string, relPath = "."): string[] {
    const abs = resolveInWorktree(this.root, relPath);
    const results: string[] = [];
    this.walk(abs, (file) => {
      const rel = this.rel(file);
      if (matchesGlob(rel, pattern)) results.push(rel);
      return results.length < MAX_FIND_RESULTS;
    });
    return results.sort();
  }

  /** Structured grep hits: worktree-relative file, 1-indexed line, and line text. */
  public grepMatches(
    query: string,
    relPath = ".",
    wholeWord = false,
  ): { file: string; line: number; content: string }[] {
    const abs = resolveInWorktree(this.root, relPath);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = wholeWord ? new RegExp(`\\b${escaped}\\b`) : new RegExp(query);
    } catch {
      re = new RegExp(escaped);
    }

    const matches: { file: string; line: number; content: string }[] = [];
    this.walk(abs, (file) => {
      let text: string;
      try {
        text = this.readText(file);
      } catch {
        return true;
      }
      const rel = this.rel(file);
      const { lines } = splitLines(text);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (re.test(line)) {
          matches.push({ file: rel, line: i + 1, content: line.trim() });
          if (matches.length >= MAX_GREP_MATCHES) return false;
        }
      }
      return true;
    });
    return matches;
  }

  private rel(abs: string): string {
    return relative(this.root, abs) || ".";
  }

  private readText(abs: string): string {
    const buf = readFileSync(abs);
    if (isBinary(buf)) throw new Error("file appears to be binary");
    if (buf.length > MAX_READ_BYTES) {
      throw new Error(`file exceeds ${MAX_READ_BYTES} byte read limit (${buf.length} bytes)`);
    }
    return buf.toString("utf8");
  }

  private writeText(abs: string, content: string): void {
    const parent = dirname(abs);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /** Run the three-tier permission check, escalating `ask` to the approval handler. */
  private async authorize(call: ToolCall): Promise<ToolObservation | null> {
    const targetPath = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
    const rawCommand =
      typeof call.arguments.command === "string" ? call.arguments.command : undefined;
    const args = Array.isArray(call.arguments.args) ? (call.arguments.args as string[]) : [];
    // The full argv must be checked, not just argv[0]: `rm` alone looks harmless
    // while `rm -rf /` does not.
    const command = rawCommand ? [rawCommand, ...args].join(" ") : undefined;

    const verdict = this.permissions.evaluate({
      toolName: call.name,
      targetPath,
      command,
      declaredScopeFiles: this.options.scopeFiles,
      agentRole: this.options.agentRole ?? "implementer",
      allowNetwork: this.options.allowNetwork ?? false,
    });

    if (verdict.allowed) return null;

    if (verdict.tier === "ask") {
      const handler = this.options.onApproval;
      if (!handler) {
        return denied(call.name, `${verdict.reason ?? "approval required"} (no approver attached)`);
      }
      const approved = await handler({
        tool: call.name,
        reason: verdict.reason ?? "approval required",
        targetPath,
        command,
      });
      return approved ? null : denied(call.name, `operator declined: ${verdict.reason ?? ""}`);
    }

    return denied(call.name, verdict.reason ?? "denied by policy");
  }

  public async execute(call: ToolCall): Promise<ToolObservation> {
    const gate = await this.authorize(call);
    if (gate) return gate;

    try {
      return await this.dispatch(call);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return denied(call.name, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      return fail(call.name, `error: ${message}`, `${call.name} failed: ${message}`);
    }
  }

  private async dispatch(call: ToolCall): Promise<ToolObservation> {
    const a = call.arguments;
    const str = (k: string): string | undefined =>
      typeof a[k] === "string" ? (a[k] as string) : undefined;
    const num = (k: string): number | undefined =>
      typeof a[k] === "number" ? (a[k] as number) : undefined;

    switch (call.name) {
      case "read_file":
        return this.readFile(str("path"), num("start"), num("end"));
      case "write_file":
        return this.writeFile(str("path"), str("content"));
      case "edit":
        return this.edit(str("path"), str("search"), str("replace"));
      case "replace_lines":
        return this.replaceLines(str("path"), num("start"), num("end"), str("replacement"));
      case "read_symbol":
        return this.readSymbol(str("path"), str("symbol"));
      case "replace_symbol_body":
        return this.replaceSymbolBody(str("path"), str("symbol"), str("body"));
      case "insert_after_symbol":
        return this.insertAfterSymbol(str("path"), str("symbol"), str("content"));
      case "find_references":
        return this.grep(str("symbol"), str("path") ?? ".", true);
      case "grep_search":
        return this.grep(str("query"), str("path") ?? ".", false);
      case "list_dir":
        return this.listDir(str("path") ?? ".");
      case "find_files":
        return this.findFiles(str("pattern") ?? "*", str("path") ?? ".");
      case "run_cmd":
        return this.runCmd(str("command"), Array.isArray(a.args) ? (a.args as string[]) : []);
      case "note":
        return this.note(str("message"));
      case "docs":
        return this.docs(str("query") ?? "");
      case "finish_card":
        this.finishRequested = true;
        return ok("finish_card", "requested verification", "Verification gates will now run.");
      default:
        return fail(call.name, `unknown tool "${call.name}"`);
    }
  }

  private readFile(path?: string, start?: number, end?: number): ToolObservation {
    if (!path) return fail("read_file", "missing required argument: path");
    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("read_file", `file not found: ${path}`);
    if (statSync(abs).isDirectory())
      return fail("read_file", `${path} is a directory; use list_dir`);

    const source = this.readText(abs);
    const { lines } = splitLines(source);
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    if (from > lines.length) {
      return fail("read_file", `start line ${from} is past end of file (${lines.length} lines)`);
    }

    this.readFiles.add(path.replace(/^\.\//, ""));

    const numbered = lines
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(5)}│${l}`)
      .join("\n");

    return ok(
      "read_file",
      `read ${path} lines ${from}-${to} of ${lines.length}`,
      clampObservation(`${path} (lines ${from}-${to} of ${lines.length}):\n${numbered}`, "file"),
    );
  }

  private writeFile(path?: string, content?: string): ToolObservation {
    if (!path) return fail("write_file", "missing required argument: path");
    if (content === undefined) return fail("write_file", "missing required argument: content");

    const abs = resolveInWorktree(this.root, path);
    const existed = existsSync(abs);
    // Preserve the file's existing line-ending convention on rewrite.
    const eol = existed ? detectEol(this.readText(abs)) : "\n";
    this.writeText(abs, applyEol(toLf(content), eol));

    const lineCount = splitLines(content).lines.length;
    return ok(
      "write_file",
      `${existed ? "overwrote" : "created"} ${path} (${lineCount} lines)`,
      `${existed ? "Overwrote" : "Created"} ${path} — ${lineCount} lines written.`,
    );
  }

  private edit(path?: string, search?: string, replace?: string): ToolObservation {
    if (!path) return fail("edit", "missing required argument: path");
    if (search === undefined) return fail("edit", "missing required argument: search");
    if (replace === undefined) return fail("edit", "missing required argument: replace");

    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("edit", `file not found: ${path}`);

    const original = this.readText(abs);
    const eol = detectEol(original);
    // Match on LF-normalized text so an LF search string still matches a CRLF file.
    const haystack = toLf(original);
    const needle = toLf(search);

    const occurrences = haystack.split(needle).length - 1;
    if (occurrences === 0) {
      return fail(
        "edit",
        `Search string not found in ${path}`,
        `edit failed: the search string does not appear in ${path}. Re-read the file and copy the exact text, including indentation.`,
      );
    }
    if (occurrences > 1) {
      return fail(
        "edit",
        `Search string is ambiguous in ${path} (${occurrences} matches)`,
        `edit failed: the search string appears ${occurrences} times in ${path}. It must match exactly once — include more surrounding context to disambiguate.`,
      );
    }

    this.writeText(abs, applyEol(haystack.replace(needle, toLf(replace)), eol));
    return ok("edit", `edited ${path}`, `Applied edit to ${path} (1 unique match replaced).`);
  }

  private replaceLines(
    path?: string,
    start?: number,
    end?: number,
    replacement?: string,
  ): ToolObservation {
    if (!path) return fail("replace_lines", "missing required argument: path");
    if (start === undefined || end === undefined) {
      return fail("replace_lines", "missing required arguments: start and end");
    }
    if (replacement === undefined)
      return fail("replace_lines", "missing required argument: replacement");

    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("replace_lines", `file not found: ${path}`);

    const original = this.readText(abs);
    const eol = detectEol(original);
    const { lines, hadTrailingNewline } = splitLines(original);

    if (start < 1 || start > lines.length) {
      return fail(
        "replace_lines",
        `start line ${start} out of range (file has ${lines.length} lines)`,
      );
    }
    if (end < start || end > lines.length) {
      return fail(
        "replace_lines",
        `end line ${end} out of range (start=${start}, file has ${lines.length} lines)`,
      );
    }

    const replacementLines = toLf(replacement).split("\n");
    lines.splice(start - 1, end - start + 1, ...replacementLines);
    this.writeText(abs, joinLines(lines, hadTrailingNewline, eol));

    return ok(
      "replace_lines",
      `replaced ${path}:${start}-${end} with ${replacementLines.length} lines`,
      `Replaced lines ${start}-${end} of ${path} with ${replacementLines.length} new line(s).`,
    );
  }

  private readSymbol(path?: string, symbol?: string): ToolObservation {
    if (!path || !symbol) return fail("read_symbol", "missing required arguments: path, symbol");
    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("read_symbol", `file not found: ${path}`);

    const source = this.readText(abs);
    const span = findSymbol(source, symbol);
    if (!span) {
      const available = listSymbolNames(source).slice(0, 25);
      return fail(
        "read_symbol",
        `symbol "${symbol}" not found in ${path}`,
        `Symbol "${symbol}" not found in ${path}. Symbols present: ${available.join(", ") || "(none detected)"}`,
      );
    }

    const body = toLf(source).slice(span.declStart, span.declEnd);
    return ok(
      "read_symbol",
      `read ${symbol} (${span.kind}) from ${path}`,
      clampObservation(`${path} :: ${symbol} (${span.kind}):\n${body}`, "symbol"),
    );
  }

  private replaceSymbolBody(path?: string, symbol?: string, body?: string): ToolObservation {
    if (!path || !symbol)
      return fail("replace_symbol_body", "missing required arguments: path, symbol");
    if (body === undefined) return fail("replace_symbol_body", "missing required argument: body");

    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("replace_symbol_body", `file not found: ${path}`);

    const original = this.readText(abs);
    const eol = detectEol(original);
    const text = toLf(original);
    const span = findSymbol(text, symbol);
    if (!span) return fail("replace_symbol_body", `symbol "${symbol}" not found in ${path}`);
    if (span.bodyOpen === -1) {
      return fail(
        "replace_symbol_body",
        `symbol "${symbol}" in ${path} has no {...} body to replace`,
      );
    }

    // Body statements sit one level deeper than the declaration itself.
    const inner = `${span.indent}  `;
    const reindented = reindentBlock(body, inner);
    const updated = `${text.slice(0, span.bodyOpen + 1)}\n${reindented}\n${span.indent}${text.slice(span.bodyClose)}`;

    this.writeText(abs, applyEol(updated, eol));
    return ok(
      "replace_symbol_body",
      `replaced body of ${symbol} in ${path}`,
      `Replaced the body of ${symbol} (${span.kind}) in ${path}, preserving surrounding indentation.`,
    );
  }

  private insertAfterSymbol(path?: string, symbol?: string, content?: string): ToolObservation {
    if (!path || !symbol)
      return fail("insert_after_symbol", "missing required arguments: path, symbol");
    if (content === undefined)
      return fail("insert_after_symbol", "missing required argument: content");

    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("insert_after_symbol", `file not found: ${path}`);

    const original = this.readText(abs);
    const eol = detectEol(original);
    const text = toLf(original);
    const span = findSymbol(text, symbol);
    if (!span) return fail("insert_after_symbol", `symbol "${symbol}" not found in ${path}`);

    const block = reindentBlock(content, span.indent);
    const updated = `${text.slice(0, span.declEnd)}\n\n${block}\n${text.slice(span.declEnd)}`;
    this.writeText(abs, applyEol(updated, eol));

    return ok(
      "insert_after_symbol",
      `inserted after ${symbol} in ${path}`,
      `Inserted ${splitLines(content).lines.length} line(s) after ${symbol} in ${path}.`,
    );
  }

  /** Depth-first file walk; `onFile` returns false to stop the traversal early. */
  private walk(startAbs: string, onFile: (abs: string) => boolean): void {
    const stack = [startAbs];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(abs);
        else if (entry.isFile() && !onFile(abs)) return;
      }
    }
  }

  private findFiles(pattern: string, path: string): ToolObservation {
    const abs = resolveInWorktree(this.root, path);
    const results: string[] = [];
    this.walk(abs, (file) => {
      const rel = this.rel(file);
      if (matchesGlob(rel, pattern)) results.push(rel);
      return results.length < MAX_FIND_RESULTS;
    });

    if (results.length === 0) {
      return ok(
        "find_files",
        `no files match "${pattern}"`,
        `No files under ${path} match "${pattern}".`,
      );
    }
    return ok(
      "find_files",
      `${results.length} file(s) match "${pattern}"`,
      clampObservation(
        `${results.length} match(es) for "${pattern}":\n${results.join("\n")}`,
        "matches",
      ),
    );
  }

  private listDir(path: string): ToolObservation {
    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("list_dir", `directory not found: ${path}`);
    if (!statSync(abs).isDirectory()) return fail("list_dir", `${path} is a file, not a directory`);

    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();

    return ok(
      "list_dir",
      `listed ${path} (${entries.length} entries)`,
      `${path}:\n${entries.join("\n") || "(empty)"}`,
    );
  }

  private grep(query: string | undefined, path: string, wholeWord: boolean): ToolObservation {
    const tool = wholeWord ? "find_references" : "grep_search";
    if (!query) return fail(tool, `missing required argument: ${wholeWord ? "symbol" : "query"}`);

    const abs = resolveInWorktree(this.root, path);
    let re: RegExp;
    try {
      re = wholeWord
        ? new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
        : new RegExp(query);
    } catch {
      // Not valid regex — fall back to a literal substring search.
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    const hits: string[] = [];
    this.walk(abs, (file) => {
      let text: string;
      try {
        text = this.readText(file);
      } catch {
        return true;
      }
      const rel = this.rel(file);
      const { lines } = splitLines(text);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (re.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= MAX_GREP_MATCHES) return false;
        }
      }
      return true;
    });

    if (hits.length === 0) {
      return ok(tool, `no matches for "${query}"`, `No matches for "${query}" under ${path}.`);
    }
    const capped = hits.length >= MAX_GREP_MATCHES ? ` (capped at ${MAX_GREP_MATCHES})` : "";
    return ok(
      tool,
      `${hits.length} match(es) for "${query}"${capped}`,
      clampObservation(
        `${hits.length} match(es) for "${query}"${capped}:\n${hits.join("\n")}`,
        "matches",
      ),
    );
  }

  private async runCmd(command?: string, args: string[] = []): Promise<ToolObservation> {
    if (!command) return fail("run_cmd", "missing required argument: command");

    const result = await this.sandbox.execute(command, args, {
      allowedPaths: [this.root],
      allowNetwork: this.options.allowNetwork ?? false,
      timeoutMs: this.options.commandTimeoutMs ?? 120_000,
      cwd: this.root,
    });

    const label = [command, ...args].join(" ");
    const stream = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = clampObservation(stream || "(no output)", "command output");

    if (result.timedOut) {
      return fail(
        "run_cmd",
        `${label} timed out`,
        `$ ${label}\nTIMED OUT after ${result.durationMs}ms\n${detail}`,
      );
    }
    if (result.exitCode !== 0) {
      return fail(
        "run_cmd",
        `${label} exited ${result.exitCode}`,
        `$ ${label}\nexit code ${result.exitCode}\n${detail}`,
      );
    }
    return ok("run_cmd", `${label} exited 0`, `$ ${label}\nexit code 0\n${detail}`);
  }

  /** Execute a command in the sandbox and return the raw result, bypassing observation framing. */
  public async runCommandRaw(command: string, args: string[] = []): Promise<ExecutionResult> {
    return this.sandbox.execute(command, args, {
      allowedPaths: [this.root],
      allowNetwork: this.options.allowNetwork ?? false,
      timeoutMs: this.options.commandTimeoutMs ?? 120_000,
      cwd: this.root,
    });
  }

  private note(message?: string): ToolObservation {
    if (!message) return fail("note", "missing required argument: message");
    this.notes.push(message);
    return ok("note", `recorded note (${this.notes.length} total)`, "Note recorded.");
  }

  private docs(query: string): ToolObservation {
    const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "DEFINITION_OF_DONE.md"];
    const found: string[] = [];

    for (const name of candidates) {
      const abs = join(this.root, name);
      if (!existsSync(abs)) continue;
      const text = this.readText(abs);
      const { lines } = splitLines(text);
      const needle = query.toLowerCase();
      // Return matching lines rather than the whole document, but keep the
      // document's own title: without it the model sees quotes with no source.
      const title = lines
        .find((l) => l.trimStart().startsWith("#"))
        ?.replace(/^#+\s*/, "")
        .trim();
      const matched = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.toLowerCase().includes(needle))
        .slice(0, 10)
        .map(({ l, i }) => `${name}:${i + 1}: ${l.trim()}`);
      if (matched.length > 0) {
        const header = title ? `--- ${name} — ${title} ---` : `--- ${name} ---`;
        found.push(`${header}\n${matched.join("\n")}`);
      }
    }

    if (found.length === 0) {
      return ok(
        "docs",
        `no documentation matches "${query}"`,
        `No documentation found matching "${query}".`,
      );
    }
    return ok(
      "docs",
      `documentation matches for "${query}"`,
      clampObservation(found.join("\n\n"), "documentation"),
    );
  }
}
