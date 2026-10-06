import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A scripted model at the HTTP boundary that records what it is sent (the
 * design-stage, measurement and context entry-point tests, FINISH_LINE_PLAN
 * C2d). Loaded into the spawned binary with `node --import`, it answers every
 * request to the Ollama address itself, so the machine's real Ollama is never
 * reached and no model is loaded. Every `/api/chat` request body is appended
 * to `G2_RECORD` as one JSON line.
 *
 * Who is asking is read from the tools offered: a request offering
 * `finish_card` is the Worker's, one offering `deps_source` or `read_docs` the
 * Researcher's. Each takes its next turn from its own script (`G2_WORKER` and
 * `G2_RESEARCHER`: a JSON array of turns, each an array of tool calls or a
 * string of content); past the end of its script it says nothing. Any other
 * request is answered from `G2_OTHER` (the content, default empty).
 *
 * A request to any host but this machine — through `fetch`, `node:http` or
 * `node:https` (the network policy's own transport) — goes to the test's
 * local HTTP stub on `G2_STUB_PORT` (`g2_web.ts`), and is refused when there
 * is none: no request leaves the machine and no name is resolved.
 */
export const SCRIPTED_MODEL = "scripted-worker:latest";

const PRELOAD = `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const real = globalThis.fetch;
const LOCAL = ["127.0.0.1", "localhost", "[::1]", "::1"];
const isLocal = (host) => LOCAL.includes(host);
// node:http and node:https too (the network policy's transport, its DNS-pinned
// agent included): a request for another host goes to the stub when there is
// one, and is refused otherwise — nothing leaves the machine.
{
  const require = createRequire(import.meta.url);
  const http = require("node:http");
  const https = require("node:https");
  const httpRequest = http.request;
  const reroute = (orig) => function (a, b, c) {
    const url = typeof a === "string" || a instanceof URL ? new URL(String(a)) : undefined;
    const opts = url ? (typeof b === "function" ? {} : b ?? {}) : a ?? {};
    const cb = typeof b === "function" ? b : c;
    const host = url ? url.hostname : String(opts.hostname ?? opts.host ?? "localhost").replace(/:\\d+$/, "");
    if (isLocal(host)) return orig.call(this, a, b, c);
    const stub = process.env.G2_STUB_PORT;
    const path = url ? url.pathname + url.search : String(opts.path ?? "/");
    const target = stub
      ? new URL("http://127.0.0.1:" + stub + "/" + host + path)
      : new URL("http://127.0.0.1:9/refused-by-test-preload/" + host + path);
    const { agent: _agent, hostname: _h, host: _host, port: _p, protocol: _pr, path: _path, lookup: _l, ...rest } = opts;
    return httpRequest(target, rest, cb);
  };
  http.request = reroute(http.request);
  https.request = reroute(https.request);
  http.get = function (a, b, c) { const r = http.request(a, b, c); r.end(); return r; };
  https.get = function (a, b, c) { const r = https.request(a, b, c); r.end(); return r; };
  syncBuiltinESMExports();
}
const MODEL = ${JSON.stringify(SCRIPTED_MODEL)};
const scripts = {
  worker: JSON.parse(process.env.G2_WORKER || "[]"),
  researcher: JSON.parse(process.env.G2_RESEARCHER || "[]"),
};
const next = { worker: 0, researcher: 0, other: 0 };
// G2_OTHER: one content for every other request, or a JSON array taken in
// order (its last entry repeated).
const others = (() => {
  const raw = process.env.G2_OTHER ?? "";
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [raw];
  } catch {
    return [raw];
  }
})();
const other = () => others[Math.min(next.other++, others.length - 1)] ?? "";
const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // With a stub (G2_STUB_PORT), every host but this machine is served by the
  // test's local stub, the host kept as the path's first segment: nothing
  // leaves the machine and no name is resolved.
  const stub = process.env.G2_STUB_PORT;
  const u = new URL(url);
  if (!isLocal(u.hostname)) {
    if (!stub) throw new TypeError("fetch failed: " + u.hostname + " refused by the test preload (no network)");
    const to = "http://127.0.0.1:" + stub + "/" + u.hostname + u.pathname + u.search;
    const req = input instanceof Request ? input : undefined;
    return real(to, { method: init?.method ?? req?.method ?? "GET", headers: init?.headers ?? req?.headers, body: init?.body, redirect: "manual", signal: init?.signal });
  }
  if (!url.startsWith("http://127.0.0.1:11434")) return real(input, init);
  const path = new URL(url).pathname;
  if (path === "/api/tags" || path === "/api/ps")
    return json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
  if (path !== "/api/chat") return json({});
  const raw = String(init?.body ?? "{}");
  const body = JSON.parse(raw);
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const role = tools.includes("finish_card")
    ? "worker"
    : tools.includes("deps_source") || tools.includes("read_docs")
      ? "researcher"
      : "other";
  if (process.env.G2_RECORD) appendFileSync(process.env.G2_RECORD, JSON.stringify({ role, body }) + "\\n");
  // G2_HANG names a role whose requests are never answered (a card left running).
  if (process.env.G2_HANG === role) return new Promise(() => {});
  let message = { role: "assistant", content: role === "other" ? other() : "" };
  if (role !== "other") {
    const turn = scripts[role][next[role]++];
    message = turn === undefined
      ? { role: "assistant", content: "" }
      : typeof turn === "string"
        ? { role: "assistant", content: turn }
        : { role: "assistant", content: "", tool_calls: turn.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) };
  }
  const final = { model: MODEL, message, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };
  return body.stream ? new Response(JSON.stringify(final) + "\\n") : json(final);
};
`;

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}
export type Turn = ToolCall[] | string;

/** Writes the preload under `home`; returns its path and the record file. */
export function scriptedModel(home: string): { preload: string; record: string } {
  const preload = join(home, "g2_scripted_model.mjs");
  const record = join(home, "g2_requests.jsonl");
  writeFileSync(preload, PRELOAD);
  return { preload, record };
}

/** The environment that scripts the model: the turns of each role and where to record. */
export function scriptEnv(
  record: string,
  scripts: {
    worker?: Turn[];
    researcher?: Turn[];
    /** Every other request's content, or each in order (the last repeated). */
    other?: string | string[];
    /** A role whose requests are never answered. */
    hang?: "worker" | "researcher";
  } = {},
): Record<string, string> {
  return {
    G2_RECORD: record,
    G2_WORKER: JSON.stringify(scripts.worker ?? []),
    G2_RESEARCHER: JSON.stringify(scripts.researcher ?? []),
    ...(scripts.other !== undefined
      ? {
          G2_OTHER:
            typeof scripts.other === "string" ? scripts.other : JSON.stringify(scripts.other),
        }
      : {}),
    ...(scripts.hang ? { G2_HANG: scripts.hang } : {}),
  };
}

export interface Recorded {
  role: "worker" | "researcher" | "other";
  body: {
    model: string;
    messages: { role: string; content: string }[];
    tools?: unknown[];
  };
}

/** Every request the scripted model was sent, in order. */
export function recorded(record: string): Recorded[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Recorded);
}
