import { describe, expect, it } from "vitest";
import {
  type NetworkRequestRecord,
  mergeNetworkConfigs,
  policyFetch,
  policyRefusal,
} from "../src/network_policy.js";

/**
 * Design-stage DS-N4-3 and DS-N4-4: a denied domain is refused whatever
 * `fetch_allow` or `mode` say, naming the file and the rule that refused
 * it; a project's widening of `fetch_allow` or `mode` is ignored and
 * reported, never acted on.
 */
const files = { user: "/home/u/.sekhemet/config.toml", project: "/repo/.sekhemet/config.toml" };

describe("fetch_deny names the file and the rule (DS-N4-3)", () => {
  it("refuses a denied domain and its subdomains in open mode and inside fetch_allow, naming the user's file", async () => {
    const policy = mergeNetworkConfigs(
      { mode: "open", research: "yes", fetchAllow: ["pypi.org"], fetchDeny: ["pypi.org"] },
      {},
      files,
    );
    for (const host of ["pypi.org", "files.pypi.org"]) {
      const why = policyRefusal(policy, host, { research: true });
      expect(why).toMatch(/fetch_deny/);
      expect(why).toContain("the user's config.toml");
      expect(why).toContain("pypi.org");
    }
    const records: NetworkRequestRecord[] = [];
    const f = policyFetch(policy, {
      purpose: "research",
      research: true,
      record: (r) => records.push(r),
    });
    // The person is told the file's path; the recorded reason names its role.
    await expect(f("https://files.pypi.org/x")).rejects.toThrow(files.user);
    expect(records[0]).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("the user's config.toml: pypi.org"),
    });
  });

  it("names the project's file when the project's rule refused it", () => {
    const policy = mergeNetworkConfigs({ mode: "open" }, { fetchDeny: ["*.example.org"] }, files);
    const why = policyRefusal(policy, "docs.example.org");
    expect(why).toContain("the project's .sekhemet/config.toml");
    expect(why).toContain("*.example.org");
    expect(policyRefusal(policy, "example.com")).toBeUndefined();
  });

  it("never puts a file's path in the reason the ledger records (a person's paths are private)", async () => {
    const policy = mergeNetworkConfigs(
      { mode: "open", fetchDeny: ["a.test"] },
      { fetchDeny: ["b.test"] },
      files,
    );
    for (const host of ["a.test", "b.test"]) {
      const why = policyRefusal(policy, host) as string;
      expect(why).not.toContain(files.user);
      expect(why).not.toContain(files.project);
      expect(why).not.toMatch(/\/home|\/repo/);
      const records: NetworkRequestRecord[] = [];
      await expect(
        policyFetch(policy, { purpose: "t", record: (r) => records.push(r) })(`https://${host}/`),
      ).rejects.toThrow();
      expect(records[0]?.reason).toBe(why);
    }
    // Where the rule came from is still kept, with its path, for the person.
    expect(policy.denyRules).toEqual([
      { rule: "a.test", file: files.user, role: "user" },
      { rule: "b.test", file: files.project, role: "project" },
    ]);
  });

  it("keeps a readable default label when no path is given", () => {
    const policy = mergeNetworkConfigs({ mode: "open", fetchDeny: ["x.test"] }, {});
    expect(policyRefusal(policy, "x.test")).toMatch(/fetch_deny.*config\.toml.*x\.test/);
  });
});

describe("a project may only narrow (DS-N4-4)", () => {
  it("ignores and reports a project's fetch_allow addition and wider mode, and fetches nothing on its account", () => {
    const policy = mergeNetworkConfigs(
      { mode: "allowlist", fetchAllow: ["docs.example.com"] },
      { mode: "open", fetchAllow: ["docs.example.com", "evil.example.net"], research: "yes" },
      files,
    );
    expect(policy.mode).toBe("allowlist");
    expect(policy.fetchAllow).toEqual(["docs.example.com"]);
    expect(policy.ignored).toEqual([
      { file: files.project, key: "mode", value: "open" },
      { file: files.project, key: "fetch_allow", value: "evil.example.net" },
      { file: files.project, key: "research", value: "yes" },
    ]);
    expect(policyRefusal(policy, "evil.example.net")).toBeDefined();
    expect(policyRefusal(policy, "docs.example.com")).toBeUndefined();
  });

  it("reports nothing when the project only narrows", () => {
    const policy = mergeNetworkConfigs(
      { mode: "open", research: "yes", fetchAllow: ["a.test", "b.test"] },
      { mode: "offline", fetchAllow: ["a.test"], fetchDeny: ["c.test"], research: "no" },
      files,
    );
    expect(policy.ignored).toEqual([]);
    expect(policy.fetchAllow).toEqual(["a.test"]);
  });
});

describe("a refusal never names an absolute home path", () => {
  it("names a file under the home directory from ~, and a project's file from its root", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { displayConfigPath } = await import("../src/network_policy.js");
    const user = join(homedir(), ".config", "sekhemet", "config.toml");
    const policy = mergeNetworkConfigs({ mode: "open", fetchDeny: ["x.test"] }, {}, { user });
    const refused = await policyFetch(policy, { purpose: "t" })("https://x.test/").catch(
      (err: Error) => err.message,
    );
    expect(refused).not.toContain(homedir());
    expect(refused).toContain("~/.config/sekhemet/config.toml");
    expect(displayConfigPath("/work/app/.sekhemet/config.toml", "/work/app")).toBe(
      ".sekhemet/config.toml",
    );
    expect(displayConfigPath("/etc/sekhemet.toml")).toBe("/etc/sekhemet.toml");
  });
});

describe("card zero's generator reaches only its ecosystem's registry (design-stage DS-P2-1, -2)", () => {
  it("names each ecosystem's registry hosts, even offline, and fetch_deny still wins", async () => {
    const { generatorAllowlist } = await import("../src/network_policy.js");
    const offline = mergeNetworkConfigs({}, {});
    expect(offline.mode).toBe("offline");
    expect(generatorAllowlist(offline, "npm")).toEqual(["registry.npmjs.org"]);
    expect(generatorAllowlist(offline, "python")).toEqual(["pypi.org", "files.pythonhosted.org"]);
    expect(generatorAllowlist(offline, "rust")).toEqual([
      "crates.io",
      "static.crates.io",
      "index.crates.io",
    ]);
    expect(generatorAllowlist(offline, "go")).toEqual(["proxy.golang.org", "sum.golang.org"]);
    const denied = mergeNetworkConfigs({ fetchDeny: ["files.pythonhosted.org"] }, {});
    expect(generatorAllowlist(denied, "python")).toEqual(["pypi.org"]);
  });
});
