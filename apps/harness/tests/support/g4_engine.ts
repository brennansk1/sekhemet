import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * A scripted model engine in its own process, for the worker-loop and runtime
 * entry-point tests (FINISH_LINE_PLAN C2d): a local HTTP server speaking
 * Ollama's API (`/api/tags`, `/api/ps`, `/api/chat`, streamed or not), which
 * the spawned binary reaches through a preload that sends its requests for
 * the Ollama address (127.0.0.1:11434) to this server's port instead. No model
 * is loaded, nothing leaves the machine, and the machine's real Ollama is
 * never reached. Because it is a real process on a real socket, a test can
 * SIGKILL it mid-run and the binary meets a refused or reset connection.
 *
 * The Worker (a request offering `finish_card`) takes its turns from the
 * script in order; past the end it says nothing. A turn may hold its reply
 * until a file exists (`waitFor`: the test's signal that something happened
 * meanwhile), and may kill the engine mid-stream (`die`). Every `/api/chat`
 * body is appended to the record file as one JSON line.
 */
export interface EngineTurn {
  calls?: { name: string; arguments?: Record<string, unknown> }[];
  text?: string;
  /** Reply only once this file exists. */
  waitFor?: string;
  /** Send the first chunk of the reply, then SIGKILL the engine's own process. */
  die?: boolean;
}

export const ENGINE_MODEL = "scripted-worker:latest";

const SERVER = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
const [scriptFile, record] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptFile, "utf8"));
const MODEL = ${JSON.stringify(ENGINE_MODEL)};
let next = 0;
const wait = (file) => new Promise((ok) => { const t = setInterval(() => { if (existsSync(file)) { clearInterval(t); ok(); } }, 25); });
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/api/tags" || req.url === "/api/ps") return json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
    if (req.url !== "/api/chat") return json({});
    const body = JSON.parse(raw || "{}");
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
    const role = tools.includes("finish_card") ? "worker" : "other";
    appendFileSync(record, JSON.stringify({ role, at: Date.now(), body }) + "\\n");
    const turn = role === "worker" ? script[next++] : undefined;
    if (turn?.waitFor) await wait(turn.waitFor);
    const message = turn?.calls
      ? { role: "assistant", content: "", tool_calls: turn.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) }
      : { role: "assistant", content: turn?.text ?? "" };
    const final = { model: MODEL, message, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };
    if (turn?.die) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ model: MODEL, message: { role: "assistant", content: "" }, done: false }) + "\\n");
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify(final) + "\\n");
      return;
    }
    json(final);
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

/** Loaded into the spawned binary: its requests for the Ollama address go to the engine. */
const REDIRECT = `
import net from "node:net";
// The owner's real model servers (Ollama 11434, the Worker 8098 and 8099,
// Hermes 8080) are refused at the socket, whatever reaches for them.
const DENY = new Set([11434, 8098, 8099, 8080]);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect and http pass their options normalized, as an array.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof a === "object" && a !== null ? a : { port: a, host: args[1] };
  const host = String(o.host ?? "localhost");
  if (!o.path && DENY.has(Number(o.port)) && /^(127\\.0\\.0\\.1|localhost|::1|\\[::1\\])$/.test(host)) {
    const err = Object.assign(new Error("connect ECONNREFUSED " + host + ":" + o.port + " (test guard)"), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};
const real = globalThis.fetch;
const OLLAMA = "http://127.0.0.1:11434";
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(OLLAMA) || url.startsWith("http://localhost:11434")) {
    const to = "http://127.0.0.1:" + process.env.G4_ENGINE_PORT + new URL(url).pathname + new URL(url).search;
    if (input instanceof Request) return real(new Request(to, input), init);
    return real(to, init);
  }
  return real(input, init);
};
`;

export interface Engine {
  port: number;
  proc: ChildProcess;
  /** The preload that points the binary at this engine. */
  preload: string;
  /** The environment the binary needs to reach it. */
  env: Record<string, string>;
  /** Every request so far, in order. */
  requests: () => { role: "worker" | "other"; at: number; body: EngineRequest }[];
  stop: () => void;
}

export interface EngineRequest {
  model: string;
  stream?: boolean;
  think?: unknown;
  options?: Record<string, unknown>;
  messages: { role: string; content: string; tool_calls?: unknown[] }[];
  tools?: { function?: { name: string; parameters?: unknown } }[];
}

const engines: ChildProcess[] = [];
afterEach(() => {
  for (const e of engines.splice(0))
    if (e.exitCode === null && e.signalCode === null) e.kill("SIGKILL");
});

/** Start the engine with the Worker's script; `dir` holds its files. */
export async function startEngine(dir: string, worker: EngineTurn[]): Promise<Engine> {
  const file = join(dir, "g4_engine.mjs");
  const script = join(dir, "g4_engine_script.json");
  const record = join(dir, "g4_engine_requests.jsonl");
  const preload = join(dir, "g4_engine_redirect.mjs");
  writeFileSync(file, SERVER);
  writeFileSync(script, JSON.stringify(worker));
  writeFileSync(record, "");
  writeFileSync(preload, REDIRECT);
  const proc = spawn(process.execPath, [file, script, record], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  engines.push(proc);
  const port = Number(
    await new Promise<string>((ok, bad) => {
      proc.stdout?.once("data", (d) => ok(String(d)));
      proc.once("exit", (c) => bad(new Error(`the engine exited ${c} before listening`)));
    }),
  );
  return {
    port,
    proc,
    preload,
    env: { G4_ENGINE_PORT: String(port) },
    requests: () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    stop: () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };
}

/** The Worker's requests only. */
export const workerRequests = (e: Engine) => e.requests().filter((r) => r.role === "worker");

/**
 * What the Worker was shown of its last turn's tool results: the binary puts
 * them in the user message under `=== LAST TURN ===`.
 */
export const lastTurn = (r: { body: EngineRequest } | undefined): string => {
  const user =
    [...(r?.body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  const at = user.indexOf("=== LAST TURN ===");
  if (at < 0) return "";
  const next = user.indexOf("\n=== ", at + 4);
  return user.slice(at, next < 0 ? undefined : next);
};
