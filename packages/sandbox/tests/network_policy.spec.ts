import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkDestination } from "../src/egress.js";
import {
  type NetworkRequestRecord,
  allowlistWarnings,
  cardAllowlist,
  mergeNetworkConfigs,
  policyFetch,
} from "../src/network_policy.js";

/** S3: one network policy (security items 28–33; SEC-12, SEC-12a, SEC-13, SEC-14, SEC-15b). */
describe("the one network policy", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("never lets the repository's gates.toml reach a host the user's config does not permit (SEC-12)", () => {
    const policy = mergeNetworkConfigs(
      { mode: "allowlist", fetchAllow: ["registry.npmjs.org"] },
      {},
    );
    expect(cardAllowlist(policy, ["registry.npmjs.org", "evil.example.com"])).toEqual([
      "registry.npmjs.org",
    ]);
  });

  it("lets a project's fetch_deny win over both allowlists (SEC-12a)", () => {
    const policy = mergeNetworkConfigs(
      { mode: "allowlist", fetchAllow: ["pypi.org", "files.pythonhosted.org"] },
      { fetchDeny: ["pypi.org"] },
    );
    expect(cardAllowlist(policy, ["pypi.org", "files.pythonhosted.org"])).toEqual([
      "files.pythonhosted.org",
    ]);
  });

  it("never lets a project widen the user's mode or allowlist", () => {
    const policy = mergeNetworkConfigs(
      { mode: "allowlist", fetchAllow: ["a.example.com"] },
      { mode: "open", fetchAllow: ["a.example.com", "b.example.com"] },
    );
    expect(policy.mode).toBe("allowlist");
    expect(policy.fetchAllow).toEqual(["a.example.com"]);
  });

  it("is offline when the user set neither mode nor research (SEC-13)", async () => {
    const policy = mergeNetworkConfigs({}, {});
    expect(policy.mode).toBe("offline");
    expect(policy.research).toBe("no");
    expect(cardAllowlist(policy, ["registry.npmjs.org"])).toEqual([]);
    const records: NetworkRequestRecord[] = [];
    const f = policyFetch(policy, { purpose: "supply-chain", record: (r) => records.push(r) });
    await expect(f("https://registry.npmjs.org/left-pad")).rejects.toThrow(/offline/);
    expect(records).toEqual([
      expect.objectContaining({
        host: "registry.npmjs.org",
        allowed: false,
        purpose: "supply-chain",
      }),
    ]);
  });

  it("refuses a private or metadata address even when the host is allowed (item 30)", async () => {
    const policy = mergeNetworkConfigs({ mode: "allowlist", fetchAllow: ["169.254.169.254"] }, {});
    const records: NetworkRequestRecord[] = [];
    const f = policyFetch(policy, { purpose: "supply-chain", record: (r) => records.push(r) });
    await expect(f("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    expect(records.at(-1)?.allowed).toBe(false);
  });

  it("reaches loopback in every mode, and records the request with its payload hash (items 29, 32)", async () => {
    const port = await new Promise<number>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }).listen(0, "127.0.0.1", () => {
        const a = server?.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
    const records: NetworkRequestRecord[] = [];
    const f = policyFetch(mergeNetworkConfigs({}, {}), {
      purpose: "local",
      record: (r) => records.push(r),
    });
    const res = await f(`http://127.0.0.1:${port}/x`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(records[0]).toMatchObject({ host: "127.0.0.1", allowed: true });
    expect(records[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends localhost to 127.0.0.1 itself and accepts a body-less reply", async () => {
    const port = await new Promise<number>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(204);
        res.end();
      }).listen(0, "127.0.0.1", () => {
        const a = server?.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
    const f = policyFetch(mergeNetworkConfigs({}, {}), { purpose: "local" });
    const res = await f(`http://localhost:${port}/`);
    expect(res.status).toBe(204);
  });

  it("lets fetch_deny win at the proxy, subdomains included (item 28)", async () => {
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const d = await checkDestination("evil.npmjs.org", 443, ["npmjs.org"], lookup, [
      "evil.npmjs.org",
    ]);
    expect(d).toMatchObject({ allowed: false, reason: expect.stringMatching(/fetch_deny/) });
    const ok = await checkDestination("registry.npmjs.org", 443, ["npmjs.org"], lookup, [
      "evil.npmjs.org",
    ]);
    expect(ok.allowed).toBe(true);
  });

  it("bounds research by a non-empty fetch_allow (item 29a)", async () => {
    const policy = mergeNetworkConfigs({ research: "yes", fetchAllow: ["docs.example.com"] }, {});
    const records: NetworkRequestRecord[] = [];
    const f = policyFetch(policy, {
      purpose: "research",
      research: true,
      record: (r) => records.push(r),
    });
    await expect(f("https://elsewhere.example.org/")).rejects.toThrow(
      /research outside fetch_allow/,
    );
  });

  it("warns about wildcard and upload-capable allowlist entries (SEC-15b)", () => {
    const w = allowlistWarnings(["*.example.com", "github.com", "registry.npmjs.org"]);
    expect(w.map((x) => x.host)).toEqual(["*.example.com", "github.com"]);
    expect(w[0]?.reason).toMatch(/wildcard/);
    expect(w[1]?.reason).toMatch(/upload/);
  });
});
