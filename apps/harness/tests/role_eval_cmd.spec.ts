import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { registerAsset } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, type ModelHold, ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMeasureCommand } from "../src/measure_cmd.js";
import type { PmConversation } from "../src/pm/eval.js";
import { SESHAT_SKILL_VERSION } from "../src/pm/seshat_skill.js";
import { MEASURE_REVIEWER, MEASURE_SEND_BACKS, MEASURE_SESHAT } from "../src/role_eval_cmd.js";

// `sekhemet measure seshat | seshat-compare | reviewer | send-backs` through
// the product's measure command: each runs on a held model (scripted here,
// never loaded), writes its result file and records it on the ledger.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let repo: string;
let db: DatabaseSync;
let log: EventLog;
let cardStore: CardStore;
let lines: string[];
const print = (l: string) => lines.push(l);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sekhemet-role-eval-"));
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  cardStore = new CardStore(db, log);
  lines = [];
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

const k = () => ({ repoPath: repo, log, cardStore });
/** An empty registry of this test's own: no role is assigned. */
const registry = () => new ModelRegistry(join(repo, "models.json"));

/** A held scripted model; records whether it was released and unloaded. */
function holder(reply: () => string) {
  const state = { released: 0, unloaded: 0, role: "", model: "" };
  const adapter: LocalInferenceAdapter & { unload(): Promise<void> } = {
    modelId: "scripted-model",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
    generate: async () => ({
      text: reply(),
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    unload: async () => {
      state.unloaded++;
    },
  };
  const acquire = async (role: "planner" | "reviewer", model: string): Promise<ModelHold> => {
    state.role = role;
    state.model = model;
    return { role, adapter, release: () => void state.released++ };
  };
  return { state, acquire };
}

const events = async (type: string) => (await log.getEventsByTypes([type])).map((e) => e.payload);

describe("measure reviewer (RG-P8-13)", () => {
  it("reviews the registered set on the named Review model, writes the result and records it", async () => {
    const h = holder(() => "{}");
    const code = await runMeasureCommand(
      ["reviewer", "--model", "review-x", "--out", "r.json"],
      k(),
      print,
      { acquire: h.acquire, harnessRoot: ROOT, registry: registry() },
    );
    expect(code).toBe(0);
    expect([h.state.role, h.state.model, h.state.released, h.state.unloaded]).toEqual([
      "reviewer",
      "review-x",
      1,
      1,
    ]);
    const result = JSON.parse(readFileSync(join(repo, "r.json"), "utf8"));
    expect(result.report.items).toBeGreaterThanOrEqual(20);
    // A reviewer that finds nothing catches nothing: recall 0, RG-P8-13 not met.
    expect(result.report.recall).toBe(0);
    const [recorded] = (await events(MEASURE_REVIEWER)) as {
      assetHash: string;
      recall: number;
      passes: boolean;
    }[];
    expect(recorded?.assetHash).toBe(result.assetHash);
    expect(recorded?.passes).toBe(false);
    expect(lines.at(-2)).toMatch(/Does not meet RG-P8-13/);
  });

  it("refuses to run without a Review model", async () => {
    const code = await runMeasureCommand(["reviewer"], k(), print, {
      harnessRoot: ROOT,
      registry: registry(),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/No Review model is configured/);
  });
});

describe("measure seshat (PM-P6-13)", () => {
  it("refuses the unregistered drafts, naming what a person does first", async () => {
    const code = await runMeasureCommand(["seshat"], k(), print, {
      harnessRoot: ROOT,
      registry: registry(),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/pm-conversations is not registered.*drafts\/README\.md/s);
  });

  it("holds the registered conversations on the PM model and records the skill version", async () => {
    const root = mkdtempSync(join(tmpdir(), "pm-conv-root-"));
    const dir = join(root, "fixtures", "pm_conversations");
    mkdirSync(dir, { recursive: true });
    const drafts = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "pm_conversations", "drafts", "items.json"), "utf8"),
    ) as (PmConversation & { status?: string })[];
    writeFileSync(
      join(dir, "items.json"),
      JSON.stringify(
        drafts.map(({ status: _s, ...c }) => ({
          ...c,
          labelledBy: { principal: "person: test-owner", kind: "person" },
        })),
      ),
    );
    copyFileSync(
      join(ROOT, "fixtures", "pm_conversations", "drafts", "boards.json"),
      join(dir, "boards.json"),
    );
    writeFileSync(
      join(root, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "", assets: [] }),
    );
    registerAsset(
      root,
      {
        name: "pm-conversations",
        path: "fixtures/pm_conversations",
        labelledBy: "person: test-owner",
      },
      { modelIds: [] },
    );
    const h = holder(() => "Noted.");
    const code = await runMeasureCommand(
      ["seshat", "--model", "pm-x", "--runs", "1", "--out", "s.json"],
      k(),
      print,
      { acquire: h.acquire, harnessRoot: root, registry: registry() },
    );
    expect(code).toBe(0);
    expect([h.state.role, h.state.model, h.state.released]).toEqual(["planner", "pm-x", 1]);
    const result = JSON.parse(readFileSync(join(repo, "s.json"), "utf8"));
    expect(result.skillVersion).toBe(SESHAT_SKILL_VERSION);
    expect(result.runs[0].total).toBe(20);
    const [recorded] = (await events(MEASURE_SESHAT)) as {
      skillVersion: string;
      model: string;
      passes: boolean;
      items: unknown[];
    }[];
    expect(recorded?.skillVersion).toBe(SESHAT_SKILL_VERSION);
    expect(recorded?.model).toBe("scripted-model");
    expect(recorded?.items).toHaveLength(20);
    expect(recorded?.passes).toBe(false);

    // Two result files compare paired; the same run against itself shows no difference.
    lines = [];
    expect(await runMeasureCommand(["seshat-compare", "s.json", "s.json"], k(), print)).toBe(0);
    expect(lines.join("\n")).toMatch(/no clear difference/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("measure send-backs (RG-P8-14)", () => {
  it("records the share against R8's one in five", async () => {
    const code = await runMeasureCommand(["send-backs"], k(), print);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/No send-backs yet/);
    const [recorded] = (await events(MEASURE_SEND_BACKS)) as { total: number; verdict: string }[];
    expect(recorded).toMatchObject({ total: 0, verdict: "too_few" });
    expect(existsSync(join(repo, ".sekhemet"))).toBe(false);
  });
});
