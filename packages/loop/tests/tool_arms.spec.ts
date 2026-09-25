import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimatePromptTokens, measureToolInterface, workerCopy } from "@sekhemet/context";
import { type GateRunner, gateCopy } from "@sekhemet/gates";
import type { CardKind } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";
import { CLASS_TOOLS, TOOL_CATALOG, toolsForClass } from "../src/tool_catalog.js";
import { toolDefinition } from "../src/tool_schema.js";
import { ToolExecutor } from "../src/tools.js";

// worker-loop M2: the two tool arms B2.5 compares. The fixed-set arm sends the
// same tools array on every step and no tool_search (WL-M2-2); implement
// offers at most twelve tools, recall among them (WL-M2-3); every class's
// schemas fit DEC-27's 1,700 tokens (WL-M2-6). The progressive arm keeps the
// whole class catalog reachable through tool_search.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tool-arms-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 0;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

/** Fifteen gate ids in note's enum: the size the ratchets are measured at. */
const GATES15 = [
  "architecture",
  "bounds",
  "dependencies",
  "hook",
  "hygiene",
  "integrity",
  "licenses",
  "lint",
  "osv",
  "reachability",
  "regression",
  "secrets",
  "semgrep",
  "typecheck",
  "unit",
];

/** A project with mutation, the visual layer and every project gate. */
const GATES23 = [
  ...GATES15,
  "mutation",
  "trailers",
  "visual",
  "visual-a11y",
  "visual-confinement",
  "visual-console",
  "visual-layout",
  "visual-snapshot",
];

function session(calls: ToolCall[][], extra: Record<string, unknown> = {}) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    generate: async (req: InferenceRequest) => {
      seen.push(req);
      return { text: "", toolCalls: calls[Math.min(i++, calls.length - 1)] ?? [], usage };
    },
  } as unknown as LocalInferenceAdapter;
  const s = new CardExecutionSessionImpl({
    cardId: "c",
    stepBudget: 8,
    worktreePath: root,
    modelAdapter: adapter,
    gateRunner: passing,
    integrityGate: false,
    suspectableGates: GATES15,
    ...extra,
  });
  return { s, seen };
}

const WRITING: CardKind[] = ["implement", "interface", "data", "rule"];

describe("WL-M2-3: the implement class's fixed set", () => {
  it("offers at most twelve tools, recall among them, and never tool_search", () => {
    for (const cls of WRITING) {
      const names = toolsForClass(cls).map((t) => t.name);
      expect(names.length, cls).toBeLessThanOrEqual(12);
      expect(names, cls).toContain("recall");
      expect(names, cls).not.toContain("tool_search");
      for (const needed of ["read_file", "write_file", "edit", "check", "finish_card"]) {
        expect(names, `${cls} ${needed}`).toContain(needed);
      }
    }
  });

  it("stays within twelve with run_script for a script-capable Worker", () => {
    const names = toolsForClass("implement", TOOL_CATALOG, { scriptCapable: true }).map(
      (t) => t.name,
    );
    expect(names).toContain("run_script");
    expect(names.length).toBeLessThanOrEqual(12);
  });
});

describe("WL-M2-2: the fixed-set arm's tools array", () => {
  it("is byte-identical on every step and holds no tool_search", async () => {
    const read: ToolCall = { id: "r", name: "read_file", arguments: { path: "src/a.ts" } };
    const search: ToolCall = { id: "s", name: "tool_search", arguments: { query: "docs" } };
    const { s, seen } = session([[read], [search], [read]]);
    await s.executeTurn();
    const second = await s.executeTurn();
    await s.executeTurn();
    expect(s.getToolSetArm()).toBe("fixed");
    const arrays = seen.map((r) => JSON.stringify(r.tools));
    expect(arrays).toHaveLength(3);
    expect(new Set(arrays).size).toBe(1);
    expect((seen[0]?.tools ?? []).map((t) => t.name)).not.toContain("tool_search");
    // tool_search is not offered, so calling it is refused, not served.
    expect(second.observations[0]).toMatchObject({ ok: false, deniedRule: "not_offered" });
  });

  it("drops tool_search from a caller's catalog too", () => {
    const { s } = session([[]], { tools: TOOL_CATALOG });
    expect(s.getToolSpecs().map((t) => t.name)).not.toContain("tool_search");
  });
});

describe("the progressive arm", () => {
  it("keeps the whole implement catalog reachable through tool_search", () => {
    const { s } = session([[]], { progressiveTools: true });
    expect(s.getToolSetArm()).toBe("progressive");
    const offered = s.getToolSpecs().map((t) => t.name);
    for (const t of TOOL_CATALOG.filter((x) => x.name !== "run_script")) {
      expect(offered, t.name).toContain(t.name);
    }
  });
});

