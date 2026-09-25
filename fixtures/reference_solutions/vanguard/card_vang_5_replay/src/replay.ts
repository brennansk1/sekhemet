import { performance } from "node:perf_hooks";
import type { EventStore } from "./store.js";
import type { ReplayRequest, ReplayResult, WebhookEvent } from "./types.js";

export const HOP_BY_HOP_HEADERS = [
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
];

/** The headers to replay: stored ones minus hop-by-hop, then overrides, then the replay marker. */
export function buildReplayHeaders(
  event: WebhookEvent,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.includes(lower)) headers[lower] = value;
  }
  for (const [name, value] of Object.entries(overrides)) headers[name.toLowerCase()] = value;
  headers["x-vanguard-replay"] = String(event.id);
  return headers;
}

/** Send a stored webhook to a target and capture its answer. */
export async function replayEvent(
  store: EventStore,
  request: ReplayRequest,
  now: () => number = () => performance.now(),
): Promise<ReplayResult> {
  const event = store.get(request.eventId);
  if (!event) throw new Error(`event not found: ${request.eventId}`);
  const url = new URL(request.targetUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  const started = now();
  const response = await fetch(url, {
    method: event.method,
    headers: buildReplayHeaders(event, request.headerOverrides),
    body: Buffer.from(event.body),
  });
  const responseBody = await response.text();
  return {
    eventId: event.id,
    status: response.status,
    durationMs: now() - started,
    responseBody,
  };
}
