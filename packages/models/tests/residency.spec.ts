import { describe, expect, it } from "vitest";
import { ModelRouter, type UnloadableAdapter, planResidency } from "../src/router.js";

const GB = 1024 ** 3;
const fake = (id: string, events: string[]): UnloadableAdapter =>
  ({
    modelId: id,
    generate: async () => ({
      text: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    }),
    unload: async () => {
      events.push(`unload ${id}`);
    },
    confirmUnloaded: async () => true,
  }) as unknown as UnloadableAdapter;
const QUIET = { pressureLevel: () => 1, freeBytes: () => 0 };

describe("@sekhemet/models hardware-aware residency", () => {
  const roster = [
    { role: "worker" as const, modelId: "cyber-tiel", bytes: 16 * GB },
    { role: "manager" as const, modelId: "dirk", bytes: 13 * GB },
    { role: "escalation" as const, modelId: "dirk", bytes: 13 * GB },
    { role: "researcher" as const, modelId: "apodex", bytes: 18 * GB },
    { role: "reviewer" as const, modelId: "mistral", bytes: 16 * GB },
  ];

  it("keeps everything resident on a 128 GB host", () => {
    const plan = planResidency(roster, 110 * GB);
    expect(plan.swapped).toEqual([]);
    expect(plan.usedBytes).toBe(63 * GB); // dirk counted once
  });

  it("keeps only the worker resident on a 24 GB host, the rest swap", () => {
    const plan = planResidency(roster, 16 * GB);
    expect(plan.resident).toEqual(["worker"]);
    expect(plan.swapped).toEqual(["manager", "escalation", "researcher", "reviewer"]);
  });

  it("keeps worker and Merit together on a 36 GB budget, swapping the others", () => {
    expect(planResidency(roster, 36 * GB).resident).toEqual(["worker", "manager", "escalation"]);
  });

  it("evicts the least valuable resident only when a load would not fit", async () => {
    const events: string[] = [];
    const router = new ModelRouter(
      {
        worker: () => fake("cyber-tiel", events),
        manager: () => fake("dirk", events),
        researcher: () => fake("apodex", events),
        reviewer: () => fake("mistral", events),
      },
      {
        ...QUIET,
        budgetBytes: 36 * GB,
        footprints: { worker: 16 * GB, manager: 13 * GB, researcher: 18 * GB, reviewer: 16 * GB },
      },
    );
    await router.use("worker");
    await router.use("manager");
    expect(events).toEqual([]); // both fit: no swap
    expect(router.isResident("worker") && router.isResident("manager")).toBe(true);

    await router.use("researcher"); // 45 GB > 36: evict the lower-priority resident (Merit)
    expect(events).toEqual(["unload dirk"]);
    expect(router.isResident("worker")).toBe(true);
    expect(router.residentRoles().sort()).toEqual(["researcher", "worker"]);
    expect(router.swapCount).toBe(1);
  });

  it("never evicts anything when every model fits", async () => {
    const events: string[] = [];
    const router = new ModelRouter(
      {
        worker: () => fake("w", events),
        manager: () => fake("m", events),
        researcher: () => fake("r", events),
      },
      {
        ...QUIET,
        budgetBytes: 110 * GB,
        footprints: { worker: 16 * GB, manager: 13 * GB, researcher: 18 * GB },
      },
    );
    for (const role of ["worker", "manager", "researcher", "worker", "manager"] as const)
      await router.use(role);
    expect(events).toEqual([]);
    expect(router.swapCount).toBe(0);
  });
});
