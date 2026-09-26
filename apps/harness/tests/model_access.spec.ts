import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  FootprintRefusal,
  ModelRegistry,
  type ModelRole,
  type UnloadableAdapter,
  assignRole,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ModelAccess, roleModelName } from "../src/model_access.js";
import { researcherModel } from "../src/research/service.js";

// MD-N9-4: every caller obtains its model through the one scheduler, and no
// production code outside it constructs a model adapter. Nothing loads.

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fakes(events: string[], bytes: Record<string, number | undefined> = {}) {
  const built: { name: string; role: ModelRole; contextTokens?: number }[] = [];
  const resolve = (name: string, role: ModelRole, want: { contextTokens?: number } = {}) => {
    built.push({
      name,
      role,
      ...(want.contextTokens ? { contextTokens: want.contextTokens } : {}),
    });
    const adapter: UnloadableAdapter = {
      modelId: name,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: want.contextTokens ?? 8192, maxTokens: 1024 },
      generate: async () => ({
        text: name,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
      unload: async () => {
        events.push(`unload ${name}`);
      },
      confirmUnloaded: async () => true,
      footprintBytes: async () => (name in bytes ? bytes[name] : 12 * GB),
    };
    return adapter;
  };
  return { built, resolve };
}

describe("ModelAccess: the harness's one path to a model (MD-N9-4)", () => {
  it("serves queues on the same weights with one adapter at the largest window, and swaps on a small host", async () => {
    const events: string[] = [];
    const { built, resolve } = fakes(events);
    const access = ModelAccess.forQueues(
      [
        { queue: "worker", role: "worker", name: "cyber" },
        { queue: "chat", role: "planner", name: "qwen", window: { contextTokens: 8192 } },
        { queue: "escalation", role: "planner", name: "qwen", window: { contextTokens: 12_288 } },
      ],
      {
        resolve,
        usableBytes: 16 * GB,
        coResident: false,
        pressureLevel: () => 1,
        healthCheck: false,
      },
    );
    const plan = await access.measure();
    expect(plan.unknown).toEqual([]);
    const chat = await access.use("chat");
    const esc = await access.use("escalation");
    expect(chat).toBe(esc);
    expect(built.filter((b) => b.name === "qwen")).toEqual([
      { name: "qwen", role: "planner", contextTokens: 12_288 },
    ]);
    await access.use("worker");
    expect(events).toEqual(["unload qwen"]);
    expect(access.swapCount).toBe(1);
    expect(access.isResident("worker")).toBe(true);
    expect(access.activeRole).toBe("worker");
  });

  it("refuses a model whose footprint is unknown, naming it", async () => {
    const { resolve } = fakes([], { mystery: undefined });
    const access = ModelAccess.forQueues(
      [{ queue: "research", role: "researcher", name: "mystery" }],
      {
        resolve,
        usableBytes: 16 * GB,
        healthCheck: false,
      },
    );
    expect((await access.measure()).unknown).toEqual(["mystery"]);
    await expect(access.use("research")).rejects.toBeInstanceOf(FootprintRefusal);
  });

  it("adds a queue later, and releases one queue's weights on demand", async () => {
    const events: string[] = [];
    const { resolve } = fakes(events);
    const access = ModelAccess.forQueues([], { resolve, usableBytes: 64 * GB, healthCheck: false });
    access.ensureQueue({ queue: "chat", role: "planner", name: "qwen" });
    access.ensureQueue({ queue: "research", role: "researcher", name: "apodex" });
    access.ensureQueue({ queue: "chat", role: "planner", name: "qwen" });
    await access.measure();
    await access.use("chat");
    await access.use("research");
    expect(events).toEqual([]);
    await access.release("research");
    expect(events).toEqual(["unload apodex"]);
    expect(access.isResident("chat")).toBe(true);
  });

  it("M1: a held model is not evicted by another queue; the Researcher's flow holds once and releases", async () => {
    const events: string[] = [];
    const { resolve } = fakes(events);
    const access = ModelAccess.forQueues([{ queue: "chat", role: "planner", name: "qwen" }], {
      resolve,
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      healthCheck: false,
    });
    await access.measure();
    const seshat = await access.hold("chat");
    const research = researcherModel("apodex", access);
    await expect(research.acquire()).rejects.toBeInstanceOf(FootprintRefusal);
    expect(events).toEqual([]);
    seshat.release();
    const a = await research.acquire();
    const b = await research.acquire();
    expect(a).toBe(b);
    expect(events).toEqual(["unload qwen"]);
    // Held by the research flow: Seshat cannot evict it mid-question.
    await expect(access.hold("chat")).rejects.toBeInstanceOf(FootprintRefusal);
    await research.release();
    expect(events).toEqual(["unload qwen", "unload apodex"]);
    (await access.hold("chat")).release();
  });

  it("MD-N10-3: a role's model is the flag, else the person's assignment, else the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-access-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "models.json"));
    expect(roleModelName("worker", undefined, { registry, host: "h" })).toBeUndefined();
    assignRole(registry, {
      role: "worker",
      model: "qwen-next",
      scope: "personal",
      by: "person: B",
      host: "h",
      qualification: "qualified",
    });
    expect(roleModelName("worker", undefined, { registry, host: "h" })).toBe("qwen-next");
    expect(roleModelName("worker", "cyber-tiel", { registry, host: "h" })).toBe("cyber-tiel");
    expect(roleModelName("worker", undefined, { registry, host: "other" })).toBeUndefined();
  });
});

describe("MD-N9-4: no production code outside the scheduler constructs a model adapter", () => {
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const CONSTRUCTS =
    /new (HttpInferenceAdapter|ManagedLlamaServerAdapter|ModelRoster|ResidencyScheduler)\(|create(CyberTielWorker|ApodexResearcher|Qwen38Managed)\(/;
  /** The one harness module that builds adapters: `model_access.ts`. */
  const ALLOWED = new Set(["apps/harness/src/model_access.ts"]);

  it("finds construction only in model_access.ts", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const rel = relative(ROOT, p);
          if (ALLOWED.has(rel)) continue;
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (CONSTRUCTS.test(line) && !/^\s*(\*|\/\/)/.test(line))
                hits.push(`${rel}:${i + 1}`);
            });
        }
      }
    };
    walk(join(ROOT, "apps", "harness", "src"));
    for (const pkg of [
      "planner",
      "loop",
      "eval",
      "board",
      "ui",
      "gates",
      "context",
      "kernel",
      "sync",
    ]) {
      walk(join(ROOT, "packages", pkg, "src"));
    }
    expect(hits).toEqual([]);
  });
});
