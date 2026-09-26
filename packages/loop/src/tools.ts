import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  type LspPool,
  condenseToolOutput,
  languageOf as lspLanguageOf,
  workerCopy,
} from "@sekhemet/context";
import { redactSecrets } from "@sekhemet/gates";
import type { ToolCall } from "@sekhemet/models";
import {
  type ExecutionResult,
  PermissionEngine,
  type ProcessSandbox,
  commandHosts,
  confinedSandbox,
  dumpDom,
  htmlToText,
  stopProcessTree,
  tagUntrusted,
} from "@sekhemet/sandbox";

/** A free loopback port for a background process (L23). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
import { matchesGlob } from "./glob.js";
import { type ToolObservation, clampObservation, denied, fail, ok } from "./observation.js";
import { PathEscapeError, canonicalizeRoot, resolveInWorktree } from "./paths.js";
import { findSymbol, listSymbolNames } from "./symbols.js";
import { applyEol, detectEol, joinLines, reindentBlock, splitLines, toLf } from "./text.js";
import { RESTRICTED_TOOL_NAMES } from "./tool_catalog.js";
import { type SymbolLocation, TsSymbolService, isTypeScriptLike } from "./ts_service.js";
import { atomicWrite, validateWrite } from "./write_contract.js";

/** One rename site: the offsets it replaces and the text that replaces them (M2). */
interface RenameEdit {
  start: number;
  end: number;
  text: string;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sekhemet", "coverage", ".next"]);
const MAX_GREP_MATCHES = 80;
/** Lines of grep output (matches plus context) handed back at most. */
const MAX_GREP_OUTPUT_LINES = 240;
/** Lines of command output kept after condensing (error lines are always kept). */
const RUN_CMD_MAX_LINES = 60;

/** How `grep_search` reports what it found (L6). */
export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GrepOptions {
  /** Directory to search, worktree-relative. */
  path?: string;
  mode?: GrepOutputMode;
  /** Lines of context before and after each match (content mode only). */
  context?: number;
  /** Only search files matching this glob (basename match when it has no slash). */
  glob?: string;
  caseInsensitive?: boolean;
  wholeWord?: boolean;
}

/**
 * Shell programs `run_cmd` refuses as the leading command, with the tool that
 * does the job without flooding the context (L8). A raw `cat` of a long file
 * costs its full length; `read_file` returns numbered lines or an outline.
 */
const REDIRECTED_COMMANDS: Record<string, { tool: string; how: string }> = {
  cat: { tool: "read_file", how: 'read_file(path="...") (add start/end for a range)' },
  head: { tool: "read_file", how: 'read_file(path="...", start=1, end=40)' },
  tail: { tool: "read_file", how: 'read_file(path="...", start=..., end=...)' },
  less: { tool: "read_file", how: 'read_file(path="...")' },
  more: { tool: "read_file", how: 'read_file(path="...")' },
  grep: { tool: "grep_search", how: 'grep_search(query="...", path="src", context=2)' },
  egrep: { tool: "grep_search", how: 'grep_search(query="...")' },
  fgrep: { tool: "grep_search", how: 'grep_search(query="...")' },
  rg: { tool: "grep_search", how: 'grep_search(query="...", output_mode="files_with_matches")' },
  sed: {
    tool: "edit",
    how: 'edit(path="...", search="exact old text", replace="new text"), or read_file for sed -n',
  },
};

/** The leading program of each `&&` / `||` / `;` segment of a command line. */
function leadingPrograms(line: string): string[] {
  return line
    .split(/&&|\|\||;|\n/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      // Skip leading `VAR=value` assignments and a `command`/`exec` prefix.
      const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      const first = words[0] === "command" || words[0] === "exec" ? words[1] : words[0];
      return basename((first ?? "").replace(/^[({]+/, ""));
    })
    .filter(Boolean);
}
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
  /**
   * Whether the session offers `recall` (context CX-M1-1). Default true; when
   * false, condensed output carries no recall pointer.
   */
  recallOffered?: boolean | undefined;
  worktreePath: string;
  scopeFiles?: string[] | undefined;
  agentRole?: string | undefined;
  allowNetwork?: boolean | undefined;
  commandTimeoutMs?: number | undefined;
  sandbox?: ProcessSandbox | undefined;
  permissionEngine?: PermissionEngine | undefined;
  /** Invoked for `ask`-tier calls. Absent means ask-tier is refused. */
  onApproval?: ApprovalHandler | undefined;
  /**
   * Restricted mode (defect 3): refuse `run_cmd`, shell lines and raw commands
   * whenever the sandbox cannot confine them, exactly as the gate runner does.
   */
  requireConfinement?: boolean | undefined;
  /** The project's protected globs, from `gates.toml [project] protected` (defect 5). */
  protectedGlobs?: string[] | undefined;
  /**
   * Refuse an edit or overwrite of an existing file the agent has not read
   * (or been shown) this card (L17). Default on.
   */
  requireReadBeforeEdit?: boolean | undefined;
  /**
   * Restricted mode (S12, design "Restricted mode"): read-only inspection.
   * Every tool that writes a file or runs a command is refused, whatever
   * the catalog the model was shown; `check` still runs the static gates.
   */
  readOnly?: boolean | undefined;
  /** Domains network commands may reach (S8), through the egress proxy (S5). */
  allowedDomains?: string[] | undefined;
  /** The card's egress proxy port (S5); commands get it as their only network. */
  egressProxyPort?: number | undefined;
  /**
   * Language servers for the symbol tools (C2, NEW-worker-loop-7): TypeScript
   * through its server first, then the in-process service; other languages
   * through theirs, then text search.
   */
  lspPool?: LspPool | undefined;
  /**
   * The card declares a mechanical change (a `refactor`): `rename_symbol` may
   * then change files outside the declared scope (WL-N6-2).
   */
  mechanicalChange?: boolean | undefined;
  /**
   * The library's official web docs for `docs(query, library)` when the
   * installed copy has nothing (supplied by the harness's research service).
   */
  webDocs?: ((library: string, query: string) => Promise<string>) | undefined;
  /** The card's class (L18/L19): `browse` reaches outside localhost only on research cards. */
  cardClass?: string | undefined;
}

/**
 * What the Worker is told when a call is refused because the tool is not
 * available to it: restricted mode (S12, SEC-19) and a tool this session did
 * not offer. Model-facing copy lives here, not at the call sites.
 */
export const REFUSAL_COPY = {
  restricted:
    "restricted mode: this is a read-only audit. Files cannot be written and commands cannot run; inspect with read_file, read_symbol, grep_search and check, and record findings with note().",
  notOfferedSummary: "not offered on this card",
  notOffered: (name: string, offered: readonly string[]): string =>
    `${name} is not available on this card; the tools you can call are: ${offered.join(", ")}.`,
} as const;

/** Tools that change the worktree or execute code: refused in restricted mode. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "replace_lines",
  "replace_symbol_body",
  "insert_after_symbol",
  "rename_symbol",
  "run_cmd",
  "start_process",
  "write_process",
]);

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
/** Unranged reads above this many lines return an outline (delegated reading). */
const OUTLINE_THRESHOLD = 200;

/** Top-level declarations with their line numbers, for the outline. */
function outlineOf(lines: string[]): string {
  const re =
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|type|enum|const|let|var|describe|it|test)\s*\(?\s*['"`]?([A-Za-z_$][\w$ -]*)/;
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (m?.[2])
      out.push(`${String(i + 1).padStart(5)}  ${m[1]?.replace(/\s+/g, "")} ${m[2].trim()}`);
  });
  return out.slice(0, 80).join("\n");
}

