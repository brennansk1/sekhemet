import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationGroups } from "../src/integrations_view.js";

/**
 * DB-N2-7: Integrations renders what `/api/integrations` returns, grouped by
 * the `tier` the API gives (Now, Next, Later), with nothing hard-coded: an
 * integration the API omits is not shown, and only Now cards have controls.
 */

const copy = [
  {
    id: "github",
    name: "GitHub Issues and Projects",
    mono: "GH",
    does: "Sync.",
    leaves: "Issues.",
  },
  { id: "slack", name: "Slack", mono: "SL", does: "Standups.", leaves: "Messages." },
  { id: "sentry", name: "Sentry", mono: "SE", does: "Errors.", leaves: "Nothing." },
];

describe("integrationGroups", () => {
  it("groups the API's entries by the API's tier, in the API's order", () => {
    const g = integrationGroups(
      [
        { id: "slack", name: "Slack for the PM", tier: "now", connected: true },
        { id: "github", name: "GitHub", tier: "now", connected: false },
        { id: "sentry", name: "Sentry", tier: "next", connected: false },
        { id: "notion", name: "Notion publishing", tier: "later", connected: false },
      ],
      copy,
    );
    expect(g.now.map((e) => e.id)).toEqual(["slack", "github"]);
    expect(g.next.map((e) => e.id)).toEqual(["sentry"]);
    expect(g.later.map((e) => e.id)).toEqual(["notion"]);
    // The page's copy fills in what the API does not say, never the tier.
    expect(g.next[0]).toMatchObject({ tier: "next", does: "Errors.", controls: false });
    expect(g.now[0]).toMatchObject({ controls: true, connected: true });
    // An entry the page has no copy for is still shown, in the API's words.
    expect(g.later[0]).toMatchObject({ name: "Notion publishing", mono: "NO", does: "" });
  });

  it("does not show an integration the API omits", () => {
    const g = integrationGroups(
      [{ id: "github", name: "GitHub", tier: "now", connected: false }],
      copy,
    );
    expect([...g.now, ...g.next, ...g.later].map((e) => e.id)).toEqual(["github"]);
  });

  it("shows nothing at all when the server has no integrations route (404)", () => {
    const g = integrationGroups([], copy);
    expect(g).toEqual({ now: [], next: [], later: [] });
  });

  it("drops an entry with no tier or an unknown one", () => {
    const g = integrationGroups(
      [
        { id: "x", name: "X", connected: false },
        { id: "y", name: "Y", tier: "someday", connected: false },
      ],
      copy,
    );
    expect(g).toEqual({ now: [], next: [], later: [] });
  });

  it("the page keeps no tier or roadmap of its own", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "web", "integrations.js"), "utf8");
    expect(src).not.toMatch(/tier:\s*"(now|next|later)"/);
    expect(src).toContain("integrationGroups(");
  });
});
