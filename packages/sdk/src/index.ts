import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @sekhemet/sdk (H13): a typed client for a running Sekhemet, for scripts,
 * editors and other tools. It speaks the dashboard server's REST API and its
 * live stream (WebSocket at /api/ws), and finds a daemon started with
 * `sekhemet daemon start` from the project's .sekhemet/daemon.json.
 *
 * Writes carry the X-Sekhemet-Action header the server requires for
 * mutations (the server also refuses writes from foreign browser origins).
 * No dependencies: it uses Node's built-in fetch and WebSocket (Node 22+).
 */

export type CardStatus =
  | "backlog"
  | "ready"
  | "planning"
  | "in_progress"
  | "verify"
  | "review"
  | "done"
  | "rejected"
  | "parked";

export interface Card {
  id: string;
  title: string;
  status: CardStatus;
  tier: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
  spec?: string;
  [key: string]: unknown;
}

export interface LedgerEvent {
  seq: number;
  type: string;
  actor: string;
  cardId?: string;
  payload: unknown;
  createdAt: string;
}

export interface StreamMessage {
  event: string;
  data: unknown;
}

export class SekhemetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL, e.g. http://127.0.0.1:4040. */
  baseUrl?: string;
  /** Find the daemon of this project (.sekhemet/daemon.json) instead of a base URL. */
  repoPath?: string;
  fetch?: typeof fetch;
}

/** The base URL of a project's running daemon, from its PID file. */
export function daemonUrl(repoPath: string): string {
  const info = JSON.parse(readFileSync(join(repoPath, ".sekhemet", "daemon.json"), "utf8")) as {
    port: number;
  };
  return `http://127.0.0.1:${info.port}`;
}

export class SekhemetClient {
  readonly baseUrl: string;
  private readonly f: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ?? (opts.repoPath ? daemonUrl(opts.repoPath) : "http://127.0.0.1:4040")
    ).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const write = method !== "GET";
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(write ? { "X-Sekhemet-Action": "1" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const msg =
        (parsed as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
      throw new SekhemetError(res.status, msg);
    }
    return parsed as T;
  }

  // --- board and cards --------------------------------------------------------
  board(): Promise<{ cards: Card[]; [k: string]: unknown }> {
    return this.call("GET", "/api/board");
  }
  card(id: string): Promise<{ card: Card; [k: string]: unknown }> {
    return this.call("GET", `/api/cards/${encodeURIComponent(id)}`);
  }
  updateCard(
    id: string,
    fields: Partial<Pick<Card, "priority" | "estimate" | "labels" | "title" | "spec">> &
      Record<string, unknown>,
  ): Promise<unknown> {
    return this.call("PATCH", `/api/cards/${encodeURIComponent(id)}`, fields);
  }
  accept(id: string): Promise<unknown> {
    return this.call("POST", `/api/cards/${encodeURIComponent(id)}/accept`, {});
  }
  sendBack(id: string, note: string): Promise<unknown> {
    return this.call("POST", `/api/cards/${encodeURIComponent(id)}/return`, { note });
  }
  park(id: string, reason: string): Promise<unknown> {
    return this.call("POST", `/api/cards/${encodeURIComponent(id)}/park`, { reason });
  }
  abort(id: string, reason: string): Promise<unknown> {
    return this.call("POST", `/api/cards/${encodeURIComponent(id)}/abort`, { reason });
  }
  explain(id: string): Promise<unknown> {
    return this.call("GET", `/api/cards/${encodeURIComponent(id)}/explain`);
  }
  attempts(id: string): Promise<unknown> {
    return this.call("GET", `/api/cards/${encodeURIComponent(id)}/attempts`);
  }
  transcript(id: string): Promise<unknown> {
    return this.call("GET", `/api/cards/${encodeURIComponent(id)}/transcript`);
  }

  // --- ledger, machine, runs -------------------------------------------------
  events(
    opts: { since?: number; card?: string; type?: string } = {},
  ): Promise<LedgerEvent[] | { events: LedgerEvent[] }> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.card) q.set("card", opts.card);
    if (opts.type) q.set("type", opts.type);
    return this.call("GET", `/api/events${q.size ? `?${q}` : ""}`);
  }
  gates(): Promise<unknown> {
    return this.call("GET", "/api/gates");
  }
  machine(): Promise<unknown> {
    return this.call("GET", "/api/machine");
  }
  doctor(): Promise<unknown> {
    return this.call("GET", "/api/doctor");
  }
  runs(): Promise<unknown> {
    return this.call("GET", "/api/runs");
  }
  models(): Promise<unknown> {
    return this.call("GET", "/api/models");
  }
  capability(): Promise<unknown> {
    return this.call("GET", "/api/capability");
  }
  learning(): Promise<unknown> {
    return this.call("GET", "/api/learning");
  }
  flowMetrics(days = 14): Promise<unknown> {
    return this.call("GET", `/api/metrics/flow?days=${days}`);
  }

  // --- Seshat, the project manager --------------------------------------------
  pm = {
    send: (text: string, context: Record<string, unknown> = {}): Promise<unknown> =>
      this.call("POST", "/api/pm/messages", { text, context }),
    thread: (since = 0): Promise<unknown> => this.call("GET", `/api/pm/thread?since=${since}`),
  };

  /**
   * The live stream: every ledger append (with the board), machine frames and
   * PM frames, as {event, data} messages. Returns a function that closes it.
   */
  stream(onMessage: (m: StreamMessage) => void, onError?: (e: unknown) => void): () => void {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error("This Node has no built-in WebSocket (Node 22+ required).");
    const ws = new WS(`${this.baseUrl.replace(/^http/, "ws")}/api/ws`);
    ws.addEventListener("message", (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)) as StreamMessage);
      } catch (err) {
        onError?.(err);
      }
    });
    ws.addEventListener("error", (ev) => onError?.(ev));
    return () => ws.close();
  }
}
