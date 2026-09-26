import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { processTreeResidentBytes, spawnConfinedSync } from "@sekhemet/sandbox";

/**
 * A headless LSP client pool (C2, design "LSP client pool"). One language
 * server per (language, workspace root), spawned on first use, spoken to
 * over stdio with JSON-RPC 2.0 and `Content-Length` framing, and shut down
 * after an idle period. It gives the Worker's symbol tools real definitions
 * and references (L9) and the planner real impact analysis (P24), instead
 * of text matching.
 */
export interface LspServerCommand {
  command: string;
  args: string[];
  /**
   * The heap cap for a Node-based server, in MiB (`--max-old-space-size`
   * through `NODE_OPTIONS`); its process tree is also held under twice this
   * resident (WL-N7-2).
   */
  heapMb?: number;
  /** Sent with `initialize` (exclusions, the tsserver memory cap). */
  initializationOptions?: Record<string, unknown>;
  /** Answers to the server's `workspace/configuration` requests, by section path. */
  settings?: Record<string, unknown>;
}

/** A language server's default heap cap: a tenant beside a 13 GB Worker on 24 GB. */
export const DEFAULT_LSP_HEAP_MB = 1024;

/** What the run's language servers may hold resident together before the guard trims them. */
export const LSP_RESIDENT_CAP_BYTES = 2 * DEFAULT_LSP_HEAP_MB * 1024 * 1024;

/** Directories no server analyses: environments, dependencies, build output (WL-N7-2). */
export const LSP_EXCLUDED_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".git",
  ".sekhemet",
] as const;

const GLOBS = LSP_EXCLUDED_DIRS.map((d) => `**/${d}`);

/** Pyright's bounds: its heap and its excluded directories, at init and on request. */
export const PYTHON_BOUNDS: Pick<
  LspServerCommand,
  "heapMb" | "initializationOptions" | "settings"
> = {
  heapMb: DEFAULT_LSP_HEAP_MB,
  initializationOptions: { python: { analysis: { exclude: GLOBS } } },
  settings: { "python.analysis": { exclude: GLOBS } },
};

/**
 * The TypeScript server, chosen by configuration (WL-N7-1): the default is
 * `typescript-language-server`; `tsc` selects TypeScript 7's native server
 * (`tsc --lsp --stdio`). `SEKHEMET_TS_LSP` sets it for a run.
 */
export function typescriptServer(choice: string | undefined): LspServerCommand {
  const bounds = {
    heapMb: DEFAULT_LSP_HEAP_MB,
    initializationOptions: {
      maxTsServerMemory: DEFAULT_LSP_HEAP_MB,
      tsserver: { watchOptions: { excludeDirectories: GLOBS } },
    },
  };
  return choice === "tsc"
    ? { command: "tsc", args: ["--lsp", "--stdio"], ...bounds }
    : { command: "typescript-language-server", args: ["--stdio"], ...bounds };
}

/** Default servers per language; override per project. Each is bounded (WL-N7-2). */
export const DEFAULT_LSP_SERVERS: Record<string, LspServerCommand> = {
  typescript: typescriptServer(process.env.SEKHEMET_TS_LSP),
  python: { command: "pyright-langserver", args: ["--stdio"], ...PYTHON_BOUNDS },
  rust: {
    command: "rust-analyzer",
    args: [],
    initializationOptions: { files: { excludeDirs: [...LSP_EXCLUDED_DIRS] } },
  },
};

export function languageOf(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
    return "typescript";
  }
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  return undefined;
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
};

export interface LspLocation {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export class LspError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "LspError";
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One language-server process. */
export class LspClient {
  private child: ChildProcess | undefined;
  /** Why the server is not running, when confinement refused it. */
  private refused: string | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private opened = new Map<string, number>();
  private initialized: Promise<void> | undefined;
  public lastUsed = Date.now();
  private exited = false;
  /** Why the server stopped, for the tool's fallback reply (WL-N7-3). */
  public exitReason: string | undefined;

