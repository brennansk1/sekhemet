import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { answer } from "../src/pm/agent.js";
import { judgeLicence, searchLibraries } from "../src/pm/libraries.js";
import { ResearchHostAwaitsYes } from "../src/research_consent.js";

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

describe("library reuse with licence checks", () => {
  it("accepts permissive licences and flags the rest", () => {
    expect(judgeLicence("MIT").usable).toBe(true);
    expect(judgeLicence("(MIT OR Apache-2.0)").usable).toBe(true);
    expect(judgeLicence("MPL-2.0")).toMatchObject({
      usable: false,
      action: "flag",
      note: expect.stringMatching(/weak copyleft/),
    });
    expect(judgeLicence("GPL-3.0")).toMatchObject({ usable: false, action: "exclude" });
    expect(judgeLicence("UNLICENSED").note).toMatch(/proprietary/);
    expect(judgeLicence("SEE LICENSE IN LICENSE.md").note).toMatch(/legal review/);
  });

  it("reads npm search results with licences and downloads", async () => {
    const hits = await searchLibraries("csv parse", "npm", async () => ({
      objects: [
        {
          package: {
            name: "csv-parse",
            version: "5.6.0",
            license: "MIT",
            description: "CSV parser",
          },
          downloads: { weekly: 17_000_000 },
        },
        { package: { name: "gpl-csv", version: "1.0.0", license: "GPL-3.0", description: "x" } },
      ],
    }));
    expect(hits.map((h) => [h.name, h.usable])).toEqual([
      ["csv-parse", true],
      ["gpl-csv", false],
    ]);
  });

  it("lets Seshat search before proposing, and keeps its proposals", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "find_library", arguments: { query: "csv parse" } }],
        usage,
      },
      {
        text: "Use csv-parse (MIT) rather than writing a parser.",
        toolCalls: [
          {
            id: "2",
            name: "propose_create_card",
            arguments: { title: "Import CSV", spec: "Use csv-parse.", reason: "reuse" },
          },
        ],
        usage,
      },
    ]);
    let searched = "";
    const result = await answer(
      model,
      {
        project: "p",
        cards: await cards.listCards(),
        cycles: [],
        recentRuns: [],
        pmModel: "dirk-27b",
        today: "2026-09-18",
      },
      [],
      [{ id: "m", seq: 1, role: "user", text: "Add CSV import", createdAt: "", state: "queued" }],
      undefined,
      async (q) => {
        searched = q;
        return [
          {
            name: "csv-parse",
            ecosystem: "npm",
            version: "5",
            license: "MIT",
            description: "",
            url: "",
          },
        ];
      },
    );
    expect(searched).toBe("csv parse");
    expect(result.text).toContain("csv-parse (MIT)");
    expect(result.proposals.map((p) => p.kind)).toEqual(["create_card"]);
  });
  it("tells Seshat plainly when its registry awaits a yes (DS-S8-8)", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: "",
        toolCalls: [
          { id: "1", name: "find_library", arguments: { query: "csv", ecosystem: "pypi" } },
        ],
        usage,
      },
      { text: "Not settled.", toolCalls: [], usage },
    ]);
    await answer(
      model,
      {
        project: "p",
        cards: await cards.listCards(),
        cycles: [],
        recentRuns: [],
        pmModel: "dirk-27b",
        today: "2026-09-18",
      },
      [],
      [{ id: "m", seq: 1, role: "user", text: "Add CSV import", createdAt: "", state: "queued" }],
      undefined,
      async () => {
        throw new ResearchHostAwaitsYes("pypi.org", "pypi.org awaits a yes: not named");
      },
    );
    expect(model.callHistory.at(-1)?.prompt).toContain("pypi.org awaits a yes");
  });
});
