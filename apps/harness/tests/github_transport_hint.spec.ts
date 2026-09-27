import { policyRefusal } from "@sekhemet/sandbox";
import { describe, expect, it } from "vitest";
import { networkHint } from "../src/github_transport.js";

// integrations §4: a refused host's hint names the setting to change. The
// sandbox's reason for a denied host names the rule and its file (DS-N4-3),
// `in fetch_deny [<file>: <rule>]`; the hint still recognises it.
describe("networkHint names fetch_deny for a denied host", () => {
  it("recognises the deny reason with its provenance", () => {
    const reason = policyRefusal(
      {
        mode: "open",
        fetchAllow: [],
        fetchDeny: ["github.com"],
        research: "no",
        denyRules: [{ rule: "github.com", file: "~/.config/sekhemet/config.toml" }],
      },
      "github.com",
    );
    expect(reason).toMatch(/^in fetch_deny \[/);
    expect(networkHint(reason as string, "github.com")).toBe(
      "github.com is in [network] fetch_deny; remove it there to connect",
    );
  });
});
