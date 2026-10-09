import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLANNED_WITHOUT_MODEL,
  type PlannerLedger,
  STRUCTURAL_WORDS,
  SpidrFeaturePlanner,
  contentWords,
  formatPlanReport,
  persistPlan,
  resolvePlannerModel,
} from "../src/index.js";

/**
 * P1, model first (planner-pm §2.1.2-3): the Planner role's model writes the
 * slices; with none configured it is Seshat's; with none loadable the
 * heuristic runs and says so in the plan's first line, using only the spec's
 * own words; a bad reply is refused, retried once, then the heuristic runs.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function diskLedger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-model-first-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const reply = (text: string, finishReason?: string): InferenceResponse => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  ...(finishReason ? { finishReason } : {}),
});

const GOOD = JSON.stringify({
  slices: [
    {
      kind: "path",
      title: "Refund a paid invoice",
      keywords: ["refund", "invoice"],
      rationale: "The refund path first.",
      behaviour: "Given a paid invoice of 1000 cents, refunding 400 leaves a balance of 600.",
    },
  ],
});

describe("PM-P1-2: with no [models] planner, plan with Seshat's model", () => {
  it("resolves the Planner's model: flag, then an explicit planner, then Seshat's", () => {
    expect(resolvePlannerModel({ configured: "auto", seshatModel: "dirk-27b:latest" })).toBe(
      "dirk-27b:latest",
    );
    expect(resolvePlannerModel({ seshatModel: "dirk-27b:latest" })).toBe("dirk-27b:latest");
    expect(resolvePlannerModel({ configured: "qwen-planner", seshatModel: "dirk" })).toBe(
      "qwen-planner",
    );
    expect(resolvePlannerModel({ flag: "cli-model", configured: "qwen", seshatModel: "d" })).toBe(
      "cli-model",
    );
  });

  it("N0 (c6 #2): the person's Planning model assignment stands after the flag, before config.toml and Seshat's default", () => {
    expect(
      resolvePlannerModel({ assigned: "my-planner", configured: "qwen", seshatModel: "dirk" }),
    ).toBe("my-planner");
    expect(resolvePlannerModel({ assigned: "my-planner", seshatModel: "dirk" })).toBe("my-planner");
    expect(
      resolvePlannerModel({ flag: "cli-model", assigned: "my-planner", seshatModel: "dirk" }),
    ).toBe("cli-model");
    expect(
      resolvePlannerModel({ flag: "none", assigned: "my-planner", seshatModel: "dirk" }),
    ).toBeUndefined();
    // An assignment is the person's own: it is not dropped for an unlisted name.
    expect(
      resolvePlannerModel({
        assigned: "my-planner",
        seshatModel: "dirk",
        isRegistered: () => false,
      }),
    ).toBe("my-planner");
  });

  it("plans without a model when 'none' is named or configured", () => {
    expect(resolvePlannerModel({ flag: "none", seshatModel: "dirk-27b:latest" })).toBeUndefined();
    expect(
      resolvePlannerModel({ configured: "none", seshatModel: "dirk-27b:latest" }),
    ).toBeUndefined();
  });

  it("takes Seshat's model by default only when the registry lists it", () => {
    const registry = new Set(["dirk-27b:latest"]);
    const isRegistered = (m: string) => registry.has(m);
    expect(resolvePlannerModel({ seshatModel: "dirk-27b:latest", isRegistered })).toBe(
      "dirk-27b:latest",
    );
    expect(resolvePlannerModel({ seshatModel: "unlisted:latest", isRegistered })).toBeUndefined();
    expect(
      resolvePlannerModel({ configured: "unlisted:latest", seshatModel: "d", isRegistered }),
    ).toBe("unlisted:latest");
  });
});

describe("PM-P1-3: with no loadable model, the heuristic plans in the spec's own words", () => {
  const SPEC =
    "A billing service that charges customers monthly, handles refunds and emails invoices.";

  it("says so as the plan's first line, marks each card, and invents no noun", async () => {
    const l = diskLedger();
    await l.store.createCard({ id: "epic_b", tier: "epic", title: SPEC, status: "in_progress" });
    // A model that cannot be loaded: every request fails.
    const unloadable = {
      modelId: "planner",
      supportedArms: ["arm_b_json" as const],
      generate: async () => {
        throw new Error("model could not be loaded");
      },
    };
    const plan = await new SpidrFeaturePlanner({
      adapter: unloadable as never,
    }).decomposeSpec({ parentId: "epic_b", parentTier: "epic", spec: SPEC });
    expect(plan.source).toBe("heuristic");
    const result = await persistPlan(l, plan, { epicId: "epic_b" });
    const report = formatPlanReport(result);
    expect(report.split("\n")[0]).toBe(PLANNED_WITHOUT_MODEL);

    const spec = new Set(contentWords(SPEC));
    const foreign = (text: string) =>
      contentWords(text).filter((w) => !spec.has(w) && !STRUCTURAL_WORDS.has(w));
    expect(result.created.length).toBeGreaterThan(0);
    for (const c of result.created) {
      const card = await l.store.getCard(c.id);
      expect(card?.labels, c.id).toContain("no-model");
      expect(foreign(card?.title ?? ""), card?.title).toEqual([]);
      for (const criterion of card?.acceptanceCriteria ?? []) {
        expect(foreign(criterion), criterion).toEqual([]);
      }
    }
  });
});

describe("PM-P1-4: a bad reply is refused, retried once, then the heuristic runs", () => {
  const plan = (adapter: MockInferenceAdapter) =>
    new SpidrFeaturePlanner({ adapter }).decomposeSpec({
      parentId: "epic_r",
      parentTier: "epic",
      spec: "Refund a paid invoice.",
    });

  it("malformed JSON twice: two requests, then the heuristic, each refusal recorded", async () => {
    const adapter = new MockInferenceAdapter("planner", [reply("not json"), reply("{oops")], {
      exhaustion: "throw",
    });
    const p = await plan(adapter);
    expect(adapter.callHistory.length).toBe(2);
    expect(p.source).toBe("heuristic");
    expect(p.modelRefusals?.length).toBe(2);
  });

  it("truncated output is refused and the retry is used", async () => {
    const adapter = new MockInferenceAdapter("planner", [reply(GOOD, "length"), reply(GOOD)], {
      exhaustion: "throw",
    });
    const p = await plan(adapter);
    expect(adapter.callHistory.length).toBe(2);
    expect(p.source).toBe("model_assisted");
    expect(p.modelRefusals?.[0]).toMatch(/truncated/);
  });

  it("an unknown slice kind refuses the whole reply", async () => {
    const bad = JSON.stringify({
      slices: [
        { kind: "path", title: "Refund", keywords: ["refund"], rationale: "r" },
        { kind: "widget", title: "Widget", keywords: ["widget"], rationale: "r" },
      ],
    });
    const adapter = new MockInferenceAdapter("planner", [reply(bad), reply(GOOD)], {
      exhaustion: "throw",
    });
    const p = await plan(adapter);
    expect(adapter.callHistory.length).toBe(2);
    expect(p.modelRefusals?.[0]).toMatch(/widget/);
    expect(p.stories.some((s) => /widget/i.test(s.card.title))).toBe(false);
  });

  it("an empty slice list twice falls back to the heuristic", async () => {
    const empty = JSON.stringify({ slices: [] });
    const adapter = new MockInferenceAdapter("planner", [reply(empty), reply(empty)], {
      exhaustion: "throw",
    });
    const p = await plan(adapter);
    expect(adapter.callHistory.length).toBe(2);
    expect(p.source).toBe("heuristic");
    expect(p.stories.length).toBeGreaterThan(0);
  });

  it("asks at temperature 0 with the spec in the prompt", async () => {
    const adapter = new MockInferenceAdapter("planner", [reply(GOOD)], { exhaustion: "throw" });
    await plan(adapter);
    expect(adapter.callHistory[0]?.temperature).toBe(0);
    expect(adapter.callHistory[0]?.prompt).toContain("Refund a paid invoice.");
  });
});
