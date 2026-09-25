import { request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { EgressProxy, canonicalHost, checkDestination } from "../src/egress.js";

/** A resolver that never touches the network: names map to fixed addresses. */
function fakeLookup(table: Record<string, string[]>) {
  const calls: string[] = [];
  const lookup = async (host: string) => {
    calls.push(host);
    const addrs = table[host];
    if (!addrs) throw new Error(`ENOTFOUND ${host}`);
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, calls };
}

const table = {
  "api.example.com": ["93.184.216.34"],
  "loop.example.com": ["127.0.0.1"],
  "lan.example.com": ["10.0.0.5"],
  "meta.example.com": ["169.254.169.254"],
  "cgnat.example.com": ["100.64.1.1"],
  "ula.example.com": ["fd00::1"],
  "v6loop.example.com": ["::1"],
  "mapped.example.com": ["::ffff:127.0.0.1"],
  "mixed.example.com": ["93.184.216.34", "192.168.1.1"],
};
const allow = ["example.com", "93.184.216.34", "127.0.0.1", "169.254.169.254", "[::1]", "::1"];

describe("SEC-11 hostname canonicalisation", () => {
  it("lowercases and strips one trailing dot", () => {
    expect(canonicalHost("API.Example.COM.")).toEqual({ host: "api.example.com" });
    expect(canonicalHost("[::1]")).toEqual({ host: "::1" });
  });

  it.each([
    ["", "empty"],
    ["evil.com\0.example.com", "NUL"],
    ["exa mple.com", "hostname syntax"],
    ["example.com/x", "hostname syntax"],
    ["a..example.com", "hostname syntax"],
    ["example.com..", "hostname syntax"],
    ["-a.example.com", "hostname syntax"],
    [`${"a".repeat(64)}.example.com`, "label"],
    [`${"abcdefghi.".repeat(26)}com`, "253"],
    ["[not-an-ip]", "IPv6"],
  ])("refuses %j (%s)", async (raw, why) => {
    const c = canonicalHost(raw);
    expect("reason" in c && c.reason).toMatch(new RegExp(why, "i"));
    const { lookup, calls } = fakeLookup(table);
    const d = await checkDestination(raw, 443, ["example.com"], lookup);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(new RegExp(why, "i"));
    expect(calls).toEqual([]);
  });
});

describe("SEC-10 ports", () => {
  it.each([22, 25, 8080, 0, 65535])("refuses port %i on an allowlisted host", async (port) => {
    const { lookup, calls } = fakeLookup(table);
    const d = await checkDestination("api.example.com", port, ["example.com"], lookup);
    expect(d).toMatchObject({ allowed: false });
    expect(d.reason).toMatch(/port/);
    expect(calls).toEqual([]);
  });

  it.each([80, 443])("allows port %i", async (port) => {
    const { lookup } = fakeLookup(table);
    const d = await checkDestination("api.example.com", port, ["example.com"], lookup);
    expect(d).toMatchObject({ allowed: true, address: "93.184.216.34", host: "api.example.com" });
  });
});

describe("SEC-9 resolution in the proxy", () => {
  it.each([
    ["loop.example.com", "loopback"],
    ["lan.example.com", "private"],
    ["meta.example.com", "linkLocal"],
    ["cgnat.example.com", "carrierGradeNat"],
    ["ula.example.com", "uniqueLocal"],
    ["v6loop.example.com", "loopback"],
    ["mapped.example.com", "loopback"],
    ["mixed.example.com", "private"],
  ])("refuses %s (resolves to %s)", async (host, range) => {
    const { lookup } = fakeLookup(table);
    const d = await checkDestination(host, 443, ["example.com"], lookup);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain(range);
    expect(d.address).toBeUndefined();
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "linkLocal"],
    ["[::1]", "loopback"],
    ["0x7f.1", "loopback"],
    ["2130706433", "loopback"],
  ])("classifies the IP literal %s without resolving it", async (host, range) => {
    const { lookup, calls } = fakeLookup(table);
    const d = await checkDestination(host, 80, ["0x7f.1", "2130706433", ...allow], lookup);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain(range);
    expect(calls).toEqual([]);
  });

  it("allows a public literal and returns it as the address to dial", async () => {
    const { lookup, calls } = fakeLookup(table);
    const d = await checkDestination("93.184.216.34", 443, allow, lookup);
    expect(d).toMatchObject({ allowed: true, address: "93.184.216.34" });
    expect(calls).toEqual([]);
  });

  it("refuses names that do not resolve", async () => {
    const { lookup } = fakeLookup(table);
    const d = await checkDestination("nx.example.com", 443, ["example.com"], lookup);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/resolve/);
  });

  it("checks the allowlist before resolving, and an empty allowlist denies everything", async () => {
    const { lookup, calls } = fakeLookup(table);
    const off = await checkDestination("api.example.com", 443, ["npmjs.org"], lookup);
    expect(off).toMatchObject({ allowed: false });
    expect(off.reason).toMatch(/allowlist/);
    const none = await checkDestination("api.example.com", 443, [], lookup);
    expect(none).toMatchObject({ allowed: false });
    expect(calls).toEqual([]);
  });
});

describe("the proxy applies the checks and records every refusal", () => {
  it("refuses CONNECT to a disallowed port and to a name resolving to loopback", async () => {
    const { lookup } = fakeLookup(table);
    const proxy = new EgressProxy({ allow: ["example.com"], lookup });
    const port = await proxy.start();
    try {
      expect(await rawConnect(port, "api.example.com:22")).toMatch(/^HTTP\/1.1 403/);
      expect(await rawConnect(port, "LOOP.example.com.:443")).toMatch(/^HTTP\/1.1 403/);
      expect(await rawConnect(port, "[::1]:443")).toMatch(/^HTTP\/1.1 403/);
      expect(proxy.log.map((r) => [r.method, r.host, r.port, r.allowed])).toEqual([
        ["CONNECT", "api.example.com", 22, false],
        ["CONNECT", "loop.example.com", 443, false],
        ["CONNECT", "::1", 443, false],
      ]);
      expect(proxy.log[0]?.reason).toMatch(/port/);
      expect(proxy.log[1]?.reason).toContain("loopback");
      for (const r of proxy.log) expect(r.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await proxy.close();
    }
  });

  it("refuses plain HTTP to a metadata address and to a non-standard port", async () => {
    const { lookup } = fakeLookup(table);
    const proxy = new EgressProxy({ allow: ["example.com"], lookup });
    const port = await proxy.start();
    try {
      const meta = await get(port, "http://meta.example.com/latest/meta-data/");
      expect(meta.status).toBe(403);
      const odd = await get(port, "http://api.example.com:8080/");
      expect(odd.status).toBe(403);
      expect(proxy.log.map((r) => [r.host, r.port, r.allowed])).toEqual([
        ["meta.example.com", 80, false],
        ["api.example.com", 8080, false],
      ]);
      expect(proxy.log[0]?.reason).toContain("linkLocal");
      expect(proxy.log[1]?.reason).toMatch(/port/);
    } finally {
      await proxy.close();
    }
  });
});

function rawConnect(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (c) => {
      buf += c;
    });
    s.on("end", () => resolve(buf));
    s.on("close", () => resolve(buf));
    s.on("error", reject);
  });
}

function get(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
