import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EgressProxy,
  ProcessSandbox,
  domainAllowed,
  generateSeatbeltProfile,
} from "../src/index.js";
import { srtProxyUrl, srtUnavailableReason } from "../src/srt_engine.js";

describe("allowlisting egress proxy with a request log (S5)", () => {
  let dir: string;
  let upstream: Server;
  let upstreamPort: number;
  let upstreamHits: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "egress-"));
    upstreamHits = 0;
    upstream = createServer((req, res) => {
      upstreamHits += 1;
      res.end(`hello from upstream ${req.url}`);
    });
    upstreamPort = await new Promise((r) =>
      upstream.listen(0, "127.0.0.1", () => r((upstream.address() as { port: number }).port)),
    );
  });
  afterEach(async () => {
    await new Promise((r) => upstream.close(() => r(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches domains and subdomains only", () => {
    expect(domainAllowed("registry.npmjs.org", ["npmjs.org"])).toBe(true);
    expect(domainAllowed("evilnpmjs.org", ["npmjs.org"])).toBe(false);
    expect(domainAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
  });

  // SEC-9/SEC-10: a loopback upstream on a random port is refused even when
  // allowlisted; the allowed decision is covered at the policy level in
  // egress_hardening.spec.ts (checkDestination), since tests reach no internet.
  it("refuses loopback and unlisted destinations, and logs both with a reason and payload hash", async () => {
    const records: unknown[] = [];
    const proxy = new EgressProxy({ allow: ["127.0.0.1"], onRequest: (r) => records.push(r) });
    const port = await proxy.start();
    try {
      const local = await fetchVia(port, `http://127.0.0.1:${upstreamPort}/x`);
      expect(local).toContain("Sekhemet egress:");
      expect(local).not.toContain("hello from upstream");
      const refused = await fetchVia(port, "http://example.invalid/y");
      expect(refused).toContain("not on this project's network allowlist");
      expect(proxy.log.map((r) => [r.host, r.allowed])).toEqual([
        ["127.0.0.1", false],
        ["example.invalid", false],
      ]);
      expect(proxy.log.every((r) => r.reason)).toBe(true);
      expect(proxy.log[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(records).toHaveLength(2);
      expect(upstreamHits).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("gives a confined command the proxy as its only way out", () => {
    const profile = generateSeatbeltProfile({
      allowedPaths: [dir],
      allowNetwork: false,
      timeoutMs: 1,
      cwd: dir,
      egressProxyPort: 40123,
    });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-outbound (remote tcp "localhost:40123"))');
  });

  // R9: srt's Linux sandbox has its own empty network namespace, so the proxy's
  // host port is unreachable from inside; srt relays 127.0.0.1:3128 to it.
  it("points a command under srt at the proxy's address inside srt's sandbox", () => {
    const o = { allowedPaths: [dir], allowNetwork: false, timeoutMs: 1, cwd: dir };
    expect(srtProxyUrl({ ...o, egressProxyPort: 40123 }, "darwin")).toBe("http://127.0.0.1:40123");
    expect(srtProxyUrl({ ...o, egressProxyPort: 40123 }, "linux")).toBe("http://127.0.0.1:3128");
    expect(srtProxyUrl(o, "linux")).toBeUndefined();
    expect(
      srtProxyUrl({ ...o, allowNetwork: true, egressProxyPort: 40123 }, "linux"),
    ).toBeUndefined();
  });

  // DEC-39: under both engines.
  it
    .runIf(new ProcessSandbox({ engine: "native" }).confinement !== "none")
    .each(
      srtUnavailableReason() === undefined ? (["native", "srt"] as const) : (["native"] as const),
    )("lets curl inside the %s engine reach the network only through the proxy", async (engine) => {
    const proxy = new EgressProxy({ allow: ["127.0.0.1"] });
    const port = await proxy.start();
    try {
      const box = new ProcessSandbox({ engine });
      const opts = { allowedPaths: [dir], allowNetwork: false, timeoutMs: 15_000, cwd: dir };
      const via = await box.execute(
        "curl",
        ["-s", "--max-time", "5", `http://127.0.0.1:${upstreamPort}/z`],
        {
          ...opts,
          egressProxyPort: port,
        },
      );
      // The proxy answered (and refused the loopback target, SEC-9).
      expect(via.stdout).toContain("Sekhemet egress:");
      const direct = await box.execute(
        "curl",
        ["-s", "--max-time", "5", "--noproxy", "*", `http://127.0.0.1:${upstreamPort}/z`],
        { ...opts, egressProxyPort: port },
      );
      expect(direct.stdout).not.toContain("hello from upstream");
      expect(direct.stdout).not.toContain("Sekhemet egress:");
      expect(proxy.log.map((r) => [r.host, r.allowed])).toEqual([["127.0.0.1", false]]);
      expect(upstreamHits).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});

/** A plain-HTTP request through an HTTP proxy (absolute URI form). */
async function fetchVia(proxyPort: number, url: string): Promise<string> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}
