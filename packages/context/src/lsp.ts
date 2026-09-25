import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnConfinedSync } from "@sekhemet/sandbox";

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
}

/** Default servers per language; override per project. */
export const DEFAULT_LSP_SERVERS: Record<string, LspServerCommand> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
  rust: { command: "rust-analyzer", args: [] },
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

  constructor(
    private readonly server: LspServerCommand,
    public readonly root: string,
    private readonly timeoutMs = 15_000,
  ) {
    // A language server executes the project's code (plugins, build
    // scripts, configs): it runs confined to the worktree with the allowlisted
    // environment and no network (S3a, SEC-17).
    const child = spawnConfinedSync(server.command, server.args, { root, timeoutMs: 0 });
    if (!child) {
      this.exited = true;
      this.refused = "no OS confinement on this host";
      return;
    }
    this.child = child;
    child.stderr.resume();
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", () => {
      this.exited = true;
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
      let msg: { id?: number; result?: unknown; error?: { message: string; code: number } };
      try {
        msg = JSON.parse(body);
      } catch {
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
            textDocument: { definition: {}, references: {}, documentSymbol: {} },
          },
          workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
        });
        this.notify("initialized", {});
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

export interface LspPoolOptions {
  servers?: Record<string, LspServerCommand>;
  /** Shut a server down after this long unused. Default 5 minutes. */
  idleMs?: number;
  requestTimeoutMs?: number;
}

/** Clients keyed by language and root, with idle shutdown. */
export class LspPool {
  private clients = new Map<string, LspClient>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: LspPoolOptions = {}) {}

  /** The client for a file's language under `root`, spawning it if needed. */
  public clientFor(root: string, path: string): LspClient | undefined {
    const language = languageOf(path);
    if (!language) return undefined;
    const server = (this.options.servers ?? DEFAULT_LSP_SERVERS)[language];
    if (!server) return undefined;
    const key = `${language}\n${resolve(root)}`;
    let client = this.clients.get(key);
    if (!client || !client.alive) {
      client = new LspClient(server, resolve(root), this.options.requestTimeoutMs);
      this.clients.set(key, client);
      this.startSweeper();
    }
    return client;
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

  public async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.shutdown()));
  }
}
