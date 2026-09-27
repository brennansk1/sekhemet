import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { RESEARCH_METHOD, research } from "../src/research/researcher.js";
import { ResearchService } from "../src/research/service.js";
import { RESEARCH_GOLDEN_RUN } from "../src/research_bakeoff.js";

// design-stage DS-N2-9: the latest research golden-set run's pipeline verdict
// routes a model to its recommended pipeline — `native`, the Apodex loop on
// the model's trained tools, or `tool-loop`, research's own loop. With no
// verdict the dispatch is as before. An on-disk ledger (DEFINITION_OF_DONE
// §2A); the model is scripted, none is loaded.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A scripted model that answers at once and records what it was sent. */
function scripted(modelId: string): LocalInferenceAdapter & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  return {
    modelId,
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    contextWindow: { contextTokens: 16384, maxTokens: 1500 },
    requests,
    async generate(req) {
      requests.push(structuredClone(req));
      return {
        text: "Not settled: nothing read.",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
}

const usedToolLoop = (m: { requests: InferenceRequest[] }) =>
  (m.requests[0]?.systemPrompt ?? "").includes(RESEARCH_METHOD);

async function ledgerWith(verdicts: { model: string; recommended?: "native" | "tool-loop" }[]) {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-route-"));
  dirs.push(repoPath);
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  await log.append({
    actor: "harness",
    type: RESEARCH_GOLDEN_RUN,
    payload: {
      setHash: "e".repeat(64),
      setVersion: "1",
      host: "host-a",
      items: 25,
      contenders: [],
      pipelines: verdicts.map((v) => ({
        model: v.model,
        ...(v.recommended ? { recommended: v.recommended } : {}),
        notRecommended: v.recommended ? [v.recommended === "native" ? "tool-loop" : "native"] : [],
        tests: [],
      })),
      adoption: { incumbent: "apodex-1.1-mini", verdicts: [] },
    },
  });
  return { repoPath, log };
}

describe("research() follows the pipeline it is given", () => {
  it("an Apodex model told tool-loop runs research's own loop; untold, its native loop", async () => {
    const told = scripted("apodex-1.1-mini");
    await research(told, "q", { repoPath: tmpdir(), pipeline: "tool-loop" });
    expect(usedToolLoop(told)).toBe(true);
    const untold = scripted("apodex-1.1-mini");
    await research(untold, "q", { repoPath: tmpdir() });
    expect(usedToolLoop(untold)).toBe(false);
  });

  it("another model told native runs the native loop", async () => {
    const m = scripted("spark-x2.5-4b");
    await research(m, "q", { repoPath: tmpdir(), pipeline: "native" });
    expect(usedToolLoop(m)).toBe(false);
  });
});

describe("the research service reads the recorded verdict (DS-N2-9)", () => {
  it("routes the model to the pipeline the latest golden-set run recommends", async () => {
    const { repoPath, log } = await ledgerWith([
      { model: "apodex-1.1-mini", recommended: "tool-loop" },
    ]);
    const m = scripted("apodex-1.1-mini");
    const service = new ResearchService({ repoPath, model: async () => m, web: undefined, log });
    await service.ask("which sqlite binding", { fresh: true });
    expect(usedToolLoop(m)).toBe(true);
  });

  it("leaves a model the run did not judge on its usual pipeline", async () => {
    const { repoPath, log } = await ledgerWith([{ model: "spark-x2.5-4b" }]);
    const m = scripted("apodex-1.1-mini");
    const service = new ResearchService({ repoPath, model: async () => m, web: undefined, log });
    await service.ask("which sqlite binding", { fresh: true });
    expect(usedToolLoop(m)).toBe(false);
  });
});
