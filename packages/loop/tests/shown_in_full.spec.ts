import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCopy } from "@sekhemet/context";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { ToolExecutor } from "../src/tools.js";

// The B2.1 review, B2: edit's refusal points at the content above only for a
// file the last prompt showed in full.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shown-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const edit = (tools: ToolExecutor) =>
  tools.execute({
    id: "e",
    name: "edit",
    arguments: { path: "src/a.ts", search: "missing text", replace: "x" },
  });

describe("edit's refusal follows what the prompt showed", () => {
  it("points at the content above for a file shown in full", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    tools.markSeen("src/a.ts");
    tools.setShownInFull(["src/a.ts"]);
    expect((await edit(tools)).content).toBe(workerCopy.editNotFound("src/a.ts", true));
  });

  it("gives the read_file call for a file not shown in full", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    tools.markSeen("src/a.ts");
    tools.setShownInFull([]);
    const content = (await edit(tools)).content;
    expect(content).toBe(workerCopy.editNotFound("src/a.ts", false));
    expect(content).toContain('read_file(path="src/a.ts"');
  });
});

describe("a pinned file counts as read only when the prompt showed it in full (confirmation review)", () => {
  it("does not mark a scope file the allocator cut as read", async () => {
    const paths = Array.from({ length: 24 }, (_, k) => `src/f${k}.ts`);
    const body = Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    for (const p of paths) writeFileSync(join(root, p), body.slice(0, 5_900));
    const adapter: LocalInferenceAdapter = {
      modelId: "rec",
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 32_768, maxTokens: 1_024 },
      generate: async () => ({
        text: "",
        toolCalls: [{ id: "c1", name: "note", arguments: { text: "looking" } }],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
    };
    const s = new CardExecutionSessionImpl({
      cardId: "card_cut",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner: { runGates: async () => ({ passed: true, durationMs: 1, failures: [] }) },
      scopeFiles: paths,
    });
    await s.executeTurn();
    const internals = s as unknown as {
      lastPrompt?: { shownInFull: string[] };
      tools: ToolExecutor;
    };
    const shown = internals.lastPrompt?.shownInFull ?? [];
    const cut = paths.filter((p) => !shown.includes(p));
    expect(shown.length).toBeGreaterThan(0);
    expect(cut.length).toBeGreaterThan(0);
    for (const p of shown) expect(internals.tools.hasSeen(p)).toBe(true);
    for (const p of cut) expect(internals.tools.hasSeen(p), p).toBe(false);
  });
});