  constructor(
    private readonly server: LspServerCommand,
    public readonly root: string,
    private readonly timeoutMs = 15_000,
  ) {
    // A language server executes the project's code (plugins, build
    // scripts, configs): it runs confined to the worktree with the allowlisted
    // environment and no network (S3a, SEC-17).
    const child = spawnConfinedSync(server.command, server.args, {
      root,
      timeoutMs: 0,
      // WL-N7-2: the heap capped, and the tree held under twice it.
      ...(server.heapMb
        ? {
            env: { NODE_OPTIONS: `--max-old-space-size=${server.heapMb}` },
            maxMemoryBytes: server.heapMb * 2 * 1024 * 1024,
          }
        : {}),
    });
    if (!child) {
      this.exited = true;
      this.refused = "no OS confinement on this host";
      return;
    }
    this.child = child;
    child.stderr.resume();
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitReason = signal ? `stopped by ${signal}` : `exited with ${code ?? "no code"}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new LspError(`${server.command} exited`));
      }
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new LspError(`${server.command}: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  public get alive(): boolean {
    return !this.exited;
  }

  /** The server's process id while it runs. */
  public get pid(): number | undefined {
    return this.exited ? undefined : this.child?.pid;
  }

  /** A request is in flight: trimming must not stop it. */
  public get busy(): boolean {
    return this.pending.size > 0;
  }

  /** Close every open document, so the server may drop its state; returns how many. */
  public closeDocuments(): number {
    const count = this.opened.size;
    for (const uri of this.opened.keys()) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
    this.opened.clear();
    return count;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let msg: {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string; code: number };
      };
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      // A request from the server: answer it, or it may wait on us.
      if (msg.method !== undefined && msg.id !== undefined) {
        this.write({ id: msg.id, result: this.answerServer(msg.method, msg.params) });
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id) as Pending;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new LspError(msg.error.message, msg.error.code));
        else p.resolve(msg.result);
      }
      // Server requests and notifications (diagnostics, progress) are ignored.
    }
  }

  /** `workspace/configuration` from the server's settings (WL-N7-2); null otherwise. */
  private answerServer(method: string, params: unknown): unknown {
    if (method !== "workspace/configuration") return null;
    const items = (params as { items?: { section?: string }[] } | undefined)?.items ?? [];
    return items.map((i) => (i.section ? (this.server.settings?.[i.section] ?? null) : null));
  }

  private write(message: object): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child?.stdin?.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  public request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exited) {
      const why = this.refused ? ` (${this.refused})` : "";
      return Promise.reject(new LspError(`${this.server.command} is not running${why}`));
    }
    this.lastUsed = Date.now();
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  public notify(method: string, params: unknown): void {
    if (!this.exited) this.write({ method, params });
  }

  public initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          capabilities: {
            textDocument: { definition: {}, references: {}, documentSymbol: {}, rename: {} },
            workspace: { configuration: true, workspaceEdit: { documentChanges: true } },
          },
          workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
          ...(this.server.initializationOptions
            ? { initializationOptions: this.server.initializationOptions }
            : {}),
        });
        this.notify("initialized", {});
        if (this.server.settings) {
          this.notify("workspace/didChangeConfiguration", { settings: this.server.settings });
        }
      })();
    }
    return this.initialized;
  }

  /** Open (or re-sync) a document from disk. */
  public open(path: string): string {
    const abs = resolve(this.root, path);
    const uri = pathToFileURL(abs).href;
    const text = readFileSync(abs, "utf8");
    const version = (this.opened.get(uri) ?? 0) + 1;
    if (version === 1) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: LANGUAGE_IDS[extname(abs).toLowerCase()] ?? "plaintext",
          version,
          text,
        },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    this.opened.set(uri, version);
    return uri;
  }

  private toLocations(raw: unknown): LspLocation[] {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
      .map((l: { uri?: string; targetUri?: string; range?: Rng; targetRange?: Rng }) => {
        const uri = l.uri ?? l.targetUri;
        const range = l.range ?? l.targetRange;
        if (!uri || !range) return undefined;
        return {
          path: decodeURIComponent(new URL(uri).pathname),
          line: range.start.line + 1,
          column: range.start.character + 1,
        };
      })
      .filter((x): x is LspLocation => x !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }

  /** Definition of the symbol at a 1-based position. */
  public async definition(path: string, line: number, column: number): Promise<LspLocation[]> {
    await this.initialize();
    const uri = this.open(path);
    return this.toLocations(
      await this.request("textDocument/definition", {
        textDocument: { uri },
        position: { line: line - 1, character: column - 1 },
      }),
    );
  }

  /**
   * Rename the symbol at a 1-based position (`textDocument/rename`): the
   * server's workspace edit, as text edits per file, 0-based ranges (WL-N6-1).
   */
  public async rename(
    path: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<LspFileEdits[]> {
    await this.initialize();
    const uri = this.open(path);
    const edit = await this.request<WorkspaceEditLike | null>("textDocument/rename", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
      newName,
    });
    const byFile = new Map<string, LspTextEdit[]>();
    const add = (u: string, edits: LspTextEdit[]) => {
      const file = decodeURIComponent(new URL(u).pathname);
      byFile.set(file, [...(byFile.get(file) ?? []), ...edits]);
    };
    for (const [u, edits] of Object.entries(edit?.changes ?? {})) add(u, edits);
    for (const dc of edit?.documentChanges ?? []) {
      if (dc.textDocument?.uri && Array.isArray(dc.edits)) add(dc.textDocument.uri, dc.edits);
    }
    return [...byFile]
      .map(([file, edits]) => ({ path: file, edits }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** References to the symbol at a 1-based position. */
  public async references(
    path: string,
    line: number,
    column: number,
    includeDeclaration = false,
  ): Promise<LspLocation[]> {
    await this.initialize();
    const uri = this.open(path);
    return this.toLocations(
      await this.request("textDocument/references", {
        textDocument: { uri },
        position: { line: line - 1, character: column - 1 },
        context: { includeDeclaration },
      }),
    );
  }

  public async shutdown(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Unresponsive server: kill below.
    }
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        void (this.child as { stop?: () => Promise<void> } | undefined)?.stop?.();
        r();
      }, 2000);
      if (this.exited) {
        clearTimeout(t);
        r();
      } else {
        this.child?.once("exit", () => {
          clearTimeout(t);
          r();
        });
      }
    });
  }
}

