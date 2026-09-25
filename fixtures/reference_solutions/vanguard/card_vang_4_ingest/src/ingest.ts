import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_TOLERANCE_SECONDS, verifyGithub, verifyStripe } from "./hmac.js";
import type { EventStore } from "./store.js";
import type { HmacConfig, VerificationResult, WebhookEvent } from "./types.js";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface IngestOptions {
  store: EventStore;
  hmac: HmacConfig;
  maxBodyBytes?: number;
  /** Epoch milliseconds; default Date.now. */
  now?: () => number;
  onEvent?: (event: WebhookEvent) => void;
}

export function verifyForSource(
  source: string,
  headers: Record<string, string>,
  body: Buffer,
  hmac: HmacConfig,
  nowSeconds: number,
): VerificationResult {
  if (source === "stripe" && hmac.stripeSecret !== undefined) {
    return verifyStripe(
      headers["stripe-signature"],
      body,
      hmac.stripeSecret,
      nowSeconds,
      hmac.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    );
  }
  if (source === "github" && hmac.githubSecret !== undefined) {
    return verifyGithub(headers["x-hub-signature-256"], body, hmac.githubSecret);
  }
  return { status: "unsigned", scheme: "none" };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** POST /ingest/:source — verify, store (failures included) and answer. */
export function createIngestHandler(
  options: IngestOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  return (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const match = /^\/ingest\/([a-z0-9-]{1,32})$/.exec(path);
    const source = match?.[1];
    if (source === undefined) {
      req.resume();
      json(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      req.resume();
      res.setHeader("allow", "POST");
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        json(res, 413, { error: "payload too large" });
        return;
      }
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const receivedAt = now();
      const result = verifyForSource(
        source,
        headers,
        body,
        options.hmac,
        Math.floor(receivedAt / 1000),
      );
      const event = options.store.insert({
        source,
        method: "POST",
        path: url,
        headers,
        body,
        receivedAt,
        verification: result.status,
      });
      options.onEvent?.(event);
      if (result.status === "failed") {
        json(res, 401, { id: event.id, verification: "failed", reason: result.reason });
      } else {
        json(res, 202, { id: event.id, verification: result.status });
      }
    });
  };
}