/** An observation with every secret the scanner finds redacted (security item 34, SEC-22). */
export function redactObservation(o: ToolObservation): ToolObservation {
  const content = redactSecrets(o.content);
  const summary = redactSecrets(o.summary);
  return content === o.content && summary === o.summary ? o : { ...o, content, summary };
}

export class ToolExecutor {
  public readonly root: string;
  /** Tokens output condensing removed from what the model saw (runtime RUN-47). */
  private condensedSaved = 0;
  private sandbox: ProcessSandbox;
  private permissions: PermissionEngine;
  private notes: string[] = [];
  private finishRequested = false;
  private readFiles = new Set<string>();
  private shownInFull = new Set<string>();
  /** Worktree-relative files whose current contents the agent has seen this card. */
  private seen = new Set<string>();
  private deniedByRule = new Map<string, number>();
  /** Lines a mechanical tool changed, per worktree-relative file (WL-N6-1, gates GT-BF-3). */
  private toolApplied = new Map<string, Set<number>>();

  constructor(private options: ToolExecutorOptions) {
    this.root = canonicalizeRoot(options.worktreePath);
    this.sandbox = options.sandbox ?? confinedSandbox(options.requireConfinement === true);
    this.permissions =
      options.permissionEngine ??
      new PermissionEngine({
        ...(options.protectedGlobs?.length ? { protectedGlobs: options.protectedGlobs } : {}),
        ...(options.allowedDomains?.length ? { allowedDomains: options.allowedDomains } : {}),
      });
  }

  /**
   * Record that the agent has the file's contents in front of it without a
   * read_file call (pinned in the prompt), so read-before-edit admits it.
   */
  /**
   * The files the last prompt showed in full (the B2.1 review, B2): edit's
   * refusal points at the content above only for these.
   */
  public setShownInFull(paths: readonly string[]): void {
    this.shownInFull = new Set(paths);
  }

  /** The tools this step offers: a reply names only these (review item 3). Unset: all. */
  private offeredTools: ReadonlySet<string> | undefined;

  public setOfferedTools(names: readonly string[]): void {
    this.offeredTools = new Set(names);
  }

  private offers(name: string): boolean {
    return this.offeredTools === undefined || this.offeredTools.has(name);
  }

  public markSeen(relPath: string): void {
    try {
      this.seen.add(this.rel(resolveInWorktree(this.root, relPath)));
    } catch {
      // A path outside the worktree is never seen.
    }
  }

  /** True when the agent has read or been shown this file this card. */
  public hasSeen(relPath: string): boolean {
    try {
      return this.seen.has(this.rel(resolveInWorktree(this.root, relPath)));
    } catch {
      return false;
    }
  }

  /** How many calls each permission rule has refused this card. */
  public getDenialCounts(): Record<string, number> {
    return Object.fromEntries(this.deniedByRule);
  }

  /** Restricted mode with no OS confinement: commands must not run at all. */
  private confinementRefusal(): string | undefined {
    const required = this.options.requireConfinement === true || this.sandbox.requiresConfinement;
    if (!required || this.sandbox.confinement !== "none") return undefined;
    return "restricted mode: this host has no OS confinement (Seatbelt or bubblewrap), so commands cannot run. Use the file tools and check instead.";
  }

  /**
   * Read-before-edit (L17): an edit to an existing file must be based on what
   * the agent has actually seen of it this card. Creating a file needs no read.
   */
  private unreadRefusal(tool: string, path: string, abs: string): ToolObservation | undefined {
    if (this.options.requireReadBeforeEdit === false) return undefined;
    if (!existsSync(abs) || this.seen.has(this.rel(abs))) return undefined;
    return fail(
      tool,
      `${tool} refused: ${path} has not been read this card`,
      `${tool} refused: you have not read ${path} during this card, so the change would be based on a guess about its contents. Read it first with read_file(path="${path}") or read_symbol, then edit. (Creating a new file needs no read.)`,
    );
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
    if (!existsSync(abs)) return matches;
    for (const file of statSync(abs).isFile() ? [abs] : this.searchableFiles(abs)) {
      let text: string;
      try {
        text = this.readText(file);
      } catch {
        continue;
      }
      const rel = this.rel(file);
      const { lines } = splitLines(text);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (re.test(line)) {
          matches.push({ file: rel, line: i + 1, content: line.trim() });
          if (matches.length >= MAX_GREP_MATCHES) return matches;
        }
      }
    }
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
    // The write contract (L16, G7): parse, secret scan, then an atomic write.
    // The thrown message becomes the observation, so the model sees exactly
    // what was refused and where.
    const verdict = validateWrite(abs, content, this.rel(abs));
    if (!verdict.ok) {
      const parse = verdict.problems.filter((p) => p.rule === "parse").map((p) => p.message);
      const secrets = verdict.problems.filter((p) => p.rule === "secret").map((p) => p.message);
      throw new Error(
        [
          parse.length
            ? `write refused: the result would not parse (${parse.join("; ")}). The file on disk is unchanged. For a short file, rewrite it whole with write_file.`
            : "",
          secrets.length
            ? `write refused: it would add a credential (${secrets.join("; ")}). Read secrets from the environment or a config file outside the repository; never write them into source.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    atomicWrite(abs, content);
  }

  /** Refused in restricted mode (SEC-19): a writer, or a tool outside the restricted catalog. */
  private restrictedRefuses(name: string): boolean {
    return (
      this.options.readOnly === true &&
      (MUTATING_TOOLS.has(name) || !RESTRICTED_TOOL_NAMES.includes(name))
    );
  }

  /**
   * A model call to a tool this session did not offer (a class's tool set,
   * `run_script` for a Worker that is not script-capable, WL-M2-4) is refused,
   * not run: leaving a tool out of the prompt is not a permission. Restricted
   * mode's own refusal speaks for the tools it covers.
   */
  public refuseNotOffered(name: string, offered: readonly string[]): ToolObservation | undefined {
    if (offered.includes(name) || this.restrictedRefuses(name)) return undefined;
    this.deniedByRule.set("not_offered", (this.deniedByRule.get("not_offered") ?? 0) + 1);
    return {
      ...denied(name, REFUSAL_COPY.notOfferedSummary),
      content: REFUSAL_COPY.notOffered(name, offered),
      deniedRule: "not_offered",
    };
  }

  /** Run the three-tier permission check, escalating `ask` to the approval handler. */
  private async authorize(call: ToolCall): Promise<ToolObservation | null> {
    // SEC-19: an audit runs only the restricted catalog. A tool it was not
    // offered (browse, start_process, a writer) is refused whatever the model
    // calls, not merely left out of the prompt.
    if (this.restrictedRefuses(call.name)) {
      this.deniedByRule.set("restricted", (this.deniedByRule.get("restricted") ?? 0) + 1);
      return {
        ...denied(call.name, REFUSAL_COPY.restricted),
        deniedRule: "restricted",
      };
    }
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
      // Program + args is one program; a bare string is a shell line (S8).
      ...(rawCommand && args.length > 0 ? { program: rawCommand } : {}),
      localBinaries: this.localBinaries(),
      declaredScopeFiles: this.options.scopeFiles,
      agentRole: this.options.agentRole ?? "implementer",
      allowNetwork: this.options.allowNetwork ?? false,
    });

    if (
      this.untrustedContext &&
      (verdict.tier === "ask" || (command && commandHosts(command).length > 0))
    ) {
      return {
        ...denied(
          call.name,
          `strict policy: this step's context includes untrusted content, so ${verdict.tier === "ask" ? (verdict.reason ?? "this command") : "network access"} is refused without asking`,
        ),
        deniedRule: "untrusted_context",
      };
    }
    if (verdict.allowed) return null;
    if (verdict.rule) {
      this.deniedByRule.set(verdict.rule, (this.deniedByRule.get(verdict.rule) ?? 0) + 1);
    }

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

