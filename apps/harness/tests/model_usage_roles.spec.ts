import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { attachImage, describeAttachments } from "../src/attachments.js";
import { extractInfo } from "../src/research/apodex.js";
import { inferenceVisionAdapter } from "../src/vision_check.js";

/** A model that records each request and answers with fixed text. */
function recording(text = "1. yes"): { model: LocalInferenceAdapter; seen: InferenceRequest[] } {
  const seen: InferenceRequest[] = [];
  return {
    seen,
    model: {
      modelId: "m",
      supportedArms: ["arm_a_flat", "arm_b_json"],
      generate: async (req) => {
        seen.push(req);
        return {
          text,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    },
  };
}

// Measurement rule 4a: a request names whose it is where its weights may
// serve more than one role (the Research model on the Planning model's
// weights, the vision check on the Review model's), so its `model/usage`
// is charged to the right role and purpose.

const SRC = join(import.meta.dirname, "..", "src");

/** Each `.generate({ … })` object literal in a source file, by brace matching. */
function generateCalls(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  const out: string[] = [];
  for (let at = text.indexOf(".generate({"); at !== -1; at = text.indexOf(".generate({", at + 1)) {
    let depth = 0;
    let end = at + ".generate(".length;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    out.push(text.slice(at, end + 1));
  }
  return out;
}

describe("requests name their role and purpose", () => {
  // A guard over the source, for the research loops whose runs need a search
  // tool and pages; the request that reaches the model is checked below for
  // the ones that run alone (fix round F2 review).
  it("every Research model request names the Research model", () => {
    for (const file of [
      "research/researcher.ts",
      "research/apodex_loop.ts",
      "research/apodex.ts",
      "research/critique.ts",
    ]) {
      const calls = generateCalls(file);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const c of calls) expect(c, file).toMatch(/\brole: "researcher"/);
    }
  });

  it("the request an extraction sends names the Research model", async () => {
    const { model, seen } = recording("the total is 40 hours");
    await extractInfo(model, "the weekly total", "A page about overtime.");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role).toBe("researcher");
  });

  it("an attachment's description is counted as the vision model describing an image", async () => {
    const repo = mkdtempSync(join(tmpdir(), "usage-roles-"));
    const db = new DatabaseSync(":memory:");
    try {
      initSchema(db);
      const cards = new CardStore(db, new EventLog(db));
      const card = await cards.createCard({ tier: "task", title: "Show the total" });
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32),
      ]);
      await attachImage(repo, cards, card.id, { name: "mock.png", bytes: png });
      const { model, seen } = recording('{"description":"a table","criteria":[]}');
      await describeAttachments(repo, cards, card, model);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.task).toBe("describe_image");
    } finally {
      db.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the visual check's question is the Review model's vision check", async () => {
    const { model, seen } = recording();
    await inferenceVisionAdapter("eyes", async () => model).answer(
      Buffer.from([0x89, 0x50]),
      ["Is the total shown?"],
      { temperature: 0 },
    );
    expect(seen[0]).toMatchObject({ role: "reviewer", task: "vision_check" });
  });
});