describe("WL-M2-6: every class's fixed set within DEC-27's 1,700 tokens", () => {
  // The allocator's estimator: the Worker's own tokenizer needs the model,
  // so the zone budgets are asserted with this one (context rule 11).
  it("fits the native schemas and the text interface of every class, with a fifteen- and a 23-gate enum", () => {
    for (const gates of [GATES15, GATES23]) {
      for (const cls of Object.keys(CLASS_TOOLS) as CardKind[]) {
        for (const scriptCapable of [false, true]) {
          const tools = session([[]], {
            tools: toolsForClass(cls, TOOL_CATALOG, { scriptCapable }),
            suspectableGates: gates,
          }).s.getToolSpecs();
          const label = `${cls}${scriptCapable ? " +run_script" : ""} ${gates.length} gates`;
          const native = estimatePromptTokens(JSON.stringify(tools.map(toolDefinition)));
          const text = estimatePromptTokens(measureToolInterface(tools).rendered);
          expect(native, `${label} native`).toBeLessThanOrEqual(1_700);
          expect(text, `${label} text`).toBeLessThanOrEqual(1_700);
        }
      }
    }
  });
});

describe("WL-M2-7: the progressive arm answers a symbol query with read_symbol calls", () => {
  it("names the declaring file in each call, as read_symbol takes it", async () => {
    writeFileSync(
      join(root, "src", "types.ts"),
      "export interface ChronicleEvent {\n  id: string;\n}\n",
    );
    const { s } = session(
      [[{ id: "t", name: "tool_search", arguments: { query: "ChronicleEvent" } }]],
      { progressiveTools: true },
    );
    const turn = await s.executeTurn();
    expect(turn.observations[0]?.ok).toBe(true);
    expect(turn.observations[0]?.content).toContain(
      workerCopy.readSymbolCall("src/types.ts", "ChronicleEvent"),
    );
  });
});

describe("a remedy or refusal names only tools its arm offers (review item 3)", () => {
  const catalog = TOOL_CATALOG.map((t) => t.name);
  /** The catalog tools a text names; a gate id in `gate "…"` is not a tool. */
  const named = (text: string) => {
    const bare = text.replace(/gate "[^"]*"/g, "");
    return catalog.filter((n) => new RegExp(`\\b${n}\\b`).test(bare));
  };
  const SAMPLE = ["src/ledger.ts", "Entry", "amount, id, note", "4", "TS2304", "./types.js"];
  const render = (copy: Record<string, unknown>) =>
    Object.entries(copy).map(([key, v]) => {
      if (typeof v !== "function") return [key, String(v)] as const;
      const f = v as (...a: unknown[]) => string;
      try {
        return [key, f(...SAMPLE.slice(0, Math.max(f.length, 1)))] as const;
      } catch {
        return [key, f(["src/ledger.ts"], "x")] as const;
      }
    });
  /** Replies only tool_search gives: they exist only where it is offered. */
  const TOOL_SEARCH_REPLIES = new Set(["toolSearchSymbols", "symbolNotDeclared", "readSymbolCall"]);

  const arms = WRITING.flatMap((cls) =>
    [false, true].flatMap((scriptCapable) =>
      (["fixed", "progressive"] as const).map((arm) => ({
        label: `${cls} ${arm}${scriptCapable ? " +run_script" : ""}`,
        offered: toolsForClass(cls, TOOL_CATALOG, { scriptCapable, arm }).map((t) => t.name),
      })),
    ),
  );

  it("in the gates and Worker copy modules", () => {
    for (const { label, offered } of arms) {
      const texts = [
        ...render(gateCopy),
        ...render(workerCopy).filter(
          ([key]) => offered.includes("tool_search") || !TOOL_SEARCH_REPLIES.has(key),
        ),
      ];
      for (const [key, text] of texts) {
        const missing = named(text).filter((n) => !offered.includes(n));
        expect(missing, `${label}: ${key}`).toEqual([]);
      }
    }
  });

  it("in read_file's and run_cmd's own replies", async () => {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(
      join(root, "src", "long.ts"),
      Array.from({ length: 260 }, (_, i) => `export const v${i} = ${i};`).join("\n"),
    );
    for (const { label, offered } of arms) {
      const tools = new ToolExecutor({ worktreePath: root });
      tools.setOfferedTools(offered);
      const replies = [
        await tools.execute({ id: "d", name: "read_file", arguments: { path: "src/lib" } }),
        await tools.execute({ id: "o", name: "read_file", arguments: { path: "src/long.ts" } }),
        ...(offered.includes("run_cmd")
          ? await Promise.all(
              ["grep -rn x src", "cat src/a.ts", "sed -n 1p src/a.ts"].map((command) =>
                tools.execute({ id: "r", name: "run_cmd", arguments: { command } }),
              ),
            )
          : []),
      ];
      for (const r of replies) {
        const missing = named(r.content).filter((n) => !offered.includes(n) && n !== r.tool);
        expect(missing, `${label}: ${r.content.slice(0, 80)}`).toEqual([]);
      }
    }
  });
});
