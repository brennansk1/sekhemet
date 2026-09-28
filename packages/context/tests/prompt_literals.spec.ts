import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LiteralInventory,
  MODEL_PATH_FILES,
  compareWithInventory,
  copyModuleShapedFiles,
  extractModelFacingLiterals,
  inventoryOf,
  scanModelFacingLiterals,
} from "../src/prompt_literals.js";
import { unregisteredCopyModules } from "../src/prompt_tags.js";

// Context CX-M1-13 and PROMPT_STANDARD rules 13 and 36: every model-facing
// literal outside a copy module is recorded, and the record may only shrink.

/**
 * The number of literals in prompt_literals_baseline.json, exactly. A record
 * that shrinks lowers it in the same change, so a hand edit of the JSON shows
 * here. History: 506 at first; 513 when the inventory also read `directive:`
 * fields, `ladder.ts` and `working_memory.ts`; 495 when B2.3 moved 18 gate
 * remedies into the gates copy module; 483 when the B2 coherence pass moved
 * 12 Worker literals into the Worker copy module; 481 when edit's
 * not-found remedy and recall's description moved there too; 446 when the
 * B2.1 review's fixes moved 13 more (the harness's 8 project-gate remedies
 * into the gates copy module; 4 lines of worker_prompt.ts and 1 of
 * session.ts into the Worker copy module) and the 22 qualification strings
 * moved into the qualification copy module; 443 when read_file's directory and
 * outline replies moved into the Worker copy module, to name only the tools
 * the arm offers (the B2.5 arms review, item 3); 438 when B4.0a built
 * Seshat's prompt from allocator sections and moved the re-plan prompt into
 * its copy module; 437 when find_references' fallback moved into the Worker
 * copy module with the source index (gates T2); 428 when B4.3 moved Seshat's
 * prompt and tool descriptions into the new PM copy module and the planner's
 * slice prompt and oracle into the planner copy module.
 */
const RECORDED_LITERAL_TOTAL = 418;

const texts = (file: string, source: string) =>
  extractModelFacingLiterals(file, source).map((l) => l.text);

describe("a refusal is model-facing only where the Worker meets it", () => {
  const refusal = (name: string) =>
    `export function ${name}(model: string) { return \`Refusing \${model} as the Worker: not qualified for this combination on this host.\`; }`;

  it("does not inventory a refusal the harness application says to a person", () => {
    expect(texts("apps/harness/src/qualify.ts", refusal("qualificationRefusal"))).toEqual([]);
  });

  it("names the person-facing builders, so another refusal in the app is still inventoried", () => {
    expect(texts("apps/harness/src/x.ts", refusal("toolRefusal"))).toHaveLength(1);
  });

  it("still inventories a refusal built on the Worker's path", () => {
    expect(texts("packages/loop/src/x.ts", refusal("confinementRefusal"))).toEqual([
      "Refusing ${} as the Worker: not qualified for this combination on this host.",
    ]);
    expect(texts("packages/sandbox/src/x.ts", refusal("addressRefusal"))).toHaveLength(1);
  });
});

