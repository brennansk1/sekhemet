import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationGroups, secretStoreNotice } from "../src/integrations_view.js";

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
        { id: "slack", name: "Slack for Seshat", tier: "now", connected: true },
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

/**
 * SEC-27c (B-12): where credentials are entered, the page says where they
 * are kept, and on a host with no secret store says so plainly and offers
 * the choice of a private file, which the person must make.
 */
describe("Integrations says where secrets are kept", () => {
  it("names the store when there is one, with no choice to make", () => {
    const n = secretStoreNotice({
      store: "secret-service",
      storeName: "the Secret Service (secret-tool)",
      cleartextChosen: false,
      heldInFiles: 0,
      message:
        "Integration secrets (Slack, push and email) are kept in the Secret Service (secret-tool).",
    });
    expect(n).toMatchObject({ tone: "pass", offerChoice: false });
    expect(n?.text).toMatch(/Secret Service/);
  });

  it("with no store and no choice, warns that secrets are not saved and offers the file", () => {
    const n = secretStoreNotice({
      unavailable: "secret-tool is not installed",
      cleartextChosen: false,
      heldInFiles: 0,
      message:
        "This machine has no secret store: secret-tool is not installed. Integration secrets (Slack, push and email) are not saved until you install one or choose, in Integrations, to keep them in a private file.",
    });
    expect(n).toMatchObject({ tone: "warn", offerChoice: true });
    expect(n?.text).toMatch(/not saved/);
    expect(n?.action).toMatch(/private file/);
  });

  it("with no store and the choice made, says it is the person's choice and offers nothing more", () => {
    const n = secretStoreNotice({
      unavailable: "secret-tool is not installed",
      cleartextChosen: true,
      cleartextChosenAt: "2026-09-29T08:00:00.000Z",
      heldInFiles: 1,
      message: "This machine has no secret store: … You chose on 2026-09-29 to keep …",
    });
    expect(n).toMatchObject({ tone: "warn", offerChoice: false });
    expect(n?.text).toMatch(/You chose/);
  });

  it("shows nothing when the server does not report a secret store (an older server)", () => {
    expect(secretStoreNotice(undefined)).toBeUndefined();
    expect(secretStoreNotice({} as never)).toBeUndefined();
  });

  it("the page asks the server and uses this helper", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "web", "integrations.js"), "utf8");
    expect(src).toContain("/api/integrations/secret-store");
    expect(src).toContain("secretStoreNotice(");
  });
});
