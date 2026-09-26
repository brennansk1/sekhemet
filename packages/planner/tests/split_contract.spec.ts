import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_BUDGET,
  type PlannedStory,
  type PlannerLedger,
  SpidrFeaturePlanner,
  persistPlan,
  splitStory,
} from "../src/index.js";

/**
 * A split and the card vocabulary (planner-pm §2.2, §2.3.3, §2.5; DEC-26):
 * each child keeps its own behaviour and only its own tests; `kind`,
 * `change`, `split` and `splitDepth` are stored fields, never a title suffix;
 * a story at depth 4 that still fails INVEST is held, not split again.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function diskLedger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-split-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const SPEC = "Refund a paid invoice and email the invoice to the customer.";
const MAP = {
  files: ["src/refund.ts", "src/invoice_email.ts"],
  fileTokens: { "src/refund.ts": 2_000, "src/invoice_email.ts": 2_000 },
};
const REFUND = "Given a paid invoice of 1000 cents, refunding 400 leaves 600";
const EMAIL = "Given an invoice of 1000 cents, emailing it sends 1 email to the customer";

/** A path story over two files with one criterion each — too big to run as one card. */
async function oversized(): Promise<{ story: PlannedStory; stories: PlannedStory[] }> {
  const plan = await new SpidrFeaturePlanner({ codebaseMap: MAP }).decomposeSpec({
    parentId: "epic_s",
    parentTier: "epic",
    spec: SPEC,
  });
  const story = plan.stories.find((s) => s.slice === "path") as PlannedStory;
  story.card.scopeFiles = ["src/refund.ts", "src/invoice_email.ts"];
  story.keywords = ["refund", "invoice", "email"];
  story.estimatedPackTokens = 5_000;
  story.acceptanceTests = [
    { filePath: "tests/refund_path.spec.ts", assertion: REFUND, initiallyFailing: true },
    { filePath: "tests/refund_path.spec.ts", assertion: EMAIL, initiallyFailing: true },
  ];
  return { story, stories: plan.stories };
}

describe("PM-P1-7 (planner side): each part keeps its own behaviour and only its own tests", () => {
  it("gives each child only the criteria of its own axis, never the parent's full set", async () => {
    const { story } = await oversized();
    const children = splitStory(
      story,
      MAP,
      DEFAULT_TIER_BUDGET,
      new Set(story.card.scopeFiles),
      story.advances,
      new Date().toISOString(),
    );
    expect(children?.length).toBe(2);
    const own = (children ?? []).map((c) => c.acceptanceTests.map((t) => t.assertion));
    expect(own).toEqual([[REFUND], [EMAIL]]);
    for (const c of children ?? []) {
      expect(c.splitFrom).toBe(story.card.id);
      expect(c.card.parentId).toBe(story.card.parentId);
      for (const t of c.acceptanceTests) {
        expect(t.assertion).not.toMatch(/observable through the exported surface/);
      }
    }
  });
});

describe("PM-P1-11/12/13: kind, change, split and splitDepth are stored, never a title suffix", () => {
  it("persists a split child with its axis, its own kind, change 'feature' and depth 1", async () => {
    const l = diskLedger();
    await l.store.createCard({ id: "epic_s", tier: "epic", title: SPEC, status: "in_progress" });
    const { story, stories } = await oversized();
    const plan = await new SpidrFeaturePlanner({ codebaseMap: MAP }).decomposeSpec({
      parentId: "epic_s",
      parentTier: "epic",
      spec: SPEC,
    });
    const children = splitStory(
      story,
      MAP,
      DEFAULT_TIER_BUDGET,
      new Set(),
      story.advances,
      new Date().toISOString(),
    ) as PlannedStory[];
    plan.stories = [...stories.filter((s) => s !== story), ...children];
    const result = await persistPlan(l, plan, { epicId: "epic_s" });
    for (const child of children) {
      const card = await l.store.getCard(child.card.id);
      expect(card, child.card.id).not.toBeNull();
      expect(card?.split).toBe("path");
      expect(card?.kind).toBe("implement");
      expect(card?.change).toBe("feature");
      expect(card?.splitDepth).toBe(1);
      expect(card?.parentId).toBe("epic_s");
    }
    for (const c of result.created) {
      const card = await l.store.getCard(c.id);
      expect(card?.title).not.toMatch(/\(SPIDR/);
      expect(card?.change).toBe("feature");
      const planned = plan.stories.find((s) => s.card.id === c.id);
      if (planned?.splitFrom === undefined) {
        expect(card?.split, c.id).toBeUndefined();
        expect(card?.splitDepth, c.id).toBeUndefined();
      }
    }
    const contract = stories.find((s) => s.slice === "interface");
    expect((await l.store.getCard(contract?.card.id as string))?.kind).toBe("interface");
  });

  it("a story at split depth 4 that still fails INVEST is held in Planning, not split", async () => {
    const l = diskLedger();
    await l.store.createCard({ id: "epic_s", tier: "epic", title: SPEC, status: "in_progress" });
    const { story, stories } = await oversized();
    story.splitDepth = 4;
    story.splitFrom = "story_path_parent";
    const plan = await new SpidrFeaturePlanner({ codebaseMap: MAP }).decomposeSpec({
      parentId: "epic_s",
      parentTier: "epic",
      spec: SPEC,
    });
    plan.stories = stories;
    const result = await persistPlan(l, plan, { epicId: "epic_s" });
    const card = await l.store.getCard(story.card.id);
    expect(card?.status).toBe("planning");
    expect(card?.splitDepth).toBe(4);
    expect(card?.blockedReason).toMatch(/Small/);
    expect(result.held.map((h) => h.id)).toContain(story.card.id);
  });

  it("decompose never splits a lineage past the depth limit", async () => {
    const plan = await new SpidrFeaturePlanner({ codebaseMap: MAP }).decomposeSpec({
      parentId: "epic_s",
      parentTier: "epic",
      spec: SPEC,
      maxSplitDepth: 1,
      // A window so small every card is over Zone 3's cap.
      tierBudget: { ...DEFAULT_TIER_BUDGET, workerWindowTokens: 9_000 },
    });
    expect(plan.stories.every((s) => s.splitDepth <= 1)).toBe(true);
  });
});