describe("finding model-facing literals", () => {
  it("finds prompts, tool descriptions and chat content by where they are written", () => {
    const source = `
      const res = await model.generate({
        systemPrompt: "You are the planner. Answer with JSON only.",
        prompt: \`Card \${id}: write the plan now.\`,
      });
      const tool = { name: "grep", description: "Search files for a pattern.", parameters: {} };
      const turn = { role: "user", content: "Reply to the human now please." };
      const schema = { parameters: { properties: { q: { type: "string", description: "The query to run here" } } } };
      history.push({ turn: 3, action: "memory guard", result: \`Execution paused: \${why} for now\` });
    `;
    expect(texts("apps/harness/src/x.ts", source)).toEqual([
      "You are the planner. Answer with JSON only.",
      "Card ${}: write the plan now.",
      "Search files for a pattern.",
      "Reply to the human now please.",
      "The query to run here",
      "Execution paused: ${} for now",
    ]);
  });

  it("finds observation and refusal text, and prompt constants and builders", () => {
    const source = `
      return denied("write_file", "the path is outside the declared scope");
      const MANAGER_SYSTEM = "You are the planning model in a coding harness.";
      export function pmSystemPrompt(s) { return \`You are the project manager for \${s.project} today.\`; }
      function refuseNotOffered(name) { return "that tool is not offered on this card"; }
    `;
    expect(texts("packages/loop/src/x.ts", source)).toEqual([
      "the path is outside the declared scope",
      "You are the planning model in a coding harness.",
      "You are the project manager for ${} today.",
      "that tool is not offered on this card",
    ]);
  });

  it("ignores human-facing text, short strings and copy modules", () => {
    const source = `
      throw new Error("the ledger file could not be opened at all");
      console.log("Starting the dashboard server now on port");
      const card = { title: "Ledger store for the chronicle", status: "done" };
      const s = { systemPrompt: "ok" };
    `;
    expect(texts("packages/kernel/src/x.ts", source)).toEqual([]);
    expect(
      texts("packages/gates/src/copy.ts", 'const P = { prompt: "Write the plan now please." };'),
    ).toEqual([]);
  });

  it("does not exempt a file shaped like a copy module that is not registered", () => {
    expect(
      texts(
        "packages/loop/src/worker_copy.ts",
        'const P = { prompt: "Write the plan now please." };',
      ),
    ).toEqual(["Write the plan now please."]);
  });

  it("finds a repair rung's directive", () => {
    expect(
      texts(
        "packages/kernel/src/x.ts",
        'const r = { rung: "x", directive: "Repair the specific failure above now." };',
      ),
    ).toEqual(["Repair the specific failure above now."]);
  });

  it("reads the repair ladder and the working memory as the Worker's prompt path", () => {
    expect(MODEL_PATH_FILES).toContain("packages/loop/src/ladder.ts");
    expect(MODEL_PATH_FILES).toContain("packages/loop/src/working_memory.ts");
  });

  it("counts every prose literal in a file on the model's path", () => {
    expect(
      texts(
        "packages/loop/src/tools.ts",
        'throw new Error("write refused: the result would not parse at all");',
      ),
    ).toEqual(["write refused: the result would not parse at all"]);
  });
});

describe("the inventory may only shrink", () => {
  const lit = (file: string, text: string) =>
    extractModelFacingLiterals(file, `const P = { prompt: ${JSON.stringify(text)} };`);

  it("reports an added literal and a stale entry", () => {
    const before = inventoryOf([...lit("a.ts", "Write the plan now please.")]);
    const now = [
      ...lit("a.ts", "Write the plan now please."),
      ...lit("b.ts", "Answer with JSON only now."),
    ];
    const diff = compareWithInventory(now, before);
    expect(diff.added.map((l) => `${l.file}: ${l.text}`)).toEqual([
      "b.ts: Answer with JSON only now.",
    ]);
    expect(diff.stale).toEqual([]);
    expect(compareWithInventory([], before).stale.map((e) => e.file)).toEqual(["a.ts"]);
  });

  it("treats a second copy of a recorded literal as added", () => {
    const one = lit("a.ts", "Write the plan now please.");
    const diff = compareWithInventory([...one, ...one], inventoryOf(one));
    expect(diff.added).toHaveLength(1);
  });
});

describe("CX-M1-13: the repository's model-facing literals", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const path = join(import.meta.dirname, "..", "prompt_literals_baseline.json");

  it("registers every file shaped like a copy module (rule 13)", () => {
    expect(unregisteredCopyModules(copyModuleShapedFiles(root))).toEqual([]);
  });

  it("adds no model-facing literal outside a copy module, and the record only shrinks", () => {
    const current = scanModelFacingLiterals(root);
    expect(current.length).toBeGreaterThan(50);
    // Recording never creates the record: a missing file would accept everything.
    expect(existsSync(path), `${path} is missing; restore it from git`).toBe(true);
    const read = () => JSON.parse(readFileSync(path, "utf8")) as LiteralInventory;
    let diff = compareWithInventory(current, read());
    // Recording only ever shrinks the record: it refuses while anything is added.
    if (process.env.SEKHEMET_RECORD_PROMPT_BASELINE === "1" && diff.added.length === 0) {
      writeFileSync(path, `${JSON.stringify(inventoryOf(current), null, 2)}\n`);
      diff = compareWithInventory(current, read());
    }
    expect(
      diff.added.map((l) => `${l.file}:${l.line} [${l.context}] ${l.text.slice(0, 80)}`),
      "new model-facing literals: move them into the role's copy module (PROMPT_STANDARD rule 13)",
    ).toEqual([]);
    expect(
      diff.stale.map((e) => `${e.file} ${e.text}`),
      "recorded literals that are gone: rerun with SEKHEMET_RECORD_PROMPT_BASELINE=1 to shrink the record",
    ).toEqual([]);
    expect(
      read().literals.length,
      "the record's size differs from RECORDED_LITERAL_TOTAL: lower the constant with the record",
    ).toBe(RECORDED_LITERAL_TOTAL);
  });
});
