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

describe("allowlisting egress proxy with a request log (S5)", () => {
  let dir: string;
  let upstream: Server;
  let upstreamPort: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "egress-"));
    upstream = createServer((req, res) => res.end(`hello from upstream ${req.url}`));
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

  it("forwards allowlisted requests, refuses the rest, and logs both with a payload hash", async () => {
    const records: unknown[] = [];
    const proxy = new EgressProxy({ allow: ["127.0.0.1"], onRequest: (r) => records.push(r) });
    const port = await proxy.start();
    try {
      const ok = await fetchVia(port, `http://127.0.0.1:${upstreamPort}/x`);
      expect(ok).toContain("hello from upstream /x");
      const refused = await fetchVia(port, "http://example.invalid/y");
      expect(refused).toContain("not on this project's network allowlist");
      expect(proxy.log.map((r) => [r.host, r.allowed])).toEqual([
        ["127.0.0.1", true],
        ["example.invalid", false],
      ]);
      expect(proxy.log[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(records).toHaveLength(2);
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

  // DEC-39: under both engines.
  it.runIf(platform() === "darwin").each(["native", "srt"] as const)(
    "lets curl inside the %s engine reach an allowlisted host only through the proxy",
    async (engine) => {
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
        expect(via.stdout).toContain("hello from upstream /z");
        const direct = await box.execute(
          "curl",
          ["-s", "--max-time", "5", "--noproxy", "*", `http://127.0.0.1:${upstreamPort}/z`],
          { ...opts, egressProxyPort: port },
        );
        expect(direct.stdout).not.toContain("hello from upstream");
        expect(proxy.log.filter((r) => r.allowed)).toHaveLength(1);
      } finally {
        await proxy.close();
      }
    },
  );
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
