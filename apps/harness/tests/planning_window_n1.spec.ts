import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRegistry,
  type ModelRole,
  type QualificationCombination,
  type UnloadableAdapter,
  assignRole,
  hostFingerprintHash,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roleQualificationCheck } from "../src/doctor.js";
import {
  ModelAccess,
  describeModel,
  describeServed,
  planQueueSpec,
  planningQueueSpecs,
  qualifiedWindow,
} from "../src/model_access.js";
import { pmModelFor } from "../src/pm/service.js";
import {
  type CombinationDeps,
  qualificationCombination,
  verifiedQueueRoles,
} from "../src/qualify.js";

/**
 * N1-WIN (overnight run N1, 2026-10-09): `serve`'s Seshat ran nail-mtp with
 * an 8,192-token window (`pm/prompt_fitted`: budget 6,736, the 19.7 KB brief
 * cut to 1,209 tokens), while nail-mtp is qualified for the Planning role at
 * 16,384 on that host. A Planning model runs at the window it is qualified at
 * for the Planning role on this host; a model with no such qualification
 * keeps the roster's window for the role. Nothing loads: the adapters are fakes.
 */

const GB = 1024 ** 3;
let dir: string;
let registry: ModelRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-planning-window-"));
  registry = new ModelRegistry(join(dir, "models.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function combination(
  contextTokens: number,
  opts: { role?: ModelRole; host?: string; contextVersion?: string } = {},
): QualificationCombination {
  return {
    engine: "llama.cpp b10809 (5266f24da)",
    modelBuild: "sampled-sha256:test",
    host: opts.host ?? hostFingerprintHash(),
    settings: {
      contextTokens,
      kvType: "q8_0",
      speculative: "off",
      prefixCaching: true,
      parallelSlots: 1,
      chatTemplate: "pinned",
      contextVersion: opts.contextVersion ?? "v1",
      ...(opts.role ? { role: opts.role } : {}),
    },
  };
}

function qualify(
  id: string,
  contextTokens: number,
  opts: { role?: ModelRole; host?: string; status?: "qualified" | "failed" | "invalidated" } = {},
): void {
  registry.recordCombinationQualification(id, combination(contextTokens, opts), {
    suiteVersion: "q1.2",
    passRate: opts.status === "failed" ? 0.5 : 1,
    status: opts.status ?? "qualified",
  });
}

function fakeResolve() {
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
      contextWindow: { contextTokens: want.contextTokens ?? 8192, maxTokens: 2048 },
      generate: async () => ({
        text: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
      unload: async () => {},
      confirmUnloaded: async () => true,
      footprintBytes: async () => 12 * GB,
    };
    return adapter;
  };
  return { built, resolve };
}

describe("N1-WIN: the window a model is qualified at for a role, on this host", () => {
  it("is the context of its newest qualified combination for that role here", () => {
    qualify("nail-mtp", 16_384); // the Coding model's (no role)
    qualify("nail-mtp", 12_288, { role: "planner" });
    qualify("nail-mtp", 16_384, { role: "planner" });
    expect(qualifiedWindow("nail-mtp", "planner", { registry })).toEqual({ contextTokens: 16_384 });
  });

  it("is none for a model qualified only for another role, on another host, or not qualified", () => {
    qualify("coder", 16_384); // Coding model only
    expect(qualifiedWindow("coder", "planner", { registry })).toBeUndefined();
    qualify("elsewhere", 16_384, { role: "planner", host: "another-host" });
    expect(qualifiedWindow("elsewhere", "planner", { registry })).toBeUndefined();
    qualify("failing", 16_384, { role: "planner", status: "failed" });
    expect(qualifiedWindow("failing", "planner", { registry })).toBeUndefined();
    expect(qualifiedWindow("unlisted", "planner", { registry })).toBeUndefined();
  });

  it("reads an Ollama-prefixed name as its listed model", () => {
    qualify("qwen3:14b", 12_288, { role: "planner" });
    expect(qualifiedWindow("ollama/qwen3:14b", "planner", { registry })).toEqual({
      contextTokens: 12_288,
    });
  });
});

describe("N1-WIN: Seshat's chat queue runs at the Planning model's qualified window", () => {
  it("builds the chat adapter at 16,384 for a Planning model qualified there (was the roster's 8,192)", async () => {
    qualify("nail-mtp", 16_384, { role: "planner" });
    const { built, resolve } = fakeResolve();
    const access = ModelAccess.forQueues([], {
      resolve,
      usableBytes: 64 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    const hold = await pmModelFor("nail-mtp", registry, undefined, { access })();
    expect(hold.adapter.contextWindow?.contextTokens).toBe(16_384);
    expect(built).toEqual([{ name: "nail-mtp", role: "planner", contextTokens: 16_384 }]);
    hold.release();
  });

  it("keeps today's window for a Planning model with no qualified window", async () => {
    qualify("nail-mtp", 16_384); // the Coding model's only
    const { built, resolve } = fakeResolve();
    const access = ModelAccess.forQueues([], {
      resolve,
      usableBytes: 64 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    const hold = await pmModelFor("nail-mtp", registry, undefined, { access })();
    expect(built).toEqual([{ name: "nail-mtp", role: "planner" }]);
    hold.release();
  });
});

/**
 * The Planning model as `qualify --models nail-mtp --role planner` records it
 * (wave2.ts measures the Coding-model launch, 16,384 tokens), on "host-a".
 */
const deps: CombinationDeps = {
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b10809 (abc1234)",
  host: () => "host-a",
  contextVersion: (role) => `ctx-${role}`,
};
const served = () => ({ registry, host: "host-a" });

function qualifyPlanningAt16k(): void {
  // Listed first, as on a real host: the roster records the model's family,
  // whose published sampling every later launch then runs at.
  describeModel("nail-mtp", "planner", { registry });
  const launch = describeModel("nail-mtp", "planner", {
    registry,
    want: { contextTokens: 16_384 },
  });
  expect(launch.contextWindow?.contextTokens).toBe(16_384);
  registry.recordCombinationQualification(
    "nail-mtp",
    qualificationCombination(launch, { ...deps, role: "planner", registry }),
    { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
  );
}

describe("N1-WIN: every check of the Planning model sizes it as the runtime does", () => {
  it("the roster's own Planning window is not the qualified one (the N1 premise)", () => {
    expect(
      describeModel("nail-mtp", "planner", { registry }).contextWindow?.contextTokens,
    ).not.toBe(16_384);
  });

  it("the queue's gate keeps the manager and Seshat queues for a Planning model qualified only at 16,384", () => {
    qualifyPlanningAt16k();
    const specs = planningQueueSpecs("nail-mtp", served());
    const roles = verifiedQueueRoles(
      registry,
      specs,
      { state: "unfilled", reason: "no Review model" },
      (n, r) => describeServed(n, r, served()),
      deps,
    );
    expect(roles.refusals).toEqual([]);
    expect(roles.has("manager")).toBe(true);
    expect(roles.has("seshat")).toBe(true);
  });

  it("the manager queue's adapter is built at 16,384", async () => {
    qualifyPlanningAt16k();
    const specs = planningQueueSpecs("nail-mtp", served()).filter((s) => s.queue !== "escalation");
    expect(specs.map((s) => [s.queue, s.window?.contextTokens])).toEqual([
      ["manager", 16_384],
      ["seshat", 16_384],
    ]);
    const { built, resolve } = fakeResolve();
    const access = ModelAccess.forQueues(specs, {
      resolve,
      usableBytes: 64 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    await access.measure();
    const adapter = await access.use("manager");
    expect(adapter.contextWindow?.contextTokens).toBe(16_384);
    expect(built.map((b) => b.contextTokens)).toEqual([16_384]);
  });

  it("plan's queue runs the Planning model at 16,384", () => {
    qualifyPlanningAt16k();
    expect(planQueueSpec("nail-mtp", served())).toEqual({
      queue: "plan",
      role: "planner",
      name: "nail-mtp",
      window: { contextTokens: 16_384 },
    });
    // No Planning qualification here: the roster's window, as before.
    expect(planQueueSpec("unlisted", served())).toEqual({
      queue: "plan",
      role: "planner",
      name: "unlisted",
    });
  });

  it("doctor reports a Planning model qualified at 16,384 verified", () => {
    qualifyPlanningAt16k();
    assignRole(registry, {
      role: "planner",
      model: "nail-mtp",
      scope: "personal",
      by: "person",
      host: "host-a",
      qualification: "qualified",
    });
    const c = roleQualificationCheck(registry, { deps, host: "host-a", worker: "nail-mtp" });
    expect(c.detail).toMatch(/Planning model nail-mtp: verified/);
    expect(c.detail).not.toMatch(/Planning model nail-mtp: not verified/);
  });
});
