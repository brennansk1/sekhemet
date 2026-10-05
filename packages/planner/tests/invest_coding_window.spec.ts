import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, hostFingerprintHash } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIER_BUDGET, type PlannedStory, validateInvest } from "../src/index.js";

// MD-N4-10 (models §4, SPEC-06): no planner constant sets the Worker's
// window. A caller that passes no tier budget gets the resolved Coding
// model's window from the registry: this host's assignment, else the shipped
// Coding model's (rule 3, DEC-47 O-5).

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-invest-win-"));
  // This file's own registry: the shared test registry may hold another file's assignment.
  vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function story(packTokens: number): PlannedStory {
  return {
    card: {
      id: "s1",
      tier: "story",
      title: "s1",
      status: "ready",
      scopeFiles: ["src/s1.ts"],
      stepBudget: 20,
      stepsUsed: 0,
      createdAt: "",
      updatedAt: "",
    },
    slice: "path",
    rationale: "r",
    keywords: ["s1"],
    acceptanceTests: [
      { filePath: "tests/s1.spec.ts", assertion: "given 1, returns 2", initiallyFailing: true },
    ],
    advances: [{ kind: "gate", ref: "unit" }],
    difficulty: { value: 3, factors: [] },
    routing: "direct",
    dependsOn: [],
    estimatedPackTokens: packTokens,
    splitDepth: 0,
  };
}

const smallPasses = () =>
  validateInvest([story(3_000)]).checks.find((c) => c.check === "small")?.passed;

describe("MD-N4-10: INVEST's default window is the resolved Coding model's", () => {
  it("reads the shipped Coding model's window when this host has assigned none", () => {
    expect(DEFAULT_TIER_BUDGET.workerWindowTokens).toBe(16_384);
    // A pack that fits Zone 3's cap at 16,384 (3,792 tokens).
    expect(smallPasses()).toBe(true);
  });

  it("follows this host's assignment, read when INVEST runs, not when the planner loads", () => {
    const registry = new ModelRegistry();
    registry.upsert("short-coder", { contextWindow: 8_192 });
    registry.recordRoleAssignment(hostFingerprintHash(), {
      role: "worker",
      model: "short-coder",
      scope: "personal",
      by: "p_owner",
      date: "2026-10-04T00:00:00Z",
    });
    expect(DEFAULT_TIER_BUDGET.workerWindowTokens).toBe(8_192);
    // The same pack no longer fits Zone 3's cap at 8,192.
    expect(smallPasses()).toBe(false);
  });

  it("keeps no constant window in the planner's default budget (a search test)", () => {
    const constants = readFileSync(join(SRC, "constants.ts"), "utf8");
    expect(constants).not.toMatch(/workerWindowTokens:\s*REFERENCE_WORKER_WINDOW/);
    expect(constants).not.toMatch(/workerWindowTokens:\s*\d/);
  });
});
