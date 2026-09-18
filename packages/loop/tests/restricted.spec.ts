import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult, GateRung, GateRunner } from "@sekhemet/gates";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { RESTRICTED_TOOL_NAMES, restrictedToolCatalog } from "../src/tool_catalog.js";
import { ToolExecutor } from "../src/tools.js";

function scripted(turns: Omit<ToolCall, "id">[][]) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "s",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      const calls = turns[i++] ?? [{ name: "finish_card", arguments: {} }];
      return {
        text: "",
        toolCalls: calls.map((c, n) => ({ id: `${i}-${n}`, ...c })),
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

describe("restricted mode is a read-only audit (S12, H27)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "restricted-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("strips run_cmd and every writing tool from the catalog", () => {
    const names = restrictedToolCatalog().map((t) => t.name);
    expect(names).not.toContain("run_cmd");
    for (const w of ["write_file", "edit", "replace_lines", "replace_symbol_body"]) {
      expect(names).not.toContain(w);
    }
    expect(names).toEqual(expect.arrayContaining(["read_file", "grep_search", "check", "note"]));
    expect(names.length).toBe(RESTRICTED_TOOL_NAMES.length);
  });

  it("refuses writes and commands in the executor, whatever the model calls", async () => {
    const tools = new ToolExecutor({
      worktreePath: root,
      scopeFiles: ["src/a.ts"],
      readOnly: true,
    });
    tools.markSeen("src/a.ts");
    const write = await tools.execute({
      id: "w",
      name: "edit",
      arguments: { path: "src/a.ts", search: "1", replace: "2" },
    });
    expect(write.ok).toBe(false);
    expect(write.denied).toBe(true);
    expect(write.content).toContain("restricted mode");
    const run = await tools.execute({ id: "r", name: "run_cmd", arguments: { command: "ls" } });
    expect(run.denied).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    const read = await tools.execute({
      id: "x",
      name: "read_file",
      arguments: { path: "src/a.ts" },
    });
    expect(read.ok).toBe(true);
    expect(tools.getDenialCounts().restricted).toBe(2);
  });

  it("sends only the restricted catalog and never runs the formatter", async () => {
    const rungsRun: GateRung[][] = [];
    const gate: GateRunner = {
      runGates: async (rungs): Promise<GateResult> => {
        rungsRun.push(rungs);
        return { passed: true, failures: [], durationMs: 1 };
      },
    };
    const { adapter, seen } = scripted([
      [{ name: "write_file", arguments: { path: "src/a.ts", content: "pwned" } }],
      [{ name: "finish_card", arguments: {} }],
    ]);
    const session = new CardExecutionSessionImpl({
      cardId: "card_audit",
      stepBudget: 4,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner: gate,
      scopeFiles: ["src/a.ts"],
      restricted: true,
      gateRungs: ["typecheck"],
      // A formatter that would write: it must not run in an audit.
      autofixCommand: ["sh", "-c", "echo formatted > src/a.ts"],
    });
    const turns = await session.run();
    expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("run_cmd");
    expect(seen[0]?.tools?.map((t) => t.name)).not.toContain("write_file");
    expect(turns[0]?.observations[0]?.denied).toBe(true);
    expect(turns.at(-1)?.stopReason).toBe("gate_passed");
    expect(rungsRun).toEqual([["typecheck"]]);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });
});