    return {
      ...denied(call.name, verdict.reason ?? "denied by policy"),
      ...(verdict.rule ? { deniedRule: verdict.rule } : {}),
    };
  }

  public async execute(call: ToolCall): Promise<ToolObservation> {
    // SEC-22: what a tool returns is redacted before anything keeps it — the
    // prompt (a stored context pack), the step records, the transcript.
    return redactObservation(await this.executeUnredacted(call));
  }

  private async executeUnredacted(call: ToolCall): Promise<ToolObservation> {
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
      case "find_references": {
        const viaLsp = await this.lspReferences(str("symbol"), str("file"));
        if (viaLsp) return viaLsp;
        // WL-N7-3: a non-TypeScript file whose server is out: text search, said so.
        const down = this.lspDown(str("file"));
        if (down && !isTypeScriptLike(str("file") ?? "")) {
          return this.textReferences(str("symbol"), str("path") ?? ".", down);
        }
        return this.findReferences(str("symbol"), str("path") ?? ".", str("file"));
      }
      case "go_to_definition": {
        const viaLsp = await this.lspDefinition(str("symbol"), str("file"));
        return viaLsp ?? this.goToDefinition(str("symbol"), str("file"));
      }
      case "rename_symbol":
        return this.renameSymbol(str("path"), str("symbol"), str("new_name"));
      case "run_script":
        return this.runScript(str("code"));
      case "start_process":
        return this.startProcess(str("name"), str("command"));
      case "read_process":
        return this.readProcess(str("name"), num("lines"));
      case "write_process":
        return this.writeProcess(str("name"), str("input"));
      case "stop_process":
        return this.stopProcess(str("name"));
      case "browse":
        return this.browse(str("url"));
      case "grep_search": {
        const mode = str("output_mode");
        const ctx = num("context");
        const glob = str("glob");
        return this.grep(str("query"), {
          path: str("path") ?? ".",
          ...(mode !== undefined ? { mode: mode as GrepOutputMode } : {}),
          ...(ctx !== undefined ? { context: ctx } : {}),
          ...(glob ? { glob } : {}),
          caseInsensitive: a.case_insensitive === true,
        });
      }
      case "list_dir":
        return this.listDir(str("path") ?? ".");
      case "find_files":
        return this.findFiles(str("pattern") ?? "*", str("path") ?? ".");
      case "run_cmd":
        return this.runCmd(
          str("command"),
          Array.isArray(a.args) ? (a.args as string[]) : [],
          str("description"),
        );
      case "note":
        return this.note(str("message"));
      case "docs":
        return this.docs(str("query") ?? "", str("library"));
      case "git_history":
        return this.gitHistory(str("query") ?? "", str("sha"));
      case "dependencies":
        return this.dependencies(str("query") ?? "");
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
      return fail(
        "read_file",
        workerCopy.readFileDirectory(
          path,
          this.offers("list_dir")
            ? "list_dir"
            : this.offers("grep_search")
              ? "grep_search"
              : undefined,
        ),
      );

    const source = this.readText(abs);
    const { lines } = splitLines(source);
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    if (from > lines.length) {
      return fail("read_file", `start line ${from} is past end of file (${lines.length} lines)`);
    }

    this.readFiles.add(path.replace(/^\.\//, ""));
    this.seen.add(this.rel(abs));

    // Delegated reading (SoL-Pi, arXiv 2609.20519): a whole large file floods
    // a 16k window. Unranged reads of long files return an outline with line
    // numbers plus the head; the Worker then reads exactly what it needs.
    if (start === undefined && end === undefined && lines.length > OUTLINE_THRESHOLD) {
      const outline = outlineOf(lines);
      const head = lines
        .slice(0, 40)
        .map((l, i) => `${String(i + 1).padStart(5)}│${l}`)
        .join("\n");
      return ok(
        "read_file",
        `outlined ${path} (${lines.length} lines)`,
        workerCopy.readFileOutline(
          path,
          String(lines.length),
          outline,
          head,
          this.offers("read_symbol") ? "read_symbol" : undefined,
        ),
      );
    }

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
    const unread = this.unreadRefusal("write_file", path, abs);
    if (unread) return unread;
    // Preserve the file's existing line-ending convention on rewrite.
    const eol = existed ? detectEol(this.readText(abs)) : "\n";
    this.writeText(abs, applyEol(toLf(content), eol));
    // The agent wrote every byte, so it knows the file's contents.
    this.seen.add(this.rel(abs));

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
    const unread = this.unreadRefusal("edit", path, abs);
    if (unread) return unread;

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
        workerCopy.editNotFound(path, this.shownInFull.has(path.replace(/^\.\//, ""))),
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
    const unread = this.unreadRefusal("replace_lines", path, abs);
    if (unread) return unread;

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
    this.seen.add(this.rel(abs));
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
    const unread = this.unreadRefusal("replace_symbol_body", path, abs);
    if (unread) return unread;

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
    const unread = this.unreadRefusal("insert_after_symbol", path, abs);
    if (unread) return unread;

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

  /**
   * L7: git's view of the tree (gitignore-aware), newest first. Recently
   * modified files are the ones a card is most likely about, which is why
   * Claude Code's Glob sorts by mtime rather than by name.
   */
  private findFiles(pattern: string, path: string): ToolObservation {
    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail("find_files", `directory not found: ${path}`);
    const matched = this.searchableFiles(abs)
      .map((file) => ({ rel: this.rel(file), file }))
      .filter(({ rel }) => matchesGlob(rel, pattern))
      .map(({ rel, file }) => {
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          // Vanished between listing and stat: sorts last.
        }
        return { rel, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const results = matched.slice(0, MAX_FIND_RESULTS).map((m) => m.rel);
    const more = matched.length - results.length;

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
        `${results.length} match(es) for "${pattern}", newest first:\n${results.join("\n")}${more > 0 ? `\n(${more} more not shown; narrow the pattern)` : ""}`,
        "matches",
      ),
    );
  }

  private localBins: Set<string> | undefined;
  private untrustedContext = false;

  /**
   * The step's context includes untrusted content (S9): ask-tier calls are
   * refused without asking anyone, and network commands are refused even
   * when their domain is allowlisted.
   */
  public setUntrustedContext(on: boolean): void {
    this.untrustedContext = on;
  }

  /** Programs the project provides in node_modules/.bin (trusted, S8). */
  private localBinaries(): Set<string> {
    if (!this.localBins) {
      const bin = join(this.root, "node_modules", ".bin");
      this.localBins = new Set(existsSync(bin) ? readdirSync(bin) : []);
    }
    return this.localBins;
  }

  private tsService: TsSymbolService | undefined;

  // --- L12 code mode ---------------------------------------------------------

  /**
   * L12: a script over read-only helpers, run in its own Node process under
   * the OS sandbox and Node's permission model: it may read the worktree and
   * nothing else (no writes, no child processes, no workers), with a
   * 10-second timeout. Its return value (a string or JSON) is the observation.
   */
  private async runScript(code: string | undefined): Promise<ToolObservation> {
    if (!code?.trim()) return fail("run_script", "code is required");
    // Real paths: Node's permission model compares resolved paths (/var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sekhemet-script-")));
    const file = join(dir, "script.cjs");
    writeFileSync(
      file,
      `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ROOT = ${JSON.stringify(this.root)};
const SKIP = new Set(["node_modules", ".git", "dist", ".sekhemet", "coverage"]);
const inRoot = (p) => { const a = path.resolve(ROOT, String(p)); if (a !== ROOT && !a.startsWith(ROOT + path.sep)) throw new Error("outside the worktree: " + p); return a; };
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const a = path.join(dir, e.name); if (e.isDirectory()) walk(a, out); else out.push(path.relative(ROOT, a)); if (out.length > 5000) break; } return out; };
const globRe = (g) => new RegExp("^" + String(g).replace(/[.+^$(){}|[\\]\\\\]/g, "\\\\$&").replace(/\\*\\*\\/?/g, "\\u0000").replace(/\\*/g, "[^/]*").replace(/\\?/g, "[^/]").replace(/\\u0000/g, ".*") + "$");
const read = (p) => fs.readFileSync(inRoot(p), "utf8");
const list = (d = ".") => fs.readdirSync(inRoot(d)).filter((n) => !SKIP.has(n)).sort();
const find = (g, d = ".") => { const re = globRe(g); return walk(inRoot(d)).filter((f) => re.test(f)).sort().slice(0, 500); };
const grep = (pattern, d = ".") => { const re = new RegExp(pattern); const out = []; const base = inRoot(d); const files = fs.statSync(base).isFile() ? [path.relative(ROOT, base)] : walk(base); for (const f of files) { let lines; try { lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\\n"); } catch { continue; } lines.forEach((t, i) => { if (re.test(t)) out.push({ file: f, line: i + 1, text: t.trim() }); }); if (out.length >= 500) break; } return out; };
const __result = (function () {
${code}
})();
Promise.resolve(__result).then((v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "undefined"); }, (e) => { process.stderr.write(String(e && e.message || e)); process.exitCode = 1; });
`,
    );
    try {
      const result = await this.sandbox.execute(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${realpathSync(this.root)}`,
          `--allow-fs-read=${dir}`,
          file,
        ],
        { allowedPaths: [], allowNetwork: false, timeoutMs: 10_000, cwd: dir },
      );
      if (result.timedOut)
        return fail("run_script", "script timed out", "run_script timed out after 10 s.");
      if (result.exitCode !== 0) {
        return fail(
          "run_script",
          "script failed",
          `run_script failed: ${(result.stderr || result.stdout).trim().split("\n").slice(0, 8).join("\n")}`,
        );
      }
      return ok(
        "run_script",
        `script returned ${result.stdout.length} chars`,
        clampObservation(result.stdout, "script output"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- L23 background processes, L24 interactive input -----------------------

  private processes = new Map<
    string,
    {
      child: import("node:child_process").ChildProcessWithoutNullStreams;
      port: number;
      output: string[];
      exit?: number | null;
    }
  >();

  /** Ports held by this card's background processes. */
  public processPorts(): number[] {
    return [...this.processes.values()].map((p) => p.port);
  }

  private async startProcess(
    name: string | undefined,
    command: string | undefined,
  ): Promise<ToolObservation> {
    if (!name || !command) return fail("start_process", "name and command are required");
    if (this.processes.has(name) && this.processes.get(name)?.exit === undefined) {
      return fail(
        "start_process",
        `${name} is already running`,
        `A process named ${name} is running; stop_process it first or pick another name.`,
      );
    }
    const port = await freePort();
    const child = this.sandbox.spawnBackground("/bin/sh", ["-c", command], {
      allowedPaths: [this.root],
      allowNetwork: this.options.allowNetwork ?? false,
      timeoutMs: 0,
      cwd: this.root,
      env: { PORT: String(port) },
      localPorts: [port],
      ...(this.options.egressProxyPort ? { egressProxyPort: this.options.egressProxyPort } : {}),
    });
    if (!child)
      return fail(
        "start_process",
        "no OS confinement",
        "Background processes need OS confinement on this host.",
      );
    const entry: { child: typeof child; port: number; output: string[]; exit?: number | null } = {
      child,
      port,
      output: [],
    };
    const push = (chunk: Buffer) => {
      entry.output.push(...chunk.toString("utf8").split("\n"));
      if (entry.output.length > 2000) entry.output.splice(0, entry.output.length - 2000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("exit", (code) => {
      entry.exit = code;
    });
    this.processes.set(name, entry);
    await new Promise((r) => setTimeout(r, 300));
    return ok(
      "start_process",
      `started ${name} on port ${port}`,
      `Started ${name} (pid ${child.pid}) with PORT=${port}. Read its output with read_process(name="${name}"); reach it at http://localhost:${port}/.${entry.exit !== undefined ? ` It already exited with ${entry.exit}.` : ""}`,
    );
  }

  private readProcess(name: string | undefined, lines: number | undefined): ToolObservation {
    const p = name ? this.processes.get(name) : undefined;
    if (!p)
      return fail(
        "read_process",
        `no process ${name}`,
        `No background process named ${name}. Running: ${[...this.processes.keys()].join(", ") || "none"}.`,
      );
    const tail = p.output.slice(-(lines ?? 40)).join("\n");
    const state = p.exit === undefined ? `running on port ${p.port}` : `exited with ${p.exit}`;
    return ok(
      "read_process",
      `${name}: ${state}`,
      `${name} is ${state}.\n${tail || "(no output yet)"}`,
    );
  }

  private writeProcess(name: string | undefined, input: string | undefined): ToolObservation {
    const p = name ? this.processes.get(name) : undefined;
    if (!p || p.exit !== undefined) return fail("write_process", `${name} is not running`);
    p.child.stdin.write(`${input ?? ""}\n`);
    return ok(
      "write_process",
      `sent ${String(input ?? "").length} chars to ${name}`,
      `Sent to ${name}. Read the response with read_process.`,
    );
  }

  private stopProcess(name: string | undefined): ToolObservation {
    const p = name ? this.processes.get(name) : undefined;
    if (!p) return fail("stop_process", `no process ${name}`);
    // The whole tree: `sh -c` is only the parent of the real server (B1 review).
    void stopProcessTree(p.child).catch(() => undefined);
    this.processes.delete(name as string);
    return ok("stop_process", `stopped ${name}`, `Stopped ${name}.`);
  }

  /** Count what one condensing removed (runtime item 32, RUN-47); returns it unchanged. */
  public countCondensed<T extends { result: { tokensSaved: number } }>(condensed: T): T {
    this.condensedSaved += condensed.result.tokensSaved;
    return condensed;
  }

  /** Tokens output condensing removed in this executor's calls so far (RUN-47). */
  public get condensedTokensSaved(): number {
    return this.condensedSaved;
  }

  /** Stop every background process (card end). */
  public dispose(): void {
    for (const p of this.processes.values()) {
      // Detached into its own group: kill the group even when the shell has
      // already exited, since its children can outlive it (B1 review).
      try {
        if (p.child.pid) process.kill(-p.child.pid, "SIGKILL");
      } catch {
        // Gone, or not a group leader.
      }
      try {
        p.child.kill("SIGKILL");
      } catch {
        // Gone.
      }
    }
    this.processes.clear();
  }

  // --- L20 browse --------------------------------------------------------------

  private async browse(url: string | undefined): Promise<ToolObservation> {
    let target: URL;
    try {
      target = new URL(url ?? "");
    } catch {
      return fail("browse", "not a URL");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    if (!local && this.options.cardClass !== "research") {
      return denied(
        "browse",
        "browse reaches only this card's own app on localhost; web pages are for research cards (L19)",
      );
    }
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const dom = await dumpDom(target.toString(), {
      ...(local ? { localPorts: [port] } : {}),
      ...(this.options.egressProxyPort ? { egressProxyPort: this.options.egressProxyPort } : {}),
      ...(this.options.readOnly || this.options.requireConfinement ? { restricted: true } : {}),
    });
    let html = dom;
    if (html === undefined && !local) {
      // A web page is reached only through the confined browser and the
      // card's egress proxy; the harness never fetches it itself (S3a, S5).
      return fail(
        "browse",
        "could not load",
        `Could not load ${target}: no confined browser could render it, and web pages are not fetched outside the sandbox.`,
      );
    }
    if (html === undefined) {
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
        html = await res.text();
      } catch (err) {
        return fail(
          "browse",
          "could not load",
          `Could not load ${target}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const text = htmlToText(html);
    const body = local ? text : tagUntrusted(text, target.hostname);
    return ok(
      "browse",
      `loaded ${target.host}${target.pathname} (${text.length} chars)`,
      clampObservation(body, "page"),
    );
  }

  /** The TypeScript language service over this worktree, built on first use (L9). */
  private symbolService(): TsSymbolService {
    this.tsService ??= new TsSymbolService(this.root, () => this.searchableFiles(this.root));
    return this.tsService;
  }

  /**
   * L9: semantic references through the TypeScript language service for
   * TS/JS symbols (through imports, re-exports and aliases); a whole-word
   * grep for anything else, said as such.
   */
  private findReferences(
    symbol: string | undefined,
    path: string,
    file: string | undefined,
  ): ToolObservation {
    if (!symbol) return fail("find_references", "symbol is required");
    let refs: SymbolLocation[] | undefined;
    try {
      refs = this.symbolService().references(symbol, file);
    } catch {
      refs = undefined;
    }
    if (!refs) {
      const text = this.grep(symbol, { path, wholeWord: true });
      return {
        ...text,
        content: `(no TypeScript declaration of ${symbol}: whole-word text matches)\n${text.content}`,
      };
    }
    const within =
      path === "." ? refs : refs.filter((r) => r.path.startsWith(path.replace(/^\.\//, "")));
    return ok(
      "find_references",
      `${within.length} semantic reference(s) to ${symbol}`,
      clampObservation(
        `${within.length} reference(s) to ${symbol} (resolved by the TypeScript language service; D = declaration):\n${within
          .map((r) => `${r.isDefinition ? "D " : "  "}${r.path}:${r.line}:${r.column}  ${r.text}`)
          .join("\n")}`,
        "references",
      ),
    );
  }

  /**
   * C2: references through the project's language server for a file in a
   * language the TypeScript service does not cover (Python, Rust). The
   * symbol's first whole-word occurrence in `file` is the position asked
   * about. Undefined when no server applies, so the caller falls back.
   */
  private async lspReferences(
    symbol: string | undefined,
    file: string | undefined,
  ): Promise<ToolObservation | undefined> {
    const pool = this.options.lspPool;
    if (!pool || !symbol || !file) return undefined;
    const lang = lspLanguageOf(file);
    if (!lang) return undefined;
    const at = this.symbolPosition(file, symbol);
    if (!at) return undefined;
    const { abs } = at;
    try {
      const client = pool.clientFor(this.root, abs);
      if (!client) return undefined;
      const refs = await client.references(abs, at.line, at.column, true);
      return ok(
        "find_references",
        `${refs.length} reference(s) to ${symbol} (language server)`,
        clampObservation(
          `${refs.length} reference(s) to ${symbol} (resolved by the ${lang} language server):\n${refs
            .map((r) => `  ${this.rel(r.path)}:${r.line}:${r.column}`)
            .join("\n")}`,
          "references",
        ),
      );
    } catch (err) {
      // WL-N7-3: absent, crashed or over its heap: out for the run; the caller falls back.
      pool.markUnavailable(this.root, abs, errorText(err));
      return undefined;
    }
  }

  /** Where a symbol first appears in a file, its declaration line first (1-based). */
  private symbolPosition(
    file: string,
    symbol: string,
  ): { abs: string; line: number; column: number } | undefined {
    const abs = resolveInWorktree(this.root, file);
    if (!existsSync(abs)) return undefined;
    const lines = readFileSync(abs, "utf8").split("\n");
    const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${name}\\b`);
    const decl = new RegExp(
      `\\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct)\\s+${name}\\b`,
    );
    let lineIdx = lines.findIndex((l) => decl.test(l));
    if (lineIdx < 0) lineIdx = lines.findIndex((l) => re.test(l));
    if (lineIdx < 0) return undefined;
    const text = lines[lineIdx] ?? "";
    const declAt = decl.exec(text);
    const column = declAt
      ? declAt.index + declAt[0].length - symbol.length + 1
      : text.search(re) + 1;
    return { abs, line: lineIdx + 1, column };
  }

  /** The language whose server is out for this file, and why (WL-N7-3). */
  private lspDown(file: string | undefined): { language: string; reason: string } | undefined {
    const pool = this.options.lspPool;
    if (!pool || !file) return undefined;
    const language = lspLanguageOf(file);
    const reason = language
      ? pool.unavailableReason(this.root, resolveInWorktree(this.root, file))
      : undefined;
    return language && reason ? { language, reason } : undefined;
  }

  /** Whole-word text matches, saying which server was out (WL-N7-3). */
  private textReferences(
    symbol: string | undefined,
    path: string,
    down: { language: string; reason: string },
  ): ToolObservation {
    const text = this.grep(symbol ?? "", { path, wholeWord: true });
    return {
      ...text,
      content: `${workerCopy.languageServerUnavailable(down.language, clipReason(down.reason))}\n${text.content}`,
    };
  }

  /** WL-N7-1: a declaration through the file's language server; undefined to fall back. */
  private async lspDefinition(
    symbol: string | undefined,
    file: string | undefined,
  ): Promise<ToolObservation | undefined> {
    const pool = this.options.lspPool;
    if (!pool || !symbol || !file || !lspLanguageOf(file)) return undefined;
    const at = this.symbolPosition(file, symbol);
    if (!at) return undefined;
    try {
      const client = pool.clientFor(this.root, at.abs);
      if (!client) return undefined;
      const defs = await client.definition(at.abs, at.line, at.column);
      if (defs.length === 0) return undefined;
      return this.definitions(
        symbol,
        defs.map((d) => {
          const lineText = existsSync(d.path)
            ? (readFileSync(d.path, "utf8").split("\n")[d.line - 1] ?? "").trim()
            : "";
          return { path: this.rel(d.path), line: d.line, column: d.column, detail: lineText };
        }),
      );
    } catch (err) {
      pool.markUnavailable(this.root, at.abs, errorText(err));
      return undefined;
    }
  }

  /** Lines a mechanical tool changed, per file, for the bounds gate (WL-N6-1). */
  public toolAppliedLines(): { tool: "rename_symbol"; files: Record<string, number> } | undefined {
    if (this.toolApplied.size === 0) return undefined;
    const files: Record<string, number> = {};
    for (const [f, lines] of [...this.toolApplied].sort(([a], [b]) => a.localeCompare(b))) {
      files[f] = lines.size;
    }
    return { tool: "rename_symbol", files };
  }

  /**
   * WL-N6-1/2: rename a declaration and every use through the language
   * server (the in-process TypeScript service when there is none), in one
   * call. Refused, naming the files, when a site is outside the card's scope
   * (unless the card's change is mechanical) or protected. The changed lines
   * are recorded as tool-applied.
   */
  private async renameSymbol(
    path: string | undefined,
    symbol: string | undefined,
    newName: string | undefined,
  ): Promise<ToolObservation> {
    if (!path || !symbol || !newName || !/^[A-Za-z_$][\w$]*$/.test(newName)) {
      return fail("rename_symbol", workerCopy.renameArguments);
    }
    const at = this.symbolPosition(path, symbol);
    if (!at) return fail("rename_symbol", workerCopy.renameFileMissing(path));
    const edits =
      (await this.lspRenameEdits(at, newName)) ?? this.tsRenameEdits(path, symbol, newName);
    if (!edits || edits.size === 0) {
      return fail("rename_symbol", workerCopy.renameNoService(symbol, path));
    }
    const files = [...edits.keys()].sort();
    const scope = this.options.scopeFiles ?? [];
    const inScope = (f: string) =>
      scope.some((p) => {
        const pattern = p.replace(/^\.\//, "");
        return f === pattern || f.endsWith(`/${pattern}`) || matchesGlob(f, pattern);
      });
    const outside = files.filter((f) => f.startsWith("..") || (scope.length > 0 && !inScope(f)));
    if (
      outside.length > 0 &&
      (!this.options.mechanicalChange || outside.some((f) => f.startsWith("..")))
    ) {
      return fail("rename_symbol", workerCopy.renameOutsideScope(outside.join(", ")));
    }
    const guarded = files.filter((f) =>
      (this.options.protectedGlobs ?? []).some((g) => matchesGlob(f, g)),
    );
    if (guarded.length > 0)
      return fail("rename_symbol", workerCopy.renameProtected(guarded.join(", ")));
    let sites = 0;
    try {
      for (const f of files) {
        const abs = resolveInWorktree(this.root, f);
        const text = this.readText(abs);
        const spans = [...(edits.get(f) ?? [])].sort((a, b) => b.start - a.start);
        let next = text;
        const touched = this.toolApplied.get(f) ?? new Set<number>();
        for (const e of spans) {
          // M2: each edit's own text (a shorthand site keeps its shape).
          next = `${next.slice(0, e.start)}${e.text}${next.slice(e.end)}`;
          touched.add(text.slice(0, e.start).split("\n").length);
          sites++;
        }
        this.writeText(abs, next);
        this.toolApplied.set(f, touched);
        this.seen.add(f);
      }
    } catch (err) {
      return fail("rename_symbol", errorText(err));
    }
    const said = workerCopy.renamed(symbol, newName, sites, files.join(", "));
    return ok("rename_symbol", said, said);
  }

  /** A rename's sites through the file's language server, by relative file; undefined to fall back. */
  private async lspRenameEdits(
    at: { abs: string; line: number; column: number },
    newName: string,
  ): Promise<Map<string, RenameEdit[]> | undefined> {
    const pool = this.options.lspPool;
    if (!pool || !lspLanguageOf(at.abs)) return undefined;
    try {
      const client = pool.clientFor(this.root, at.abs);
      if (!client) return undefined;
      const changes = await client.rename(at.abs, at.line, at.column, newName);
      const out = new Map<string, RenameEdit[]>();
      for (const c of changes) {
        const text = existsSync(c.path) ? readFileSync(c.path, "utf8") : "";
        const starts = lineStarts(text);
        out.set(
          this.rel(c.path),
          c.edits.map((e) => ({
            start: (starts[e.range.start.line] ?? 0) + e.range.start.character,
            end: (starts[e.range.end.line] ?? 0) + e.range.end.character,
            text: e.newText,
          })),
        );
      }
      return out;
    } catch (err) {
      pool.markUnavailable(this.root, at.abs, errorText(err));
      return undefined;
    }
  }

  /** A rename's sites through the in-process TypeScript service. */
  private tsRenameEdits(
    path: string,
    symbol: string,
    newName: string,
  ): Map<string, RenameEdit[]> | undefined {
    if (!isTypeScriptLike(path)) return undefined;
    let locations: ReturnType<TsSymbolService["renameLocations"]>;
    try {
      locations = this.symbolService().renameLocations(symbol, path);
    } catch {
      locations = undefined;
    }
    if (!locations) return undefined;
    const out = new Map<string, RenameEdit[]>();
    for (const l of locations) {
      const rel = this.rel(l.file);
      const text = `${l.prefixText ?? ""}${newName}${l.suffixText ?? ""}`;
      out.set(rel, [...(out.get(rel) ?? []), { start: l.start, end: l.start + l.length, text }]);
    }
    return out;
  }

  /** The file that declares a TypeScript/JavaScript symbol, for tool_search's read_symbol calls (WL-M2-7). */
  public declaringFile(symbol: string): string | undefined {
    try {
      return this.symbolService().definition(symbol, undefined)[0]?.path;
    } catch {
      return undefined;
    }
  }

  private goToDefinition(symbol: string | undefined, file: string | undefined): ToolObservation {
    if (!symbol) return fail("go_to_definition", "symbol is required");
    let defs: (SymbolLocation & { type: string })[] = [];
    try {
      defs = this.symbolService().definition(symbol, file);
    } catch {
      defs = [];
    }
    if (defs.length === 0) {
      return fail(
        "go_to_definition",
        `no declaration of ${symbol}`,
        `No TypeScript/JavaScript declaration named ${symbol}${file ? ` in ${file}` : ""}. Try grep_search.`,
      );
    }
    return this.definitions(
      symbol,
      defs.map((d) => ({ path: d.path, line: d.line, column: d.column, detail: d.type || d.text })),
    );
  }

  /** The declarations found, one reply shape for every source (WL-N7-1). */
  private definitions(
    symbol: string,
    defs: { path: string; line: number; column: number; detail: string }[],
  ): ToolObservation {
    return ok(
      "go_to_definition",
      `${defs.length} declaration(s) of ${symbol}`,
      defs.map((d) => `${d.path}:${d.line}:${d.column}\n  ${d.detail}`).join("\n"),
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

  /**
   * Files under `absDir` the search should see: git's own view (tracked plus
   * untracked, minus everything `.gitignore` excludes) when the worktree is a
   * git checkout, else a walk that skips build and VCS directories (L6).
   */
  private searchableFiles(absDir: string): string[] {
    const relDir = relative(this.root, absDir) || ".";
    try {
      const out = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relDir],
        {
          cwd: this.root,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 32 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const files = [...new Set(out.split("\0").filter(Boolean))]
        .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)))
        .map((f) => join(this.root, f))
        .filter((abs) => {
          try {
            return statSync(abs).isFile();
          } catch {
            return false; // tracked but deleted in the worktree
          }
        });
      return files.sort();
    } catch {
      const files: string[] = [];
      this.walk(absDir, (file) => {
        files.push(file);
        return true;
      });
      return files.sort();
    }
  }

  private grep(query: string | undefined, opts: GrepOptions = {}): ToolObservation {
    const wholeWord = opts.wholeWord === true;
    const tool = wholeWord ? "find_references" : "grep_search";
    if (!query) return fail(tool, `missing required argument: ${wholeWord ? "symbol" : "query"}`);
    const mode = opts.mode ?? "content";
    if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
      return fail(
        tool,
        `unknown output_mode "${String(mode)}"`,
        `Unknown output_mode "${String(mode)}". Use "content" (matching lines), "files_with_matches" (file names) or "count" (matches per file).`,
      );
    }
    const context = Math.max(0, Math.min(10, Math.floor(opts.context ?? 0)));
    if (opts.context !== undefined && (!Number.isFinite(opts.context) || opts.context < 0)) {
      return fail(tool, `context must be a non-negative number, got ${opts.context}`);
    }
    const path = opts.path ?? ".";
    const abs = resolveInWorktree(this.root, path);
    if (!existsSync(abs)) return fail(tool, `path not found: ${path}`);
    const flags = opts.caseInsensitive ? "i" : "";
    let re: RegExp;
    try {
      re = wholeWord
        ? new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags)
        : new RegExp(query, flags);
    } catch {
      // Not valid regex — fall back to a literal substring search.
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    const globMatch = (rel: string): boolean => {
      if (!opts.glob) return true;
      return opts.glob.includes("/")
        ? matchesGlob(rel, opts.glob)
        : matchesGlob(basename(rel), opts.glob);
    };

    const files = statSync(abs).isFile() ? [abs] : this.searchableFiles(abs);
    const out: string[] = [];
    const counts: { file: string; n: number }[] = [];
    let matches = 0;
    let capped = false;
    for (const file of files) {
      const rel = this.rel(file);
      if (!globMatch(rel)) continue;
      let text: string;
      try {
        text = this.readText(file);
      } catch {
        continue; // binary or oversized
      }
      const { lines } = splitLines(text);
      const hitLines: number[] = [];
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i] as string)) hitLines.push(i);
      if (hitLines.length === 0) continue;

      if (mode === "count") {
        counts.push({ file: rel, n: hitLines.length });
        matches += hitLines.length;
        continue;
      }
      if (mode === "files_with_matches") {
        out.push(rel);
        matches += hitLines.length;
        if (out.length >= MAX_FIND_RESULTS) {
          capped = true;
          break;
        }
        continue;
      }
      // content: rg-style, "file:line: text" for hits, "file-line- text" for context.
      let lastPrinted = -2;
      for (const h of hitLines) {
        if (matches >= MAX_GREP_MATCHES || out.length >= MAX_GREP_OUTPUT_LINES) {
          capped = true;
          break;
        }
        const from = Math.max(0, h - context);
        const to = Math.min(lines.length - 1, h + context);
        if (context > 0 && lastPrinted >= 0 && from > lastPrinted + 1) out.push("--");
        for (let i = Math.max(from, lastPrinted + 1); i <= to; i++) {
          const text = (lines[i] as string).trim().slice(0, 200);
          const hit = hitLines.includes(i);
          out.push(hit ? `${rel}:${i + 1}: ${text}` : `${rel}-${i + 1}- ${text}`);
        }
        matches++;
        lastPrinted = to;
      }
      if (capped) break;
    }

    if (mode === "count") {
      if (counts.length === 0)
        return ok(tool, `no matches for "${query}"`, `No matches for "${query}" under ${path}.`);
      const body = counts.map((c) => `${c.file}:${c.n}`).join("\n");
      return ok(
        tool,
        `${matches} match(es) in ${counts.length} file(s)`,
        `${matches} match(es) for "${query}" in ${counts.length} file(s):\n${body}`,
      );
    }
    if (out.length === 0) {
      return ok(tool, `no matches for "${query}"`, `No matches for "${query}" under ${path}.`);
    }
    const note = capped
      ? ` (capped; narrow with path, glob or output_mode="files_with_matches")`
      : "";
    const head =
      mode === "files_with_matches"
        ? `${out.length} file(s) match "${query}"${note}`
        : `${matches} match(es) for "${query}"${note}`;
    return ok(tool, head, clampObservation(`${head}:\n${out.join("\n")}`, "matches"));
  }

  private async runCmd(
    command?: string,
    args: string[] = [],
    description?: string,
  ): Promise<ToolObservation> {
    if (!command?.trim()) return fail("run_cmd", "missing required argument: command");

    const refusal = this.confinementRefusal();
    if (refusal) return denied("run_cmd", refusal);

    // Structured tools first (L8): a raw cat/grep/sed floods the window with
    // unnumbered text the other tools would have returned numbered and capped.
    const line = [command, ...args].join(" ");
    for (const program of leadingPrograms(line)) {
      const redirect = REDIRECTED_COMMANDS[program];
      if (redirect) {
        return fail(
          "run_cmd",
          `run_cmd refused: use ${redirect.tool} instead of ${program}`,
          `run_cmd refused: \`${program}\` has a dedicated tool that returns numbered, capped output. Use ${redirect.how} instead. run_cmd is for builds, tests and project scripts.`,
        );
      }
    }

    // Models write commands the way developers type them: a whole line, often
    // with pipes or redirects. Treating that line as a program name failed with
    // "command not found" — on one live card, 17 of 20 run_cmd calls. A line
    // with no separate args runs through /bin/sh, still inside the same
    // sandbox, and the permission engine has already checked the full string.
    const shellLine = args.length === 0 && /[\s|&;<>()$`]/.test(command.trim());
    const [file, argv] = shellLine ? ["/bin/sh", ["-c", command]] : [command, args];

    const result = await this.sandbox.execute(file, argv, {
      allowedPaths: [this.root],
      allowNetwork: this.options.allowNetwork ?? false,
      timeoutMs: this.options.commandTimeoutMs ?? 120_000,
      cwd: this.root,
      ...(this.options.egressProxyPort ? { egressProxyPort: this.options.egressProxyPort } : {}),
      // Commands may talk to this card's own background processes (L23).
      localPorts: this.processPorts(),
    });

    const label = line;
    const heading = description?.trim() ? `# ${description.trim()}\n$ ${label}` : `$ ${label}`;
    const stream = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    // Condense rather than clamp (C8): error lines are protected from
    // truncation, repeats are grouped, and whenever anything is condensed away
    // the raw text stays recallable by the ref in the footer.
    const condensed = this.countCondensed(
      condenseToolOutput(stream, {
        exitCode: result.exitCode,
        command: label,
        maxLines: RUN_CMD_MAX_LINES,
        ...(this.options.recallOffered === false ? { recallOffered: false } : {}),
      }),
    );
    const detail = condensed.text;
    // CX-N5-3: what condensing removed, beside the raw output's size.
    const condensing = {
      rawTokens: condensed.result.originalTokens,
      savedTokens: condensed.result.tokensSaved,
    };

    if (result.timedOut) {
      return {
        ...fail(
          "run_cmd",
          `${label} timed out`,
          `${heading}\nTIMED OUT after ${result.durationMs}ms\n${detail}`,
        ),
        condensing,
      };
    }
    if (result.exitCode !== 0) {
      return {
        ...fail(
          "run_cmd",
          `${label} exited ${result.exitCode}`,
          `${heading}\nexit code ${result.exitCode}\n${detail}`,
        ),
        condensing,
      };
    }
    return {
      ...ok("run_cmd", `${label} exited 0`, `${heading}\nexit code 0\n${detail}`),
      condensing,
    };
  }

  /** Execute a command in the sandbox and return the raw result, bypassing observation framing. */
  public async runCommandRaw(command: string, args: string[] = []): Promise<ExecutionResult> {
    const refusal = this.confinementRefusal();
    if (refusal) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `Refusing to execute: ${refusal}`,
        durationMs: 0,
        oomKilled: false,
        timedOut: false,
      };
    }
    return this.sandbox.execute(command, args, {
      allowedPaths: [this.root],
      allowNetwork: this.options.allowNetwork ?? false,
      timeoutMs: this.options.commandTimeoutMs ?? 120_000,
      cwd: this.root,
      ...(this.options.egressProxyPort ? { egressProxyPort: this.options.egressProxyPort } : {}),
      // Commands may talk to this card's own background processes (L23).
      localPorts: this.processPorts(),
    });
  }

  private note(message?: string): ToolObservation {
    if (!message) return fail("note", "missing required argument: message");
    this.notes.push(message);
    return ok("note", `recorded note (${this.notes.length} total)`, "Note recorded.");
  }

  /**
   * The project's own history, searchable.
   *
   * The failure the user sees most in AI coding agents is repeating a problem
   * the repository already solved: the fix is in the commit log and nobody
   * looked. With a query this searches commit messages and code changes
   * (pickaxe); with a sha it shows that commit. Read-only, no shell.
   */
  private gitHistory(query: string, sha?: string): ToolObservation {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: this.root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
    try {
      if (sha) {
        if (!/^[0-9a-f]{4,40}$/i.test(sha))
          return fail("git_history", "sha must be a hex commit id");
        return ok(
          "git_history",
          `commit ${sha}`,
          clampObservation(git(["show", "--stat", "--patch", "--format=%h %s%n%b", sha])),
        );
      }
      if (!query.trim()) {
        return ok(
          "git_history",
          "recent commits",
          git(["log", "--oneline", "-n", "20"]) || "No commits yet.",
        );
      }
      const messages = git(["log", "--oneline", "-n", "15", "-i", `--grep=${query}`]);
      const code = git(["log", "--oneline", "-n", "10", "-S", query]);
      const body = [
        `Commits whose message mentions "${query}":\n${messages || "(none)"}`,
        `Commits that added or removed "${query}" in code:\n${code || "(none)"}`,
        "Use git_history(sha=...) to see how a commit did it.",
      ].join("\n\n");
      return ok("git_history", `history for ${query}`, body);
    } catch (err) {
      return fail(
        "git_history",
        err instanceof Error ? (err.message.split("\n")[0] ?? "git failed") : String(err),
      );
    }
  }

  /**
   * What is already installed. Writing a helper the project already has a
   * dependency for is the second most common waste; this lists package.json
   * dependencies (and whether each is present in node_modules).
   */
  private dependencies(query: string): ToolObservation {
    const pkgPath = join(this.root, "package.json");
    if (!existsSync(pkgPath)) return fail("dependencies", "no package.json in this project");
    try {
      const pkg = JSON.parse(this.readText(pkgPath)) as Record<
        string,
        Record<string, string> | undefined
      >;
      const rows: string[] = [];
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(pkg[field] ?? {})) {
          if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
          const present = existsSync(join(this.root, "node_modules", name));
          rows.push(`${name}@${version} (${field}${present ? "" : ", not installed"})`);
        }
      }
      const note =
        "Prefer these and Node's built-in modules (node:fs, node:path, node:crypto, node:sqlite, node:test...) over writing your own. New packages cannot be installed from here.";
      return ok(
        "dependencies",
        `${rows.length} dependencies`,
        `${rows.join("\n") || "(none match)"}\n\n${note}`,
      );
    } catch (err) {
      return fail("dependencies", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * L10, tiered documentation lookup:
   *   1. the project's own docs (root guides, then docs/**.md);
   *   2. a dependency's docs AT ITS INSTALLED VERSION: its README and its
   *      type declarations (`.d.ts`) from node_modules, or a local mirror
   *      under `.sekhemet/docs/<name>@<version>/`;
   * cached on disk per (library, version, query) under `.sekhemet/docs-cache`.
   * A dependency named in the query is searched without being asked for.
   */
  private async docs(query: string, library?: string): Promise<ToolObservation> {
    if (!query.trim()) return fail("docs", "query is required");
    const found: string[] = [];
    const matchLines = (label: string, text: string, max = 10, q = query): string | undefined => {
      const needle = q.toLowerCase();
      const { lines } = splitLines(text);
      const title = lines
        .find((l) => l.trimStart().startsWith("#"))
        ?.replace(/^#+\s*/, "")
        .trim();
      const words = needle.split(/\s+/).filter((w) => w.length > 2);
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => {
          const low = l.toLowerCase();
          return low.includes(needle) || (words.length > 1 && words.every((w) => low.includes(w)));
        })
        .slice(0, max)
        .map(({ l, i }) => `${label}:${i + 1}: ${l.trim()}`);
      if (hits.length === 0) return undefined;
      return `${title ? `--- ${label} — ${title} ---` : `--- ${label} ---`}\n${hits.join("\n")}`;
    };

    // Tier 1: the project's own documentation.
    if (!library) {
      const guides = ["README.md", "AGENTS.md", "CLAUDE.md", "DEFINITION_OF_DONE.md"];
      const docFiles = this.searchableFiles(this.root)
        .map((f) => this.rel(f))
        .filter((f) => f.startsWith("docs/") && f.endsWith(".md"))
        .slice(0, 200);
      for (const name of [...guides, ...docFiles]) {
        const abs = join(this.root, name);
        if (!existsSync(abs)) continue;
        const block = matchLines(name, this.readText(abs));
        if (block) found.push(block);
        if (found.length >= 6) break;
      }
    }

    // Tier 2: dependencies at their installed version.
    const libs = library
      ? [library]
      : this.dependencyNames().filter((d) => query.toLowerCase().includes(d.toLowerCase()));
    for (const lib of libs.slice(0, 3)) {
      // The library's own name is how it was picked, not what to look for in it.
      const within = library
        ? query
        : query.replace(new RegExp(lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "").trim() ||
          query;
      const block = this.libraryDocs(lib, within, matchLines);
      if (block) found.push(block);
    }

    // Tier 3: the library's official documentation on the web, only when
    // the installed copy had nothing on this (a harness-supplied fetcher:
    // llms.txt, the sitemap, a polite cached fetch; no model involved).
    if (library && this.options.webDocs && !found.some((b) => b.includes(`=== ${library} `))) {
      try {
        const web = (await this.options.webDocs(library, query)).trim();
        if (web) {
          const clipped = web.length > 6000 ? `${web.slice(0, 6000)}\n… (truncated)` : web;
          found.push(
            `=== ${library}: from the official docs (web) ===\n${tagUntrusted(clipped, `docs:${library}`)}`,
          );
        }
      } catch {
        // Offline or unknown library: the local tiers are the answer.
      }
    }

    if (found.length === 0) {
      return ok(
        "docs",
        `no documentation matches "${query}"`,
        `No documentation found matching "${query}"${library ? ` in ${library}` : ""}.${library ? "" : " Name a dependency with library=... to search its installed docs and types."}`,
      );
    }
    return ok(
      "docs",
      `documentation matches for "${query}"`,
      clampObservation(found.join("\n\n"), "documentation"),
    );
  }

  private dependencyNames(): string[] {
    try {
      const pkg = JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      return Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    } catch {
      return [];
    }
  }

  private libraryDocs(
    lib: string,
    query: string,
    matchLines: (label: string, text: string, max?: number, q?: string) => string | undefined,
  ): string | undefined {
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(lib)) return undefined;
    const dir = join(this.root, "node_modules", lib);
    let version = "not installed";
    try {
      version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string })
        .version;
    } catch {
      // Not installed: a mirror may still exist.
    }
    const cacheDir = join(this.root, ".sekhemet", "docs-cache");
    const key = createHash("sha256")
      .update(`${lib}@${version}:${query}`)
      .digest("hex")
      .slice(0, 24);
    const cached = join(cacheDir, `${key}.txt`);
    if (existsSync(cached)) return readFileSync(cached, "utf8") || undefined;

    const blocks: string[] = [];
    const sources: string[] = [];
    const mirror = join(this.root, ".sekhemet", "docs", `${lib}@${version}`);
    if (existsSync(mirror)) {
      this.walk(mirror, (f) => {
        if (f.endsWith(".md")) sources.push(f);
        return sources.length < 200;
      });
    }
    for (const name of ["README.md", "readme.md", "README"]) {
      if (existsSync(join(dir, name))) {
        sources.push(join(dir, name));
        break;
      }
    }
    if (existsSync(dir)) {
      this.walk(dir, (f) => {
        if (f.endsWith(".d.ts") && !f.includes(`${join(dir, "node_modules")}`)) sources.push(f);
        return sources.length < 400;
      });
    }
    for (const src of sources) {
      const label = `${lib}@${version}/${relative(existsSync(mirror) && src.startsWith(mirror) ? mirror : dir, src)}`;
      try {
        const block = matchLines(label, readFileSync(src, "utf8"), 6, query);
        if (block) blocks.push(block);
      } catch {
        // Unreadable file: skip.
      }
      if (blocks.length >= 5) break;
    }
    const out =
      blocks.length > 0 ? `=== ${lib} ${version} (installed) ===\n${blocks.join("\n")}` : "";
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, out);
    } catch {
      // A cache that cannot be written only costs the next lookup.
    }
    return out || undefined;
  }
}

/** A thrown value as text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A server's failure, short enough for one line of a reply. */
function clipReason(reason: string): string {
  return reason.length > 120 ? `${reason.slice(0, 119)}…` : reason;
}

/** Offsets of each line's start, for 0-based LSP positions. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}
