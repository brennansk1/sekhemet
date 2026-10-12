import { describe, expect, it } from "vitest";
import { agentPanel } from "../src/issue.js";
import { type RoleRowLike, codingModelFact, codingModelWords } from "../src/nav.js";
import { aiStateLine, tileAiState } from "../src/teammates.js";

// Wave 8 review (sweep 4 #21, plan item B3): the sidebar named a model only
// when the Coding model was assigned, while Status and Projects read a fact
// that was true whenever any found model fitted — so with none assigned the
// sidebar said *No Coding model set up* and Status gave a queue estimate,
// and with one assigned but absent or unverified Status still did. One fact,
// from Configuration's roles (`GET /api/config/roles`), for every surface.

const worker = (row: Omit<RoleRowLike, "role"> & { verifiedModels?: string[] }) => [
  { role: "worker", ...row },
];

describe("the Coding model's readiness, one fact from Configuration's roles", () => {
  it("is not ready with none assigned, whatever the folders hold (case 1)", () => {
    const f = codingModelFact(worker({ qualified: false, verifiedModels: ["nail-mtp"] }));
    expect(f).toEqual({ ready: false, model: null, why: "none" });
    expect(codingModelWords(f)).toBe("No Coding model set up");
  });

  it("is not ready when the assigned model's file is not on this machine (case 2)", () => {
    const f = codingModelFact(
      worker({
        model: "cyber-tiel",
        qualified: true,
        effective: { model: "cyber-tiel", present: false },
      }),
    );
    expect(f).toEqual({ ready: false, model: "cyber-tiel", why: "missing" });
    expect(codingModelWords(f)).toBe("Coding model cyber-tiel is not on this machine");
  });

  it("is not ready when the assigned model is not verified here (case 2)", () => {
    const f = codingModelFact(
      worker({
        model: "cyber-tiel",
        qualified: false,
        effective: { model: "cyber-tiel", present: true },
      }),
    );
    expect(f).toEqual({ ready: false, model: "cyber-tiel", why: "unverified" });
    expect(codingModelWords(f)).toBe("Coding model cyber-tiel is not verified on this machine");
  });

  it("is ready when assigned, present here and verified here", () => {
    const f = codingModelFact(
      worker({
        model: "cyber-tiel",
        qualified: true,
        effective: { model: "cyber-tiel", present: true },
      }),
    );
    expect(f).toEqual({ ready: true, model: "cyber-tiel", why: null });
    expect(codingModelWords(f)).toBe("Coding model cyber-tiel");
    // An Ollama tag lives in Ollama's store, which Configuration does not read: presence unknown.
    expect(
      codingModelFact(
        worker({ model: "qwen3:8b", qualified: true, effective: { model: "qwen3:8b" } }),
      ).ready,
    ).toBe(true);
  });

  it("reads no roles as none", () => {
    expect(codingModelFact(undefined)).toEqual({ ready: false, model: null, why: "none" });
  });
});

// Sweep 4 #21 (plan item B3): the board tile said *Agent · queued* and the
// issue page *Queued: the Agent starts this issue when a slot is free.* on a
// machine where the bar says issues cannot run.
describe("a Ready issue with no Coding model ready waits for one, never *queued*", () => {
  const ready = { status: "ready" };

  it("the issue page says it waits for a Coding model", () => {
    const p = agentPanel(ready, [], { noCodingModel: true });
    expect(p.label).toBe("");
    expect(p.sentence).toBe(
      "Waiting for a Coding model: the Agent starts this issue once one is set up and verified on this machine.",
    );
    expect(p.sentence).not.toMatch(/queued|slot/i);
    // With a Coding model ready, the queue's words stand.
    expect(agentPanel(ready, []).label).toBe("queued");
  });

  it("the tile shows no queued state, and the teammate line says it waits", () => {
    const queued = [
      {
        who: "agent" as const,
        state: "queued" as const,
        standing: "1st in queue, about 10 minutes",
      },
    ];
    expect(tileAiState(queued, { noCodingModel: true })).toBeUndefined();
    expect(tileAiState(queued)?.label).toBe("queued");
    const line = aiStateLine(queued[0], { noCodingModel: true });
    expect(line.label).toBe("");
    expect(line.sentence).not.toMatch(/queue|slot/i);
    // Another state is untouched: a finished issue is still finished.
    expect(
      tileAiState([{ who: "agent", state: "done", waitingFor: "review" }], { noCodingModel: true })
        ?.label,
    ).toBe("finished");
  });
});
