import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { signGithub, signStripe } from "../src/hmac.js";

// HELD OUT (measurement T11, MS-T7-8): never shown to the Planner, Seshat or
// the Worker. Project-level checks of Vanguard — a local webhook inbox that
// verifies, keeps and replays webhooks — that no card's acceptance test makes
// through the daemon. DRAFT until a person confirms it.

const NOW_S = 1_700_000_000;
const PAYLOAD = '{"action":"opened","number":7}';

describe("held out: vanguard as a whole", () => {
  let dir: string;
  const daemons: Daemon[] = [];
  const start = async () => {
    const d = await startDaemon({
      dbPath: join(dir, "vanguard.db"),
      port: 0,
      hmac: { stripeSecret: "whsec_s", githubSecret: "gh_s" },
      now: () => NOW_S * 1000,
    });
    daemons.push(d);
    return d;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vanguard-held-out-"));
  });

  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies a GitHub webhook signed with its secret", async () => {
    const d = await start();
    const res = await fetch(`http://127.0.0.1:${d.port}/ingest/github`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": signGithub("gh_s", PAYLOAD),
        "content-type": "application/json",
      },
      body: PAYLOAD,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ verification: "verified" });
  });

  it("refuses a Stripe signature made long ago, even with the right secret", async () => {
    const d = await start();
    const res = await fetch(`http://127.0.0.1:${d.port}/ingest/stripe`, {
      method: "POST",
      headers: { "stripe-signature": signStripe("whsec_s", PAYLOAD, NOW_S - 3600) },
      body: PAYLOAD,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ verification: "failed" });
  });

  it("keeps what it received across a restart", async () => {
    const a = await start();
    await fetch(`http://127.0.0.1:${a.port}/ingest/shopify`, { method: "POST", body: "a=1" });
    await a.close();
    daemons.splice(daemons.indexOf(a), 1);
    const b = await start();
    const list = (await (await fetch(`http://127.0.0.1:${b.port}/events`)).json()) as {
      source: string;
    }[];
    expect(list.map((e) => e.source)).toEqual(["shopify"]);
  });
});
