import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, ModelRole, UnloadableAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardSpeed } from "../src/config_model_actions.js";
import { ModelAccess } from "../src/model_access.js";

// DB-NM14-3 (B4.1 half-B review): a person's *Measure speed* runs llama-bench
// (one warm-up, five runs at the role's depth) and times the first token with
// and without the prefix cache, all under the scheduler's benchmark rule — no
// other role loads meanwhile, and only what it loaded is unloaded. Fake
// adapters and a fake llama-bench: nothing loads.

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fakes(events: string[]) {
  const seen = new Set<string>();
  return (name: string, _role: ModelRole): UnloadableAdapter => ({
    modelId: name,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 1024 },
    generate: async (req: InferenceRequest) => {
      // A prefix seen before is cached: its first token comes sooner.
      const cached = seen.has(req.prompt);
      seen.add(req.prompt);
      await new Promise((r) => setTimeout(r, cached ? 5 : 40));
      req.onToken?.("x");
      return {
        text: "x",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
    load: async () => {
      events.push(`load ${name}`);
      return "loaded";
    },
    unload: async () => {
      events.push(`unload ${name}`);
    },
    confirmUnloaded: async () => true,
    footprintBytes: async () => 4 * GB,
  });
}

const benchJson = (tg: number, pp: number) =>
  JSON.stringify([
    { n_prompt: 512, n_gen: 0, avg_ts: pp },
    { n_prompt: 0, n_gen: 128, avg_ts: tg },
  ]);

describe("Measure speed (DB-NM14-3)", () => {
  it("runs llama-bench at the role's depth and times the first token with and without the prefix cache, under the benchmark rule", async () => {
    const events: string[] = [];
    const repo = mkdtempSync(join(tmpdir(), "speed-"));
    dirs.push(repo);
    const access = ModelAccess.forQueues([{ queue: "pm", role: "planner", name: "seshat" }], {
      resolve: fakes(events),
      usableBytes: 64 * GB,
      coResident: true,
      healthCheck: false,
    });
    await access.measure();
    const calls: string[][] = [];
    let pmRefused = "";
    const measure = dashboardSpeed({
      repoPath: repo,
      access: () => access,
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        if (calls.length === 1)
          pmRefused = await access.hold("pm").then(
            () => "",
            (e: Error) => e.message,
          );
        return benchJson(50 + (calls.length % 2) * 0.5, 900);
      },
      ttftRuns: 3,
    });
    const r = await measure({
      model: "tiny",
      path: "/models/tiny.gguf",
      role: "worker",
      depth: 4096,
    });
    expect(calls).toHaveLength(6);
    expect(calls[0]).toEqual(expect.arrayContaining(["-m", "/models/tiny.gguf", "-d", "4096"]));
    expect(r.bench?.accepted).toBe(true);
    expect(r.bench?.decode.grade).toBe("measured");
    expect(pmRefused).toMatch(/benchmark is running/);
    expect(r.ttft?.withoutCacheMs.grade).toBe("measured");
    expect(r.ttft?.withCacheMs.value).toBeLessThan(r.ttft?.withoutCacheMs.value ?? 0);
    expect(events).toEqual(["load tiny", "unload tiny"]);
  });

  it("unloads an idle resident before llama-bench's own process loads the model, and refuses while one is in use", async () => {
    const events: string[] = [];
    const repo = mkdtempSync(join(tmpdir(), "speed-"));
    dirs.push(repo);
    const access = ModelAccess.forQueues([{ queue: "pm", role: "planner", name: "seshat" }], {
      resolve: fakes(events),
      usableBytes: 64 * GB,
      coResident: true,
      healthCheck: false,
    });
    await access.measure();
    await access.use("pm");
    let residentAtBench: string[] | undefined;
    const measure = dashboardSpeed({
      repoPath: repo,
      access: () => access,
      exec: async () => {
        residentAtBench ??= access.residentWeights();
        return benchJson(50, 900);
      },
      ttftRuns: 1,
    });
    const req = { model: "tiny", path: "/models/tiny.gguf", role: "worker" as const, depth: 4096 };
    await measure(req);
    expect(residentAtBench).toEqual([]);
    expect(events.slice(0, 2)).toEqual(["load seshat", "unload seshat"]);

    await access.use("pm");
    const held = await access.hold("pm");
    try {
      await expect(measure(req)).rejects.toThrow(/seshat is in use/);
    } finally {
      held.release();
    }
  });

  it("says why llama-bench did not run, and still times the first token", async () => {
    const events: string[] = [];
    const repo = mkdtempSync(join(tmpdir(), "speed-"));
    dirs.push(repo);
    const access = ModelAccess.forQueues([], {
      resolve: fakes(events),
      usableBytes: 64 * GB,
      coResident: true,
      healthCheck: false,
    });
    const measure = dashboardSpeed({
      repoPath: repo,
      access: () => access,
      exec: async () => {
        throw new Error("spawn llama-bench ENOENT");
      },
      ttftRuns: 1,
    });
    const r = await measure({ model: "tiny", path: "/m.gguf", role: "worker", depth: 1024 });
    expect(r.bench).toBeUndefined();
    expect(r.benchError).toMatch(/ENOENT/);
    expect(r.ttft?.withoutCacheMs.value).toBeGreaterThan(0);
    expect(events).toEqual(["load tiny", "unload tiny"]);
  });
});