type Rng = { start: { line: number; character: number } };

/** One text edit of a workspace edit (0-based range). */
export interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/** A workspace edit's edits to one file (absolute path). */
export interface LspFileEdits {
  path: string;
  edits: LspTextEdit[];
}

interface WorkspaceEditLike {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument?: { uri: string }; edits?: LspTextEdit[] }[];
}

export interface LspPoolOptions {
  servers?: Record<string, LspServerCommand>;
  /** Shut a server down after this long unused. Default 5 minutes. */
  idleMs?: number;
  requestTimeoutMs?: number;
}

/** Clients keyed by language and root, with idle shutdown. */
export class LspPool {
  private clients = new Map<string, LspClient>();
  private unavailable = new Map<string, string>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: LspPoolOptions = {}) {}

  /** The client for a file's language under `root`, spawning it if needed. */
  public clientFor(root: string, path: string): LspClient | undefined {
    const language = languageOf(path);
    if (!language) return undefined;
    const server = (this.options.servers ?? DEFAULT_LSP_SERVERS)[language];
    if (!server) return undefined;
    const key = `${language}\n${resolve(root)}`;
    // A server that was absent or failed stays out for the run (WL-N7-3).
    if (this.unavailable.has(key)) return undefined;
    let client = this.clients.get(key);
    if (!client || !client.alive) {
      client = new LspClient(server, resolve(root), this.options.requestTimeoutMs);
      this.clients.set(key, client);
      this.startSweeper();
    }
    return client;
  }

  /** Why the server for this file's language under `root` is out, when it is (WL-N7-3). */
  public unavailableReason(root: string, path: string): string | undefined {
    const language = languageOf(path);
    return language ? this.unavailable.get(`${language}\n${resolve(root)}`) : undefined;
  }

  /**
   * The server for this file's language failed (absent, crashed, over its
   * heap): no further request starts it this run; the caller falls back.
   */
  public markUnavailable(root: string, path: string, reason: string): void {
    const language = languageOf(path);
    if (!language) return;
    const key = `${language}\n${resolve(root)}`;
    this.unavailable.set(key, reason);
    const client = this.clients.get(key);
    this.clients.delete(key);
    void client?.shutdown();
  }

  public get size(): number {
    return [...this.clients.values()].filter((c) => c.alive).length;
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    const idle = this.options.idleMs ?? 5 * 60_000;
    this.sweeper = setInterval(() => void this.sweep(idle), Math.min(idle, 30_000));
    this.sweeper.unref?.();
  }

  /** Shut down clients idle longer than `idleMs`. */
  public async sweep(idleMs = this.options.idleMs ?? 5 * 60_000): Promise<number> {
    const now = Date.now();
    let closed = 0;
    for (const [key, client] of this.clients) {
      if (!client.alive || now - client.lastUsed >= idleMs) {
        this.clients.delete(key);
        await client.shutdown();
        closed++;
      }
    }
    return closed;
  }

  /**
   * What the pool's servers hold resident, in bytes: each server's process
   * and its descendants (`typescript-language-server` runs `tsserver` as a
   * child). Zero when none is running. For the memory guard, which counts a
   * language server as a tenant beside the Worker (WL-N7-2).
   */
  public residentBytes(): number {
    const pids = [...this.clients.values()]
      .map((c) => c.pid)
      .filter((p): p is number => p !== undefined);
    if (pids.length === 0) return 0;
    return processTreeResidentBytes(pids);
  }

  /**
   * Give memory back: close every open document and stop every server not
   * serving a request. A stopped server starts again on the next symbol
   * request that needs it.
   */
  public async trimCaches(): Promise<{ stopped: number; documentsClosed: number }> {
    let stopped = 0;
    let documentsClosed = 0;
    for (const [key, client] of this.clients) {
      if (client.busy) continue;
      documentsClosed += client.closeDocuments();
      this.clients.delete(key);
      if (client.alive) stopped++;
      await client.shutdown();
    }
    return { stopped, documentsClosed };
  }

  /**
   * The memory guard's check on this tenant (WL-N7-2): when the servers hold
   * more than `capBytes` resident, give it back (`trimCaches`). A server that
   * is stopped starts again on the next request that needs it; no gate waits
   * on one.
   */
  public async enforceResidentCap(
    capBytes: number,
  ): Promise<{ residentBytes: number; trimmed: boolean }> {
    const residentBytes = this.residentBytes();
    if (residentBytes <= capBytes) return { residentBytes, trimmed: false };
    await this.trimCaches();
    return { residentBytes, trimmed: true };
  }

  public async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.clients.values()];
    this.clients.clear();
    this.unavailable.clear();
    await Promise.all(all.map((c) => c.shutdown()));
  }
}
