import { expect, it } from "vitest";
import { buildReplayHeaders } from "../src/replay.js";
import type { WebhookEvent } from "../src/types.js";

it("drops hop-by-hop headers stored with capitals", () => {
  const event: WebhookEvent = {
    id: 3,
    source: "stripe",
    method: "POST",
    path: "/ingest/stripe",
    headers: { Host: "127.0.0.1:4040", "Content-Length": "2", "Content-Type": "application/json" },
    body: Buffer.from("{}"),
    receivedAt: 1,
    verification: "unsigned",
  };
  expect(buildReplayHeaders(event)).toEqual({
    "content-type": "application/json",
    "x-vanguard-replay": "3",
  });
});
